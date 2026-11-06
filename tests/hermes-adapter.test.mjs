import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HermesAdapter } from '../server/adapters/hermes.mjs';

const bridgePath = fileURLToPath(new URL('./fixtures/mock-hermes.mjs', import.meta.url));
async function fixture(t, scenario = {}, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'relay-hermes-'));
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify(scenario));
  const adapter = new HermesAdapter({ hermesRoot: cwd, pythonCommand: process.execPath,
    bridgePath, requestTimeoutMs: 500, cancelTimeoutMs: 300, ...options });
  t.after(async () => { await adapter.close().catch(() => adapter.child?.kill('SIGKILL')); await rm(cwd, { recursive: true, force: true }); });
  const wire = async () => (await readFile(join(cwd, 'wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { adapter, cwd, wire };
}
async function started(t, scenario, options) {
  const f = await fixture(t, scenario, options);
  await f.adapter.connect();
  f.thread = await f.adapter.startThread({ workspace: f.cwd, permissionMode: 'read-only', tools: [] });
  return f;
}
const completion = adapter => new Promise(resolve => {
  const listener = event => { if (event.method === 'turn/completed') { adapter.off('notification', listener); resolve(event); } };
  adapter.on('notification', listener);
});

test('Hermes admits a stable run, reports actual terminal evidence and resumes the same scoped session', async t => {
  const { adapter, cwd, thread, wire } = await started(t);
  assert.match(thread.id, /^hermes:/);
  const notices = []; adapter.on('notification', event => notices.push(event));
  const done = completion(adapter);
  const turn = await adapter.startTurn({ threadId: thread.id, text: 'Read project', runId: 'run-1' });
  assert.equal(turn.id, 'admission-run-1');
  assert.equal((await done).params.turn.status, 'completed');
  assert.equal(notices.filter(event => event.method === 'turn/completed').length, 1);
  assert.ok(notices.some(event => event.method === 'item/completed' && event.params.item.text === 'Verified result'));
  assert.deepEqual(await adapter.resumeThread({ id: thread.id, workspace: cwd, permissionMode: 'read-only', tools: [] }), thread);
  const calls = await wire();
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(calls.find(call => call.method === 'turn/start').params.runId, 'run-1');
});

test('Hermes rejects writes, custom tools, missing run identity and foreign ownership before submission', async t => {
  const { adapter, cwd, thread, wire } = await started(t);
  await assert.rejects(adapter.startThread({ workspace: cwd, permissionMode: 'workspace-write' }), /read-only/);
  await assert.rejects(adapter.startThread({ workspace: cwd, tools: [{}] }), /tools/);
  await assert.rejects(adapter.startTurn({ threadId: thread.id, text: 'Read' }), /run/);
  await assert.rejects(adapter.startTurn({ threadId: 'hermes:foreign', text: 'Read', runId: 'r' }), /owned|Resume/);
  assert.equal((await wire()).filter(call => call.method === 'turn/start').length, 0);
});

test('admission does not complete work, and cancellation requires the exact owned terminal receipt', async t => {
  const { adapter, thread } = await started(t, {pending:true});
  const events=[]; adapter.on('notification', event=>events.push(event));
  const turn=await adapter.startTurn({threadId:thread.id,text:'Wait',runId:'held'});
  assert.equal(events.filter(event=>event.method==='turn/completed').length,0);
  await assert.rejects(adapter.startTurn({threadId:thread.id,text:'Duplicate',runId:'different'}),/unfinished/);
  await assert.rejects(adapter.interrupt({threadId:thread.id,turnId:'other-admission'}),/exact owned/);
  await adapter.interrupt({threadId:thread.id,turnId:turn.id});
  assert.equal(events.filter(event=>event.method==='turn/completed').length,1);
  assert.equal(events.at(-1).params.turn.status,'interrupted');
});

test('different projects run concurrently and stale or foreign events cannot settle another run', async t => {
  const {adapter,cwd,thread}=await started(t,{pending:true});
  const second=await adapter.startThread({workspace:cwd,tools:[]});
  const [one,two]=await Promise.all([
    adapter.startTurn({threadId:thread.id,text:'One',runId:'one'}),
    adapter.startTurn({threadId:second.id,text:'Two',runId:'two'})]);
  adapter.notification({method:'turn/completed',params:{threadId:thread.id,runId:'two',turn:{id:two.id,status:'completed'}}});
  adapter.notification({method:'turn/completed',params:{threadId:thread.id,runId:'one',turn:{id:'older',status:'completed'}}});
  assert.equal(adapter.runs.size,2);
  await adapter.interrupt({threadId:thread.id,turnId:one.id});
  assert.equal(adapter.runs.size,1);
  await adapter.interrupt({threadId:second.id,turnId:two.id});
});

test('lost acknowledgment remains uncertain and read-only recovery never resubmits', async t => {
  const {adapter,thread,wire}=await started(t,{lostAck:true},{requestTimeoutMs:75});
  await assert.rejects(adapter.startTurn({threadId:thread.id,text:'private prompt',runId:'lost'}),error=>{
    assert.equal(error.uncertain,true); assert.equal(error.runId,'lost');
    assert.equal(error.turnId,'admission-lost'); assert.equal(error.text,undefined); return true;
  });
  const result=await adapter.recover({threadId:thread.id,runId:'lost'});
  assert.equal(result.state,'completed'); assert.equal(result.result,'Recovered result');
  await assert.rejects(adapter.startTurn({threadId:thread.id,text:'Replay',runId:'lost'}),/already submitted/);
  assert.equal((await wire()).filter(call=>call.method==='turn/start').length,1);
});

test('same-process lost acknowledgment can reattach, recover and stop without submitting twice', async t=>{
  const {adapter,cwd,thread,wire}=await started(t,{lostAck:true,recovery:'running'},{requestTimeoutMs:75});
  await assert.rejects(adapter.startTurn({threadId:thread.id,text:'Read',runId:'reattach'}),error=>error.uncertain===true);
  assert.deepEqual(await adapter.resumeThread({id:thread.id,workspace:cwd,permissionMode:'read-only',tools:[]}),thread);
  await assert.rejects(adapter.resumeThread({id:thread.id,workspace:'/other',permissionMode:'read-only'}),/scope/);
  const recovered=await adapter.recover({threadId:thread.id,runId:'reattach'});
  await adapter.interrupt({threadId:thread.id,turnId:recovered.turnId});
  assert.equal(adapter.runs.size,0);
  assert.equal((await wire()).filter(call=>call.method==='turn/start').length,1);
});

test('unconfirmed cancellation retains the remote work slot and fails close honestly', async t => {
  const {adapter,thread}=await started(t,{pending:true,cancelUnknown:true});
  const turn=await adapter.startTurn({threadId:thread.id,text:'Wait',runId:'unknown'});
  await assert.rejects(adapter.interrupt({threadId:thread.id,turnId:turn.id}),error=>error.uncertain===true);
  assert.equal(adapter.runs.size,1);
  await assert.rejects(adapter.close(),error=>error.uncertain===true);
  assert.ok(adapter.child);
});

test('a confirmed completion racing cancellation is preserved rather than replaced by cancellation failure',async t=>{
  const {adapter,thread}=await started(t,{pending:true,finishDuringCancel:true});
  const turn=await adapter.startTurn({threadId:thread.id,text:'Read',runId:'race'});
  const done=completion(adapter);
  await adapter.interrupt({threadId:thread.id,turnId:turn.id});
  assert.equal((await done).params.turn.status,'completed');
  assert.equal(adapter.runs.size,0);
});

for(const scenario of ['malformed','oversize','exit']) test(`Hermes ${scenario} transport never becomes completion or exposes native diagnostics`,async t=>{
  const {adapter,thread}=await started(t,{[scenario]:true});
  const events=[]; adapter.on('notification',event=>events.push(event));
  await assert.rejects(adapter.startTurn({threadId:thread.id,text:'Read',runId:scenario}),error=>{
    assert.equal(error.uncertain,true); assert.doesNotMatch(error.message,/private token/); return true;
  });
  assert.equal(events.filter(event=>event.method==='turn/completed').length,0);
  await assert.rejects(adapter.close(),error=>error.uncertain===true);
});

test('unqualified version and mismatched scope fail before inference', async t=>{
  const wrong=await fixture(t,{version:'0.24.0'});
  await assert.rejects(wrong.adapter.connect(),/version|scope/);
  const scope=await fixture(t,{scopeMismatch:true});
  await scope.adapter.connect();
  await assert.rejects(scope.adapter.startThread({workspace:scope.cwd}),/scope/);
  assert.equal((await scope.wire()).some(call=>call.method==='turn/start'),false);
});

test('session-open timeout cannot imply a remotely running prompt',async t=>{
  const {adapter,cwd,wire}=await fixture(t,{openTimeout:true},{requestTimeoutMs:75});
  await adapter.connect();
  await assert.rejects(adapter.startThread({workspace:cwd}),error=>error.uncertain===false);
  assert.equal(adapter.runs.size,0);
  assert.equal((await wire()).some(call=>call.method==='turn/start'),false);
});

test('recovered running receipt can be stopped after a fresh adapter connection',async t=>{
  const {adapter,wire}=await fixture(t,{recovery:'running'});
  await adapter.connect();
  const receipt=await adapter.recover({threadId:'hermes:local-persisted',runId:'saved'});
  assert.equal(receipt.state,'running');
  await adapter.close();
  const calls=await wire();
  assert.equal(calls.some(call=>call.method==='turn/start'),false);
  assert.equal(calls.find(call=>call.method==='turn/interrupt').params.turnId,'admission-saved');
});

test('unknown recovery after a fresh connection retains ownership and cannot become confirmed shutdown',async t=>{
  const {adapter,wire}=await fixture(t,{recovery:'unknown',cancelUnknown:true});
  await adapter.connect();
  const recovered=await adapter.recover({threadId:'hermes:local-persisted',runId:'uncertain'});
  assert.equal(recovered.state,'unknown'); assert.equal(adapter.runs.size,1);
  await assert.rejects(adapter.close(),error=>error.uncertain===true);
  assert.equal((await wire()).some(call=>call.method==='close'),false);
});

for(const state of ['running','completed','unknown']) test(`stale ${state} recovery for A cannot replace or delete newly admitted B`,async t=>{
  const {adapter,thread}=await started(t,{pending:true});
  const first=await adapter.startTurn({threadId:thread.id,text:'First',runId:'run-a'});
  const request=adapter.request.bind(adapter);let release;
  adapter.request=(method,params,...rest)=>method==='turn/recover'
    ? new Promise(resolve=>{release=resolve;}) : request(method,params,...rest);
  const checking=adapter.recover({threadId:thread.id,runId:'run-a',turnId:first.id});
  adapter.notification({method:'turn/completed',params:{threadId:thread.id,runId:'run-a',turn:{id:first.id,status:'completed'}}});
  const second=await adapter.startTurn({threadId:thread.id,text:'Second',runId:'run-b'});
  const owner=adapter.runs.get(thread.id);
  release({state,threadId:thread.id,runId:'run-a',turnId:first.id,result:'Old result'});
  await checking;
  assert.equal(adapter.runs.get(thread.id),owner);
  assert.equal(owner.runId,'run-b'); assert.equal(owner.turnId,second.id);
});

test('stale running receipt cannot resurrect an observed terminal admission',async t=>{
  const {adapter,thread}=await started(t,{pending:true});
  const first=await adapter.startTurn({threadId:thread.id,text:'First',runId:'settled-a'});
  const request=adapter.request.bind(adapter);let release;
  adapter.request=(method,params,...rest)=>method==='turn/recover'
    ? new Promise(resolve=>{release=resolve;}) : request(method,params,...rest);
  const checking=adapter.recover({threadId:thread.id,runId:'settled-a',turnId:first.id});
  adapter.notification({method:'turn/completed',params:{threadId:thread.id,runId:'settled-a',turn:{id:first.id,status:'completed'}}});
  release({state:'running',threadId:thread.id,runId:'settled-a',turnId:first.id});
  await checking;
  assert.equal(adapter.runs.has(thread.id),false);
});

test('fresh recovery reserves ownership before a receipt and terminal notification arrive in the same batch',async t=>{
  const {adapter,thread}=await started(t,{pending:true});
  const request=adapter.request.bind(adapter);let release;
  adapter.request=(method,params,...rest)=>method==='turn/recover'
    ? new Promise(resolve=>{release=resolve;}) : request(method,params,...rest);
  const events=[];adapter.on('notification',event=>events.push(event));
  const checking=adapter.recover({threadId:thread.id,runId:'saved-batch'});
  release({state:'running',threadId:thread.id,runId:'saved-batch',turnId:'saved-admission'});
  adapter.notification({method:'turn/completed',params:{threadId:thread.id,runId:'saved-batch',turn:{id:'saved-admission',status:'completed'}}});
  await checking;
  assert.equal(events.filter(event=>event.method==='turn/completed').length,1);
  assert.equal(adapter.runs.has(thread.id),false);
});

test('concurrent fresh recovery retains terminal ownership against an older running receipt',async t=>{
  const {adapter,thread}=await started(t,{pending:true});
  const request=adapter.request.bind(adapter), releases=[];
  adapter.request=(method,params,...rest)=>method==='turn/recover'
    ? new Promise(resolve=>{releases.push(resolve);}) : request(method,params,...rest);
  const old=adapter.recover({threadId:thread.id,runId:'saved-concurrent'});
  const fresh=adapter.recover({threadId:thread.id,runId:'saved-concurrent'});
  releases[1]({state:'completed',threadId:thread.id,runId:'saved-concurrent',turnId:'saved-admission'});
  await fresh;
  releases[0]({state:'running',threadId:thread.id,runId:'saved-concurrent',turnId:'saved-admission'});
  await old;
  assert.equal(adapter.runs.has(thread.id),false);
});

test('native bridge validates frozen policy, exact receipts and read-only lost-ACK correlation without native services', t=>{
  const python=[process.env.RELAY_TEST_PYTHON,'python3',join(homedir(),'.hermes','hermes-agent','venv','bin','python')].filter(Boolean)
    .find(command=>spawnSync(command,['-c','import sys; assert sys.version_info >= (3, 10)'],{stdio:'ignore',timeout:3000}).status===0);
  if(!python){t.skip('Python 3.10+ is unavailable; bridge fixture requires the Python standard library.');return;}
  const source=String.raw`
import asyncio, copy, hashlib, importlib.util, json, pathlib
spec=importlib.util.spec_from_file_location('bridge', 'server/hermes-bridge.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
b=m.Bridge('/fixture/hermes','/fixture/node')
root='/fixture/project'; sid='local-fixture'; admission='admission-1'
fingerprint=hashlib.sha256(json.dumps(b.editor(root)['mcp_servers'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
info={'version':'0.23.0','enabled_toolsets':['mcp-editor_vamfi_relay_project_0123abcd'],
 'launch_request':{'source':'acp','cwd':root,'ignore_rules':True,'toolsets':['no_mcp'],'max_turns':6,
 'editor':{'edit_approval_policy':'ask','mcp_servers':{'fingerprint':fingerprint}}}}
b.validate_scope(info,root)
wrapped=copy.deepcopy(info);wrapped['tools']={'gateway':['tool_search','tool_describe','tool_call']}
b.validate_scope(wrapped,root)
for change in ('version','toolset','fingerprint','extraTool','ignoreRules'):
 altered=copy.deepcopy(info)
 if change=='version':altered['version']='0.24.0'
 if change=='toolset':altered['enabled_toolsets'].append('terminal')
 if change=='fingerprint':altered['launch_request']['editor']['mcp_servers']['fingerprint']='wrong'
 if change=='extraTool':altered['tools']={'unsafe':['terminal']}
 if change=='ignoreRules':altered['launch_request']['ignore_rules']=False
 try:b.validate_scope(altered,root);raise AssertionError(change)
 except m.Rejected:pass

class Client:
 def __init__(self):
  self.calls=[];self.mode='settled';self.receipt_sid=sid
  self.gate=None;self.entered=None;self.wait_method=None;self.status='terminal'
 async def rpc(self,method,**p):
  self.calls.append(method)
  if method==self.wait_method:self.entered.set();await self.gate
  if method=='session.info':return copy.deepcopy(info)
  if method=='session.resume':return {'info':copy.deepcopy(info),'pending':[], 'messages':[
   {'role':'user','message_id':'unrelated','display_metadata':{'submission_id':'other'}},
   *([{'role':'user','message_id':admission,'display_metadata':{'submission_id':'saved','gateway_input_owner':'private'}}] if self.mode!='absent' else [])]}
  if method=='prompt.receipt':return {'ref':{'session_id':self.receipt_sid},'admission_id':admission,
   'status':self.status,'outcome':'completed','result':{'completed':True,'final_response':'exact result'}}
  raise AssertionError(method)

async def run():
 client=Client();b.client=client
 got=await b.recover({'threadId':'hermes:'+sid,'runId':'saved'})
 assert got=={'state':'completed','threadId':'hermes:'+sid,'runId':'saved','turnId':admission,'result':'exact result'}
 assert 'prompt.submit' not in client.calls
 client.mode='absent'
 got=await b.recover({'threadId':'hermes:'+sid,'runId':'missing'})
 assert got['state']=='unknown' and sid in b.runs
 try:await b.dispatch('close',{});raise AssertionError('unknown close')
 except m.Rejected as e:assert e.uncertain
 b.runs.clear();client.receipt_sid='local-other'
 try:await b.receipt(sid,admission);raise AssertionError('foreign receipt')
 except m.Rejected as e:assert e.uncertain
 assert 'prompt.submit' not in client.calls
 assert b.receipt_state({'admission_id':admission,'status':'terminal','outcome':'completed','result':{'completed':False}},admission)=='unknown'
 assert b.receipt_state({'admission_id':admission,'status':'terminal','outcome':'cancelled'},admission)=='interrupted'
 assert b.receipt_state({'admission_id':admission,'status':'terminal','outcome':'completed','result':{'failed':True}},admission)=='failed'
 # Only matching admission/generation text and tool events leave the native bridge.
 client.events=asyncio.Queue();b.runs[sid]={'sid':sid,'run_id':'saved','admission':admission,
  'generation':2,'seq':-1,'epoch':None,'done':False}
 emitted=[];m.send=emitted.append
 consumer=asyncio.create_task(b.events())
 def event(kind,seq,**changes):
  return {'method':'event','params':{'session_id':sid,'admission_id':admission,'execution_generation':2,
   'type':kind,'seq':seq,'replay_epoch':'epoch','payload':{'text':'visible'},**changes}}
 for frame in [event('reasoning.delta',1),event('session.info',2),event('message.delta',3,session_id='local-other'),
   event('message.delta',4,execution_generation=1),event('message.delta',5),event('message.delta',5),
   event('tool.start',6,payload={'tool_id':'tool-1','name':'tool_call','args':{'name':'read_file'}}),
   event('tool.complete',7,payload={'tool_id':'tool-1','name':'tool_call','result':{'text':'fixture'}})]:
  client.events.put_nowait(frame)
 await asyncio.sleep(0);consumer.cancel()
 await asyncio.gather(consumer,return_exceptions=True)
 assert len(emitted)==3
 assert [item['params']['method'] for item in emitted]==['item/agentMessage/delta','item/completed','item/completed']
 assert emitted[-1]['params']['params']['item']['output']=='{"text": "fixture"}'
 # A monitor's terminal settlement must win over stale recovery snapshots and receipts.
 for wait_method,status,mode in [('prompt.receipt','started','settled'),('prompt.receipt','terminal','settled'),
                                  ('session.resume','terminal','absent')]:
  for newer in (False,True):
   client.receipt_sid=sid;client.mode=mode;client.status=status;client.wait_method=wait_method
   client.entered=asyncio.Event();client.gate=asyncio.get_running_loop().create_future()
   old={'sid':sid,'run_id':'saved','admission':admission,'generation':2,'seq':-1,'epoch':None,'done':False}
   b.runs[sid]=old
   checking=asyncio.create_task(b.recover({'threadId':'hermes:'+sid,'runId':'saved'}))
   await client.entered.wait()
   b.settled(old,'completed',{'result':{'final_response':'terminal first'}})
   replacement={'sid':sid,'run_id':'newer','admission':'admission-newer','done':False}
   if newer:b.runs[sid]=replacement
   client.gate.set_result(None);await checking
   assert b.runs.get(sid) is (replacement if newer else None)
 b.runs.clear()
asyncio.run(run())
print('bridge-policy-and-recovery-passed')
`;
  const result=spawnSync(python,['-B','-c',source],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:5000,maxBuffer:128*1024});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'bridge-policy-and-recovery-passed');
});
