import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';

const status = code => error => error.statusCode === code;
async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

class FakeAdapter extends EventEmitter {
  starts = []; resumes = []; turns = []; responses = []; interrupts = [];
  async connect() { return { version: 'fixture' }; }
  async startThread(options) {
    const thread = { id: 'thread-' + (this.starts.length + 1), ...options };
    this.starts.push(thread); return { id: thread.id };
  }
  async resumeThread(options) { this.resumes.push(options); return { id: options.id }; }
  async startTurn(options) {
    const turn = { id: 'turn-' + (this.turns.length + 1), ...options };
    this.turns.push(turn);
    this.emit('notification', { method: 'turn/started', params: { threadId: turn.threadId, turn: { id: turn.id } } });
    return { id: turn.id };
  }
  respond(requestId, result) { this.responses.push({ requestId, result }); }
  async interrupt(options) {
    this.interrupts.push(options);
    this.finish(options, 'interrupted');
  }
  finish({ threadId, turnId }, state = 'completed', text = 'Observed fixture result') {
    if (state === 'completed') this.emit('notification', { method: 'item/completed', params: {
      threadId, turnId, item: { id: 'answer-' + turnId, type: 'agentMessage', phase: 'final_answer', text },
    } });
    this.emit('notification', { method: 'turn/completed', params: {
      threadId, turn: { id: turnId, status: state, ...(state === 'failed' ? { error: { message: 'Fixture turn failed.' } } : {}) },
    } });
  }
  async close() {}
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-runtime-work-'));
  const coordinatorWorkspace = join(root, 'coordinator');
  const alphaWorkspace = join(root, 'alpha');
  const betaWorkspace = join(root, 'beta');
  for (const path of [coordinatorWorkspace, alphaWorkspace, betaWorkspace]) await mkdir(path);
  const store = new Store(join(root, 'data'), coordinatorWorkspace);
  const adapter = new FakeAdapter();
  const runtime = new Runtime(store, adapter);
  t.after(async () => { await runtime.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.connect();
  const alpha = await runtime.board.registerProject({ name: 'Alpha', workspace: alphaWorkspace, permissionMode: 'workspace-write' });
  const beta = await runtime.board.registerProject({ name: 'Beta', workspace: betaWorkspace });
  const work = (project, title = 'Verify ' + project.name) => runtime.board.createWork({
    projectId: project.id, title, objective: 'Deliver the accepted change and verify its result.',
  });
  const task = taskId => store.state.tasks.find(item => item.id === taskId);
  const started = async taskId => {
    await waitFor(() => task(taskId)?.turnId || ['failed', 'cancelled', 'interrupted'].includes(task(taskId)?.status));
    assert.equal(task(taskId).status, 'running', task(taskId).error);
    return task(taskId);
  };
  return { root, store, adapter, runtime, alpha, beta, work, task, started };
}

test('casual conversation creates provider records but no work goals', async t => {
  const { runtime, store, adapter, task } = await fixture(t);
  const { taskId } = await runtime.chat("Why can't you inspect?");
  adapter.finish(task(taskId), 'completed', 'Here is what can be inspected.');
  assert.equal(store.state.workItems.length, 0);
  assert.equal(task(taskId).workId, undefined);
  assert.equal(task(taskId).status, 'completed');
  assert.deepEqual(store.state.messages.filter(message => message.channel === 'master').map(message => message.role), ['user', 'assistant']);
  assert.equal(adapter.starts[0].permissionMode, 'read-only');
  assert.deepEqual(store.state.events.filter(event => event.type === 'work_request'), []);
});

for (const action of ['create', 'update', 'draft', 'run']) test(`${action} records a durable, deduplicated request-to-goal association`, async t => {
  const { runtime, store, adapter, alpha, work, task } = await fixture(t);
  const existing = work(alpha);
  const origin = await runtime.chat('Continue the accepted Alpha goal.');
  const parent = task(origin.taskId);
  const tool = action === 'draft' ? 'relay_plan' : action === 'run' ? 'relay_run' : 'relay_work';
  const args = action === 'create' ? { action, projectId: alpha.id, title: 'New accepted Alpha goal', objective: 'Inspect and verify Alpha.' }
    : action === 'update' ? { action, workId: existing.id, nextAction: 'Inspect the implementation.' }
      : action === 'draft' ? { action, workId: existing.id, steps: [{ title: 'Inspect', instructions: 'Inspect Alpha and report evidence.' }] }
        : { workId: existing.id, instructions: 'Inspect Alpha and report evidence.' };
  const invoke = requestId => runtime.request({ id: requestId, method: 'item/tool/call', params: {
    threadId: parent.threadId, turnId: parent.turnId, tool, arguments: args,
  } });
  await invoke('first-association');
  const goal = action === 'create' ? store.state.workItems.find(item => item.title === args.title) : existing;
  if (action === 'run') await assert.rejects(invoke('duplicate-run'), status(409));
  else await invoke('repeated-association');
  const links = store.state.events.filter(event => event.type === 'work_request');
  assert.equal(links.length, 1);
  assert.equal(task(parent.id).provider, 'codex');
  if (action === 'run') assert.equal(store.state.tasks.find(item => item.workId === goal.id).provider, 'codex');
  assert.equal(links[0].taskId, parent.id); assert.equal(links[0].threadId, parent.threadId);
  assert.equal(links[0].workId, goal.id); assert.equal(links[0].projectId, alpha.id);
  assert.ok(links[0].createdAt);
  const persisted = JSON.parse(store.db.prepare('SELECT value FROM state WHERE id = 1').get().value);
  assert.deepEqual(persisted.events.filter(event => event.type === 'work_request'), links);
  assert.equal(task(parent.id).workId, undefined, 'The master request is not itself a goal run.');
  adapter.finish(task(parent.id));
});

test('different requests can link to the same goal while read-only queries and failed mutations create no links', async t => {
  const { runtime, store, adapter, alpha, work, task } = await fixture(t);
  const goal = work(alpha);
  for (const text of ['Set the next step.', 'Revise that same goal.']) {
    const { taskId } = await runtime.chat(text);
    const parent = task(taskId);
    await runtime.request({ id: text, method: 'item/tool/call', params: {
      threadId: parent.threadId, turnId: parent.turnId, tool: 'relay_work',
      arguments: { action: 'update', workId: goal.id, nextAction: text },
    } });
    adapter.finish(parent);
  }
  const { taskId } = await runtime.chat('What is the current status?');
  const parent = task(taskId);
  for (const [tool, args] of [['relay_work', { action: 'list' }], ['relay_plan', { action: 'get', workId: goal.id }]]) {
    await runtime.request({ id: tool, method: 'item/tool/call', params: { threadId: parent.threadId, turnId: parent.turnId, tool, arguments: args } });
  }
  await assert.rejects(runtime.request({ id: 'invalid-update', method: 'item/tool/call', params: {
    threadId: parent.threadId, turnId: parent.turnId, tool: 'relay_work',
    arguments: { action: 'update', workId: goal.id, status: 'invented-status' },
  } }), status(400));
  const links = store.state.events.filter(event => event.type === 'work_request');
  assert.equal(links.length, 2); assert.equal(new Set(links.map(event => event.taskId)).size, 2);
  assert.ok(links.every(event => event.workId === goal.id && event.taskId !== parent.id));
});

test('one request retains both project associations without duplicate goal links', async t => {
  const { runtime, store, alpha, beta, work, task } = await fixture(t);
  const goals = [work(alpha), work(beta)];
  const { taskId } = await runtime.chat('Prepare the next action for both accepted projects.');
  const parent = task(taskId);
  for (const goal of [...goals, goals[0]]) await runtime.request({ id: 'update-' + goal.id, method: 'item/tool/call', params: {
    threadId: parent.threadId, turnId: parent.turnId, tool: 'relay_work',
    arguments: { action: 'update', workId: goal.id, nextAction: 'Inspect the next useful change.' },
  } });
  const links = store.state.events.filter(event => event.type === 'work_request');
  assert.equal(links.length, 2);
  assert.deepEqual(links.map(event => [event.taskId, event.workId, event.projectId]), goals.map(goal => [parent.id, goal.id, goal.projectId]));
});

test('goal-associated specialists use the registered workspace with read-only authority and inspectable ancestry', async t => {
  const { runtime, store, adapter, alpha, work, task, started } = await fixture(t);
  const goal = work(alpha);
  const { taskId } = await runtime.chat('Independently review the accepted Alpha goal.');
  const parent = task(taskId);
  const delegated = runtime.request({ id: 'associated-specialist', method: 'item/tool/call', params: {
    threadId: parent.threadId, turnId: parent.turnId, tool: 'relay_delegate',
    arguments: { title: 'Alpha independent review', instructions: 'Inspect Alpha and report findings.', workId: goal.id },
  } });
  await waitFor(() => store.state.tasks.some(item => item.kind === 'worker'));
  const worker = await started(store.state.tasks.find(item => item.kind === 'worker').id);
  const observed = { workId: worker.workId, projectId: worker.projectId, parentTaskId: worker.parentTaskId,
    workspace: worker.workspace, permissionMode: worker.permissionMode };
  const providerOptions = adapter.starts.find(thread => thread.id === worker.threadId);
  const links = store.state.events.filter(event => event.type === 'work_request');
  adapter.finish(worker, 'completed', 'Independent review evidence');
  await delegated;
  assert.deepEqual(observed, { workId: goal.id, projectId: alpha.id, parentTaskId: parent.id,
    workspace: alpha.workspace, permissionMode: 'read-only' });
  assert.equal(providerOptions.workspace, alpha.workspace); assert.equal(providerOptions.permissionMode, 'read-only');
  assert.equal(adapter.turns.find(turn => turn.threadId === worker.threadId && turn.id === worker.turnId).text, 'Inspect Alpha and report findings.');
  assert.equal(worker.provider, 'codex');
  assert.deepEqual(providerOptions.tools, []);
  assert.equal(links.length, 1); assert.equal(links[0].workId, goal.id); assert.equal(links[0].taskId, parent.id);
  assert.equal(runtime.board.get(goal.id).status, 'planned', 'A specialist result does not complete the goal.');
  const response = adapter.responses.find(reply => reply.requestId === 'associated-specialist').result;
  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(response.contentItems[0].text), {
    status: 'completed', title: 'Alpha independent review', result: 'Independent review evidence',
  });
});

test('specialist goal association rejects invalid or closed goals before reserving work', async t => {
  const { runtime, store, adapter, alpha, work, task } = await fixture(t);
  const goals = ['paused', 'cancelled', 'completed'].map(value => {
    const goal = work(alpha, value);
    runtime.board.updateWork(goal.id, { status: value, ...(value === 'completed' ? { reviewed: true, completionNote: 'Inspected fixture result.' } : {}) });
    return goal;
  });
  const { taskId } = await runtime.chat('Review an eligible goal.');
  const parent = task(taskId);
  // If the boundary regresses, finish an incorrectly accepted worker so the assertion fails without hanging.
  const startTurn = adapter.startTurn.bind(adapter);
  adapter.startTurn = async options => {
    const turn = await startTurn(options);
    if (options.threadId !== parent.threadId) adapter.finish({ threadId: options.threadId, turnId: turn.id });
    return turn;
  };
  const invoke = workId => runtime.request({ id: 'invalid-specialist', method: 'item/tool/call', params: {
    threadId: parent.threadId, turnId: parent.turnId, tool: 'relay_delegate',
    arguments: { title: 'Review', instructions: 'Inspect and report.', workId },
  } });
  for (const invalid of [null, '', 42, 'x'.repeat(161)]) await assert.rejects(invoke(invalid), status(400));
  await assert.rejects(invoke('missing-goal'), status(404));
  for (const goal of goals) await assert.rejects(invoke(goal.id), status(409));
  assert.equal(store.state.tasks.filter(item => item.kind === 'worker').length, 0);
  assert.equal(adapter.starts.length, 1);
  assert.deepEqual(store.state.events.filter(event => event.type === 'work_request'), []);
});

test('unassigned specialists remain in the coordinator workspace without a fabricated goal relation', async t => {
  const { runtime, store, adapter, task, started } = await fixture(t);
  const { taskId } = await runtime.chat('Independently inspect the local coordinator documentation.');
  const parent = task(taskId);
  const delegated = runtime.delegate(parent, { title: 'Local review', instructions: 'Inspect the coordinator documentation.' });
  await waitFor(() => store.state.tasks.some(item => item.kind === 'worker'));
  const worker = await started(store.state.tasks.find(item => item.kind === 'worker').id);
  adapter.finish(worker);
  await delegated;
  assert.equal(worker.workspace, parent.workspace); assert.equal(worker.permissionMode, 'read-only');
  assert.equal(worker.projectId, undefined); assert.equal(worker.workId, undefined); assert.equal(worker.parentTaskId, parent.id);
  assert.deepEqual(store.state.events.filter(event => event.type === 'work_request'), []);
});

for (const goalStatus of ['paused', 'cancelled']) test(`${goalStatus} goal cancels a specialist opening its thread without starting or replaying its turn`, async t => {
  const { runtime, store, adapter, alpha, beta, work, task, started } = await fixture(t);
  store.change(state => { state.settings.maxWorkers = 1; });
  const goal = work(alpha), otherGoal = work(beta);
  const { taskId } = await runtime.chat('Independently inspect the accepted project work.');
  const parent = task(taskId), originalStart = adapter.startThread.bind(adapter);
  let release;
  adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await originalStart(options)); });
  const delegated = runtime.delegate(parent, { title: 'Delayed Alpha review', instructions: 'Inspect Alpha.', workId: goal.id });
  await waitFor(() => release);
  const workerId = store.state.tasks.find(item => item.kind === 'worker').id;
  await runtime.updateWork(goal.id, { status: goalStatus });
  const statusAfterStop = task(workerId).status;
  const reservedAfterStop = store.state.tasks.filter(item => item.kind === 'worker' && ['queued', 'running', 'waiting'].includes(item.status)).length;
  adapter.startThread = originalStart;
  await release();
  const done = await delegated;
  assert.equal(statusAfterStop, 'cancelled'); assert.equal(reservedAfterStop, 0);
  assert.equal(done.status, 'cancelled'); assert.equal(done.startedAt, null);
  assert.equal(adapter.turns.filter(turn => turn.threadId === done.threadId).length, 0);
  assert.equal(runtime.board.get(goal.id).status, goalStatus);
  // Releasing capacity allows another project, without implicitly reopening the stopped goal.
  const other = runtime.delegate(parent, { title: 'Beta review', instructions: 'Inspect Beta.', workId: otherGoal.id });
  await waitFor(() => store.state.tasks.some(item => item.kind === 'worker' && item.id !== workerId));
  const next = await started(store.state.tasks.find(item => item.kind === 'worker' && item.id !== workerId).id);
  adapter.finish(next); await other;
  if (goalStatus === 'cancelled') await runtime.updateWork(goal.id, { status: 'planned' });
  else runtime.resumeWork(goal.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(task(workerId).status, 'cancelled');
  assert.equal(store.state.tasks.filter(item => item.workId === goal.id).length, 1);
  assert.equal(adapter.turns.filter(turn => turn.threadId === done.threadId).length, 0);
});

for (const interruption of ['cancelRequested', 'pausedGoal']) test(`specialist startup revalidates ${interruption} before beginning a provider turn`, async t => {
  const { runtime, store, adapter, alpha, work, task } = await fixture(t);
  const goal = work(alpha);
  const { taskId } = await runtime.chat('Review the accepted Alpha goal.');
  const parent = task(taskId), originalStart = adapter.startThread.bind(adapter);
  let release;
  adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await originalStart(options)); });
  const delegated = runtime.delegate(parent, { title: 'Delayed review', instructions: 'Inspect Alpha.', workId: goal.id });
  await waitFor(() => release);
  const workerId = store.state.tasks.find(item => item.kind === 'worker').id;
  // Exercise the startup guard independently of updateWork's cancellation path.
  store.change(state => {
    if (interruption === 'cancelRequested') state.tasks.find(item => item.id === workerId).cancelRequested = true;
    else state.workItems.find(item => item.id === goal.id).status = 'paused';
  });
  const startTurn = adapter.startTurn.bind(adapter);
  adapter.startTurn = async options => {
    const turn = await startTurn(options);
    if (options.threadId !== parent.threadId) adapter.finish({ threadId: options.threadId, turnId: turn.id });
    return turn;
  };
  await release();
  const done = await delegated;
  assert.equal(adapter.turns.filter(turn => turn.threadId === done.threadId).length, 0);
  assert.equal(done.status, 'cancelled'); assert.equal(done.startedAt, null);
});

for (const association of ['goal', 'unassigned']) for (const change of ['missing', 'replaced', 'sensitive']) {
  test(`${association} specialist rejects a ${change} workspace before opening a provider thread`, async t => {
    const { runtime, store, adapter, root, alpha, work, task } = await fixture(t);
    const goal = work(alpha);
    const { taskId } = await runtime.chat('Inspect the accepted local work.');
    const parent = task(taskId);
    const workspace = association === 'goal' ? alpha.workspace : parent.workspace;
    await rename(workspace, workspace + '-original');
    if (change !== 'missing') {
      const replacement = join(root, change === 'sensitive' ? '.ssh' : 'different-directory');
      await mkdir(replacement);
      await symlink(replacement, workspace, 'dir');
    }
    // A regressed boundary gets an immediate fixture response, never real directory access.
    const startTurn = adapter.startTurn.bind(adapter);
    adapter.startTurn = async options => {
      const turn = await startTurn(options);
      if (options.threadId !== parent.threadId) adapter.finish({ threadId: options.threadId, turnId: turn.id });
      return turn;
    };
    const done = await runtime.delegate(parent, { title: 'Scoped review', instructions: 'Inspect the registered workspace.',
      ...(association === 'goal' ? { workId: goal.id } : {}) });
    assert.equal(done.status, 'failed'); assert.equal(done.startedAt, null);
    assert.equal(adapter.starts.length, 1, 'Only the original master thread may have opened.');
    assert.equal(adapter.turns.length, 1, 'No specialist turn may run after workspace identity changes.');
    assert.equal(store.state.tasks.filter(item => item.kind === 'worker' && ['queued', 'running', 'waiting'].includes(item.status)).length, 0);
  });
}

test('two project runs start asynchronously while the master answers independently', async t => {
  const { runtime, store, adapter, alpha, beta, work, task, started } = await fixture(t);
  const goalA = work(alpha), goalB = work(beta);
  const a = runtime.startProject(goalA.id, 'Execute Alpha.');
  const b = runtime.startProject(goalB.id, 'Execute Beta.');
  assert.equal(typeof a.then, 'undefined'); assert.equal(a.workId, goalA.id); assert.equal(b.workId, goalB.id);
  assert.equal(task(a.taskId).status, 'queued'); assert.equal(task(b.taskId).status, 'queued');
  assert.equal(adapter.turns.length, 0);
  const [runA, runB] = await Promise.all([started(a.taskId), started(b.taskId)]);
  assert.notEqual(runA.threadId, runB.threadId);
  const master = await runtime.chat('What is running?');
  adapter.finish(task(master.taskId), 'completed', 'Alpha and Beta are running.');
  assert.equal(task(a.taskId).status, 'running'); assert.equal(task(b.taskId).status, 'running');
  assert.equal(adapter.interrupts.length, 0);
  assert.equal(adapter.starts.find(thread => thread.id === runA.threadId).workspace, alpha.workspace);
  assert.equal(adapter.starts.find(thread => thread.id === runA.threadId).permissionMode, 'workspace-write');
  assert.equal(adapter.starts.find(thread => thread.id === runB.threadId).workspace, beta.workspace);
  assert.equal(adapter.starts.find(thread => thread.id === runB.threadId).permissionMode, 'read-only');
  assert.equal(adapter.starts.find(thread => thread.id === store.state.mainThreadId).permissionMode, 'read-only');
  adapter.finish(runB, 'completed', 'Beta observed result');
  adapter.finish(runA, 'completed', 'Alpha observed result');
  assert.equal(runtime.board.get(goalA.id).evidence[0].summary, 'Alpha observed result');
  assert.equal(runtime.board.get(goalB.id).evidence[0].summary, 'Beta observed result');
  assert.equal(store.state.workItems.length, 2);
});

test('relay_run responds before provider startup and its work survives the originating master turn', async t => {
  const { runtime, store, adapter, alpha, work, task, started } = await fixture(t);
  const goal = work(alpha);
  const origin = await runtime.chat('Start the accepted Alpha goal in the background.');
  const masterId = store.state.mainThreadId;
  const originalStart = adapter.startThread.bind(adapter);
  let release;
  adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await originalStart(options)); });
  await runtime.request({ id: 'start-project-tool', method: 'item/tool/call', params: {
    threadId: masterId, turnId: task(origin.taskId).turnId, tool: 'relay_run', arguments: { workId: goal.id },
  } });
  const reply = adapter.responses.find(response => response.requestId === 'start-project-tool').result;
  assert.equal(reply.success, true);
  const accepted = JSON.parse(reply.contentItems[0].text);
  assert.equal(accepted.workId, goal.id); assert.equal(task(accepted.taskId).status, 'queued');
  assert.equal(task(accepted.taskId).parentTaskId, origin.taskId);
  await waitFor(() => release);
  adapter.finish(task(origin.taskId), 'completed', 'Alpha was accepted for background execution.');
  const next = await runtime.chat('A separate casual question.');
  assert.equal(task(next.taskId).threadId, masterId);
  adapter.finish(task(next.taskId));
  await release();
  const execution = await started(accepted.taskId);
  assert.equal(execution.status, 'running'); assert.equal(adapter.interrupts.length, 0);
});

test('the same project rejects overlap and reuses its session after completion and reconnect', async t => {
  const { runtime, adapter, alpha, work, started } = await fixture(t);
  const goal = work(alpha);
  const first = runtime.startProject(goal.id);
  assert.throws(() => runtime.startProject(goal.id), status(409));
  const initial = await started(first.taskId);
  assert.throws(() => runtime.startProject(goal.id), status(409));
  adapter.finish(initial);
  const second = await started(runtime.startProject(goal.id, 'Continue the same accepted goal.').taskId);
  assert.equal(second.threadId, initial.threadId); assert.equal(adapter.starts.length, 1);
  adapter.finish(second);
  adapter.emit('disconnect', { message: 'Fixture reconnect.' });
  await runtime.connect();
  const third = await started(runtime.startProject(goal.id, 'Continue after reconnect.').taskId);
  assert.equal(third.threadId, initial.threadId); assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 1); assert.equal(adapter.resumes[0].id, initial.threadId);
  assert.equal(adapter.resumes[0].workspace, alpha.workspace);
  adapter.finish(third);
  runtime.updateProject(alpha.id, { permissionMode: 'read-only' });
  const fourth = await started(runtime.startProject(goal.id, 'Inspect the result without edits.').taskId);
  assert.equal(fourth.threadId, initial.threadId); assert.equal(fourth.permissionMode, 'read-only');
  assert.equal(adapter.resumes.length, 2); assert.equal(adapter.resumes[1].permissionMode, 'read-only');
  assert.equal(initial.permissionMode, 'workspace-write');
});

test('changing the default project preserves the master and active run permissions', async t => {
  const { runtime, store, adapter, alpha, beta, work, task, started } = await fixture(t);
  const first = await runtime.chat('Remember this conversation.');
  const masterId = store.state.mainThreadId, masterWorkspace = task(first.taskId).workspace;
  adapter.finish(task(first.taskId));
  const run = await started(runtime.startProject(work(alpha).id).taskId);
  await runtime.settings({ defaultProjectId: beta.id, maxWorkers: 2 });
  assert.equal(store.state.mainThreadId, masterId);
  assert.equal(store.state.settings.defaultProjectId, beta.id);
  const followup = await runtime.chat('Now discuss Beta.');
  assert.equal(task(followup.taskId).threadId, masterId); assert.equal(task(followup.taskId).workspace, masterWorkspace);
  assert.equal(adapter.starts.filter(thread => thread.id === masterId).length, 1);
  assert.equal(task(run.id).workspace, alpha.workspace); assert.equal(task(run.id).permissionMode, 'workspace-write');
  await runtime.request({ id: 'alpha-approval', method: 'item/commandExecution/requestApproval', params: {
    threadId: run.threadId, turnId: run.turnId, command: 'fixture', availableDecisions: ['accept', 'decline'],
  } });
  assert.equal(store.state.approvals[0].status, 'pending');
  assert.equal(store.state.approvals[0].taskId, run.id);
});

test('a project result needs review and produces one evidence entry and master notification', async t => {
  const { runtime, store, adapter, alpha, work, started } = await fixture(t);
  const goal = work(alpha);
  const run = await started(runtime.startProject(goal.id).taskId);
  adapter.finish(run, 'completed', 'Verified exact fixture behavior.');
  adapter.finish(run, 'completed', 'A duplicate completion must not replace evidence.');
  const finished = runtime.board.get(goal.id);
  assert.equal(finished.status, 'needs_review'); assert.equal(finished.completedAt, null);
  assert.equal(finished.evidence.length, 1); assert.equal(finished.evidence[0].taskId, run.id);
  assert.equal(finished.evidence[0].summary, 'Verified exact fixture behavior.');
  const notices = store.state.messages.filter(message => message.channel === 'master' && message.taskId === run.id);
  assert.equal(notices.length, 1); assert.match(notices[0].text, /Verified exact fixture behavior/);
  assert.equal(store.state.messages.filter(message => message.channel === 'execution' && message.taskId === run.id).length, 1);
});

test('background delivery is acknowledged only by successful master turns and only for included results', async t => {
  const { runtime, adapter, alpha, beta, work, task, started } = await fixture(t);
  const runA = await started(runtime.startProject(work(alpha).id).taskId);
  adapter.finish(runA, 'completed', 'Alpha delivery evidence');
  const pending = runtime.masterContext();
  assert.deepEqual(pending.deliveryIds, [runA.id]); assert.match(pending.text, /Alpha delivery evidence/);
  const failed = await runtime.chat('Summarize Alpha.');
  assert.deepEqual(runtime.masterContext().deliveryIds, [runA.id]);
  adapter.finish(task(failed.taskId), 'failed');
  assert.deepEqual(runtime.masterContext().deliveryIds, [runA.id]);
  const successful = await runtime.chat('Try that summary again.');
  const runB = await started(runtime.startProject(work(beta).id).taskId);
  adapter.finish(runB, 'completed', 'Beta delivery evidence');
  assert.deepEqual(new Set(runtime.masterContext().deliveryIds), new Set([runA.id, runB.id]));
  adapter.finish(task(successful.taskId), 'completed', 'Alpha is ready for review.');
  assert.deepEqual(runtime.masterContext().deliveryIds, [runB.id]);
});

for (const workStatus of ['paused', 'cancelled']) test('setting a goal ' + workStatus + ' interrupts only its execution', async t => {
  const { runtime, adapter, alpha, beta, work, task, started } = await fixture(t);
  const goalA = work(alpha), goalB = work(beta);
  const runA = await started(runtime.startProject(goalA.id).taskId);
  const runB = await started(runtime.startProject(goalB.id).taskId);
  const main = await runtime.chat('A separate question.');
  await runtime.updateWork(goalA.id, { status: workStatus });
  assert.equal(runtime.board.get(goalA.id).status, workStatus);
  assert.equal(task(runA.id).status, 'cancelled');
  assert.equal(task(runB.id).status, 'running'); assert.equal(task(main.taskId).status, 'running');
  assert.deepEqual(adapter.interrupts.map(item => item.threadId), [runA.threadId]);
  adapter.finish(runA, 'completed', 'Late completion');
  assert.equal(runtime.board.get(goalA.id).status, workStatus);
  adapter.finish(runB); assert.equal(runtime.board.get(goalB.id).status, 'needs_review');
});

test('v1 coordinator rotates once while its visible history and handoff survive', async t => {
  const { runtime, store, adapter, task } = await fixture(t);
  const history = [
    { id: 'old-question', threadId: 'legacy-main', channel: 'master', role: 'user', text: 'Keep LEGACY_HISTORY_MARKER.', status: 'complete' },
    { id: 'old-answer', threadId: 'legacy-main', channel: 'master', role: 'assistant', text: 'The previous answer remains.', status: 'complete' },
  ];
  store.change(state => {
    state.mainThreadId = 'legacy-main';
    state.threads.push({ id: 'legacy-main', role: 'coordinator', workspace: state.coordinatorWorkspace, status: 'idle', toolSpecVersion: 1 });
    state.messages.push(...history);
  });
  const first = await runtime.chat('Continue this conversation.');
  const currentId = store.state.mainThreadId;
  assert.notEqual(currentId, 'legacy-main'); assert.equal(adapter.resumes.length, 0);
  assert.deepEqual(store.state.messages.filter(message => history.some(old => old.id === message.id)), history);
  assert.ok(store.state.threads.some(thread => thread.id === 'legacy-main'));
  assert.equal(store.state.threads.find(thread => thread.id === currentId).toolSpecVersion, 5);
  assert.ok(adapter.starts[0].tools.some(tool => tool.name === 'relay_run'));
  assert.match(adapter.turns[0].text, /LEGACY_HISTORY_MARKER/);
  adapter.finish(task(first.taskId));
  await runtime.chat('One more question.');
  assert.equal(store.state.mainThreadId, currentId); assert.equal(adapter.starts.length, 1);
});

test('project startup cancellation reserves its thread until the pending open finishes', async t => {
  const { runtime, store, adapter, alpha, work, task } = await fixture(t);
  const goal = work(alpha);
  const original = adapter.startThread.bind(adapter);
  let release;
  adapter.startThread = options => new Promise(resolve => { release = async () => resolve(await original(options)); });
  const accepted = runtime.startProject(goal.id);
  await waitFor(() => release);
  await runtime.cancel(accepted.taskId);
  assert.equal(task(accepted.taskId).status, 'cancelled');
  assert.throws(() => runtime.startProject(goal.id), status(409));
  assert.throws(() => runtime.updateProject(alpha.id, { permissionMode: 'read-only' }), status(409));
  await release();
  await waitFor(() => store.state.projects.find(project => project.id === alpha.id).threadId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.turns.length, 0);
  assert.equal(task(accepted.taskId).status, 'cancelled');
});

test('late completion from a previous turn cannot finish a new run awaiting its turn ID', async t => {
  const { runtime, adapter, alpha, work, task, started } = await fixture(t);
  const goal = work(alpha);
  const first = await started(runtime.startProject(goal.id).taskId);
  adapter.finish(first, 'completed', 'First run evidence');
  let release;
  adapter.startTurn = options => new Promise(resolve => {
    adapter.turns.push({ id: 'deferred-next-turn', ...options });
    release = () => resolve({ id: 'deferred-next-turn' });
  });
  const next = runtime.startProject(goal.id, 'Continue the accepted goal.');
  await waitFor(() => release);
  assert.equal(task(next.taskId).turnId, undefined);
  adapter.emit('notification', { method: 'turn/completed', params: {
    threadId: first.threadId, turn: { id: first.turnId, status: 'completed' },
  } });
  const observed = { status: task(next.taskId).status, workStatus: runtime.board.get(goal.id).status, evidence: runtime.board.get(goal.id).evidence.length };
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, { status: 'running', workStatus: 'active', evidence: 1 });
  assert.equal(task(next.taskId).turnId, 'deferred-next-turn');
});

test('cancelling an unacknowledged turn stays active until interruption is confirmed', async t => {
  const { runtime, adapter, alpha, work, task, started } = await fixture(t);
  const goal = work(alpha);
  const originalStart = adapter.startTurn.bind(adapter);
  let release;
  adapter.startTurn = options => new Promise(resolve => {
    adapter.turns.push({ id: 'slow-start-turn', ...options });
    release = () => resolve({ id: 'slow-start-turn' });
  });
  adapter.interrupt = async options => { adapter.interrupts.push(options); };
  const accepted = runtime.startProject(goal.id);
  await waitFor(() => release);
  await runtime.cancel(accepted.taskId);
  assert.equal(task(accepted.taskId).status, 'running');
  assert.equal(task(accepted.taskId).cancelRequested, true);
  await assert.rejects(runtime.updateWork(goal.id, { status: 'completed', reviewed: true, completionNote: 'Cannot complete while provider execution is unresolved.' }), status(409));
  assert.throws(() => runtime.startProject(goal.id), status(409));
  release();
  await waitFor(() => adapter.interrupts.length === 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(task(accepted.taskId).status, 'running');
  assert.equal(task(accepted.taskId).turnId, 'slow-start-turn');
  assert.deepEqual(adapter.interrupts[0], { threadId: task(accepted.taskId).threadId, turnId: 'slow-start-turn' });
  assert.throws(() => runtime.startProject(goal.id), status(409));
  adapter.finish(task(accepted.taskId), 'interrupted');
  assert.equal(task(accepted.taskId).status, 'cancelled');
  adapter.startTurn = originalStart;
  assert.throws(() => runtime.resumeWork(goal.id), status(409));
  const next = await started(runtime.resumeWork(goal.id, { retryInterrupted: true }).taskId);
  assert.equal(next.status, 'running');
});

test('a user-supplied project path does not authorize registration of its ancestor', async t => {
  const { runtime, store, adapter, root, alpha, task } = await fixture(t);
  const origin = await runtime.chat('Register the project directory ' + alpha.workspace + ' only.');
  const count = store.state.projects.length;
  await assert.rejects(runtime.request({ id: 'ancestor-registration', method: 'item/tool/call', params: {
    threadId: task(origin.taskId).threadId, turnId: task(origin.taskId).turnId,
    tool: 'relay_projects', arguments: { action: 'register', name: 'Broader parent', workspace: root },
  } }), status(403));
  assert.equal(store.state.projects.length, count);
  await runtime.request({ id: 'exact-registration', method: 'item/tool/call', params: {
    threadId: task(origin.taskId).threadId, turnId: task(origin.taskId).turnId,
    tool: 'relay_projects', arguments: { action: 'register', name: 'Alpha', workspace: alpha.workspace },
  } });
  assert.equal(adapter.responses.find(response => response.requestId === 'exact-registration').result.success, true);
  assert.equal(store.state.projects.length, count);
});
