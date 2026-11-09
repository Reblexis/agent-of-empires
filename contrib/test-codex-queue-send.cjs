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
 const server=http.createServer(), wss=new wsServer({server}); const queue=[],history=[];let adds=0, drop=false, rejectRead=false, hold=false, onAdd; const lockObservations=[];
 wss.on('connection', ws=>ws.on('message', b=>{const q=JSON.parse(b);if(!q.id)return;
  let result={};
  if(q.method==='initialize'){ const lock=path.join(root,`.instance-lifecycle-${sessionsId}.lock`);lockObservations.push(require('node:child_process').spawnSync('flock',['-n',lock,'true']).status);result={codexHome:store}; }
  else if(q.method==='thread/read') {if(rejectRead){ws.send(JSON.stringify({id:q.id,error:{message:'unknown thread'}}));return;} result={thread:{id:threadId,source:'cli'}};}
  else if(q.method==='thread/queue/list')result={data:queue,nextCursor:null};
  else if(q.method==='thread/turns/list')result={data:history,nextCursor:null};
  else if(q.method==='thread/queue/add') {adds++; const item={id:'queue-'+adds,clientUserMessageId:q.params.clientUserMessageId,input:q.params.input};queue.push(item);onAdd?.();if(hold)return;if(drop){drop=false;ws.close();return;}result={queuedSubmission:item};}
  else {ws.send(JSON.stringify({id:q.id,error:{message:'unexpected method'}}));return;}
  ws.send(JSON.stringify({id:q.id,result}));
 }));
 await new Promise(r=>server.listen(socket,r));
 const options={store,stateDir:state,sessionsFile,wsModule:process.env.AOE_TEST_WS_MODULE,timeoutMs:1000};
 const packet={sessionId:sessionsId,threadId,deliveryId:'original-action-1',text:'Central agent: distinct background instruction.'};
 return {root,store,options,packet,queue,history,server,wss,lockObservations,get adds(){return adds},set drop(v){drop=v},set rejectRead(v){rejectRead=v},set hold(v){hold=v},set onAdd(v){onAdd=v},async close(){for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}};
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
  assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.adds,1);
  const crypto=require('node:crypto');const p={...f.packet,deliveryId:'stale-owner'};
  const lock=path.join(f.options.stateDir,crypto.createHash('sha256').update(p.deliveryId).digest('hex')+'.json.lock');fs.writeFileSync(lock,'retained');
  await assert.rejects(deliver(p,f.options),/locked/);assert.equal(f.adds,1);assert.equal(fs.readFileSync(lock,'utf8'),'retained');
 }finally{await f.close();}
});
test('no native submission is allowed without a durable journal and pre-send failures are safely retryable',async()=>{
 const f=await fixture();const original=process.env.NODE_OPTIONS;const fault=path.join(f.root,'fault.cjs');fs.writeFileSync(fault,`require('fs').fsyncSync=()=>{const e=Error('disk full');e.code='ENOSPC';throw e;};`);
 try {process.env.NODE_OPTIONS='--require '+fault;await assert.rejects(implementation().deliver(f.packet,f.options),/disk full/);assert.equal(f.adds,0);
  if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original;await implementation().deliver(f.packet,f.options);assert.equal(f.adds,1);
  const unavailable={...f.options,store:path.join(f.root,'missing-store')};fs.mkdirSync(unavailable.store);await assert.rejects(implementation().deliver({...f.packet,deliveryId:'missing-socket'},unavailable));assert.equal(f.adds,1);
 }finally{if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original;await f.close();}
});

test('the default embedded transport accepts stdin and reuses the original delivery ID', async()=>{
 const f=await fixture();try {
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e','const AOE_EMBEDDED_SOURCE='+JSON.stringify(fs.readFileSync(require.resolve('./codex-queue-send.cjs'),'utf8'))+';\n'+fs.readFileSync(require.resolve('./codex-queue-send.cjs'),'utf8').replace(/^#![^\n]*\n/,'')+'\nmodule.exports.main(process.argv.slice(1)).catch(e=>{console.error(e.message);process.exitCode=1;});','--','--packet','-','--state-dir',f.options.stateDir,'--store',f.store,'--sessions-file',f.options.sessionsFile,'--ws-module',f.options.wsModule],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>code?reject(Error(stderr)):resolve(JSON.parse(stdout)));child.stdin.end(JSON.stringify(f.packet));});
  assert.equal((await run()).disposition,'queued');assert.equal((await run()).disposition,'queued');assert.equal(f.adds,1);
 }finally{await f.close();}
});

test('standalone and embedded native RPC keep the exact lifecycle lock until acceptance',async()=>{
 const f=await fixture();try{await implementation().deliver(f.packet,f.options);assert.ok(f.lockObservations.length);assert.deepEqual(f.lockObservations,[1]);}finally{await f.close();}
});
test('an archive that owns the lifecycle lock prevents any standalone native submission',async()=>{
 const f=await fixture();const lock=path.join(f.root,`.instance-lifecycle-${sessionsId}.lock`);
 const holder=spawn('python3',['-c',"import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('LOCKED',flush=True); sys.stdin.read()",lock],{stdio:['pipe','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('error',reject);});await assert.rejects(implementation().deliver(f.packet,f.options),/lifecycle.*(locked|unavailable)/i);assert.equal(f.adds,0);}finally{holder.stdin.end();await new Promise(r=>holder.once('close',r));await f.close();}
});

test('an inherited but unlocked descriptor cannot authorize a standalone native submission',async()=>{
 const f=await fixture();const lock=path.join(f.root,`.instance-lifecycle-${sessionsId}.lock`),fd=fs.openSync(lock,'a');
 try{const child=spawn(process.execPath,['-e',`require(${JSON.stringify(require.resolve('./codex-queue-send.cjs'))}).workerMain().catch(e=>{console.error(e.message);process.exitCode=1;});`],{stdio:['pipe','pipe','pipe',fd,'ipc']});child.stdin.end(JSON.stringify({packet:f.packet,options:f.options}));let error='';child.stderr.on('data',b=>error+=b);const code=await new Promise(r=>child.once('close',r));assert.notEqual(code,0);assert.match(error,/exclusive ownership/);assert.equal(f.adds,0);}finally{fs.closeSync(fd);await f.close();}
});
test('a missing lifecycle launcher holds the original instruction without fallback',async()=>{
 const f=await fixture();const original=process.env.PATH;try{process.env.PATH='';await assert.rejects(implementation().deliver(f.packet,f.options),/launcher unavailable/);assert.equal(f.adds,0);process.env.PATH=original;await implementation().deliver(f.packet,f.options);assert.equal(f.adds,1);}finally{if(original===undefined)delete process.env.PATH;else process.env.PATH=original;await f.close();}
});
test('parent death closes the RPC worker and preserves ambiguous delivery until positive reconciliation',async()=>{
 const f=await fixture();f.hold=true;
 const staged=new Promise(r=>f.onAdd=r),closed=new Promise(r=>f.wss.once('connection',ws=>ws.once('close',r)));
 const child=spawn(process.execPath,[require.resolve('./codex-queue-send.cjs'),'--packet','-','--store',f.store,'--state-dir',f.options.stateDir,'--sessions-file',f.options.sessionsFile,'--ws-module',f.options.wsModule],{stdio:['pipe','pipe','pipe']});child.stdout.resume();child.stderr.resume();child.stdin.end(JSON.stringify(f.packet));
 try{await staged;const exited=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await exited;await closed;
  const file=path.join(f.options.stateDir,require('node:crypto').createHash('sha256').update(f.packet.deliveryId).digest('hex')+'.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).state,'sending');assert.ok(fs.existsSync(file+'.lock'),'abrupt worker exit retains ambiguous attempt');assert.equal(require('node:child_process').spawnSync('flock',['-n',path.join(f.root,`.instance-lifecycle-${sessionsId}.lock`),'true']).status,0);
  await assert.rejects(implementation().deliver(f.packet,f.options),/locked/);assert.equal(f.adds,1);
  // The fixture owns this stale lock and has established process exit; production never discards it automatically.
  fs.unlinkSync(file+'.lock');f.hold=false;await implementation().deliver(f.packet,f.options);assert.equal(f.adds,1);
 }finally{child.kill('SIGTERM');await f.close();}
});

const PNG_BYTES=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
function imagePacket(f,extra={}) { const input=path.join(f.root,'source.png');fs.writeFileSync(input,PNG_BYTES);return {...f.packet,images:[{path:input,sha256:require('node:crypto').createHash('sha256').update(PNG_BYTES).digest('hex')}],...extra}; }
test('image-only and mixed packets deliver exact retained bytes as typed localImage inputs',async()=>{
 const f=await fixture();try {const p=imagePacket(f,{text:''});const r=await implementation().deliver(p,f.options);assert.deepEqual(r.imageSha256,[p.images[0].sha256]);assert.equal(f.queue[0].input.length,1);const image=f.queue[0].input[0];assert.equal(image.type,'localImage');assert.notEqual(image.path,p.images[0].path);assert.deepEqual(fs.readFileSync(image.path),PNG_BYTES);assert.equal(fs.statSync(image.path).mode&0o777,0o400);
  await implementation().deliver({...p,deliveryId:'mixed-image',text:'Synthetic caption'},f.options);assert.deepEqual(f.queue[1].input.map(x=>x.type),['text','localImage']);assert.equal(f.queue[1].input[0].text,'Synthetic caption');assert.equal(f.adds,2);
 }finally{await f.close();}
});
test('lost image acknowledgments reconcile queue and history from retained bytes without a second add',async()=>{
 const f=await fixture();try{const p=imagePacket(f);f.drop=true;await assert.rejects(implementation().deliver(p,f.options));fs.unlinkSync(p.images[0].path);const r=await implementation().deliver(p,f.options);assert.deepEqual(r.imageSha256,[p.images[0].sha256]);assert.equal(f.adds,1);
  const second=imagePacket(f,{deliveryId:'image-history'});f.drop=true;await assert.rejects(implementation().deliver(second,f.options));const q=f.queue.pop();f.history.push({items:[{type:'userMessage',clientId:q.clientUserMessageId,content:q.input}]});fs.unlinkSync(second.images[0].path);assert.equal((await implementation().deliver(second,f.options)).disposition,'recorded');assert.equal(f.adds,2);
 }finally{await f.close();}
});
test('changed source image bytes and delivery-ID image swaps cannot replace the original instruction',async()=>{
 const f=await fixture();try{const p=imagePacket(f);await implementation().deliver(p,f.options);const other=path.join(f.root,'other.png');fs.writeFileSync(other,PNG_BYTES);await assert.rejects(implementation().deliver({...p,images:[{...p.images[0],path:other}]},f.options),/conflict/i);fs.writeFileSync(p.images[0].path,Buffer.from('changed'));await assert.rejects(implementation().deliver({...p,deliveryId:'changed-bytes'},f.options));assert.equal(f.adds,1);
  for(const images of [[{path:'relative.png',sha256:p.images[0].sha256}],[{path:other,sha256:'0'.repeat(64)}],Array(11).fill(p.images[0]),[{path:other}],{}])await assert.rejects(implementation().deliver({...p,deliveryId:'invalid-image',images},f.options));assert.equal(f.adds,1);
 }finally{await f.close();}
});
test('image reconciliation refuses path-only text and accepts exact inline history bytes',async()=>{
 const f=await fixture();try{const p=imagePacket(f);f.drop=true;await assert.rejects(implementation().deliver(p,f.options));const q=f.queue.pop();f.history.push({items:[{type:'userMessage',clientId:q.clientUserMessageId,content:q.input.map(x=>x.type==='localImage'?{type:'text',text:x.path}:x)}]});await assert.rejects(implementation().deliver(p,f.options),/conflict/i);assert.equal(f.adds,1);
  f.history[0].items[0].content=q.input.map(x=>x.type==='localImage'?{type:'image',url:'data:image/png;base64,'+PNG_BYTES.toString('base64')}:x);const r=await implementation().deliver(p,f.options);assert.equal(r.disposition,'recorded');assert.deepEqual(r.imageSha256,[p.images[0].sha256]);assert.equal(f.adds,1);
 }finally{await f.close();}
});
