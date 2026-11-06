import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, active } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error('Expected fixture state did not arrive.');
}
class Adapter extends EventEmitter {
  constructor(provider) { super(); this.provider=provider; this.starts=[]; this.resumes=[]; this.turns=[]; this.stops=[]; }
  async connect() { return {version:'fixture'}; }
  async startThread(options) { const id=`${this.provider}:${this.starts.length+1}`; this.starts.push({id,...options}); return {id}; }
  async resumeThread(options) { this.resumes.push(options); return {id:options.id}; }
  async startTurn(options) {
    this.turns.push(options);
    if(this.uncertain)throw Object.assign(Error('Transport outcome unknown'),{uncertain:true,code:'HERMES_UNCERTAIN'});
    const id=`admission-${this.turns.length}`;
    this.emit('notification',{method:'turn/started',params:{threadId:options.threadId,turn:{id}}});return {id};
  }
  finish(task,text='Actual project result',status='completed') {
    this.emit('notification',{method:'item/completed',params:{threadId:task.threadId,turnId:task.turnId,item:{type:'agentMessage',id:`answer:${task.turnId}`,text,phase:'final_answer'}}});
    this.emit('notification',{method:'turn/completed',params:{threadId:task.threadId,turn:{id:task.turnId,status}}});
  }
  async recover(options) { this.recovery=options; return {threadId:options.threadId,runId:options.runId,...this.outcome}; }
  async interrupt(options) { this.stops.push(options); if(this.stopError)throw Error('Stop unconfirmed'); this.finish(options,'Stopped','interrupted'); }
  async close() { if(this.closeError)throw Error('Remote work remains unknown'); }
  respond() {}
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'relay-providers-'));const workspace=join(root,'project');await mkdir(workspace);
  const store=new Store(join(root,'data'),workspace), codex=new Adapter('codex'), hermes=new Adapter('hermes');
  const runtime=new Runtime(store,codex,{hermes});await runtime.connect();
  const project=runtime.updateProject(store.state.settings.defaultProjectId,{provider:'hermes',permissionMode:'read-only'});
  const goal=runtime.board.createWork({projectId:project.id,title:'Inspect project',objective:'Inspect evidence.'});
  const task=id=>new Proxy({}, {get:(_,key)=>store.state.tasks.find(t=>t.id===id)?.[key]});
  t.after(async()=>{hermes.closeError=false;await runtime.close();store.close();await rm(root,{recursive:true,force:true});});
  return {root,workspace,store,codex,hermes,runtime,project,goal,task};
}
test('Hermes project runs keep the Codex master and reuse only their scoped session',async t=>{
  const f=await fixture(t);const request=await f.runtime.chat('Inspect the project');
  const first=f.task(f.runtime.startProject(f.goal.id,'Read evidence',{parentTaskId:request.taskId}).taskId);
  await until(()=>first.turnId);assert.equal(first.provider,'hermes');assert.equal(f.hermes.turns[0].runId,first.id);
  assert.equal(f.hermes.starts[0].permissionMode,'read-only');assert.deepEqual(f.hermes.starts[0].tools,[]);
  assert.equal(f.codex.starts.length,1);assert.equal(f.task(request.taskId).provider,'codex');
  f.hermes.finish(first);const second=f.task(f.runtime.startProject(f.goal.id,'Continue analysis').taskId);await until(()=>second.turnId);
  assert.equal(second.threadId,first.threadId);assert.equal(f.hermes.starts.length,1);f.hermes.finish(second);
  assert.equal(f.store.state.messages.filter(m=>m.taskId===first.id && m.channel==='master').length,1);
});
test('Hermes rejects unsupported writes and automatic plans before execution',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.runtime.updateProject(f.project.id,{permissionMode:'workspace-write'}),/read.only/i);
  assert.throws(()=>f.runtime.board.setPlan(f.goal.id,{steps:[{title:'Step',instructions:'Inspect'}]}),/Hermes|provider/i);
  assert.equal(f.hermes.turns.length,0);
});
test('Hermes background assignments follow goal provider and return to original master',async t=>{
  const f=await fixture(t);const parent=f.task((await f.runtime.chat('Delegate analysis')).taskId);
  const admitted=f.runtime.delegateBackground(parent,{workId:f.goal.id,title:'Inspect',instructions:'Read evidence'},'call-1');
  const worker=f.task(admitted.taskId);await until(()=>worker.turnId);assert.equal(worker.provider,'hermes');
  f.codex.finish(parent);f.hermes.finish(worker,'Hermes witness');
  assert.equal(f.store.state.messages.filter(m=>m.taskId===worker.id && m.channel==='master').length,1);
  assert.equal(f.store.state.messages.find(m=>m.id===`worker-result:${worker.id}`).outcomeStatus,'completed');
});
test('ambiguous Hermes admission and disconnect retain capacity without failing the master',async t=>{
  const f=await fixture(t);f.hermes.uncertain=true;
  const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.providerOutcomeUnknown);
  assert.equal(task.status,'waiting');assert.ok(active(task));assert.equal(task.completedAt,null);
  f.hermes.emit('disconnect',{provider:'hermes',uncertain:true,message:'Remote outcome unknown'});
  assert.equal(f.store.state.connection.status,'connected');assert.ok(active(task));
  assert.throws(()=>f.runtime.startProject(f.goal.id),error=>error.statusCode===409);
  f.hermes.outcome={state:'completed',turnId:'recovered-admission',result:'Recovered actual result'};
  await f.runtime.recoverTask(task.id);assert.equal(task.status,'completed');assert.equal(task.result,'Recovered actual result');
  assert.equal(f.hermes.turns.length,1);assert.equal(f.hermes.recovery.runId,task.id);
});
test('restart holds an uncertain remote run and never publishes a false interrupted result',async t=>{
  const f=await fixture(t);const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.turnId);
  f.store.close();const restored=new Store(join(f.root,'data'),f.workspace);t.after(()=>restored.close());
  const remote=restored.state.tasks.find(t=>t.id===task.id);assert.equal(remote.status,'waiting');assert.equal(remote.providerOutcomeUnknown,true);
  assert.equal(remote.completedAt,null);assert.equal(restored.state.messages.filter(m=>m.taskId===task.id && m.channel==='master').length,0);
  assert.equal(restored.state.workItems.find(w=>w.id===f.goal.id).recoveryRequired,true);
  // Original fixture is no longer a live writer after simulated crash.
  f.runtime.closing=true;f.runtime.close=async()=>{};
});
test('Stop resolves a lost ACK by its exact run identity and then cancels only that admission',async t=>{
  const f=await fixture(t);f.hermes.uncertain=true;const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.providerOutcomeUnknown);
  f.hermes.outcome={state:'running',turnId:'exact-admission'};await f.runtime.cancel(task.id);
  assert.equal(f.hermes.recovery.runId,task.id);assert.deepEqual(f.hermes.stops,[{threadId:task.threadId,turnId:'exact-admission'}]);
  assert.equal(task.status,'cancelled');assert.equal(f.hermes.turns.length,1);
});
test('failed remote shutdown leaves task active and never marks completion',async t=>{
  const f=await fixture(t);const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.turnId);f.hermes.closeError=true;
  await assert.rejects(f.runtime.close(),/unknown/);assert.ok(active(task));assert.equal(task.completedAt,null);
});
test('session startup failure before submission cannot strand an unknown executing run',async t=>{
  const f=await fixture(t);
  f.hermes.startThread=async()=>{throw Object.assign(Error('Session opening acknowledgement lost'),{uncertain:true});};
  const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>!active(task));
  assert.equal(task.status,'failed');assert.ok(!task.providerOutcomeUnknown);assert.equal(task.threadId,null);
  assert.equal(f.hermes.turns.length,0);await f.runtime.close();
  f.store.close();const restored=new Store(join(f.root,'data'),f.workspace);t.after(()=>restored.close());
  assert.equal(restored.state.tasks.find(t=>t.id===task.id).status,'failed');
  f.runtime.close=async()=>{};
});
test('a failed Hermes stop can be inspected and retried without submitting a new turn',async t=>{
  const f=await fixture(t);const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.turnId);
  f.hermes.stopError=true;await assert.rejects(f.runtime.cancel(task.id),/unconfirmed/);
  assert.equal(task.providerOutcomeUnknown,true);assert.ok(active(task));
  f.hermes.stopError=false;f.hermes.outcome={state:'running',turnId:task.turnId};
  await f.runtime.cancel(task.id);assert.equal(task.status,'cancelled');assert.equal(f.hermes.stops.length,2);assert.equal(f.hermes.turns.length,1);
});
test('a delayed running receipt cannot reopen a run after its terminal event',async t=>{
  const f=await fixture(t);const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.turnId);
  let release;f.hermes.recover=options=>new Promise(resolve=>{release=()=>resolve({...options,state:'running'});});
  const checking=f.runtime.recoverTask(task.id);await until(()=>release);f.hermes.finish(task,'Terminal witness');release();await checking;
  assert.equal(task.status,'completed');assert.equal(task.result,'Terminal witness');assert.ok(task.completedAt);
});
test('an attached but unknown receipt cannot become interrupted just because a viewer closed',async t=>{
  const f=await fixture(t);f.hermes.uncertain=true;const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.providerOutcomeUnknown);
  f.hermes.outcome={state:'unknown'};await f.runtime.recoverTask(task.id);assert.ok(f.runtime.loaded.has(task.threadId));
  await assert.rejects(f.runtime.close(),/unknown/);assert.equal(task.status,'waiting');assert.equal(task.completedAt,null);
  assert.equal(f.store.state.messages.filter(m=>m.taskId===task.id && m.channel==='master').length,0);
  f.hermes.outcome={state:'interrupted',turnId:'confirmed-for-cleanup'};
});
for(const requested of ['paused','cancelled'])test(`unknown interruption preserves the user's ${requested} goal state through restart`,async t=>{
  const f=await fixture(t);const task=f.task(f.runtime.startProject(f.goal.id).taskId);await until(()=>task.turnId);f.hermes.stopError=true;
  await assert.rejects(f.runtime.updateWork(f.goal.id,{status:requested}),/unconfirmed/);
  assert.equal(f.runtime.board.get(f.goal.id).status,requested);assert.equal(task.providerOutcomeUnknown,true);
  f.store.close();const restored=new Store(join(f.root,'data'),f.workspace);t.after(()=>restored.close());
  assert.equal(restored.state.workItems.find(w=>w.id===f.goal.id).status,requested);
  assert.equal(restored.state.tasks.find(t=>t.id===task.id).status,'waiting');
  f.runtime.closing=true;f.runtime.close=async()=>{};
});
