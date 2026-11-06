import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../server/demo.mjs';
import { attentionWork, dailySummary, dayKey, duration, executionCounts, goalSummary, linkedWorkId, masterMessages, matchesQuery, needsRetryAcknowledgment, normalizeSnapshot, ongoingWork, planNeedsApproval, shiftDay, workTasks } from './lib.js';

test('day grouping respects the workspace time zone across midnight', () => {
  assert.equal(dayKey('2026-11-06T02:30:00Z', 'America/Toronto'), '2026-11-05');
  assert.equal(dayKey('2026-11-06T02:30:00Z', 'UTC'), '2026-11-06');
  assert.equal(dayKey('invalid', 'UTC'), '');
  assert.equal(dayKey(0, 'UTC'), '1970-01-01');
});

test('daily metrics count their stated events, including a task completed on a later date', () => {
  const snapshot = normalizeSnapshot({
    meta: { timezone: 'America/Toronto' },
    tasks: [
      { id: 'earlier', kind: 'request', status: 'completed', createdAt: '2026-11-04T16:00:00Z', startedAt: '2026-11-04T16:00:00Z', completedAt: '2026-11-05T17:00:00Z' },
      { id: 'worker', kind: 'worker', status: 'running', createdAt: '2026-11-06T02:00:00Z', startedAt: '2026-11-06T02:00:00Z' },
      { id: 'next', kind: 'worker', status: 'completed', createdAt: '2026-11-06T06:00:00Z', startedAt: '2026-11-06T06:00:00Z', completedAt: '2026-11-06T07:00:00Z' },
    ],
    events: [
      { createdAt: '2026-11-06T02:00:00Z' },
      { createdAt: '2026-11-06T02:05:00Z' },
      { createdAt: '2026-11-06T06:00:00Z' },
    ],
    approvals: [
      { status: 'pending', createdAt: '2026-11-05T16:00:00Z' },
      { status: 'accepted', createdAt: '2026-11-05T17:00:00Z' },
    ],
  });
  const summary = dailySummary(snapshot, '2026-11-05');
  assert.deepEqual(summary.completed.map((item) => item.id), ['earlier']);
  assert.deepEqual(summary.started.map((item) => item.id), ['worker']);
  assert.deepEqual(summary.workers.map((item) => item.id), ['worker']);
  assert.equal(summary.approvals.length, 1);
  assert.equal(summary.events.length, 2);
  assert.equal(summary.hours[21].count, 2);
  assert.equal(summary.hours.reduce((sum, item) => sum + item.count, 0), 2);
});

test('empty or invalid event dates never create phantom activity', () => {
  const summary = dailySummary(normalizeSnapshot({ events: [{ createdAt: 'invalid' }] }), '2026-11-05');
  assert.equal(summary.events.length, 0);
  assert.equal(summary.hours.length, 24);
  assert.equal(summary.hours.every((item) => item.count === 0), true);
});

test('calendar controls cross month and daylight-saving boundaries by day', () => {
  assert.equal(shiftDay('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

test('elapsed duration stops at task completion and search handles optional fields', () => {
  assert.equal(duration({ startedAt: '2026-11-05T12:00:00Z', completedAt: '2026-11-05T12:01:05Z' }, '2026-11-06T00:00:00Z'), '1m 5s');
  assert.equal(duration({}), 'Not started');
  assert.equal(matchesQuery([undefined, 'Review workspace', null], ' WORKSPACE '), true);
  assert.equal(matchesQuery(['Review workspace'], 'deployment'), false);
});

test('ordinary questions and completed provider turns never become dashboard work', () => {
  const state = normalizeSnapshot({
    tasks: [{ id: 'question', kind: 'request', status: 'completed', title: "Why can't you inspect?", createdAt: '2026-11-05T12:00:00Z', completedAt: '2026-11-05T12:01:00Z' }],
    events: [{ id: 'answer', taskId: 'question', type: 'completed', createdAt: '2026-11-05T12:01:00Z' }],
  });
  const summary = goalSummary(state, '2026-11-05');
  assert.equal(summary.ongoing.length, 0);
  assert.equal(summary.events.length, 0);
  assert.equal(summary.completed.length, 0);
  assert.equal(summary.hours.every((hour) => hour.count === 0), true);
});

test('ongoing goals persist across selected dates and exclude every history status', () => {
  const state = normalizeSnapshot({ projects: [{ id: 'one', name: 'Atlas' }], workItems: ['planned', 'active', 'blocked', 'needs_review', 'paused', 'completed', 'cancelled'].map((status) => ({ id: status, projectId: 'one', status, title: status, createdAt: '2026-10-01T12:00:00Z' })) });
  assert.deepEqual(ongoingWork(state).map((work) => work.status), ['planned', 'active', 'blocked', 'needs_review']);
  assert.deepEqual(goalSummary(state, '2026-11-05').ongoing, goalSummary(state, '2026-01-01').ongoing);
  assert.equal(goalSummary(state, '2026-11-05').needsYou, 2);
  assert.equal(goalSummary(state, '2026-11-05').activeProjects, 1);
});

test('reviewed completion is based on goal evidence, never a finished execution', () => {
  const state = normalizeSnapshot({
    meta: { timezone: 'America/Toronto' },
    projects: [{ id: 'project' }],
    workItems: [
      { id: 'review', projectId: 'project', status: 'needs_review', evidence: [{ taskId: 'run', status: 'completed' }] },
      { id: 'done', projectId: 'project', status: 'completed', completedAt: '2026-11-06T02:00:00Z', completionNote: 'I inspected the result and verified acceptance.' },
      { id: 'unsupported', projectId: 'project', status: 'completed', completedAt: '2026-11-06T02:00:00Z' },
    ],
    tasks: [{ id: 'run', workId: 'review', status: 'completed', completedAt: '2026-11-05T15:00:00Z' }],
    approvals: [{ id: 'pending', status: 'pending', createdAt: '2026-10-01T12:00:00Z' }],
  });
  const summary = goalSummary(state, '2026-11-05');
  assert.deepEqual(summary.completed.map((work) => work.id), ['done']);
  assert.equal(summary.needsYou, 2);
});

test('goal analytics require a real relation and include linked specialist work', () => {
  const state = normalizeSnapshot({
    meta: { timezone: 'UTC' }, workItems: [{ id: 'goal', status: 'active' }],
    tasks: [{ id: 'run', workId: 'goal', kind: 'project' }, { id: 'worker', parentTaskId: 'run', kind: 'worker' }, { id: 'chat', kind: 'request' }],
    events: [
      { id: 'direct', workId: 'goal', createdAt: '2026-11-05T12:00:00Z' },
      { id: 'child', taskId: 'worker', createdAt: '2026-11-05T12:10:00Z' },
      { id: 'noise', taskId: 'chat', createdAt: '2026-11-05T12:20:00Z' },
      { id: 'unknown', workId: 'missing', createdAt: '2026-11-05T12:30:00Z' },
    ],
  });
  assert.deepEqual(goalSummary(state, '2026-11-05').events.map((event) => event.id), ['direct', 'child']);
  assert.equal(goalSummary(state, '2026-11-05').hours[12].count, 2);
  assert.deepEqual(workTasks(state, 'goal').map((task) => task.id), ['run', 'worker']);
  assert.equal(linkedWorkId(state, { taskId: 'chat' }), null);
});

test('one master conversation includes migration history and background notifications', () => {
  const state = normalizeSnapshot({
    mainThreadId: 'new', threads: [{ id: 'old', role: 'coordinator' }, { id: 'new', role: 'coordinator' }, { id: 'worker', role: 'worker' }],
    messages: [
      { id: 'legacy', threadId: 'old', role: 'user' },
      { id: 'current', threadId: 'new', channel: 'master' },
      { id: 'notification', threadId: 'project', channel: 'master' },
      { id: 'raw', threadId: 'worker', channel: 'worker' },
      { id: 'raw-legacy', threadId: 'worker' },
    ],
  });
  assert.deepEqual(masterMessages(state).map((message) => message.id), ['legacy', 'current', 'notification']);
});

test('sample goals have explicit project, execution and evidence relationships', () => {
  const state = normalizeSnapshot(demoSnapshot());
  assert.equal(state.meta.sample, true);
  for (const work of state.workItems) {
    assert.ok(state.projects.some((project) => project.id === work.projectId));
    for (const evidence of work.evidence) {
      const task = state.tasks.find((item) => item.id === evidence.taskId);
      assert.ok(task);
      assert.equal(task.workId, work.id);
      assert.equal(task.projectId, work.projectId);
      assert.equal(evidence.status, task.status);
    }
  }
  const summary = goalSummary(state, dayKey(state.meta.now, state.meta.timezone));
  assert.equal(summary.ongoing.length, 4);
  assert.equal(summary.completed.length, 1);
  assert.equal(summary.events.every((event) => linkedWorkId(state, event)), true);
  assert.ok(state.events.some((event) => !linkedWorkId(state, event)));
  assert.equal(masterMessages(state).filter((message) => message.source === 'project').length, 6);
});

test('waiting and held queue entries are not displayed as running agents', () => {
  const counts = executionCounts([
    { status: 'queued', queueState: 'waiting' }, { status: 'queued', queueState: 'held' },
    { status: 'queued', queueState: 'starting' }, { status: 'running' }, { status: 'waiting' },
    { status: 'completed' }, { status: 'interrupted' },
  ]);
  assert.deepEqual(counts, { running: 2, queued: 3, starting: 1, held: 1 });
});

test('Needs you distinguishes recovery pauses from ordinary pauses without guessing from prose', () => {
  const state = normalizeSnapshot({ workItems: [
    { id: 'manual', status: 'paused', recoveryRequired: false, nextAction: 'recover after restart' },
    { id: 'recovery', status: 'paused', recoveryRequired: true },
    { id: 'blocked', status: 'blocked' }, { id: 'review', status: 'needs_review' },
    { id: 'done', status: 'completed', recoveryRequired: true },
  ], approvals: [{ status: 'pending' }, { status: 'accepted' }] });
  assert.deepEqual(attentionWork(state).map((work) => work.id), ['recovery', 'blocked', 'review']);
  assert.equal(goalSummary(state, '2026-11-05').needsYou, 4);
});

test('plan retry acknowledgment follows unfinished steps, never old finished attempts', () => {
  for (const status of ['blocked', 'interrupted', 'cancelled']) {
    const work = { id: 'goal', plan: { steps: [{ status: 'finished' }, { status, checkpoint: null }] } };
    assert.equal(needsRetryAcknowledgment(work, normalizeSnapshot()), true);
  }
  assert.equal(needsRetryAcknowledgment({ plan: { steps: [{ status: 'finished' }, { status: 'pending' }] } }, normalizeSnapshot()), false);
  assert.equal(needsRetryAcknowledgment({ plan: { steps: [{ status: 'finished' }] } }, normalizeSnapshot()), false);
});

test('held ad-hoc work resumes without retry acknowledgment but uncertain terminal attempts require it', () => {
  const work = { id: 'goal' };
  const state = normalizeSnapshot({ workItems: [work], tasks: [{ id: 'failed', workId: 'goal', kind: 'project', status: 'failed', createdAt: '2026-11-05T10:00:00Z' }] });
  assert.equal(needsRetryAcknowledgment(work, state), true);
  state.tasks.push({ id: 'held', workId: 'goal', kind: 'project', status: 'queued', queueState: 'held', createdAt: '2026-11-05T11:00:00Z' });
  assert.equal(needsRetryAcknowledgment(work, state), false);
});

test('plan approval is renewed for an exact new draft or changed project permission', () => {
  const work = { plan: { id: 'plan-one', status: 'paused', approvedAt: '2026-11-05T10:00:00Z', approvedPermissionMode: 'read-only' } };
  assert.equal(planNeedsApproval(work, { permissionMode: 'read-only' }), false);
  assert.equal(planNeedsApproval(work, { permissionMode: 'workspace-write' }), true);
  assert.equal(planNeedsApproval({ plan: { ...work.plan, id: 'plan-two', status: 'draft', approvedAt: null } }, { permissionMode: 'read-only' }), true);
});

test('v3 sample plans preserve finished evidence and distinguish queued, interrupted, and external records', () => {
  const state = normalizeSnapshot(demoSnapshot());
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.meta.version, '0.4.0');
  assert.deepEqual(executionCounts(state.tasks), { running: 0, queued: 2, starting: 0, held: 1 });
  const paused = state.workItems.find((work) => work.id === 'sample-goal-paused');
  const held = state.workItems.find((work) => work.id === 'sample-goal-held');
  assert.equal(needsRetryAcknowledgment(paused, state), true);
  assert.equal(needsRetryAcknowledgment(held, state), false);
  assert.equal(paused.plan.steps[0].status, 'finished');
  assert.equal(paused.plan.steps[1].checkpoint.source, 'system_recovery');
  for (const work of state.workItems) {
    for (const step of work.plan?.steps || []) {
      if (!step.taskId) continue;
      const task = state.tasks.find((item) => item.id === step.taskId);
      assert.ok(task);
      assert.equal(task.planId, work.plan.id);
      assert.equal(task.stepId, step.id);
      if (step.status === 'finished') {
        assert.equal(task.status, 'completed');
        assert.equal(step.checkpoint.state, 'ready');
        assert.equal(step.checkpoint.source, 'agent_report');
      }
    }
    for (const note of work.notes) {
      assert.equal(note.source, 'external_update');
      assert.equal(work.evidence.some((evidence) => evidence.taskId === note.id), false);
      assert.equal(state.tasks.some((task) => task.id === note.id), false);
    }
  }
});
