const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {execFileSync, spawn} = require('node:child_process');
const {wsServer} = require(process.env.AOE_TEST_WS_MODULE);
const sessionsId='1111111111111111', threadId='11111111-1111-4111-8111-111111111111';
const tmp=()=>fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'aoe-queue-'));
const implementation=()=>require('./codex-queue-send.cjs');
async function fixture() {
 const root=tmp(), store=path.join(root,'native'), state=path.join(root,'journal'), socket=path.join(store,'app-server-control','app-server-control.sock');
 fs.mkdirSync(path.dirname(socket),{recursive:true});
 const sessionsFile=path.join(root,'sessions.json');
 fs.writeFileSync(sessionsFile,JSON.stringify([{id:sessionsId,tool:'codex',status:'running',agent_session_id:threadId,trashed_at:null,archived_at:null}]));
 const server=http.createServer(), wss=new wsServer({server}); const queue=[],history=[];let adds=0, drop=false, rejectRead=false;
 wss.on('connection', ws=>ws.on('message', b=>{const q=JSON.parse(b);if(!q.id)return;
  let result={};
  if(q.method==='initialize')result={codexHome:store};
  else if(q.method==='thread/read') {if(rejectRead){ws.send(JSON.stringify({id:q.id,error:{message:'unknown thread'}}));return;} result={thread:{id:threadId,source:'cli'}};}
  else if(q.method==='thread/queue/list')result={data:queue,nextCursor:null};
  else if(q.method==='thread/turns/list')result={data:history,nextCursor:null};
  else if(q.method==='thread/queue/add') {adds++; const item={id:'queue-'+adds,clientUserMessageId:q.params.clientUserMessageId,input:q.params.input};queue.push(item);if(drop){drop=false;ws.close();return;}result={queuedSubmission:item};}
  else {ws.send(JSON.stringify({id:q.id,error:{message:'unexpected method'}}));return;}
  ws.send(JSON.stringify({id:q.id,result}));
 }));
 await new Promise(r=>server.listen(socket,r));
 const options={store,stateDir:state,sessionsFile,wsModule:process.env.AOE_TEST_WS_MODULE,timeoutMs:1000};
 const packet={sessionId:sessionsId,threadId,deliveryId:'original-action-1',text:'Central agent: distinct background instruction.'};
 return {root,store,options,packet,queue,history,server,wss,get adds(){return adds},set drop(v){drop=v},set rejectRead(v){rejectRead=v},async close(){for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}};
}
async function editor(root){
 const sock=path.join(root,'tmux.sock'), out=path.join(root,'editor.json'), script=path.join(root,'editor.cjs');
 fs.writeFileSync(script,`const fs=require('fs');const s={draft:'',submitted:[]};process.stdin.setRawMode(true);process.stdin.on('data',b=>{for(const c of b.toString()){if(c==='\\r'||c==='\\n'){s.submitted.push(s.draft);s.draft='';}else s.draft+=c;}fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(s));});console.log('EDITOR READY');`);
 execFileSync('tmux',['-S',sock,'new-session','-d','-s','qa-editor',`node ${script}`]);
 const send=s=>execFileSync('tmux',['-S',sock,'send-keys','-t','qa-editor','-l','--',s]);
 const read=()=>JSON.parse(fs.readFileSync(out));
 // Wait on observable editor readiness; no real AoE or native session is created.
 for(let i=0;i<100;i++){const pane=execFileSync('tmux',['-S',sock,'capture-pane','-p','-t','qa-editor']).toString();if(pane.includes('EDITOR READY'))break;await new Promise(r=>setTimeout(r,10));}
 return {send,read,sock,close:()=>execFileSync('tmux',['-S',sock,'kill-server'])};
}
test('an automated message never submits or merges a human draft while the human keeps typing',async()=>{
 const f=await fixture();const e=await editor(f.root);
 try {e.send('What is the status of ');await new Promise(r=>setTimeout(r,20));
  if(process.env.AOE_TEST_OLD_TRANSPORT==='1') {e.send(f.packet.text);e.send('this work?');execFileSync('tmux',['-S',e.sock,'send-keys','-t','qa-editor','Enter']);}
  else {const deliver=implementation().deliver;await Promise.all([deliver(f.packet,f.options),(async()=>{e.send('this work?');})()]);}
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(e.read(),{draft:'What is the status of this work?',submitted:[]});assert.equal(f.adds,1);
 } finally {e.close();await f.close();}
});
test('empty and busy editors use the same queue without terminal input',async()=>{
 const f=await fixture();try {for(const [i,text] of ['idle editor','busy turn with an unsent draft'].entries()){await implementation().deliver({...f.packet,deliveryId:'item-'+i,text},f.options);}assert.equal(f.adds,2);assert.deepEqual(f.queue.map(x=>x.input[0].text),['idle editor','busy turn with an unsent draft']);}finally{await f.close();}
});
test('confirmed and lost-ack retries never enqueue an instruction twice',async()=>{
 const f=await fixture();try {const {deliver}=implementation();const first=await deliver(f.packet,f.options);assert.equal(first.disposition,'queued');await deliver(f.packet,f.options);assert.equal(f.adds,1);
  f.drop=true;const p={...f.packet,deliveryId:'lost-ack'};await assert.rejects(deliver(p,f.options));await deliver(p,f.options);assert.equal(f.adds,2);
  // Once native dispatch moved it to history, the correlation ID still reconciles.
  f.drop=true;const h={...f.packet,deliveryId:'history-ack'};await assert.rejects(deliver(h,f.options));const item=f.queue.pop();f.history.push({items:[{type:'userMessage',clientId:item.clientUserMessageId,content:item.input}]});await deliver(h,f.options);assert.equal(f.adds,3);
 }finally{await f.close();}
});
test('uncertain absence is held and ID reuse cannot replace the original instruction',async()=>{
 const f=await fixture();try {const {deliver}=implementation();f.drop=true;await assert.rejects(deliver(f.packet,f.options));f.queue.length=0;await assert.rejects(deliver(f.packet,f.options),/uncertain/i);assert.equal(f.adds,1);await assert.rejects(deliver({...f.packet,text:'different authority'},f.options),/conflict/i);assert.equal(f.adds,1);}finally{await f.close();}
});
test('bad identity, archived owner, unavailable socket and invalid input never touch an editor',async()=>{
 const f=await fixture();try {const {deliver}=implementation();for(const p of [{...f.packet,threadId:'22222222-2222-4222-8222-222222222222'},{...f.packet,text:''},{...f.packet,deliveryId:''}])await assert.rejects(deliver(p,f.options));f.rejectRead=true;await assert.rejects(deliver(f.packet,f.options));f.rejectRead=false;assert.equal(f.adds,0);
  fs.writeFileSync(f.options.sessionsFile,JSON.stringify([{id:sessionsId,tool:'codex',status:'running',agent_session_id:threadId,archived_at:'2026-11-09T00:00:00Z'}]));await assert.rejects(deliver(f.packet,f.options));assert.equal(f.adds,0);
 }finally{await f.close();}
});

test('the existing user-owned Codex control-socket symlink needs no daemon startup',async()=>{
 const f=await fixture();try {const original=path.join(f.store,'app-server-control','app-server-control.sock'),target=path.join(f.root,'existing.sock');fs.renameSync(original,target);fs.symlinkSync(target,original);const r=await implementation().check(sessionsId,f.options);assert.equal(r.nativeStoreVerified,true);assert.equal(r.sends,0);assert.equal(f.adds,0);}finally{await f.close();}
});

test('concurrent callers with one original ID queue once and stale locks preserve the instruction',async()=>{
 const f=await fixture();try {
  const {deliver}=implementation();const results=await Promise.allSettled([deliver(f.packet,f.options),deliver(f.packet,f.options)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.adds,1);
  const crypto=require('node:crypto');const p={...f.packet,deliveryId:'stale-owner'};
  const lock=path.join(f.options.stateDir,crypto.createHash('sha256').update(p.deliveryId).digest('hex')+'.json.lock');fs.writeFileSync(lock,'retained');
  await assert.rejects(deliver(p,f.options),/locked/);assert.equal(f.adds,1);assert.equal(fs.readFileSync(lock,'utf8'),'retained');
 }finally{await f.close();}
});
test('no native submission is allowed without a durable journal and pre-send failures are safely retryable',async()=>{
 const f=await fixture();const original=fs.fsyncSync;
 try {fs.fsyncSync=()=>{const e=Error('disk full');e.code='ENOSPC';throw e;};await assert.rejects(implementation().deliver(f.packet,f.options),/disk full/);assert.equal(f.adds,0);
  fs.fsyncSync=original;await implementation().deliver(f.packet,f.options);assert.equal(f.adds,1);
  const unavailable={...f.options,store:path.join(f.root,'missing-store')};fs.mkdirSync(unavailable.store);await assert.rejects(implementation().deliver({...f.packet,deliveryId:'missing-socket'},unavailable));assert.equal(f.adds,1);
 }finally{fs.fsyncSync=original;await f.close();}
});

test('the default embedded transport accepts stdin and reuses the original delivery ID', async()=>{
 const f=await fixture();try {
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',fs.readFileSync(require.resolve('./codex-queue-send.cjs'),'utf8').replace(/^#![^\n]*\n/,'')+'\nmodule.exports.main(process.argv.slice(1)).catch(e=>{console.error(e.message);process.exitCode=1;});','--','--packet','-','--state-dir',f.options.stateDir,'--store',f.store,'--sessions-file',f.options.sessionsFile,'--ws-module',f.options.wsModule],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>code?reject(Error(stderr)):resolve(JSON.parse(stdout)));child.stdin.end(JSON.stringify(f.packet));});
  assert.equal((await run()).disposition,'queued');assert.equal((await run()).disposition,'queued');assert.equal(f.adds,1);
 }finally{await f.close();}
});
