import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyWork } from './daily-lib.js';

const date = '2026-11-06';
const now = '2026-11-06T16:00:00Z';
const old = '2026-11-05T16:00:00Z';
function fixture() {
  return {
    meta: { timezone: 'America/Toronto' },
    projects: [{ id: 'alpha', name: 'Alpha', permissionMode: 'workspace-write' }, { id: 'beta', name: 'Beta' }],
    workItems: [{ id: 'a', projectId: 'alpha', title: 'Fix navigation', status: 'active', createdAt: old }, { id: 'b', projectId: 'beta', title: 'Calendar', status: 'blocked', createdAt: old }],
    tasks: [
      { id: 'request', kind: 'request', createdAt: now, status: 'completed', completedAt: now },
      { id: 'casual', kind: 'request', prompt: 'Why can’t you inspect?', createdAt: now, completedAt: now, status: 'completed' },
      { id: 'running', kind: 'project', workId: 'a', projectId: 'alpha', parentTaskId: 'request', status: 'running', createdAt: old, startedAt: old, permissionMode: 'read-only', provider: 'codex' },
      { id: 'held', kind: 'project', workId: 'b', status: 'queued', queueState: 'held', createdAt: old },
      { id: 'result', kind: 'project', workId: 'a', status: 'completed', createdAt: old, completedAt: now, result: 'Agent says ready' },
    ],
    messages: [{ id: 'msg', taskId: 'request', role: 'user', text: 'Fix navigation and investigate the calendar', createdAt: now }],
    events: [{ id: 'e1', type: 'work_request', taskId: 'request', workId: 'a', createdAt: now }, { id: 'e2', type: 'work_request', taskId: 'request', workId: 'b', createdAt: now }],
  };
}

test('one multi-goal request is linked once; casual chat stays out of work and outcomes', () => {
  const view = dailyWork(fixture(), date);
  assert.equal(view.requests.length, 1);
  assert.deepEqual(view.requests[0].goals.map(g => g.id), ['a', 'b']);
  assert.equal(view.requests[0].text, 'Fix navigation and investigate the calendar');
  assert.equal(view.requests[0].taskId, 'request');
  assert.equal(view.progress.length, 1);
  assert.equal(view.progress[0].kind, 'report');
  assert.equal(view.progress[0].taskId, 'result');
  assert.equal(view.reviewed.length, 0);
});

test('current assignments survive date changes with recorded scope and held state', () => {
  const state = fixture();
  const view = dailyWork(state, '2026-11-01');
  assert.equal(view.progress.length, 0);
  assert.equal(view.requests.length, 0);
  assert.deepEqual(view.assignments.map(a => a.task.id), ['running', 'held']);
  assert.equal(view.assignments[0].permissionMode, 'read-only');
  assert.equal(view.assignments[0].parent.id, 'request');
  assert.equal(view.assignments[0].provider, 'Codex');
  assert.equal(view.assignments[1].state, 'held');
  assert.equal(view.assignments[1].permissionMode, 'Not recorded');
});

test('legacy ancestry is exact, cycles and missing goals cannot invent ownership', () => {
  const state = fixture();
  state.events = [];
  state.tasks.push(
    { id: 'specialist', kind: 'worker', parentTaskId: 'running', status: 'running' },
    { id: 'cycle1', kind: 'worker', parentTaskId: 'cycle2', workId: 'missing', status: 'waiting' },
    { id: 'cycle2', kind: 'worker', parentTaskId: 'cycle1', status: 'running' },
  );
  const view = dailyWork(state, date);
  assert.equal(view.requests.length, 1);
  assert.deepEqual(view.requests[0].goals.map(g => g.id), ['a']);
  assert.equal(view.assignments.find(a => a.task.id === 'specialist').work.id, 'a');
  assert.equal(view.assignments.find(a => a.task.id === 'cycle1').work, null);
});

test('notes, observed activity, agent reports and immutable reviews remain distinct', () => {
  const state = fixture();
  state.workItems[0].notes = [{ id: 'note', text: 'External test report', createdAt: now }];
  state.events.push(
    { id: 'command', type: 'commandExecution', taskId: 'result', title: 'Command finished', detail: 'a failing check\nExit: 1', createdAt: now },
    { id: 'review', type: 'work_review', workId: 'a', detail: 'Inspected keyboard behavior', createdAt: now },
  );
  const view = dailyWork(state, date);
  assert.deepEqual(view.progress.map(p => p.kind).sort(), ['note', 'observation', 'report', 'review']);
  assert.equal(view.reviewed[0].text, 'Inspected keyboard behavior');
  assert.equal(state.workItems[0].status, 'active'); // Review remains visible after reopening.
  assert.ok(!view.progress.some(p => /passed|verified/i.test(p.label)));
});

test('timezone date boundaries, invalid dates and legacy review fallback are explicit', () => {
  const state = fixture();
  state.tasks.find(t => t.id === 'result').completedAt = '2026-11-06T02:00:00Z';
  state.workItems[0].notes = [{ id: 'bad', text: 'Missing date', createdAt: 'invalid' }];
  Object.assign(state.workItems[1], { status: 'completed', completedAt: now, completionNote: 'Inspected outcome' });
  assert.equal(dailyWork(state, date).progress.filter(p => p.kind === 'report').length, 0);
  assert.equal(dailyWork(state, '2026-11-05').progress.filter(p => p.kind === 'report').length, 1);
  assert.equal(dailyWork(state, date).reviewed.length, 1);
  state.events.push({ id: 'review', type: 'work_review', workId: 'b', detail: 'Inspected outcome', createdAt: now });
  assert.equal(dailyWork(state, date).reviewed.length, 1);
});

test('search includes goal/project context, preserves literal content and never mutates source', () => {
  const state = fixture();
  state.messages[0].text += ' <img src=x onerror=alert(1)>';
  const before = structuredClone(state);
  const view = dailyWork(state, date, 'Alpha');
  assert.equal(view.requests.length, 1);
  assert.ok(view.requests[0].text.includes('<img'));
  assert.deepEqual(view.assignments.map(a => a.task.id), ['running']);
  assert.deepEqual(state, before);
  assert.deepEqual(dailyWork({}, date), { requests: [], progress: [], assignments: [], reviewed: [] });
});
