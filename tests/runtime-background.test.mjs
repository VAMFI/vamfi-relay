import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture state did not arrive.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const status = code => error => error.statusCode === code;

class Adapter extends EventEmitter {
  starts = []; turns = []; responses = []; interrupts = [];
  async connect() { return { version: 'background-fixture' }; }
  async startThread(options) { const id = 'thread-' + (this.starts.length + 1); this.starts.push({ id, ...options }); return { id }; }
  async resumeThread(options) { return { id: options.id }; }
  async startTurn(options) {
    const turn = { id: 'turn-' + (this.turns.length + 1), ...options }; this.turns.push(turn);
    this.emit('notification', { method: 'turn/started', params: { threadId: turn.threadId, turn: { id: turn.id } } });
    return { id: turn.id };
  }
  respond(requestId, result) { this.responses.push({ requestId, result }); }
  async interrupt(options) { this.interrupts.push(options); this.finish(options, 'interrupted'); }
  async close() {}
  finish(task, state = 'completed', text = 'Observed worker result') {
    if (state === 'completed') this.emit('notification', { method: 'item/completed', params: {
      threadId: task.threadId, turnId: task.turnId, item: { id: 'message-' + task.turnId, type: 'agentMessage', phase: 'final_answer', text },
    } });
    this.emit('notification', { method: 'turn/completed', params: { threadId: task.threadId,
      turn: { id: task.turnId, status: state, ...(state === 'failed' ? { error: { message: 'Observed fixture failure' } } : {}) },
    } });
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-background-'));
  const workspace = join(root, 'coordinator'), projectPath = join(root, 'project');
  await mkdir(workspace); await mkdir(projectPath);
  const data = join(root, 'data'), store = new Store(data, workspace), adapter = new Adapter(), runtime = new Runtime(store, adapter);
  t.after(async () => { await runtime.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  const project = await runtime.board.registerProject({ name: 'Synthetic', workspace: projectPath, permissionMode: 'workspace-write' });
  const goal = runtime.board.createWork({ projectId: project.id, title: 'Inspect the synthetic project', objective: 'Review the accepted change.' });
  const task = id => store.state.tasks.find(item => item.id === id);
  const parent = task((await runtime.chat('Assign an independent specialist for this goal.')).taskId);
  const args = { title: 'Independent review', instructions: 'Read the project witness and report it exactly.', workId: goal.id };
  const request = (callId, input = args, requestId = callId) => runtime.request({ id: requestId, method: 'item/tool/call', params: {
    threadId: parent.threadId, turnId: parent.turnId, callId, tool: 'relay_delegate_background', arguments: input,
  } });
  const admit = async (callId = 'call-1', input = args) => {
    await request(callId, input);
    const response = adapter.responses.findLast(item => item.requestId === callId).result;
    assert.equal(response.success, true);
    const receipt = JSON.parse(response.contentItems[0].text);
    assert.deepEqual(receipt, { accepted: true, taskId: receipt.taskId, status: 'queued' });
    return receipt.taskId;
  };
  const started = async id => { await waitFor(() => task(id)?.turnId); return task(id); };
  return { root, data, workspace, store, adapter, runtime, project, goal, parent, args, task, request, admit, started };
}

test('background admission is durable before delayed startup and the master stays available', async t => {
  const f = await fixture(t), originalStart = f.adapter.startThread.bind(f.adapter);
  assert.match(f.adapter.starts[0].developerInstructions, /Use relay_delegate_background/);
  assert.match(f.adapter.starts[0].developerInstructions, /queued admission is not a result/);
  assert.match(f.adapter.starts[0].developerInstructions, /Use relay_delegate only when this response must wait/);
  let release;
  f.adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await originalStart(options)); });
  const workerId = await f.admit();
  const recorded = JSON.parse(f.store.db.prepare('SELECT value FROM state WHERE id = 1').get().value).tasks.find(task => task.id === workerId);
  assert.equal(recorded.deliveryMode, 'background'); assert.equal(recorded.permissionMode, 'read-only');
  assert.equal(recorded.workspace, f.project.workspace); assert.equal(recorded.parentTaskId, f.parent.id);
  assert.equal(recorded.projectId, f.project.id); assert.equal(recorded.workId, f.goal.id);
  assert.equal(Date.parse(recorded.deadlineAt) - Date.parse(recorded.createdAt), 180000);
  await waitFor(() => release);
  f.adapter.finish(f.parent, 'completed', 'The specialist was accepted.');
  const second = f.task((await f.runtime.chat('Answer an unrelated short question.')).taskId);
  f.adapter.finish(second, 'completed', 'An independent answer.');
  assert.equal(f.task(workerId).startedAt, null);
  await release(); await f.started(workerId);
  f.adapter.finish(f.task(workerId), 'completed', 'Exact synthetic witness');
  const notices = f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId);
  assert.equal(notices.length, 1); assert.equal(notices[0].source, 'worker'); assert.equal(notices[0].channel, 'master');
  assert.equal(notices[0].parentTaskId, f.parent.id); assert.equal(notices[0].workId, f.goal.id);
  assert.match(notices[0].text, /Exact synthetic witness/);
  assert.equal(f.runtime.board.get(f.goal.id).status, 'planned');
});

for (const when of ['before', 'after']) for (const outcome of ['completed', 'failed']) {
  test(`natural parent ${outcome} ${when} worker startup preserves the background assignment`, async t => {
    const f = await fixture(t);
    let release;
    if (when === 'before') {
      const original = f.adapter.startThread.bind(f.adapter);
      f.adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await original(options)); });
    }
    const workerId = await f.admit();
    if (when === 'before') await waitFor(() => release); else await f.started(workerId);
    f.adapter.finish(f.parent, outcome);
    if (release) await release();
    await f.started(workerId);
    f.adapter.finish(f.task(workerId), 'completed', 'Survived natural parent terminal state.');
    assert.equal(f.task(workerId).status, 'completed'); assert.equal(f.adapter.interrupts.length, 0);
  });
}

test('one provider call replays its durable receipt and rejects conflicting payloads', async t => {
  const f = await fixture(t);
  f.store.change(state => { state.settings.maxWorkers = 1; });
  const workerId = await f.admit();
  const reordered = { workId: f.goal.id, instructions: f.args.instructions, title: f.args.title };
  await f.request('call-1', reordered, 'transport-retry');
  assert.equal(JSON.parse(f.adapter.responses.at(-1).result.contentItems[0].text).taskId, workerId);
  await assert.rejects(f.request('call-1', { ...f.args, instructions: 'Different intent' }), status(409));
  await assert.rejects(f.request('distinct-call'), status(409));
  await f.started(workerId); f.adapter.finish(f.task(workerId)); f.adapter.finish(f.parent);
  await f.request('call-1', f.args, 'late-transport-retry');
  assert.equal(JSON.parse(f.adapter.responses.at(-1).result.contentItems[0].text).taskId, workerId);
  assert.equal(f.store.state.tasks.filter(task => task.kind === 'worker').length, 1);
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId).length, 1);
});

test('worker results enter bounded later context and only successful included requests acknowledge them', async t => {
  const f = await fixture(t), workerId = await f.admit();
  await f.started(workerId); f.adapter.finish(f.parent);
  f.adapter.finish(f.task(workerId), 'completed', 'Result retained for later conversation.');
  const context = f.runtime.masterContext();
  assert.deepEqual(context.deliveryIds, [workerId]);
  assert.equal(JSON.parse(context.text).newWorkerResults[0].result, 'Result retained for later conversation.');
  const failed = f.task((await f.runtime.chat('Read the specialist findings.')).taskId);
  f.adapter.finish(failed, 'failed');
  assert.deepEqual(f.runtime.masterContext().deliveryIds, [workerId]);
  const success = f.task((await f.runtime.chat('Read the retained findings.')).taskId);
  f.adapter.finish(success);
  assert.deepEqual(f.runtime.masterContext().deliveryIds, []);
  assert.ok(f.task(workerId).contextDeliveredAt);
  f.adapter.finish(f.task(workerId), 'failed');
  assert.equal(f.task(workerId).status, 'completed');
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId).length, 1);
});

for (const stop of ['parent', 'task', 'pause', 'cancel', 'shutdown']) test(`${stop} stops a background assignment during delayed startup without a late turn`, async t => {
  const f = await fixture(t), originalStart = f.adapter.startThread.bind(f.adapter);
  let release;
  f.adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await originalStart(options)); });
  const workerId = await f.admit(); await waitFor(() => release);
  if (stop === 'parent') await f.runtime.cancel(f.parent.id);
  else if (stop === 'task') await f.runtime.cancel(workerId);
  else if (stop === 'shutdown') await f.runtime.close();
  else await f.runtime.updateWork(f.goal.id, { status: stop === 'pause' ? 'paused' : 'cancelled' });
  await release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.task(workerId).startedAt, null);
  assert.ok(['cancelled', 'interrupted'].includes(f.task(workerId).status));
  assert.equal(f.adapter.turns.length, 1);
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId).length, 1);
});

test('admission requires a stable call ID, enforces shared bounds, and never invents a goal for unassigned work', async t => {
  const f = await fixture(t);
  await assert.rejects(f.request(undefined), status(400));
  await assert.rejects(f.request('missing', { ...f.args, workId: 'missing-goal' }), status(404));
  assert.equal(f.store.state.tasks.filter(task => task.kind === 'worker').length, 0);
  f.store.change(state => { state.settings.maxWorkers = 3; });
  for (const index of [1, 2, 3]) {
    const id = await f.admit('distinct-' + index, { title: 'Coordinator review', instructions: 'Inspect coordinator documentation.' });
    await f.started(id); f.adapter.finish(f.task(id));
    assert.equal(f.task(id).workId, undefined); assert.equal(f.task(id).projectId, undefined);
    assert.equal(f.task(id).workspace, f.parent.workspace);
  }
  await assert.rejects(f.request('fourth'), status(409));
  assert.equal(f.store.state.workItems.length, 1);
  assert.equal(f.store.state.events.filter(event => event.type === 'work_request').length, 0);
});

for (const stopResult of ['ack', 'error']) test(`deadline ${stopResult} retains uncertain execution and capacity until terminal evidence`, async t => {
  const f = await fixture(t);
  f.store.change(state => { state.settings.maxWorkers = 1; });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  f.adapter.interrupt = async options => { f.adapter.interrupts.push(options); if (stopResult === 'error') throw new Error('Stop was not confirmed.'); };
  const workerId = await f.admit();
  const limit = performance.now() + 2000;
  while (!f.task(workerId).turnId) {
    if (performance.now() > limit) throw new Error('Worker startup did not arrive.');
    await new Promise(resolve => setImmediate(resolve));
  }
  t.mock.timers.tick(180000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.interrupts.length, 1); assert.ok(f.task(workerId).deadlineExceededAt);
  assert.equal(f.task(workerId).cancelRequested, true); assert.equal(f.task(workerId).status, 'running');
  assert.equal(f.store.state.messages.some(message => message.id === 'worker-result:' + workerId), false);
  if (stopResult === 'error') assert.equal(f.task(workerId).stopError, 'Stop was not confirmed.');
  await assert.rejects(f.request('second-call'), status(409));
  f.adapter.finish(f.task(workerId), 'interrupted');
  assert.equal(f.task(workerId).status, 'cancelled');
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId).length, 1);
  t.mock.timers.reset();
});

for (const announcement of ['notification', 'response']) test(`late turn ID through ${announcement} preserves uncertainty when deadline interruption fails`, async t => {
  const f = await fixture(t);
  f.store.change(state => { state.settings.maxWorkers = 1; });
  let releaseTurn;
  f.adapter.startTurn = options => new Promise(resolve => {
    const turn = { id: 'delayed-worker-turn', ...options }; f.adapter.turns.push(turn);
    releaseTurn = () => {
      if (announcement === 'notification') f.adapter.emit('notification', { method: 'turn/started', params: { threadId: options.threadId, turn: { id: turn.id } } });
      resolve({ id: turn.id });
    };
  });
  f.adapter.interrupt = async options => { f.adapter.interrupts.push(options); throw new Error('Interruption response was lost.'); };
  const workerId = await f.admit(); await waitFor(() => releaseTurn);
  f.store.change(state => { state.tasks.find(task => task.id === workerId).deadlineAt = new Date(Date.now() - 1).toISOString(); });
  await f.runtime.expireWorker(workerId);
  assert.equal(f.task(workerId).status, 'running'); assert.equal(f.adapter.interrupts.length, 0);
  releaseTurn(); await waitFor(() => f.adapter.interrupts.length === 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.task(workerId).status, 'running'); assert.equal(f.task(workerId).completedAt, null);
  assert.equal(f.task(workerId).stopError, 'Interruption response was lost.');
  assert.equal(f.store.state.messages.some(message => message.id === 'worker-result:' + workerId), false);
  await assert.rejects(f.request('capacity-still-held'), status(409));
  f.adapter.finish(f.task(workerId), 'interrupted');
  assert.equal(f.task(workerId).status, 'cancelled');
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId).length, 1);
});

test('shutdown does not report a background worker stopped until the provider confirms close', async t => {
  const f = await fixture(t), workerId = await f.admit(); await f.started(workerId);
  let releaseClose;
  f.adapter.close = () => new Promise(resolve => { releaseClose = resolve; });
  const closing = f.runtime.close(); await waitFor(() => releaseClose);
  const beforeClose = { status: f.task(workerId).status, notified: f.store.state.messages.some(message => message.id === 'worker-result:' + workerId) };
  releaseClose(); await closing;
  f.adapter.close = async () => {};
  assert.deepEqual(beforeClose, { status: 'running', notified: false });
  assert.equal(f.task(workerId).status, 'interrupted');
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + workerId).length, 1);
});

test('parent stop freezes sibling startup before awaiting a slow child interruption', async t => {
  const f = await fixture(t), firstId = await f.admit('first'); await f.started(firstId);
  const originalStart = f.adapter.startThread.bind(f.adapter);
  let releaseThread, releaseStop;
  f.adapter.startThread = options => new Promise(resolve => { releaseThread = async () => resolve(await originalStart(options)); });
  const secondId = await f.admit('second'); await waitFor(() => releaseThread);
  f.adapter.interrupt = options => {
    f.adapter.interrupts.push(options);
    if (options.threadId === f.task(firstId).threadId) return new Promise(resolve => {
      releaseStop = () => { f.adapter.finish(options, 'interrupted'); resolve(); };
    });
    f.adapter.finish(options, 'interrupted'); return Promise.resolve();
  };
  const stopping = f.runtime.cancel(f.parent.id); await waitFor(() => releaseStop);
  const parentFrozen = f.task(f.parent.id).cancelRequested;
  await releaseThread();
  await waitFor(() => f.task(secondId).threadId || f.task(secondId).status === 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  const lateTurns = f.adapter.turns.filter(turn => turn.threadId === f.task(secondId).threadId).length;
  releaseStop(); await stopping;
  assert.equal(parentFrozen, true); assert.equal(lateTurns, 0);
  assert.equal(f.task(secondId).startedAt, null); assert.equal(f.task(secondId).status, 'cancelled');
});

test('parent stop freezes every descendant and attempts all turns despite one unconfirmed interruption', async t => {
  const f = await fixture(t), firstId = await f.admit('first'); await f.started(firstId);
  const secondId = await f.admit('second'); await f.started(secondId);
  let firstObservedFlags;
  f.adapter.interrupt = async options => {
    firstObservedFlags ??= [f.parent.id, firstId, secondId].map(id => f.task(id).cancelRequested);
    f.adapter.interrupts.push(options);
    if (options.turnId === f.task(firstId).turnId) throw new Error('First worker stop unconfirmed.');
    f.adapter.finish(options, 'interrupted');
  };
  await assert.rejects(f.runtime.cancel(f.parent.id), /First worker stop unconfirmed/);
  assert.deepEqual(firstObservedFlags, [true, true, true]);
  assert.deepEqual(new Set(f.adapter.interrupts.map(item => item.turnId)), new Set([f.parent.turnId, f.task(firstId).turnId, f.task(secondId).turnId]));
  assert.equal(f.task(firstId).status, 'running'); assert.equal(f.task(firstId).stopError, 'First worker stop unconfirmed.');
  assert.equal(f.task(secondId).status, 'cancelled'); assert.equal(f.task(f.parent.id).status, 'cancelled');
  assert.equal(f.store.state.messages.some(message => message.id === 'worker-result:' + firstId), false);
  assert.equal(f.store.state.messages.filter(message => message.id === 'worker-result:' + secondId).length, 1);
});

for (const goalStatus of ['paused', 'cancelled']) test(`goal ${goalStatus} attempts every specialist stop despite the first interruption failing`, async t => {
  const f = await fixture(t), firstId = await f.admit('first'); await f.started(firstId);
  const secondId = await f.admit('second'); await f.started(secondId);
  let firstObservedFlags;
  f.adapter.interrupt = async options => {
    firstObservedFlags ??= [firstId, secondId].map(id => f.task(id).cancelRequested);
    f.adapter.interrupts.push(options);
    if (options.turnId === f.task(firstId).turnId) throw new Error('First goal worker stop unconfirmed.');
    f.adapter.finish(options, 'interrupted');
  };
  await assert.rejects(f.runtime.updateWork(f.goal.id, { status: goalStatus }), /First goal worker stop unconfirmed/);
  assert.deepEqual(firstObservedFlags, [true, true]);
  assert.deepEqual(new Set(f.adapter.interrupts.map(item => item.turnId)), new Set([f.task(firstId).turnId, f.task(secondId).turnId]));
  assert.equal(f.task(firstId).status, 'running'); assert.equal(f.task(firstId).stopError, 'First goal worker stop unconfirmed.');
  assert.equal(f.task(secondId).status, 'cancelled'); assert.equal(f.task(f.parent.id).status, 'running');
  assert.equal(f.runtime.board.get(f.goal.id).status, goalStatus);
});

for (const target of ['parent', 'goal']) test(`${target} stop reaches running siblings while the first interruption is still pending`, async t => {
  const f = await fixture(t), firstId = await f.admit('first'); await f.started(firstId);
  const secondId = await f.admit('second'); await f.started(secondId);
  let releaseFirst;
  f.adapter.interrupt = options => {
    f.adapter.interrupts.push(options);
    if (options.turnId === f.task(firstId).turnId) return new Promise(resolve => {
      releaseFirst = () => { f.adapter.finish(options, 'interrupted'); resolve(); };
    });
    f.adapter.finish(options, 'interrupted'); return Promise.resolve();
  };
  const stopping = target === 'parent' ? f.runtime.cancel(f.parent.id) : f.runtime.updateWork(f.goal.id, { status: 'paused' });
  await waitFor(() => releaseFirst);
  const beforeFirstAcknowledged = { calls: f.adapter.interrupts.length, secondStatus: f.task(secondId).status };
  releaseFirst(); await stopping;
  assert.deepEqual(beforeFirstAcknowledged, { calls: target === 'parent' ? 3 : 2, secondStatus: 'cancelled' });
});

test('restart interrupts unfinished assignments, reconciles one receipt, and never replays execution', async t => {
  const f = await fixture(t), workerId = await f.admit(); await f.started(workerId);
  const recoveryData = join(f.root, 'recovery');
  let restored = new Store(recoveryData, f.workspace);
  restored.change(state => Object.assign(state, f.store.snapshot())); restored.close();
  for (let restart = 0; restart < 3; restart++) {
    restored = new Store(recoveryData, f.workspace);
    const adapter = new Adapter(), runtime = new Runtime(restored, adapter);
    await runtime.connect();
    assert.equal(restored.state.tasks.find(task => task.id === workerId).status, 'interrupted');
    const notices = restored.state.messages.filter(message => message.id === 'worker-result:' + workerId);
    assert.equal(notices.length, 1); assert.equal(notices[0].outcomeStatus, 'interrupted');
    assert.match(notices[0].text, /not automatically rerun/);
    await runtime.request({ id: 'replayed', method: 'item/tool/call', params: {
      threadId: f.parent.threadId, turnId: f.parent.turnId, callId: 'call-1', tool: 'relay_delegate_background', arguments: f.args,
    } });
    assert.equal(JSON.parse(adapter.responses.at(-1).result.contentItems[0].text).taskId, workerId);
    assert.equal(adapter.starts.length, 0); assert.equal(adapter.turns.length, 0);
    assert.deepEqual(runtime.masterContext().deliveryIds, [workerId]);
    await runtime.close(); restored.close();
  }
});

test('recovery repairs a missing receipt even when its old notified marker exists', async t => {
  const f = await fixture(t), workerId = await f.admit(); await f.started(workerId);
  f.adapter.finish(f.task(workerId), 'completed', 'Retained exact result');
  const recoveryData = join(f.root, 'receipt-recovery');
  let restored = new Store(recoveryData, f.workspace);
  const snapshot = f.store.snapshot(); snapshot.messages = snapshot.messages.filter(message => message.id !== 'worker-result:' + workerId);
  restored.change(state => Object.assign(state, snapshot)); restored.close();
  for (let restart = 0; restart < 2; restart++) {
    restored = new Store(recoveryData, f.workspace);
    const notices = restored.state.messages.filter(message => message.id === 'worker-result:' + workerId);
    assert.equal(notices.length, 1); assert.match(notices[0].text, /Retained exact result/);
    assert.equal(restored.state.tasks.find(task => task.id === workerId).result, 'Retained exact result');
    restored.close();
  }
});

test('later context remains bounded and a successful request acknowledges only its included results', async t => {
  const f = await fixture(t);
  f.store.change(state => {
    for (let index = 0; index < 11; index++) state.tasks.push({ id: 'terminal-' + index, kind: index % 2 ? 'project' : 'worker',
      deliveryMode: 'background', status: 'completed', title: 'Recorded result', result: 'x'.repeat(4000), error: '', createdAt: new Date().toISOString() });
  });
  const context = f.runtime.masterContext(), body = JSON.parse(context.text);
  assert.equal(context.deliveryIds.length, 8); assert.equal(body.omittedResults, 3);
  assert.equal(body.newProjectResults.length + body.newWorkerResults.length, 8);
  assert.ok([...body.newProjectResults, ...body.newWorkerResults].every(result => result.result.length <= 1500));
  f.adapter.finish(f.parent);
  const master = f.task((await f.runtime.chat('Review the retained results.')).taskId); f.adapter.finish(master);
  assert.deepEqual(f.runtime.masterContext().deliveryIds, ['terminal-8', 'terminal-9', 'terminal-10']);
});
