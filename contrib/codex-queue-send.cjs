#!/usr/bin/env node
'use strict';
// A connect-only operator bridge to Codex's existing native message queue.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const SELF_SOURCE = typeof AOE_EMBEDDED_SOURCE === 'string' ? AOE_EMBEDDED_SOURCE : fs.readFileSync(__filename, 'utf8');
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

function imageFormat(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) return 'gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'webp';
  fail('Unsupported original image data; delivery held');
}

function retainImage(image, options) {
  const st = fs.lstatSync(image.path);
  if (!st.isFile() || st.size === 0 || st.size > 5 * 1024 * 1024) fail('Image must be a regular file of at most 5 MiB');
  const bytes = fs.readFileSync(image.path);
  if (hash(bytes) !== image.sha256) fail('Original image hash changed; delivery held');
  const ext = imageFormat(bytes), directory = path.resolve(options.stateDir, 'image-inputs');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const target = path.join(directory, image.sha256 + '.' + ext);
  if (fs.existsSync(target)) {
    if (hash(fs.readFileSync(target)) !== image.sha256) fail('Retained image snapshot changed; delivery held');
    return target;
  }
  const temporary = path.join(directory, '.image-' + crypto.randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o400);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (hash(fs.readFileSync(target)) !== image.sha256) fail('Retained image snapshot conflict');
    const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return target;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function nativeInput(packet, options, journal) {
  const images = packet.images || [];
  if (journal.nativeInput) {
    const expectedLength = (packet.text ? 1 : 0) + images.length;
    if (journal.nativeInput.length !== expectedLength) fail('Retained native input conflict');
    let offset = 0;
    if (packet.text) {
      if (journal.nativeInput[0].type !== 'text' || journal.nativeInput[0].text !== packet.text) fail('Retained native text conflict');
      offset++;
    }
    for (let i = 0; i < images.length; i++) {
      const item = journal.nativeInput[i + offset];
      if (item.type !== 'localImage' || path.dirname(item.path) !== path.resolve(options.stateDir,'image-inputs') ||
          hash(fs.readFileSync(item.path)) !== images[i].sha256) fail('Retained image input conflict');
    }
    return journal.nativeInput;
  }
  return [...(packet.text ? [{type:'text',text:packet.text,text_elements:[]}] : []),
    ...images.map(image => ({type:'localImage',path:retainImage(image,options)}))];
}

function inputMatches(actual, expected, packet) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  let imageIndex = 0;
  return expected.every((item, index) => {
    const seen = actual[index];
    if (item.type === 'text') return seen?.type === 'text' && seen.text === item.text;
    const image = packet.images[imageIndex++];
    if (hash(fs.readFileSync(item.path)) !== image.sha256) fail('Retained image bytes changed; delivery held');
    if (seen?.type === 'localImage') return seen.path === item.path;
    if (seen?.type === 'image' && typeof seen.url === 'string') {
      const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(seen.url);
      return !!match && hash(Buffer.from(match[1], 'base64')) === image.sha256;
    }
    return false;
  });
}

function imageReceipt(packet) {
  return packet.images?.length ? {imageSha256:packet.images.map(image => image.sha256)} : {};
}

async function reconcile(rpc, packet, input) {
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
    if (!inputMatches(item.input, input, packet)) fail('Native delivery ID conflict');
    return {disposition: 'queued', nativeQueueId: item.id, ...imageReceipt(packet)};
  });
  if (queued) return queued;
  return scan('thread/turns/list', 'data', turn => {
    for (const item of turn.items || []) {
      if (item.type !== 'userMessage' || item.clientId !== packet.deliveryId) continue;
      if (!inputMatches(item.content, input, packet)) fail('Native delivery ID conflict');
      return {disposition: 'recorded', nativeItemId: item.id || null, ...imageReceipt(packet)};
    }
    return null;
  });
}

async function activateQueued(rpc, packet, input, receipt) {
  if (receipt.disposition !== 'queued' || receipt.startedTurnId) return receipt;
  const current = await reconcile(rpc, packet, input);
  if (!current) fail('Accepted delivery remains uncertain; no blind re-enqueue or activation is allowed');
  if (current.disposition !== 'queued') return current;
  if (!current.nativeQueueId || current.nativeQueueId !== receipt.nativeQueueId) fail('Native queue identity changed; activation held');
  const result = await rpc.request('thread/read', {threadId: packet.threadId, includeTurns: false});
  if (result.thread?.id !== packet.threadId) fail('Native thread identity does not match');
  if (result.thread.status?.type !== 'idle') return current;
  // Native start-if-idle rejects an intervening active turn atomically. Always
  // name our exact accepted submission, never the queue's default next item.
  const started = await rpc.request('thread/queue/start', {
    threadId: packet.threadId, queuedSubmissionId: current.nativeQueueId,
  });
  if (!started.turn?.id) fail('Native queue start acknowledgment unavailable; reconcile original source');
  return {...current, startedTurnId: started.turn.id};
}

function lifecyclePath(packet, options) {
  if (!/^[a-f0-9]{16}$/.test(packet.sessionId || '')) fail('Invalid lifecycle identity');
  return path.join(path.dirname(fs.realpathSync(options.sessionsFile)), `.instance-lifecycle-${packet.sessionId}.lock`);
}

async function deliver(packet, options) {
  const lock = lifecyclePath(packet, options);
  const fd = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  const source = 'const AOE_EMBEDDED_SOURCE=' + JSON.stringify(SELF_SOURCE) + ';\n' +
    SELF_SOURCE.replace(/^#![^\n]*\n/, '') +
    '\nmodule.exports.workerMain().catch(e=>{console.error(e.message);process.exitCode=1;});';
  const launcher = 'import fcntl,os,sys; fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB); os.execv(sys.argv[1],sys.argv[1:])';
  let child;
  try { child = spawn('python3', ['-c', launcher, process.execPath, '-e', source],
    {stdio: ['pipe', 'pipe', 'pipe', fd, 'ipc']}); }
  finally { fs.closeSync(fd); }
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 30000);
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) child.kill('SIGTERM'); });
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 8192) child.kill('SIGTERM'); });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Lifecycle delivery launcher unavailable; no native fallback')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('Lifecycle delivery timed out; retain original ID and uncertain journal')); return; }
      if (code !== 0) { reject(new Error('Lifecycle delivery locked or unavailable: ' + stderr.trim())); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Lifecycle delivery receipt unavailable; retain original ID')); }
    });
    child.stdin.end(JSON.stringify({packet, options}));
  });
}

async function workerMain() {
  const {packet, options} = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (process.platform !== 'linux' || !process.connected) fail('Verified lifecycle worker unavailable');
  const held = fs.fstatSync(3), expected = fs.statSync(lifecyclePath(packet, options));
  const info = fs.readFileSync('/proc/self/fdinfo/3', 'utf8');
  const exclusive = new RegExp('FLOCK\\s+ADVISORY\\s+WRITE\\s+' + process.pid + '\\s');
  if (!held.isFile() || held.dev !== expected.dev || held.ino !== expected.ino ||
      (process.getuid && held.uid !== process.getuid()) || !exclusive.test(info)) fail('Lifecycle descriptor does not prove exclusive ownership');
  const disconnected = () => process.exit(75);
  process.on('disconnect', disconnected);
  try {
    const receipt = await deliverLocked(packet, options);
    await new Promise(resolve => process.stdout.write(JSON.stringify(receipt), resolve));
  } finally {
    process.removeListener('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
}

async function deliverLocked(packet, options) {
  if (Object.keys(packet).some(key => !['sessionId','threadId','deliveryId','text','images'].includes(key))) fail('Unknown delivery packet field');
  const images = packet.images || [];
  if (!Array.isArray(images) || images.length > 10) fail('At most ten original images are supported');
  for (const image of images) {
    if (!image || Object.keys(image).sort().join(',') !== 'path,sha256' || !path.isAbsolute(image.path || '') || !/^[a-f0-9]{64}$/.test(image.sha256 || '')) fail('Invalid original image identity');
  }
  if (typeof packet.text !== 'string' || (!packet.text.trim() && !images.length)) fail('Missing text or original image');
  for (const key of ['sessionId', 'threadId', 'deliveryId']) {
    if (typeof packet[key] !== 'string' || !packet[key].trim()) fail(`Missing ${key}`);
  }
  if (!/^[a-f0-9]{16}$/.test(packet.sessionId) ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(packet.threadId) || packet.deliveryId.length > 256) fail('Invalid delivery identity');
  const row = owner(packet.sessionId, options);
  if (row.agent_session_id !== packet.threadId) fail('Recorded native identity does not match packet');
  const identity = {sessionId: packet.sessionId, threadId: packet.threadId, deliveryId: packet.deliveryId,
    text: packet.text, store: fs.realpathSync(options.store), ...(images.length ? {images} : {})};
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
    if (journal.state === 'acknowledged' &&
        (journal.receipt.disposition !== 'queued' || journal.receipt.startedTurnId)) return {...journal.receipt, duplicate: true};
    const input = nativeInput(packet, options, journal);
    journal = {...journal, nativeInput: input};
    writeJournal(file, journal);
    rpc = await connect(options, packet.threadId);
    if (journal.state === 'acknowledged') {
      const receipt = await activateQueued(rpc, packet, input, journal.receipt);
      writeJournal(file, {...journal, receipt});
      return {...receipt, duplicate: true};
    }
    if (journal.state === 'sending') {
      const receipt = await reconcile(rpc, packet, input);
      if (!receipt) fail('Delivery remains uncertain; no blind re-enqueue is allowed');
      journal = {...journal, state: 'acknowledged', receipt};
      writeJournal(file, journal);
      const activated = await activateQueued(rpc, packet, input, receipt);
      writeJournal(file, {...journal, receipt: activated});
      return {...activated, reconciled: true};
    }
    journal = {...journal, state: 'sending', attemptedAt: new Date().toISOString()};
    writeJournal(file, journal);
    const result = await rpc.request('thread/queue/add', {threadId: packet.threadId,
      clientUserMessageId: packet.deliveryId, input});
    const accepted = result.queuedSubmission;
    if (!accepted?.id || accepted.clientUserMessageId !== packet.deliveryId || !inputMatches(accepted.input, input, packet)) fail('Exact native acceptance was not confirmed');
    const receipt = {disposition: 'queued', nativeQueueId: accepted.id, ...imageReceipt(packet)};
    writeJournal(file, {...journal, state: 'acknowledged', receipt});
    const activated = await activateQueued(rpc, packet, input, receipt);
    writeJournal(file, {...journal, state: 'acknowledged', receipt: activated});
    return activated;
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

async function main(args) {
    const flags = {};
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
      const packet = JSON.parse(fs.readFileSync(flags['--packet'] === '-' ? 0 : flags['--packet'], 'utf8'));
      console.log(JSON.stringify({deliveryId: packet.deliveryId, textSha256: hash(packet.text), ...await deliver(packet, options)}));
    }
}
module.exports = {deliver, check, main, workerMain};
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
