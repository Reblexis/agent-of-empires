#!/usr/bin/env node
'use strict';
// A connect-only operator bridge to Codex's existing native message queue.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const fail = text => { throw new Error(text); };

function owner(sessionId, options) {
  const data = JSON.parse(fs.readFileSync(options.sessionsFile, 'utf8'));
  const rows = Array.isArray(data) ? data : data.sessions;
  const matches = rows.filter(row => row.id === sessionId);
  if (matches.length !== 1) fail('Exactly one current owner is required');
  const row = matches[0];
  if (row.tool !== 'codex' || row.trashed_at || row.archived_at ||
      !['running', 'idle', 'waiting'].includes(row.status)) {
    fail('Owner must be a live, unarchived native Codex session');
  }
  return row;
}

class Rpc {
  constructor(WebSocket, socket, timeoutMs) {
    this.ws = new WebSocket(`ws+unix://${socket}:/`);
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Control socket connection timed out')); this.ws.terminate(); }, timeoutMs);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', () => { clearTimeout(timer); reject(new Error('Control socket unavailable')); });
    });
    this.ws.on('error', () => this.rejectPending('Control socket failed'));
    this.ws.on('close', () => this.rejectPending('Control socket closed before acknowledgment'));
    this.ws.on('message', bytes => {
      let value;
      try { value = JSON.parse(bytes); } catch { return; }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(`Native RPC rejected ${pending.method}`));
      else pending.resolve(value.result);
    });
  }
  rejectPending(message) {
    for (const {reject, timer} of this.pending.values()) { clearTimeout(timer); reject(new Error(message)); }
    this.pending.clear();
  }
  async request(method, params) {
    await this.opened;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native RPC timed out: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, {resolve, reject, timer, method});
      this.ws.send(JSON.stringify({id, method, params}), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Native request write failed')); }
      });
    });
  }
  close() { this.ws.terminate(); }
}

async function connect(options, threadId) {
  const declared = path.join(options.store, 'app-server-control', 'app-server-control.sock');
  const link = fs.lstatSync(declared);
  const socket = fs.realpathSync(declared);
  const st = fs.statSync(socket);
  if (!st.isSocket() || (process.getuid && (link.uid !== process.getuid() || st.uid !== process.getuid()))) fail('Control socket must be owned by this user');
  const bundle = require(options.wsModule);
  const WebSocket = bundle.ws || bundle.WebSocket || bundle;
  const rpc = new Rpc(WebSocket, socket, options.timeoutMs || 5000);
  try {
    const init = await rpc.request('initialize', {
      clientInfo: {name: 'aoe_automated_delivery', version: '1'},
      capabilities: {experimentalApi: true},
    });
    if (!init.codexHome || fs.realpathSync(init.codexHome) !== fs.realpathSync(options.store)) fail('Native store identity does not match');
    rpc.ws.send(JSON.stringify({method: 'initialized'}));
    const result = await rpc.request('thread/read', {threadId, includeTurns: false});
    if (result.thread?.id !== threadId) fail('Native thread identity does not match');
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}

function writeJournal(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function inputText(input) {
  if (!Array.isArray(input) || input.some(item => item.type !== 'text')) return null;
  return input.map(item => item.text).join('');
}

async function reconcile(rpc, packet) {
  const scan = async (method, field, itemMatch) => {
    let cursor; const seen = new Set();
    for (let page = 0; page < 50; page++) {
      const result = await rpc.request(method, {threadId: packet.threadId, limit: 100, ...(cursor ? {cursor} : {}),
        ...(method === 'thread/turns/list' ? {sortDirection: 'desc', itemsView: 'full'} : {})});
      for (const item of result[field] || []) {
        const match = itemMatch(item);
        if (match) return match;
      }
      if (!result.nextCursor) return null;
      if (seen.has(result.nextCursor)) fail('Native pagination did not advance');
      cursor = result.nextCursor; seen.add(cursor);
    }
    fail('Native reconciliation page limit reached; delivery remains uncertain');
  };
  const queued = await scan('thread/queue/list', 'data', item => {
    if (item.clientUserMessageId !== packet.deliveryId) return null;
    if (inputText(item.input) !== packet.text) fail('Native delivery ID conflict');
    return {disposition: 'queued', nativeQueueId: item.id};
  });
  if (queued) return queued;
  return scan('thread/turns/list', 'data', turn => {
    for (const item of turn.items || []) {
      if (item.type !== 'userMessage' || item.clientId !== packet.deliveryId) continue;
      if (inputText(item.content) !== packet.text) fail('Native delivery ID conflict');
      return {disposition: 'recorded', nativeItemId: item.id || null};
    }
    return null;
  });
}

async function deliver(packet, options) {
  for (const key of ['sessionId', 'threadId', 'deliveryId', 'text']) {
    if (typeof packet[key] !== 'string' || !packet[key].trim()) fail(`Missing ${key}`);
  }
  if (!/^[a-f0-9]{16}$/.test(packet.sessionId) ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(packet.threadId) || packet.deliveryId.length > 256) fail('Invalid delivery identity');
  const row = owner(packet.sessionId, options);
  if (row.agent_session_id !== packet.threadId) fail('Recorded native identity does not match packet');
  const identity = {sessionId: packet.sessionId, threadId: packet.threadId, deliveryId: packet.deliveryId,
    text: packet.text, store: fs.realpathSync(options.store)};
  fs.mkdirSync(options.stateDir, {recursive: true, mode: 0o700});
  const file = path.join(options.stateDir, hash(packet.deliveryId) + '.json');
  const lock = file + '.lock';
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('Delivery is locked; retain and retry this exact ID after its owner finishes');
    throw error;
  }
  let rpc;
  try {
    let journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {identity, state: 'ready'};
    if (JSON.stringify(journal.identity) !== JSON.stringify(identity)) fail('Delivery ID conflict; original instruction retained');
    if (journal.state === 'acknowledged') return {...journal.receipt, duplicate: true};
    writeJournal(file, journal);
    rpc = await connect(options, packet.threadId);
    if (journal.state === 'sending') {
      const receipt = await reconcile(rpc, packet);
      if (!receipt) fail('Delivery remains uncertain; no blind re-enqueue is allowed');
      journal = {...journal, state: 'acknowledged', receipt};
      writeJournal(file, journal);
      return {...receipt, reconciled: true};
    }
    journal = {...journal, state: 'sending', attemptedAt: new Date().toISOString()};
    writeJournal(file, journal);
    const result = await rpc.request('thread/queue/add', {threadId: packet.threadId,
      clientUserMessageId: packet.deliveryId, input: [{type: 'text', text: packet.text, text_elements: []}]});
    const accepted = result.queuedSubmission;
    if (!accepted?.id || accepted.clientUserMessageId !== packet.deliveryId || inputText(accepted.input) !== packet.text) fail('Exact native acceptance was not confirmed');
    const receipt = {disposition: 'queued', nativeQueueId: accepted.id};
    writeJournal(file, {...journal, state: 'acknowledged', receipt});
    return receipt;
  } finally {
    rpc?.close();
    const held = fs.fstatSync(lockFd);
    fs.closeSync(lockFd);
    if (fs.existsSync(lock) && fs.statSync(lock).ino === held.ino) fs.unlinkSync(lock);
  }
}

async function check(sessionId, options) {
  const row = owner(sessionId, options);
  const rpc = await connect(options, row.agent_session_id);
  try {
    const queue = await rpc.request('thread/queue/list', {threadId: row.agent_session_id, limit: 1});
    return {sessionId, threadId: row.agent_session_id, nativeStoreVerified: true,
      queueReadable: Array.isArray(queue.data), sends: 0};
  } finally { rpc.close(); }
}

module.exports = {deliver, check};
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--packet', '--check', '--store', '--state-dir', '--sessions-file', '--ws-module'].includes(args[i]) || !args[i + 1]) fail('Supply named operator arguments');
      flags[args[i]] = args[i + 1];
    }
    const options = {store: flags['--store'] || path.join(os.homedir(), '.codex'),
      stateDir: flags['--state-dir'], sessionsFile: flags['--sessions-file'] || path.join(os.homedir(), '.config/agent-of-empires/profiles/main/sessions.json'),
      wsModule: flags['--ws-module'] || 'ws', timeoutMs: 5000};
    if (flags['--check']) console.log(JSON.stringify(await check(flags['--check'], options)));
    else {
      if (!flags['--packet'] || !options.stateDir) fail('A private packet and durable state directory are required');
      const packet = JSON.parse(fs.readFileSync(flags['--packet'], 'utf8'));
      console.log(JSON.stringify({deliveryId: packet.deliveryId, textSha256: hash(packet.text), ...await deliver(packet, options)}));
    }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
