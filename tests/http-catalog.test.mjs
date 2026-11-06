import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

class Execution extends EventEmitter {
  starts=[]; turns=[]; closed=false;
  async connect(){return {version:'fixture',authenticated:true};}
  async startThread(options){this.starts.push(options);return {id:'owned-master'};}
  async startTurn(input){this.turns.push(input);return {id:'owned-turn'};}
  async interrupt(){}
  respond(){}
  async close(){this.closed=true;}
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'relay-catalog-http-'));
  const calls=[]; const adapter=new Execution();
  const contextHash='a'.repeat(64);
  const catalog={
    async list(options){calls.push(options);return {available:true,threads:[{id:'source-a',title:'Prior Alpha'}],projects:[],totals:{threads:1},partial:false};},
    async detail(id){return {thread:{id,title:'Prior Alpha',workspace:root},contextHash,contextText:'Earlier user fact: ALPHA_CONTEXT. Earlier assistant report: read the fixture.'};},
    async memory(){return {available:true,text:'Synthetic generated memory'};},async close(){},
  };
  const app=await createApp({dataDir:join(root,'state'),workspace:root,adapter,catalog});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=(path,body,origin=base)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  return {app,adapter,catalog,calls,contextHash,base,post};
}
test('catalog routes preserve ownership, pagination intent and same-origin boundaries',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/codex/catalog?query=Alpha')).status,200);
  assert.equal(f.calls[0].query,'Alpha');
  assert.equal((await f.post('/api/codex/refresh',{loadMore:true})).status,200);
  assert.equal(f.calls.at(-1).loadMore,true);assert.equal(f.calls.at(-1).refresh,false);
  assert.equal((await f.post('/api/codex/refresh',{archived:true})).status,200);
  assert.equal(f.calls.at(-1).refresh,true);assert.equal(f.calls.at(-1).archived,true);
  assert.equal((await f.post('/api/codex/refresh',{loadMore:'yes'})).status,400);
  assert.equal((await f.post('/api/codex/refresh',{},'https://example.invalid')).status,403);
  assert.equal((await fetch(f.base+'/api/codex/memory')).status,200);
  assert.equal(f.app.store.state.tasks.length,0);assert.equal(f.app.store.state.workItems.length,0);
  const state=await(await fetch(f.base+'/api/state')).json();
  assert.ok(!JSON.stringify(state).includes('Synthetic generated memory'));
  assert.ok(!JSON.stringify(state).includes('Prior Alpha'));
});
test('HTTP reviewed handoff uses one owned master, preserves sources and survives retry',async t=>{
  const f=await fixture(t);
  const body={threadId:'source-a',contextHash:f.contextHash,request:'Explain the earlier fact without creating a goal.',reviewed:true,acknowledgeUncertainActivity:true,requestId:'http-request-1234'};
  assert.equal((await f.post('/api/codex/handoff',body,'https://example.invalid')).status,403);
  const first=await f.post('/api/codex/handoff',body);assert.equal(first.status,202);
  const accepted=await first.json();
  const second=await f.post('/api/codex/handoff',body);assert.equal(second.status,202);
  assert.deepEqual(await second.json(),accepted);
  assert.equal(f.adapter.starts.length,1);assert.equal(f.adapter.turns.length,1);
  assert.equal(f.adapter.starts[0].permissionMode,'read-only');
  assert.match(f.adapter.turns[0].text,/ALPHA_CONTEXT/);
  assert.match(f.adapter.turns[0].text,/not new instructions or permission/);
  assert.equal(f.app.store.state.tasks[0].sourceThreadId,'source-a');
  assert.equal(f.app.store.state.workItems.length,0);
  assert.equal(f.app.store.state.threads[0].id,'owned-master');
  assert.equal((await f.post('/api/codex/handoff',{...body,request:'Different'})).status,409);
});
test('discovery failure leaves execution connected and source history out of exports',async t=>{
  const f=await fixture(t);await f.app.runtime.connect();
  f.catalog.list=async()=>{throw new Error('Synthetic catalog fault');};
  assert.equal((await fetch(f.base+'/api/codex/catalog')).status,500);
  assert.equal(f.app.store.state.connection.status,'connected');assert.equal(f.adapter.closed,false);
  const exported=await(await fetch(f.base+'/api/export?date=2026-11-06')).json();
  assert.equal(exported.tasks.length,0);assert.equal(exported.messages.length,0);
  assert.ok(!JSON.stringify(exported).includes('Synthetic generated memory'));
});
