import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
async function waitFor(predicate) {
  const deadline=Date.now()+2000;
  while(!predicate()) {
    if(Date.now()>deadline)throw new Error('Fixture did not reach the expected state.');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
class FakeAdapter extends EventEmitter {
  starts=[];turns=[];resumes=[];responses=[];interrupts=[];
  async connect(){return{version:'fixture'};}
  async startThread(params){this.starts.push(params);return{id:`thread-${this.starts.length}`};}
  async resumeThread(params){this.resumes.push(params);return{id:params.id};}
  async startTurn(params){const turn={...params,id:`turn-${this.turns.length+1}`};this.turns.push(turn);this.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn:{id:turn.id}}});return{id:turn.id};}
  async interrupt(params){this.interrupts.push(params);this.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}});}
  respond(requestId,result){this.responses.push({requestId,result});}
  async close(){}
  complete(threadId,text='Verified result') {
    const turn=this.turns.findLast(t=>t.threadId===threadId);
    this.emit('notification',{method:'item/completed',params:{threadId,turnId:turn.id,item:{id:`message-${turn.id}`,type:'agentMessage',phase:'final_answer',text}}});
    this.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turn.id,status:'completed'}}});
  }
}
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'relay-test-'));const store=new Store(dir,dir);const adapter=new FakeAdapter();const runtime=new Runtime(store,adapter);
  t.after(async()=>{await runtime.close();store.close();await rm(dir,{recursive:true,force:true});});
  await runtime.connect();return{dir,store,adapter,runtime};
}
async function writableProjectRun(runtime,store) {
  const projectId=store.state.settings.defaultProjectId;
  runtime.updateProject(projectId,{permissionMode:'workspace-write'});
  const work=runtime.board.createWork({projectId,title:'Apply the accepted fixture change',objective:'Edit the bounded fixture and verify the result.'});
  const {taskId}=runtime.startProject(work.id,'Apply the accepted fixture change.');
  await waitFor(()=>store.state.tasks.find(task=>task.id===taskId)?.turnId);
  return store.state.tasks.find(task=>task.id===taskId);
}

test('one main conversation persists across turns and a reconnect',async t=>{
  const {store,adapter,runtime}=await fixture(t);
  await runtime.chat('First request');await tick();adapter.complete('thread-1');
  await runtime.chat('Second request');await tick();adapter.complete('thread-1');
  assert.equal(adapter.starts.length,1);assert.equal(store.state.tasks.filter(t=>t.status==='completed').length,2);
  adapter.emit('disconnect',{message:'fixture disconnected'});await runtime.connect();
  await runtime.chat('Third request');await tick();assert.equal(adapter.resumes.length,1);assert.equal(adapter.resumes[0].id,'thread-1');
});

test('overlapping main requests are rejected instead of racing thread creation',async t=>{
  const {runtime,adapter}=await fixture(t);
  const a=runtime.chat('One');await assert.rejects(runtime.chat('Two'),e=>e.statusCode===409);await a;
  await assert.rejects(runtime.chat('Three'),e=>e.statusCode===409);assert.equal(adapter.starts.length,1);
});

test('delegation executes a separate read-only thread and returns observed result',async t=>{
  const {runtime,store,adapter}=await fixture(t);
  const {taskId}=await runtime.chat('Delegate a bounded review');await tick();
  const parent=store.state.tasks.find(t=>t.id===taskId);
  const result=runtime.delegate(parent,{title:'Reviewer',instructions:'Inspect README'});
  await waitFor(()=>store.state.tasks.some(task=>task.kind==='worker' && task.turnId));
  assert.equal(adapter.starts[1].permissionMode,'read-only');assert.deepEqual(adapter.starts[1].tools,[]);
  adapter.complete('thread-2','README reviewed');const done=await result;
  assert.equal(done.result,'README reviewed');assert.equal(done.status,'completed');assert.equal(done.parentTaskId,taskId);
});

test('worker capacity is reserved before asynchronous startup and cancellation reaches children',async t=>{
  const {runtime,store,adapter}=await fixture(t);store.state.settings.maxWorkers=1;
  const {taskId}=await runtime.chat('Delegate');await tick();const parent=store.state.tasks.find(t=>t.id===taskId);
  const first=runtime.delegate(parent,{title:'One',instructions:'Read README'});
  await assert.rejects(runtime.delegate(parent,{title:'Two',instructions:'Read README'}),e=>e.statusCode===409);
  await waitFor(()=>store.state.tasks.some(task=>task.kind==='worker' && task.turnId));
  await runtime.cancel(taskId);await first;
  assert.equal(store.state.tasks.every(t=>t.status==='cancelled'),true);assert.equal(adapter.interrupts.length,2);
});

test('read-only approvals are denied; writable approvals are one-time and expire on disconnect',async t=>{
  const {runtime,store,adapter}=await fixture(t);
  runtime.updateProject(store.state.settings.defaultProjectId,{permissionMode:'workspace-write'});
  await runtime.chat('Inspect');await tick();
  const request={id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'example',availableDecisions:['accept','decline']}};
  await runtime.request(request);assert.equal(adapter.responses[0].result.decision,'decline');assert.equal(store.state.approvals.length,0);
  assert.equal(adapter.starts[0].permissionMode,'read-only');
  adapter.complete('thread-1');const run=await writableProjectRun(runtime,store);
  request.id=2;request.params.threadId=run.threadId;request.params.turnId=run.turnId;await runtime.request(request);
  const approval=store.state.approvals[0];assert.equal(approval.status,'pending');
  adapter.emit('disconnect',{message:'Provider went away'});
  assert.equal(store.state.approvals[0].status,'expired');await assert.rejects(runtime.approve(approval.id,'accept'),e=>e.statusCode===409);
});

test('server-resolved approvals expire and reject later decisions without responding',async t=>{
  const {runtime,store,adapter}=await fixture(t);
  const run=await writableProjectRun(runtime,store);
  await runtime.request({id:101,method:'item/commandExecution/requestApproval',params:{threadId:run.threadId,turnId:run.turnId,command:'fixture',availableDecisions:['accept','decline']}});
  const approvalId=store.state.approvals[0].id;
  adapter.emit('notification',{method:'serverRequest/resolved',params:{threadId:run.threadId,requestId:101}});
  assert.equal(store.state.approvals[0].status,'expired');
  assert.equal(store.state.tasks.find(task=>task.id===run.id).status,'running');assert.equal(runtime.pending.size,0);
  for(const decision of ['accept','decline'])await assert.rejects(runtime.approve(approvalId,decision),e=>e.statusCode===409);
  assert.equal(adapter.responses.length,0);
});

test('resolving an approval preserves other pending decisions and handles duplicate resolutions',async t=>{
  const {runtime,store,adapter}=await fixture(t);
  const run=await writableProjectRun(runtime,store);
  for(const requestId of ['first','second'])await runtime.request({id:requestId,method:'item/fileChange/requestApproval',params:{threadId:run.threadId,turnId:run.turnId,reason:'Fixture change'}});
  adapter.emit('notification',{method:'serverRequest/resolved',params:{threadId:run.threadId,requestId:'first'}});
  assert.deepEqual(store.state.approvals.map(a=>a.status),['expired','pending']);
  assert.equal(store.state.tasks.find(task=>task.id===run.id).status,'waiting');assert.equal(runtime.pending.size,1);
  adapter.emit('notification',{method:'serverRequest/resolved',params:{requestId:'second'}});
  assert.equal(store.state.approvals.every(a=>a.status==='expired'),true);
  assert.equal(store.state.tasks.find(task=>task.id===run.id).status,'running');assert.equal(runtime.pending.size,0);
  const eventCount=store.state.events.length;
  for(const requestId of ['second','unknown'])adapter.emit('notification',{method:'serverRequest/resolved',params:{requestId}});
  assert.equal(store.state.events.length,eventCount);assert.equal(adapter.responses.length,0);
});

test('restart preserves conversation and terminal results but interrupts unresolved work',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const first=new Store(dir,dir);first.change(s=>{s.mainThreadId='persisted';s.tasks.push({id:'unfinished',status:'running'},{id:'done',status:'completed',result:'evidence'});s.approvals.push({id:'stale',status:'pending'});});first.close();
  const second=new Store(dir,dir);t.after(()=>second.close());
  assert.equal(second.state.mainThreadId,'persisted');assert.equal(second.state.tasks[0].status,'interrupted');assert.equal(second.state.tasks[1].result,'evidence');assert.equal(second.state.approvals[0].status,'expired');
});

test('failed worker startup resolves without a phantom success',async t=>{
  const {runtime,store,adapter}=await fixture(t);const {taskId}=await runtime.chat('Delegate');await tick();
  adapter.startThread=async()=>{throw new Error('Fixture startup failure');};
  const worker=await runtime.delegate(store.state.tasks.find(t=>t.id===taskId),{title:'Review',instructions:'Inspect'});
  assert.equal(worker.status,'failed');assert.equal(worker.result,'');
});

test('unknown provider events do not contaminate activity',async t=>{
  const {store,adapter}=await fixture(t);const count=store.state.events.length;
  adapter.emit('notification',{method:'item/completed',params:{threadId:'foreign',item:{type:'commandExecution',command:'private'}}});
  assert.equal(store.state.events.length,count);
});

test('credentials are rejected before reaching the provider',async t=>{
  const {runtime,adapter}=await fixture(t);
  await assert.rejects(runtime.chat('API_KEY=fixture-secret-value'),e=>e.statusCode===400);
  assert.equal(adapter.starts.length,0);
});

test('enabled skills enter a prompt only when explicitly selected for that request',async t=>{
  const {runtime,store,adapter}=await fixture(t);
  store.state.skills.push({id:'enabled',name:'Selected context',content:'UNIQUE_REVIEWED_CONTEXT',enabled:true},{id:'disabled',name:'Disabled context',content:'MUST_NOT_APPEAR',enabled:false});
  await runtime.chat('No selection');await tick();assert.match(adapter.turns.at(-1).text,/^No selection\n/);assert.doesNotMatch(adapter.turns.at(-1).text,/UNIQUE_REVIEWED_CONTEXT|MUST_NOT_APPEAR/);adapter.complete('thread-1');
  await runtime.chat('Use context',['enabled','disabled']);await tick();
  assert.match(adapter.turns.at(-1).text,/UNIQUE_REVIEWED_CONTEXT/);assert.doesNotMatch(adapter.turns.at(-1).text,/MUST_NOT_APPEAR/);
});

test('deciding one approval keeps a task waiting for remaining decisions',async t=>{
  const {runtime,store,adapter}=await fixture(t);
  const run=await writableProjectRun(runtime,store);
  for(const id of [201,202])await runtime.request({id,method:'item/commandExecution/requestApproval',params:{threadId:run.threadId,turnId:run.turnId,command:'fixture',availableDecisions:['accept','decline']}});
  await runtime.approve(store.state.approvals[0].id,'decline');assert.equal(store.state.tasks.find(task=>task.id===run.id).status,'waiting');
  await runtime.approve(store.state.approvals[1].id,'accept');assert.equal(store.state.tasks.find(task=>task.id===run.id).status,'running');
  assert.deepEqual(adapter.responses.map(r=>r.result.decision),['decline','accept']);
});

test('settings and chat cannot race across workspace validation',async t=>{
  const {runtime,dir,adapter}=await fixture(t);
  const settings=runtime.settings({workspace:dir,permissionMode:'read-only',maxWorkers:2});
  await assert.rejects(runtime.chat('Must not use old workspace'),e=>e.statusCode===409);
  await settings;assert.equal(adapter.starts.length,0);
});

test('cancelling worker during thread startup resolves delegation without starting a turn',async t=>{
  const {runtime,store,adapter}=await fixture(t);const {taskId}=await runtime.chat('Delegate');await tick();
  let release;adapter.startThread=()=>new Promise(r=>{release=r;});
  const result=runtime.delegate(store.state.tasks.find(t=>t.id===taskId),{title:'Starting',instructions:'Read README'});
  await waitFor(()=>typeof release==='function');
  const worker=store.state.tasks.find(t=>t.kind==='worker');await runtime.cancel(worker.id);
  release({id:'late-worker'});
  const finished=await result;assert.equal(finished.status,'cancelled');assert.equal(runtime.waiters.size,0);assert.equal(adapter.turns.length,1);
});

test('a stop acknowledgement is not reported as terminal before provider confirmation',async t=>{
  const {runtime,store,adapter}=await fixture(t);const {taskId}=await runtime.chat('Work');await tick();
  adapter.interrupt=async()=>{};await runtime.cancel(taskId);
  assert.equal(store.state.tasks[0].cancelRequested,true);assert.equal(store.state.tasks[0].status,'running');
  adapter.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}});
  assert.equal(store.state.tasks[0].status,'cancelled');
});
