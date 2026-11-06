import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { WorkBoard } from '../server/work.mjs';

const status = code => error => error.statusCode === code;
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-work-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project-one');
  const secondWorkspace = join(root, 'project-two');
  await mkdir(workspace); await mkdir(secondWorkspace);
  return { root, workspace, secondWorkspace };
}
async function fixture(t) {
  const paths = await directory(t);
  const store = new Store(join(paths.root, 'data'), paths.workspace);
  t.after(() => store.close());
  const board = new WorkBoard(store);
  const project = board.project(store.state.settings.defaultProjectId);
  return { ...paths, store, board, project };
}
const draft = projectId => ({ projectId, title: 'Improve a bounded flow', objective: 'Deliver the accepted change and verify its visible behavior.' });

test('review receipts retain their exact note and date after reopening and restart', async t => {
  const { store, board, project, root, workspace } = await fixture(t);
  const work = board.createWork(draft(project.id));
  board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: 'Inspected the keyboard flow.' });
  const receipts = structuredClone(store.state.events.filter(event => event.type === 'work_review'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].workId, work.id);
  assert.equal(receipts[0].createdAt, board.get(work.id).completedAt);
  assert.equal(receipts[0].detail, 'Inspected the keyboard flow.');
  board.updateWork(work.id, { status: 'active', nextAction: 'Check an additional edge case.' });
  assert.equal(board.get(work.id).completedAt, null);
  assert.deepEqual(store.state.events.filter(event => event.type === 'work_review'), receipts);
  store.close();
  const restored = new Store(join(root, 'data'), workspace); t.after(() => restored.close());
  assert.deepEqual(restored.state.events.filter(event => event.type === 'work_review'), receipts);
});

test('legacy migration is additive and idempotent; everyday questions never become goals', async t => {
  const { root, workspace, secondWorkspace } = await directory(t);
  const data = join(root, 'data'); await mkdir(data);
  const legacy = {
    meta: { version: '0.1.0', timezone: 'America/Toronto' },
    settings: { workspace, permissionMode: 'workspace-write', maxWorkers: 2 },
    connection: { provider: 'codex', status: 'connected' },
    mainThreadId: 'legacy-main',
    threads: [{ id: 'legacy-main', role: 'coordinator', status: 'idle', toolSpecVersion: 1 }, { id: 'worker', role: 'worker', status: 'idle' }],
    tasks: [{ id: 'question', title: "Why can't you inspect?", kind: 'request', status: 'completed', result: 'Existing answer' }],
    messages: [{ id: 'question-message', threadId: 'legacy-main', role: 'user', text: "Why can't you inspect?", status: 'complete' }, { id: 'worker-message', threadId: 'worker', text: 'Worker detail', status: 'complete' }],
    events: [{ id: 'old-event', type: 'request', title: 'Existing event' }], approvals: [], skills: [],
  };
  const db = new DatabaseSync(join(data, 'relay.sqlite'));
  db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO state VALUES (1, ?)').run(JSON.stringify(legacy)); db.close();
  const first = new Store(data, secondWorkspace);
  const defaultId = first.state.settings.defaultProjectId;
  assert.equal(first.state.schemaVersion, 3); assert.equal(first.state.meta.version, '0.4.0');
  assert.equal(first.state.coordinatorWorkspace, workspace);
  assert.equal(first.state.projects.length, 1); assert.equal(first.state.projects[0].permissionMode, 'workspace-write');
  assert.equal(first.state.projects[0].workspace, await realpath(workspace)); assert.equal(first.state.projects[0].threadId, null);
  assert.match(defaultId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.state.workItems, []); assert.deepEqual(first.state.tasks, legacy.tasks);
  assert.deepEqual(first.state.events, legacy.events); assert.equal(first.state.mainThreadId, 'legacy-main');
  assert.equal(first.state.threads.length, 2); assert.equal(first.state.threads[0].toolSpecVersion, 1);
  assert.equal(first.state.messages[0].channel, 'master'); assert.equal(first.state.messages[1].channel, undefined);
  const projects = structuredClone(first.state.projects);
  first.change(state => { state.settings.workspace = secondWorkspace; }); first.close();
  const second = new Store(data, secondWorkspace); t.after(() => second.close());
  assert.equal(second.state.settings.defaultProjectId, defaultId); assert.deepEqual(second.state.projects, projects);
  assert.equal(second.state.coordinatorWorkspace, workspace); assert.deepEqual(second.state.workItems, []);
});

test('restart interrupts linked runs without replaying them and preserves user pauses', async t => {
  const { root, workspace } = await directory(t);
  const data = join(root, 'data');
  const first = new Store(data, workspace); const board = new WorkBoard(first);
  const projectId = first.state.settings.defaultProjectId;
  const running = board.createWork(draft(projectId)); const paused = board.createWork({ ...draft(projectId), title: 'Paused goal' });
  first.change(state => {
    state.workItems.find(work => work.id === running.id).status = 'active';
    state.workItems.find(work => work.id === paused.id).status = 'paused';
    state.tasks.push({ id: 'run-active', projectId, workId: running.id, kind: 'project', status: 'running' }, { id: 'run-paused', projectId, workId: paused.id, kind: 'project', status: 'waiting', cancelRequested: true });
    state.approvals.push({ id: 'approval', status: 'pending' });
  }); first.close();
  const second = new Store(data, workspace);
  const restarted = new WorkBoard(second).get(running.id);
  assert.equal(restarted.status, 'blocked'); assert.match(restarted.nextAction, /explicitly start.*resume/);
  assert.equal(restarted.evidence.length, 1); assert.equal(restarted.evidence[0].taskId, 'run-active');
  assert.equal(restarted.evidence[0].status, 'interrupted');
  assert.equal(new WorkBoard(second).get(paused.id).status, 'paused');
  assert.ok(second.state.tasks.every(task => task.status === 'interrupted'));
  assert.equal(second.state.approvals[0].status, 'expired');
  const evidence = structuredClone(restarted.evidence); second.close();
  const third = new Store(data, workspace); t.after(() => third.close());
  assert.equal(third.state.tasks.length, 2); assert.deepEqual(new WorkBoard(third).get(running.id).evidence, evidence);
});

test('registration canonicalizes paths and duplicate registration cannot escalate permissions', async t => {
  const { root, board, store, secondWorkspace } = await fixture(t);
  const project = await board.registerProject({ name: 'Second', workspace: secondWorkspace });
  assert.equal(project.permissionMode, 'read-only'); assert.equal(project.threadId, null);
  const alias = join(root, 'second-alias'); await symlink(secondWorkspace, alias);
  const repeated = await board.registerProject({ name: 'Unrequested rename', workspace: alias, permissionMode: 'workspace-write' });
  assert.equal(repeated.id, project.id); assert.equal(repeated.name, 'Second'); assert.equal(repeated.permissionMode, 'read-only');
  const third = join(root, 'third'); await mkdir(third);
  await assert.rejects(board.registerProject({ name: 'SECOND', workspace: third }), status(409));
  const together = await Promise.all([board.registerProject({ name: 'Third', workspace: third }), board.registerProject({ name: 'Third', workspace: third })]);
  assert.equal(together[0].id, together[1].id); assert.equal(store.state.projects.length, 3);
});

test('work creation and updates reject invalid or credential-bearing definitions without altering evidence', async t => {
  const { board, project, workspace } = await fixture(t);
  for (const input of [
    { name: '', workspace }, { name: 'x'.repeat(101), workspace }, { name: 'Bad', workspace, permissionMode: 'full-access' },
    { name: 'Bad', workspace, permissionMode: null },
    { name: 'API_KEY=CANARY_PROJECT_SECRET', workspace }, { name: 'Bad', workspace: '/' },
  ]) await assert.rejects(board.registerProject(input), status(400));
  for (const patch of [{ title: '' }, { title: 'x'.repeat(121) }, { objective: 'x'.repeat(4001) }, { nextAction: 'x'.repeat(1001) }, { objective: 'API_KEY=CANARY_OBJECTIVE_SECRET' }, { evidence: [{ summary: 'invented' }] }]) {
    assert.throws(() => board.createWork({ ...draft(project.id), ...patch }), status(400));
  }
  assert.throws(() => board.createWork(draft('unknown')), status(404));
  const work = board.createWork(draft(project.id));
  assert.equal(work.status, 'planned'); assert.deepEqual(work.evidence, []); assert.equal(work.nextAction, '');
  assert.throws(() => board.updateWork(work.id, { evidence: [{ summary: 'invented' }] }, { actor: 'model' }), status(400));
  assert.throws(() => board.updateWork(work.id, { projectId: 'different' }), status(400));
  assert.throws(() => board.updateWork(work.id, { nextAction: 'password=CANARY_UPDATE_SECRET' }), status(400));
  assert.deepEqual(board.get(work.id).evidence, []);
});

test('only explicit user review can complete work, and model updates cannot fake that review', async t => {
  const { board, project } = await fixture(t); const work = board.createWork(draft(project.id));
  for (const forbidden of ['completed', 'paused', 'cancelled']) {
    assert.throws(() => board.updateWork(work.id, { status: forbidden, reviewed: true, completionNote: 'Claimed done' }, { actor: 'model' }), status(403));
  }
  assert.throws(() => board.updateWork(work.id, { completionNote: 'Claimed done' }, { actor: 'model' }), status(403));
  assert.throws(() => board.updateWork(work.id, { status: 'completed' }), status(400));
  assert.throws(() => board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: ' ' }), status(400));
  assert.throws(() => board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: 'x'.repeat(2001) }), status(400));
  assert.equal(board.updateWork(work.id, { status: 'needs_review', nextAction: 'Check the observed output.' }, { actor: 'model' }).status, 'needs_review');
  const completed = board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: 'I verified the visible result.' });
  assert.equal(completed.status, 'completed'); assert.ok(completed.completedAt); assert.equal(completed.reviewed, undefined);
  assert.equal(board.updateWork(work.id, { status: 'planned' }).completedAt, null);
});

test('active linked execution guards definitions and completion; cancellation acknowledgement permits pause', async t => {
  const { board, store, project } = await fixture(t); const work = board.createWork(draft(project.id));
  store.change(state => {
    state.tasks.push({ id: 'project-run', projectId: project.id, workId: work.id, status: 'running' }, { id: 'child-run', parentTaskId: 'project-run', status: 'running' });
  });
  assert.throws(() => board.updateWork(work.id, { title: 'Changed during run' }), status(409));
  assert.throws(() => board.updateWork(work.id, { objective: 'Changed during run' }), status(409));
  assert.throws(() => board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: 'Reviewed' }), status(409));
  assert.throws(() => board.updateWork(work.id, { status: 'paused' }), status(409));
  assert.equal(board.updateWork(work.id, { nextAction: 'Wait for the observed result.' }).nextAction, 'Wait for the observed result.');
  store.change(state => { state.tasks.forEach(task => { task.cancelRequested = true; }); });
  assert.equal(board.updateWork(work.id, { status: 'paused' }).status, 'paused');
  store.change(state => { state.tasks[0].status = 'cancelled'; });
  assert.throws(() => board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: 'Reviewed' }), status(409));
  store.change(state => { state.tasks[1].status = 'cancelled'; });
  assert.equal(board.updateWork(work.id, { status: 'completed', reviewed: true, completionNote: 'Reviewed cancellation outcome.' }).status, 'completed');
});

test('project settings update explicitly changes permissions only while execution is idle', async t => {
  const { board, store, project, secondWorkspace } = await fixture(t);
  const second = await board.registerProject({ name: 'Second', workspace: secondWorkspace });
  assert.throws(() => board.updateProject(project.id, { workspace: secondWorkspace }), status(400));
  assert.throws(() => board.updateProject(project.id, { permissionMode: 'danger-full-access' }), status(400));
  assert.throws(() => board.updateProject(project.id, { name: second.name }), status(409));
  const changed = board.updateProject(project.id, { name: 'Explicitly configured', permissionMode: 'workspace-write' });
  assert.equal(changed.permissionMode, 'workspace-write'); assert.equal(changed.workspace, project.workspace);
  store.change(state => { state.tasks.push({ id: 'queued-project-run', projectId: project.id, status: 'queued' }); });
  assert.throws(() => board.updateProject(project.id, { permissionMode: 'read-only' }), status(409));
  assert.throws(() => board.updateProject(project.id, { name: 'Busy rename' }), status(409));
  store.change(state => { state.tasks[0].status = 'completed'; });
  assert.equal(board.updateProject(project.id, { permissionMode: 'read-only' }).permissionMode, 'read-only');
});

const planInput = () => ({ steps: [
  { title: 'Inspect the current behavior', instructions: 'Read only the relevant implementation and record findings.' },
  { title: 'Verify the accepted change', instructions: 'Run the focused verification and report its observed result.' },
] });

test('identical open goals are reused without modifying their state or next action', async t => {
  const { board, project, store } = await fixture(t);
  const first = board.createWork({ ...draft(project.id), nextAction: 'Wait for review.' });
  board.updateWork(first.id, { status: 'paused' });
  const events = store.state.events.length;
  const repeated = board.createWork({ ...draft(project.id), nextAction: 'Do not silently replace the next action.' });
  assert.equal(repeated.id, first.id); assert.equal(repeated.status, 'paused');
  assert.equal(repeated.nextAction, 'Wait for review.'); assert.equal(store.state.events.length, events);
  assert.notEqual(board.createWork({ ...draft(project.id), objective: 'A different objective.' }).id, first.id);
  board.updateWork(first.id, { status: 'cancelled' });
  assert.notEqual(board.createWork(draft(project.id)).id, first.id);
});

test('plans require bounded inert steps and exact explicit approval under current permissions', async t => {
  const { board, project, store } = await fixture(t);
  const work = board.createWork(draft(project.id));
  for (const input of [
    { steps: [] }, { steps: Array.from({ length: 9 }, () => planInput().steps[0]) },
    { steps: [{ title: 'x'.repeat(121), instructions: 'bounded' }] },
    { steps: [{ title: 'Bounded', instructions: 'x'.repeat(6001) }] },
    { steps: [{ title: 'Bounded', instructions: 'API_KEY=CANARY_PLAN_SECRET' }] },
    { steps: [{ title: 'Bounded', instructions: 'Inspect', status: 'finished' }] },
  ]) assert.throws(() => board.setPlan(work.id, input), status(400));
  const drafted = board.setPlan(work.id, planInput(), { actor: 'agent' });
  assert.equal(drafted.plan.status, 'draft'); assert.equal(drafted.plan.approvedAt, null);
  assert.equal(drafted.plan.autoContinue, false); assert.equal(drafted.plan.approvedPermissionMode, null);
  assert.ok(drafted.plan.steps.every(step => step.status === 'pending' && step.taskId === null && !step.attemptIds.length));
  assert.equal(store.state.tasks.length, 0);
  const planId = drafted.plan.id;
  assert.throws(() => board.approvePlan(work.id, { planId: 'stale', reviewed: true, autoContinue: true }), status(409));
  for (const input of [{ planId, autoContinue: true }, { planId, reviewed: true }, { planId, reviewed: true, autoContinue: 'true' }]) {
    assert.throws(() => board.approvePlan(work.id, input), status(400));
  }
  board.updateProject(project.id, { permissionMode: 'workspace-write' });
  const approved = board.approvePlan(work.id, { planId, reviewed: true, autoContinue: false });
  assert.equal(approved.plan.status, 'running'); assert.ok(approved.plan.approvedAt);
  assert.equal(approved.plan.approvedPermissionMode, 'workspace-write'); assert.equal(approved.plan.autoContinue, false);
  assert.equal(store.state.tasks.length, 0, 'approval itself never schedules provider execution');
});

test('plan revision archives history and reapproval never resets finished steps or attempts', async t => {
  const { board, project, store } = await fixture(t);
  const work = board.createWork(draft(project.id));
  let current = board.setPlan(work.id, planInput());
  board.approvePlan(work.id, { planId: current.plan.id, reviewed: true, autoContinue: true });
  store.change(state => {
    const plan = state.workItems.find(item => item.id === work.id).plan;
    plan.steps[0].status = 'finished'; plan.steps[0].taskId = 'finished-attempt'; plan.steps[0].attemptIds = ['finished-attempt'];
    plan.steps[0].checkpoint = { state: 'ready', summary: 'Agent reported the scoped inspection finished.', source: 'agent_report', createdAt: new Date().toISOString() };
    plan.status = 'paused';
    state.tasks.push({ id: 'finished-attempt', workId: work.id, planId: plan.id, stepId: plan.steps[0].id, status: 'completed', result: 'Observed provider result.' });
  });
  current = board.get(work.id);
  const finished = structuredClone(current.plan.steps[0]); const oldPlan = structuredClone(current.plan);
  const task = structuredClone(store.state.tasks[0]);
  board.updateProject(project.id, { permissionMode: 'workspace-write' });
  board.approvePlan(work.id, { planId: current.plan.id, reviewed: true, autoContinue: false });
  assert.deepEqual(board.get(work.id).plan.steps[0], finished);
  assert.deepEqual(store.state.tasks[0], task);
  const updatedInput = planInput(); updatedInput.steps[1].instructions = 'Run the refined focused verification.';
  const updated = board.setPlan(work.id, updatedInput);
  assert.notEqual(updated.plan.id, oldPlan.id); assert.equal(updated.plan.status, 'draft');
  assert.equal(updated.plan.approvedAt, null); assert.equal(updated.planHistory.length, 1);
  assert.equal(updated.planHistory[0].id, oldPlan.id); assert.deepEqual(updated.plan.steps[0], finished);
  assert.deepEqual(store.state.tasks[0], task);
  assert.throws(() => board.approvePlan(work.id, { planId: oldPlan.id, reviewed: true, autoContinue: true }), status(409));
});

test('held queue entries prevent plan mutation or approval, but can remain held while work is paused', async t => {
  const { board, project, store } = await fixture(t);
  const work = board.createWork(draft(project.id)); const planId = board.setPlan(work.id, planInput()).plan.id;
  store.change(state => { state.tasks.push({ id: 'held', kind: 'project', workId: work.id, projectId: project.id, status: 'queued', queueState: 'held' }); });
  assert.throws(() => board.setPlan(work.id, planInput()), status(409));
  assert.throws(() => board.approvePlan(work.id, { planId, reviewed: true, autoContinue: true }), status(409));
  assert.equal(board.updateWork(work.id, { status: 'paused' }).status, 'paused');
});

test('external notes never become provider tasks or execution evidence', async t => {
  const { board, project, store } = await fixture(t); const work = board.createWork(draft(project.id));
  const noted = board.addNote(work.id, { text: 'The local implementation team completed a separately verified milestone.' });
  assert.equal(noted.notes.length, 1); assert.equal(noted.notes[0].source, 'external_update');
  assert.equal(noted.status, 'planned'); assert.deepEqual(noted.evidence, []); assert.equal(store.state.tasks.length, 0);
  for (const input of [{ text: '' }, { text: 'x'.repeat(4001) }, { text: 'password=CANARY_NOTE_SECRET' }, { text: 'Claim', source: 'agent_report' }]) {
    assert.throws(() => board.addNote(work.id, input), status(400));
  }
});

test('v3 restart holds never-started queue entries and interrupts started plan attempts without replay', async t => {
  const { root, workspace } = await directory(t); const data = join(root, 'data');
  const first = new Store(data, workspace); const board = new WorkBoard(first); const projectId = first.state.settings.defaultProjectId;
  const queued = board.createWork({ ...draft(projectId), title: 'Queued work' });
  const running = board.createWork({ ...draft(projectId), title: 'Running work' });
  const paused = board.createWork({ ...draft(projectId), title: 'User-paused queue' });
  for (const work of [queued, running, paused]) {
    const plan = board.setPlan(work.id, planInput()).plan;
    board.approvePlan(work.id, { planId: plan.id, reviewed: true, autoContinue: true });
  }
  first.change(state => {
    for (const work of state.workItems) {
      work.status = work.id === paused.id ? 'paused' : 'active';
      if (work.id === running.id) {
        const finished = work.plan.steps[0]; finished.status = 'finished'; finished.taskId = 'finished-before-restart'; finished.attemptIds = [finished.taskId];
        finished.checkpoint = { state: 'ready', summary: 'Previously recorded agent checkpoint.', source: 'agent_report', createdAt: new Date().toISOString() };
        state.tasks.push({ id: finished.taskId, workId: work.id, projectId, planId: work.plan.id, stepId: finished.id, kind: 'project', status: 'completed' });
      }
      const step = work.plan.steps[work.id === running.id ? 1 : 0]; step.status = work.id === running.id ? 'running' : 'queued';
      step.taskId = `attempt-${work.id}`; step.attemptIds = [step.taskId];
      state.tasks.push({ id: step.taskId, projectId, workId: work.id, planId: work.plan.id, stepId: step.id, kind: 'project', status: 'queued', queueState: work.id === running.id ? 'starting' : work.id === paused.id ? 'held' : 'waiting', completedAt: null });
    }
  }); first.close();
  const second = new Store(data, workspace); const restored = new WorkBoard(second);
  assert.equal(restored.get(queued.id).status, 'paused'); assert.equal(restored.get(queued.id).plan.status, 'paused');
  assert.equal(restored.get(queued.id).plan.steps[0].status, 'queued'); assert.deepEqual(restored.get(queued.id).evidence, []);
  assert.equal(restored.get(paused.id).status, 'paused');
  assert.ok(second.state.workItems.every(work => work.recoveryRequired));
  const heldTasks = second.state.tasks.filter(task => task.workId !== running.id);
  assert.ok(heldTasks.every(task => task.status === 'queued' && task.queueState === 'held' && task.completedAt === null));
  assert.ok(heldTasks.every(task => /Explicitly resume/.test(task.queueReason)));
  const interrupted = restored.get(running.id);
  assert.equal(interrupted.status, 'blocked'); assert.equal(interrupted.plan.status, 'blocked');
  assert.equal(interrupted.plan.steps[0].status, 'finished'); assert.equal(interrupted.plan.steps[0].taskId, 'finished-before-restart');
  assert.equal(interrupted.plan.steps[0].checkpoint.source, 'agent_report');
  assert.equal(interrupted.plan.steps[1].status, 'interrupted'); assert.equal(interrupted.plan.steps[1].checkpoint.source, 'system_recovery');
  assert.match(interrupted.plan.steps[1].checkpoint.summary, /Relay restarted/);
  assert.equal(interrupted.evidence.length, 1); assert.equal(interrupted.evidence[0].status, 'interrupted');
  assert.equal(second.state.tasks.length, 4); const originalIds = second.state.tasks.map(task => task.id); second.close();
  const third = new Store(data, workspace); t.after(() => third.close());
  assert.deepEqual(third.state.tasks.map(task => task.id), originalIds);
  assert.equal(third.state.workItems.find(work => work.id === running.id).evidence.length, 1);
});

test('v2 work gains empty v3 fields without promoting old execution evidence into plans or notes', async t => {
  const { root, workspace } = await directory(t); const data = join(root, 'data');
  const first = new Store(data, workspace); const board = new WorkBoard(first);
  const work = board.createWork(draft(first.state.settings.defaultProjectId));
  const evidence = { taskId: 'legacy-finished', status: 'completed', summary: 'Old observed provider result.', createdAt: new Date().toISOString() };
  first.change(state => {
    state.schemaVersion = 2; state.meta.version = '0.2.0';
    const old = state.workItems.find(item => item.id === work.id); old.evidence.push(evidence);
    delete old.notes; delete old.plan; delete old.planHistory; delete old.recoveryRequired;
  }); first.close();
  const second = new Store(data, workspace); t.after(() => second.close()); const restored = new WorkBoard(second).get(work.id);
  assert.deepEqual(restored.evidence, [evidence]); assert.deepEqual(restored.notes, []);
  assert.deepEqual(restored.planHistory, []); assert.equal(restored.plan, null); assert.equal(restored.recoveryRequired, false);
});
