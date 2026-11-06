import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';

let serial = 0;
const status = code => error => error.statusCode === code;
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 10)); };
async function waitFor(predicate, reason = 'expected runtime state') {
  const until = Date.now() + 1800;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${reason}.`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

class PlanAdapter extends EventEmitter {
  starts = []; resumes = []; turns = []; responses = []; interrupts = []; overlaps = [];
  activeTurns = new Map(); holdNextStart = false; pendingStart = null; confirmInterrupt = true;
  async connect() { return { version: 'plan-fixture' }; }
  async startThread(params) { const id = `fixture-thread-${++serial}`; this.starts.push({ ...params, id }); return { id }; }
  async resumeThread(params) { this.resumes.push(params); return { id: params.id }; }
  async startTurn(params) {
    const turn = { ...params, id: `fixture-turn-${++serial}` };
    if (this.activeTurns.has(turn.threadId)) this.overlaps.push(turn.threadId);
    this.activeTurns.set(turn.threadId, turn.id); this.turns.push(turn);
    if (this.holdNextStart) {
      this.holdNextStart = false;
      return new Promise(resolve => { this.pendingStart = { turn, resolve }; });
    }
    this.emit('notification', { method: 'turn/started', params: { threadId: turn.threadId, turn: { id: turn.id } } });
    return { id: turn.id };
  }
  releaseStart() {
    const pending = this.pendingStart; this.pendingStart = null;
    this.emit('notification', { method: 'turn/started', params: { threadId: pending.turn.threadId, turn: { id: pending.turn.id } } });
    pending.resolve({ id: pending.turn.id });
  }
  complete(task, { state = 'completed', text = 'Observed fixture execution result.' } = {}) {
    const turnId = task.turnId ?? task.id;
    if (text) this.emit('notification', { method: 'item/completed', params: { threadId: task.threadId, turnId, item: { id: `message-${turnId}`, type: 'agentMessage', phase: 'final_answer', text } } });
    if (this.activeTurns.get(task.threadId) === turnId) this.activeTurns.delete(task.threadId);
    this.emit('notification', { method: 'turn/completed', params: { threadId: task.threadId, turn: { id: turnId, status: state, ...(state === 'failed' ? { error: { message: 'Synthetic provider failure.' } } : {}) } } });
  }
  async interrupt(params) { this.interrupts.push(params); if (this.confirmInterrupt) this.complete(params, { state: 'interrupted', text: '' }); }
  respond(id, result) { this.responses.push({ id, result }); }
  async close() { if (this.pendingStart) { const pending = this.pendingStart; this.pendingStart = null; pending.resolve({ id: pending.turn.id }); } }
}

async function fixture(t, maxWorkers = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-plan-runtime-'));
  const workspaceA = join(dir, 'project-a'); const workspaceB = join(dir, 'project-b');
  await mkdir(workspaceA); await mkdir(workspaceB);
  const state = { dir, dataDir: join(dir, 'data'), workspaceA, workspaceB };
  state.store = new Store(state.dataDir, workspaceA); state.adapter = new PlanAdapter(); state.runtime = new Runtime(state.store, state.adapter);
  state.store.change(snapshot => { snapshot.settings.maxWorkers = maxWorkers; });
  state.projectA = state.store.state.settings.defaultProjectId;
  state.projectB = (await state.runtime.board.registerProject({ name: 'Project B', workspace: workspaceB })).id;
  t.after(async () => { await state.runtime.close(); await settle(); state.store.close(); await rm(dir, { recursive: true, force: true }); });
  await state.runtime.connect(); return state;
}
const goal = (f, title, projectId = f.projectA) => f.runtime.board.createWork({ projectId, title, objective: `Deliver and verify the accepted ${title} outcome.` });
const task = (f, id) => f.store.state.tasks.find(item => item.id === id);
const attempts = (f, workId) => f.store.state.tasks.filter(item => item.workId === workId && item.kind === 'project');
async function running(f, id) { await waitFor(() => task(f, id)?.turnId, 'provider turn to start'); return task(f, id); }
async function plan(f, title = 'Two-step plan', projectId = f.projectA) {
  const work = goal(f, title, projectId);
  return f.runtime.board.setPlan(work.id, { steps: [
    { title: 'Inspect the bounded change', instructions: 'Inspect the accepted scope and report the concrete findings.' },
    { title: 'Verify the bounded outcome', instructions: 'Perform the focused verification and report the observed result.' },
  ] });
}
async function startPlan(f, work, autoContinue = true) {
  await f.runtime.startPlan(work.id, { planId: work.plan.id, reviewed: true, autoContinue });
  await waitFor(() => attempts(f, work.id).some(item => item.turnId), 'first plan turn');
  return attempts(f, work.id).find(item => item.turnId && ['running', 'waiting'].includes(item.status));
}
const ready = (f, current, summary = 'Agent reports the assigned checkpoint was reached.') => f.runtime.reportCheckpoint(current, { state: 'ready', summary });
async function invoke(f, current, tool, args) {
  const id = `request-${++serial}`;
  f.adapter.emit('request', { id, method: 'item/tool/call', params: { threadId: current.threadId, turnId: current.turnId, tool, arguments: args } });
  await waitFor(() => f.adapter.responses.some(response => response.id === id), 'tool response');
  return f.adapter.responses.find(response => response.id === id).result;
}
async function restart(f) {
  await settle(); f.runtime.closing = true; f.adapter.removeAllListeners(); f.store.close();
  f.store = new Store(f.dataDir, f.workspaceA); f.adapter = new PlanAdapter(); f.runtime = new Runtime(f.store, f.adapter);
  await f.runtime.connect(); await settle();
}

test('FIFO queue skips busy projects, respects shared capacity, and leaves ordinary chat responsive', async t => {
  const f = await fixture(t, 2);
  const a1 = goal(f, 'A first'); const a2 = goal(f, 'A second'); const b1 = goal(f, 'B first', f.projectB); const b2 = goal(f, 'B second', f.projectB);
  const accepted = [a1, a2, b1, b2].map(work => f.runtime.startProject(work.id));
  assert.ok(accepted.every(result => result.queued === true));
  await running(f, accepted[0].taskId); await running(f, accepted[2].taskId);
  assert.equal(task(f, accepted[1].taskId).queueState, 'waiting'); assert.equal(task(f, accepted[3].taskId).queueState, 'waiting');
  assert.equal(f.adapter.turns.length, 2);
  const chat = await f.runtime.chat('What is the current status?'); const main = await running(f, chat.taskId);
  assert.equal(f.store.state.workItems.length, 4); assert.equal(main.permissionMode, 'read-only'); f.adapter.complete(main);
  f.adapter.complete(task(f, accepted[0].taskId)); await running(f, accepted[1].taskId);
  assert.equal(task(f, accepted[3].taskId).queueState, 'waiting');
  f.adapter.complete(task(f, accepted[2].taskId)); await running(f, accepted[3].taskId);
  assert.equal(task(f, accepted[0].taskId).threadId, task(f, accepted[1].taskId).threadId);
  assert.equal(task(f, accepted[2].taskId).threadId, task(f, accepted[3].taskId).threadId);
  assert.deepEqual(f.adapter.overlaps, []);
});

test('specialists share running capacity while queued goals consume no worker slots', async t => {
  const f = await fixture(t, 2);
  const first = f.runtime.startProject(goal(f, 'A occupies a slot').id); await running(f, first.taskId);
  const waitingA = f.runtime.startProject(goal(f, 'A waits for its thread').id);
  const chat = await f.runtime.chat('Perform the accepted bounded independent review.'); const master = await running(f, chat.taskId);
  const delegation = f.runtime.delegate(master, { title: 'Bounded specialist', instructions: 'Read the assigned fixture and report the observation.' });
  await waitFor(() => f.store.state.tasks.some(item => item.kind === 'worker' && item.turnId), 'specialist slot');
  const worker = f.store.state.tasks.find(item => item.kind === 'worker');
  assert.equal(worker.permissionMode, 'read-only');
  const waitingB = f.runtime.startProject(goal(f, 'B waits for capacity', f.projectB).id); await settle();
  assert.equal(task(f, waitingA.taskId).queueState, 'waiting'); assert.equal(task(f, waitingB.taskId).queueState, 'waiting');
  f.adapter.complete(task(f, first.taskId)); await running(f, waitingA.taskId);
  assert.equal(task(f, waitingB.taskId).queueState, 'waiting');
  f.adapter.complete(worker); assert.equal((await delegation).status, 'completed'); await running(f, waitingB.taskId);
  assert.deepEqual(f.adapter.overlaps, []);
});

test('queue rejects duplicate unfinished goals and enforces the 50-attempt bound', async t => {
  const f = await fixture(t, 1); const firstGoal = goal(f, 'First bounded queue item');
  f.runtime.startProject(firstGoal.id);
  assert.throws(() => f.runtime.startProject(firstGoal.id), status(409));
  for (let index = 1; index < 50; index++) f.runtime.startProject(goal(f, `Bounded queue item ${index}`).id);
  assert.throws(() => f.runtime.startProject(goal(f, 'Beyond queue bound').id), status(409));
  assert.equal(f.store.state.tasks.filter(item => item.kind === 'project').length, 50);
});

test('a queued goal can be held and explicitly resumed without a fresh attempt', async t => {
  const f = await fixture(t, 1); const first = f.runtime.startProject(goal(f, 'Occupy the slot').id); await running(f, first.taskId);
  const waiting = goal(f, 'Wait then resume', f.projectB); const queued = f.runtime.startProject(waiting.id);
  await f.runtime.updateWork(waiting.id, { status: 'paused' });
  assert.equal(task(f, queued.taskId).status, 'queued'); assert.equal(task(f, queued.taskId).queueState, 'held');
  assert.equal(f.adapter.interrupts.length, 0);
  f.adapter.complete(task(f, first.taskId)); await settle(); assert.equal(f.adapter.turns.length, 1);
  await f.runtime.resumeWork(waiting.id, {}); await running(f, queued.taskId);
  assert.equal(attempts(f, waiting.id).length, 1); assert.equal(f.adapter.turns.length, 2);
});

test('cancelling queued work never starts it after capacity becomes available', async t => {
  const f = await fixture(t, 1); const first = f.runtime.startProject(goal(f, 'Occupy cancellation slot').id); await running(f, first.taskId);
  const waiting = goal(f, 'Cancel before execution', f.projectB); const queued = f.runtime.startProject(waiting.id);
  await f.runtime.updateWork(waiting.id, { status: 'cancelled' });
  assert.equal(task(f, queued.taskId).status, 'cancelled'); assert.equal(f.adapter.interrupts.length, 0);
  f.adapter.complete(task(f, first.taskId)); await settle(); assert.equal(f.adapter.turns.length, 1);
  await assert.rejects(async () => f.runtime.resumeWork(waiting.id, {}), status(409));
});

test('only the exact reviewed plan runs and ready checkpoints need terminal provider evidence', async t => {
  const f = await fixture(t); const work = await plan(f);
  await assert.rejects(async () => f.runtime.startPlan(work.id, { planId: 'obsolete', reviewed: true, autoContinue: true }), status(409));
  await assert.rejects(async () => f.runtime.startPlan(work.id, { planId: work.plan.id, reviewed: false, autoContinue: true }), status(400));
  await assert.rejects(async () => f.runtime.startProject(work.id), status(409));
  assert.equal(attempts(f, work.id).length, 0);
  const first = await startPlan(f, work); await ready(f, first); await settle();
  assert.equal(attempts(f, work.id).length, 1); assert.equal(task(f, first.id).checkpoint.source, 'agent_report');
  assert.notEqual(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
  f.adapter.complete(task(f, first.id));
  await waitFor(() => attempts(f, work.id).length === 2, 'next reviewed step');
  const second = await running(f, attempts(f, work.id)[1].id);
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
  assert.equal(second.stepId, work.plan.steps[1].id); assert.equal(second.threadId, first.threadId);
  await ready(f, second); f.adapter.complete(task(f, second.id)); await settle();
  const final = f.runtime.board.get(work.id);
  assert.equal(final.plan.status, 'needs_review'); assert.equal(final.status, 'needs_review');
  assert.equal(final.completedAt, null); assert.ok(final.plan.steps.every(step => step.status === 'finished'));
  assert.equal(f.store.state.messages.filter(message => message.source === 'project' && message.workId === work.id).length, 2);
});

test('autoContinue false pauses between finished steps until explicit resume', async t => {
  const f = await fixture(t); const work = await plan(f, 'Manual continuation'); const first = await startPlan(f, work, false);
  await ready(f, first); f.adapter.complete(first); await settle();
  assert.equal(attempts(f, work.id).length, 1); assert.equal(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
  assert.equal(f.runtime.board.get(work.id).plan.status, 'paused');
  await f.runtime.resumeWork(work.id, {});
  await waitFor(() => attempts(f, work.id).length === 2, 'explicit next step'); await running(f, attempts(f, work.id)[1].id);
  assert.equal(attempts(f, work.id)[1].stepId, work.plan.steps[1].id);
});

test('pause freezes continuation before interruption and late success cannot restart the plan', async t => {
  const f = await fixture(t); const work = await plan(f, 'Pause during terminal race'); const first = await startPlan(f, work);
  await ready(f, first); f.adapter.confirmInterrupt = false;
  await f.runtime.updateWork(work.id, { status: 'paused' });
  assert.equal(task(f, first.id).status, 'running'); assert.equal(task(f, first.id).cancelRequested, true);
  assert.equal(f.runtime.board.get(work.id).plan.status, 'paused'); assert.equal(f.adapter.interrupts.length, 1);
  await assert.rejects(async () => f.runtime.resumeWork(work.id, {}), status(409));
  f.adapter.complete(task(f, first.id)); await settle();
  assert.equal(f.runtime.board.get(work.id).status, 'paused'); assert.equal(f.runtime.board.get(work.id).plan.status, 'paused');
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].status, 'finished'); assert.equal(attempts(f, work.id).length, 1);
});

test('cancelling a task freezes its plan before a late ready checkpoint and successful completion', async t => {
  const f = await fixture(t); const work = await plan(f, 'Stop task during terminal race'); const first = await startPlan(f, work);
  f.adapter.confirmInterrupt = false;
  await f.runtime.cancel(first.id);
  assert.equal(task(f, first.id).status, 'running'); assert.equal(task(f, first.id).cancelRequested, true);
  assert.equal(f.runtime.board.get(work.id).status, 'paused'); assert.equal(f.runtime.board.get(work.id).plan.status, 'paused');
  await ready(f, task(f, first.id)); f.adapter.complete(task(f, first.id)); await settle();
  assert.equal(task(f, first.id).status, 'completed', 'the late provider result remains truthful');
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
  assert.equal(f.runtime.board.get(work.id).status, 'paused'); assert.equal(f.runtime.board.get(work.id).plan.status, 'paused');
  assert.equal(attempts(f, work.id).length, 1); assert.equal(f.adapter.turns.length, 1);
});

for (const checkpoint of ['missing', 'blocked']) test(`${checkpoint} checkpoint halts a successful provider turn without inventing goal success`, async t => {
  const f = await fixture(t); const work = await plan(f, `${checkpoint} checkpoint`); const first = await startPlan(f, work);
  if (checkpoint === 'blocked') await f.runtime.reportCheckpoint(first, { state: 'blocked', summary: 'The required acceptance check is still failing.' });
  f.adapter.complete(first); await settle();
  assert.equal(task(f, first.id).status, 'completed', 'provider completion remains truthful');
  assert.equal(attempts(f, work.id).length, 1); assert.equal(f.runtime.board.get(work.id).plan.status, 'blocked');
  assert.equal(f.runtime.board.get(work.id).status, 'blocked');
  assert.notEqual(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
});

test('a ready checkpoint cannot advance a failed provider turn', async t => {
  const f = await fixture(t); const work = await plan(f, 'Failure after checkpoint'); const first = await startPlan(f, work);
  await ready(f, first); f.adapter.complete(first, { state: 'failed' }); await settle();
  assert.equal(task(f, first.id).status, 'failed'); assert.equal(attempts(f, work.id).length, 1);
  assert.equal(f.runtime.board.get(work.id).plan.status, 'blocked'); assert.notEqual(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
});

test('recovery metadata cannot masquerade as an agent ready checkpoint', async t => {
  const f = await fixture(t); const work = await plan(f, 'Provenance-bound checkpoint'); const first = await startPlan(f, work);
  f.store.change(state => { state.tasks.find(item => item.id === first.id).checkpoint = { state: 'ready', summary: 'Recovery metadata is not an agent report.', source: 'system_recovery', createdAt: new Date().toISOString() }; });
  f.adapter.complete(first); await settle();
  assert.equal(attempts(f, work.id).length, 1); assert.equal(f.runtime.board.get(work.id).plan.status, 'blocked');
  assert.notEqual(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
});

test('retry requires acknowledgment, creates a fresh attempt, and preserves finished steps', async t => {
  const f = await fixture(t); const work = await plan(f, 'Explicit uncertain retry'); const first = await startPlan(f, work);
  await ready(f, first); f.adapter.complete(first);
  await waitFor(() => attempts(f, work.id).length === 2, 'second step'); const second = await running(f, attempts(f, work.id)[1].id);
  f.adapter.complete(second, { state: 'interrupted', text: '' }); await settle();
  const finished = structuredClone(f.runtime.board.get(work.id).plan.steps[0]);
  await assert.rejects(async () => f.runtime.resumeWork(work.id, {}), status(409));
  await f.runtime.resumeWork(work.id, { retryInterrupted: true });
  await waitFor(() => attempts(f, work.id).length === 3, 'fresh retry attempt'); const retry = await running(f, attempts(f, work.id)[2].id);
  assert.notEqual(retry.id, second.id); assert.equal(retry.stepId, second.stepId);
  assert.deepEqual(f.runtime.board.get(work.id).plan.steps[0], finished);
  assert.deepEqual(f.runtime.board.get(work.id).plan.steps[1].attemptIds, [second.id, retry.id]);
  assert.notEqual(task(f, second.id).status, 'running'); assert.equal(attempts(f, work.id).filter(item => item.stepId === first.stepId).length, 1);
});

test('a fresh retry clears the previous step checkpoint and requires its own ready report', async t => {
  const f = await fixture(t); const work = await plan(f, 'No stale checkpoint on retry'); const first = await startPlan(f, work);
  await ready(f, first, 'The previous attempt reported ready before its provider failure.');
  f.adapter.complete(task(f, first.id), { state: 'failed' }); await settle();
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].checkpoint.state, 'ready');
  await f.runtime.resumeWork(work.id, { retryInterrupted: true });
  await waitFor(() => attempts(f, work.id).length === 2, 'fresh checkpoint retry');
  const retry = await running(f, attempts(f, work.id)[1].id);
  assert.equal(retry.stepId, first.stepId); assert.notEqual(retry.id, first.id);
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].checkpoint, null);
  assert.equal(retry.checkpoint ?? null, null); assert.equal(task(f, first.id).checkpoint.state, 'ready', 'historical evidence remains attached to its original attempt');
  f.adapter.complete(retry); await settle();
  assert.equal(attempts(f, work.id).length, 2); assert.equal(f.runtime.board.get(work.id).plan.status, 'blocked');
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].status, 'blocked');
  assert.equal(f.runtime.board.get(work.id).plan.steps[1].status, 'pending');
});

test('restart holds waiting work and never replays a plan until explicit recovery', async t => {
  const f = await fixture(t, 1); const work = await plan(f, 'Recover partial plan'); const first = await startPlan(f, work);
  await ready(f, first); f.adapter.complete(first);
  await waitFor(() => attempts(f, work.id).length === 2, 'step before crash'); const uncertain = await running(f, attempts(f, work.id)[1].id);
  const waiting = goal(f, 'Never started before restart', f.projectB); const queued = f.runtime.startProject(waiting.id); await settle();
  await restart(f);
  assert.equal(f.adapter.turns.length, 0); assert.equal(task(f, queued.taskId).queueState, 'held');
  assert.equal(task(f, uncertain.id).status, 'interrupted'); assert.equal(f.runtime.board.get(work.id).recoveryRequired, true);
  assert.equal(f.runtime.board.get(work.id).plan.steps[0].status, 'finished');
  await assert.rejects(async () => f.runtime.resumeWork(work.id, {}), status(409));
  await f.runtime.resumeWork(waiting.id, {}); await running(f, queued.taskId);
  assert.equal(attempts(f, waiting.id).length, 1); f.adapter.complete(task(f, queued.taskId));
  await f.runtime.resumeWork(work.id, { retryInterrupted: true });
  await waitFor(() => attempts(f, work.id).length === 3, 'recovery retry'); const retried = await running(f, attempts(f, work.id)[2].id);
  assert.equal(retried.stepId, uncertain.stepId); assert.notEqual(retried.id, uncertain.id);
  assert.equal(attempts(f, work.id).filter(item => item.stepId === first.stepId).length, 1);
});

test('queued approved work holds on permission drift and never silently widens its task snapshot', async t => {
  const f = await fixture(t, 1); const blocker = f.runtime.startProject(goal(f, 'Capacity blocker', f.projectB).id); await running(f, blocker.taskId);
  const work = await plan(f, 'Permission-bound plan');
  await f.runtime.startPlan(work.id, { planId: work.plan.id, reviewed: true, autoContinue: true });
  const queued = attempts(f, work.id)[0];
  f.store.change(state => { state.projects.find(project => project.id === f.projectA).permissionMode = 'workspace-write'; });
  f.adapter.complete(task(f, blocker.taskId));
  await waitFor(() => task(f, queued.id).queueState === 'held', 'permission mismatch hold');
  assert.equal(task(f, queued.id).permissionMode, 'read-only'); assert.equal(f.runtime.board.get(work.id).plan.approvedPermissionMode, 'read-only');
  await assert.rejects(async () => f.runtime.resumeWork(work.id, { retryInterrupted: true }), status(409));
  await settle(); assert.equal(f.adapter.turns.length, 1);
});

test('late old turn events and checkpoint calls cannot bind to a newly starting step', async t => {
  const f = await fixture(t); const work = await plan(f, 'Ignore stale provider events'); const first = await startPlan(f, work);
  await ready(f, first); f.adapter.holdNextStart = true; f.adapter.complete(first);
  await waitFor(() => f.adapter.pendingStart, 'next turn acknowledgment gap'); const second = attempts(f, work.id)[1];
  f.adapter.emit('notification', { method: 'turn/started', params: { threadId: first.threadId, turn: { id: first.turnId } } });
  f.adapter.complete(first, { text: 'STALE_RESULT_MUST_NOT_COMPLETE_NEW_ATTEMPT' });
  const response = await invoke(f, first, 'relay_checkpoint', { state: 'ready', summary: 'STALE_CHECKPOINT' });
  assert.notEqual(response.success, true); assert.equal(task(f, second.id).status, 'running');
  assert.equal(task(f, second.id).turnId, undefined); assert.equal(task(f, second.id).checkpoint, undefined);
  assert.equal(task(f, second.id).result, '');
  f.adapter.releaseStart(); await running(f, second.id);
  assert.notEqual(task(f, second.id).turnId, first.turnId); assert.deepEqual(f.adapter.overlaps, []);
});

test('v3 tools rotate legacy master/project sessions once, preserve history, and reuse new sessions', async t => {
  const f = await fixture(t); const work = goal(f, 'Continue a legacy project'); const marker = 'LEGACY_PROJECT_RESULT_FOR_BOUNDED_HANDOFF';
  f.store.change(state => {
    state.mainThreadId = 'legacy-master'; state.projects.find(project => project.id === f.projectA).threadId = 'legacy-project';
    state.threads.push({ id: 'legacy-master', role: 'coordinator', toolSpecVersion: 2, workspace: f.workspaceA, status: 'idle' }, { id: 'legacy-project', role: 'project', projectId: f.projectA, toolSpecVersion: 2, workspace: f.workspaceA, status: 'idle' });
    state.tasks.push({ id: 'legacy-attempt', threadId: 'legacy-project', projectId: f.projectA, workId: work.id, kind: 'project', status: 'completed', result: marker, createdAt: new Date().toISOString(), contextDeliveredAt: new Date().toISOString() });
    state.messages.push({ id: 'legacy-master-message', threadId: 'legacy-master', channel: 'master', role: 'user', text: 'Continue the accepted project.', status: 'complete' }, { id: 'legacy-project-message', threadId: 'legacy-project', taskId: 'legacy-attempt', channel: 'execution', role: 'assistant', phase: 'final_answer', text: marker, status: 'complete' });
  });
  const chat = await f.runtime.chat('What is the current status?'); const master = await running(f, chat.taskId);
  assert.notEqual(master.threadId, 'legacy-master'); assert.equal(f.store.state.threads.find(thread => thread.id === master.threadId).toolSpecVersion, 5);
  assert.ok(f.adapter.starts.find(entry => entry.id === master.threadId).tools.some(tool => tool.name === 'relay_plan')); f.adapter.complete(master);
  const first = f.runtime.startProject(work.id); const current = await running(f, first.taskId);
  assert.notEqual(current.threadId, 'legacy-project'); assert.equal(f.store.state.threads.find(thread => thread.id === current.threadId).toolSpecVersion, 3);
  assert.ok(f.adapter.starts.find(entry => entry.id === current.threadId).tools.some(tool => tool.name === 'relay_checkpoint'));
  assert.ok(JSON.stringify(f.adapter.turns).includes(marker)); f.adapter.complete(current); const opened = f.adapter.starts.length;
  const next = f.runtime.startProject(goal(f, 'Reuse upgraded session').id); await running(f, next.taskId);
  assert.equal(task(f, next.taskId).threadId, current.threadId); assert.equal(f.adapter.starts.length, opened);
  f.adapter.complete(task(f, next.taskId)); f.adapter.emit('disconnect', { message: 'Synthetic reconnect boundary.' }); await f.runtime.connect();
  const resumed = f.runtime.startProject(goal(f, 'Resume upgraded session').id); await running(f, resumed.taskId);
  assert.equal(task(f, resumed.taskId).threadId, current.threadId); assert.equal(f.adapter.starts.length, opened);
  assert.ok(f.adapter.resumes.some(entry => entry.id === current.threadId));
  assert.ok(f.store.state.threads.some(thread => thread.id === 'legacy-project')); assert.ok(f.store.state.messages.some(message => message.id === 'legacy-project-message'));
  assert.ok(!f.adapter.resumes.some(entry => ['legacy-project', 'legacy-master'].includes(entry.id)));
});

test('model tools can draft but never approve a plan; checkpoint tool is project-only', async t => {
  const f = await fixture(t); const work = goal(f, 'Model-drafted bounded plan');
  const chat = await f.runtime.chat('Draft the finite plan for the accepted goal.'); const master = await running(f, chat.taskId);
  const drafted = await invoke(f, master, 'relay_plan', { action: 'draft', workId: work.id, steps: [{ title: 'Inspect', instructions: 'Inspect the bounded accepted scope.' }] });
  assert.equal(drafted.success, true); const planId = f.runtime.board.get(work.id).plan.id;
  const approval = await invoke(f, master, 'relay_plan', { action: 'approve', workId: work.id, planId, reviewed: true, autoContinue: true });
  assert.notEqual(approval.success, true); assert.equal(f.runtime.board.get(work.id).plan.approvedAt, null); assert.equal(attempts(f, work.id).length, 0);
  const checkpoint = await invoke(f, master, 'relay_checkpoint', { state: 'ready', summary: 'Coordinator must not fabricate execution checkpoints.' });
  assert.notEqual(checkpoint.success, true); assert.equal(task(f, master.id).checkpoint, undefined);
});
