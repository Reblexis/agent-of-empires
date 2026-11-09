const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn, execFile, execFileSync} = require('node:child_process');
const run = require('node:util').promisify(execFile);
const {once} = require('node:events');
const wsModule = require(process.env.AOE_TEST_WS_MODULE);
const wsServer = wsModule.wsServer || wsModule.WebSocketServer;
const binary = process.argv[2];
const release = process.argv[3] === 'release';
const sid = '1111111111111111';
const tid = '11111111-1111-4111-8111-111111111111';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = fs.mkdtempSync('/dev/shm/aqh-');
const xdg = path.join(root,'config');
const app = path.join(xdg,release?'agent-of-empires':'agent-of-empires-dev');
const profile = path.join(app,'profiles/default');
const native = path.join(root,'native');
const project = path.join(root,'project');
const tmux = path.join(root,'tmux.sock');
const storeSocket = path.join(native,'app-server-control/app-server-control.sock');
const name = `${release?'aoe_':'aoe_dev_'}Synthetic_11111111`;
let child, keeper, wss, rpc;
let drop = false;
const queue = [];
const history = [];
let adds = 0;
const receipts = [];
const env = {PATH:'/usr/bin:/bin',HOME:root,XDG_CONFIG_HOME:xdg,XDG_DATA_HOME:path.join(root,'share'),TMPDIR:root,TMUX_TMPDIR:root,AOE_TMUX_SOCKET:tmux,DO_NOT_TRACK:'1',AOE_LOG_LEVEL:'warn',GIT_CONFIG_GLOBAL:path.join(root,'.gitconfig'),GIT_CONFIG_SYSTEM:'/dev/null',AOE_CODEX_QUEUE_STATE_DIR:path.join(root,'journal'),AOE_CODEX_WS_MODULE:process.env.AOE_TEST_WS_MODULE};
if (process.env.AOE_TEST_QUEUE_HELPER) env.AOE_CODEX_QUEUE_HELPER=process.env.AOE_TEST_QUEUE_HELPER;
async function until(predicate, description, timeout=15000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}
 throw new Error(`Timeout: ${description}`);
}
(async()=>{
 try {
  for(const p of [profile,project,path.dirname(storeSocket),env.XDG_DATA_HOME])fs.mkdirSync(p,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(app,'config.toml'),'[app_state]\nhas_acknowledged_agent_hooks=true\n[systemd]\nenabled=false\n');
  fs.writeFileSync(path.join(profile,'config.toml'),`[session.agent_config_dir]\ncodex=${JSON.stringify(native)}\n`);
  fs.writeFileSync(path.join(profile,'sessions.json'),JSON.stringify([{id:sid,title:'Synthetic',project_path:project,tool:'codex',status:'running',created_at:'2026-01-01T00:00:00Z',agent_session_id:tid,resume_probe_failed_sid:tid}]));
  fs.writeFileSync(path.join(app,'inbox-router'),sid+'\n');
  fs.writeFileSync(path.join(app,'inbox.key'),'synthetic-fixture-key',{mode:0o600});
  const editorFile=path.join(root,'editor.json');
  const editorScript=path.join(root,'editor.cjs');
  fs.writeFileSync(editorScript,`const fs=require('fs');const s={draft:'',submitted:[]};process.stdin.setRawMode(true);process.stdin.on('data',b=>{for(const c of b.toString()){if(c==='\\r'||c==='\\n'){s.submitted.push(s.draft);s.draft='';}else s.draft+=c;}fs.writeFileSync(${JSON.stringify(editorFile)},JSON.stringify(s));});console.log('EDITOR READY');`);
  execFileSync('tmux',['-S',tmux,'new-session','-d','-s',name,`/usr/bin/node ${editorScript}`],{env});
  execFileSync('tmux',['-S',tmux,'set-environment','-t',name,'AOE_INSTANCE_ID',sid],{env});
  await until(()=>execFileSync('tmux',['-S',tmux,'capture-pane','-p','-t',name],{env}).includes('EDITOR READY'),'synthetic editor ready');
  execFileSync('tmux',['-S',tmux,'send-keys','-t',name,'-l','--','Unfinished human question'],{env});
  await until(()=>fs.existsSync(editorFile),'editor state');
  // Retain only the isolated fixture's startup-recovery lock. No real owner can be resumed.
  keeper=spawn('python3',['-c',"import fcntl,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('LOCKED',flush=True); time.sleep(300)",path.join(app,'.recovery.lock')],{env,stdio:['ignore','pipe','pipe']});
  await once(keeper.stdout,'data');
  rpc=http.createServer();wss=new wsServer({server:rpc});
  wss.on('connection',ws=>ws.on('message',raw=>{
   const q=JSON.parse(raw);if(!q.id)return;let result;
   if(q.method==='initialize')result={codexHome:native};
   else if(q.method==='thread/read')result={thread:{id:tid,source:'cli'}};
   else if(q.method==='thread/queue/list')result={data:queue,nextCursor:null};
   else if(q.method==='thread/turns/list')result={data:history,nextCursor:null};
   else if(q.method==='thread/queue/add'){
    const item={id:'fixture-'+(++adds),clientUserMessageId:q.params.clientUserMessageId,input:q.params.input};queue.push(item);result={queuedSubmission:item};
    if(drop){drop=false;ws.close();return;}
   } else {ws.send(JSON.stringify({id:q.id,error:{message:'unsupported fixture method'}}));return;}
   ws.send(JSON.stringify({id:q.id,result}));
  }));
  await new Promise(r=>rpc.listen(storeSocket,r));
  const portServer=http.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const log=fs.openSync(path.join(root,'server.log'),'w');
  child=spawn(binary,['serve','--host','127.0.0.1','--port',String(port),'--no-auth'],{env,stdio:['ignore',log,log]});fs.closeSync(log);
  const base='http://127.0.0.1:'+port;
  await until(async()=>{if(child.exitCode!==null)throw new Error('Fixture daemon exited: '+fs.readFileSync(path.join(root,'server.log'),'utf8').slice(-3000));try{return(await fetch(base+'/api/sessions')).ok;}catch{return false;}},'isolated HTTP bind',30000);
  async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(route.startsWith('/api/inbox/')?{Authorization:'Bearer synthetic-fixture-key'}:{})},body:JSON.stringify(body)});const raw=await r.text();let j;try{j=JSON.parse(raw);}catch{j={message:raw};}receipts.push({route,status:r.status,queued:j.queued,recorded:j.recorded,images:j.images});return {status:r.status,json:j};}
  const beforePin=queue.length;
  const wrongPin=await post('/api/inbox/message',{text:'Pinned instruction',delivery_id:'fixture:pinned:1',expected_owner:'2222222222222222',images:[{data:png.toString('base64')}]});
  assert.equal(wrongPin.status,503,'an owner change after caller binding must hold before queueing');assert.equal(wrongPin.json.error.code,'owner_mismatch');assert.equal(queue.length,beforePin);assert.equal(fs.existsSync(path.join(project,'.aoe-pasted-images')),false,'owner mismatch must not stage attachments');
  for(const expected_owner of ['',null,7,'invalid-owner','AAAAAAAAAAAAAAAA','11111111111111111'])assert.equal((await post('/api/inbox/message',{text:'Malformed pinned instruction',delivery_id:'fixture:invalid-pin',expected_owner,images:[]})).status,422,'a supplied malformed owner pin is never ignored');
  const missing=await post('/api/inbox/message',{text:'Background instruction',images:[]});assert.equal(missing.status,503,'missing original ID must hold');assert.equal(queue.length,0);
  const body={text:'Background image instruction',delivery_id:'fixture:source:1',expected_owner:sid,images:[{data:png.toString('base64')}]};
  const first=await post('/api/inbox/message',body);assert.equal(first.status,200);assert.equal(first.json.queued,true);assert.equal(first.json.images,1);assert.equal(queue.length,1);
  const image=queue[0].input.find(x=>x.type==='localImage');assert.ok(image);assert.equal(sha(fs.readFileSync(image.path)),sha(png));assert.equal(fs.statSync(image.path).mode&0o777,0o400);assert.equal(queue[0].clientUserMessageId,body.delivery_id);
  const repeat=await post('/api/inbox/message',body);assert.equal(repeat.status,200);assert.equal(queue.length,1,'confirmed retry never adds');
  const conflict=await post('/api/inbox/message',{...body,text:'Changed instruction'});assert.equal(conflict.status,503);assert.equal(queue.length,1);
  drop=true;const lost={...body,delivery_id:'fixture:source:2'};assert.equal((await post('/api/inbox/message',lost)).status,503);assert.equal(queue.length,2);assert.equal((await post('/api/inbox/message',lost)).status,200);assert.equal(queue.length,2,'lost acknowledgment reconciles exact original');
  drop=true;const historic={...body,delivery_id:'fixture:source:3'};assert.equal((await post('/api/inbox/message',historic)).status,503);const consumed=queue.pop();history.push({items:[{type:'userMessage',clientId:consumed.clientUserMessageId,content:consumed.input}]});const beforeRecorded=adds;const recorded=await post('/api/inbox/message',historic);assert.equal(recorded.status,200);assert.equal(recorded.json.recorded,true);assert.equal(recorded.json.queued,false);assert.equal(adds,beforeRecorded);assert.equal(queue.length,2);
  assert.equal((await post(`/api/sessions/${sid}/send`,{message:'Ordinary automated input',revive:false})).status,409);assert.equal(queue.length,2);
  const apiBody={message:'Ordinary automated input',revive:false,delivery_id:'fixture:api:1'};
  assert.equal((await post(`/api/sessions/${sid}/send`,apiBody)).json.queued,true);assert.equal((await post(`/api/sessions/${sid}/send`,apiBody)).status,200);assert.equal(queue.length,3);
  await assert.rejects(run(binary,['send',sid,'CLI automated input','--no-revive'],{env}));assert.equal(queue.length,3);
  const cli=['send',sid,'CLI automated input','--no-revive','--delivery-id','fixture:cli:1'];
  assert.match((await run(binary,cli,{env})).stdout,/queued/);await run(binary,cli,{env});assert.equal(queue.length,4);
  const imageOnly=await post('/api/inbox/message',{text:'',delivery_id:'fixture:image-only:1',images:body.images});assert.equal(imageOnly.status,200);assert.equal(imageOnly.json.queued,true);assert.equal(queue.length,5);assert.ok(queue[4].input.some(x=>x.type==='localImage'));
  assert.deepEqual(JSON.parse(fs.readFileSync(editorFile)),{draft:'Unfinished human question',submitted:[]});
  const receipt={result:'passed',candidateSha256:sha(fs.readFileSync(binary)),adds,queueItems:queue.length,recordedItems:history.length,imageSha256:sha(png),receipts,draftUntouched:true,modelCalls:0,realOwnersTouched:0,fixtureRoot:root};
  fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
 } finally {
  if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  if(keeper&&keeper.exitCode===null){keeper.kill('SIGTERM');await once(keeper,'exit');}
  if(wss){for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r));}
  if(rpc)await new Promise(r=>rpc.close(r));
  try{execFileSync('tmux',['-S',tmux,'kill-server'],{env});}catch{}
 }
})().catch(e=>{console.error(e.stack);console.error('Retained fixture: '+root);process.exitCode=1;});
