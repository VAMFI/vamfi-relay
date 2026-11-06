import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexCatalog } from '../server/catalog.mjs';

const thread = (id, extra = {}) => ({ id, name: `Chat ${id}`, preview: 'Fix the project',
  cwd: '/workspace/alpha', createdAt: 1700000000, updatedAt: 1700000100,
  source: 'cli', status: { type: 'notLoaded' }, ...extra });
class Provider extends EventEmitter {
  calls = [];
  rows = [thread('chat-1')];
  turns = [{ id: 'turn-1', status: 'completed', startedAt: 1700000000, completedAt: 1700000100,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Fix the test' }] },
      { type: 'agentMessage', text: 'The test passes.' }] }];
  async connect() { this.calls.push(['connect']); if (this.failure) throw new Error('SECRET failure'); }
  async listThreads(options) { this.calls.push(['list', options]); return { data: this.rows, nextCursor: null }; }
  async listProjects() { return { data: [], nextCursor: null }; }
  async memoryStatus() { return { v2Ready: true, v2ConsolidatedThreads: 23 }; }
  async readThread(options) { this.calls.push(['read', options]); return { thread: this.rows.find(t => t.id === options.threadId) }; }
  async listThreadTurns(options) { this.calls.push(['turns', options]); return { data: this.turns, nextCursor: null }; }
  async close() { this.calls.push(['close']); }
}
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'relay-catalog-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adapter = new Provider();
  const store = { state: { threads: [], tasks: [], projects: [], connection: { status: 'connected' } } };
  let clock = 1700000200000;
  const catalog = new CodexCatalog({ adapter, store, codexHome: home, now: () => clock });
  t.after(() => catalog.close());
  return { home, adapter, store, catalog, tick: ms => { clock += ms; } };
}

test('catalog discovers metadata only, groups projects and never imports state', async t => {
  const { adapter, catalog, store } = await fixture(t);
  adapter.rows.push(thread('child', { parentThreadId: 'chat-1', source: { subAgent: 'review' } }),
    thread('other', { cwd: '/workspace/beta', name: 'password=synthetic-secret' }));
  const before = structuredClone(store.state);
  const result = await catalog.list();
  assert.equal(result.available, true); assert.equal(result.threads.length, 3);
  assert.equal(result.projects.length, 2); assert.equal(result.totals.unknown, 3);
  assert.equal(result.threads[0].activity.state, 'unknown');
  assert.equal(result.threads.find(t => t.id === 'child').parentThreadId, 'chat-1');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  assert.deepEqual(store.state, before);
  assert.ok(adapter.calls.every(c => ['connect', 'list'].includes(c[0])));
  assert.deepEqual((await catalog.list({ query: 'beta' })).threads.map(t => t.id), ['other']);
});

test('activity distinguishes owned confirmed runs from unknown external state and clears stale observations', async t => {
  const { adapter, catalog, store, tick } = await fixture(t);
  adapter.rows = [thread('owned'), thread('external', { status: { type: 'active', activeFlags: [] } }),
    thread('unloaded'), thread('idle', { status: { type: 'idle' } })];
  store.state.threads.push({ id: 'owned' });
  store.state.tasks.push({ threadId: 'owned', status: 'running', turnId: 'turn-1', startedAt: '2023-11-14T22:15:00Z' });
  let result = await catalog.list();
  assert.equal(result.threads.find(t => t.id === 'owned').activity.basis, 'relay-run');
  assert.equal(result.threads.find(t => t.id === 'external').activity.state, 'unknown');
  assert.equal(result.threads.find(t => t.id === 'external').activity.lastRecorded.state, 'active');
  assert.match(result.threads.find(t => t.id === 'external').activity.label, /provider/i);
  assert.equal(result.threads.find(t => t.id === 'unloaded').activity.state, 'unknown');
  assert.equal(result.threads.find(t => t.id === 'idle').activity.state, 'unknown');
  assert.equal(result.totals.active, 1);
  store.state.connection.status = 'disconnected';
  adapter.failure = true; tick(16000);
  result = await catalog.list();
  assert.equal(result.available, false);
  assert.ok(result.threads.every(t => t.activity.state === 'unknown'));
  assert.ok(result.threads.every(t => !t.activity.lastRecorded));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('initial pagination is bounded, explicitly partial, and can load another bounded page', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.listThreads = async ({ cursor, limit }) => {
    const start = Number(cursor || 0);
    assert.equal(limit, 100);
    adapter.calls.push(['list']);
    return { data: Array.from({ length: 100 }, (_, i) => thread(`chat-${start + i}`)), nextCursor: String(start + 100) };
  };
  const first = await catalog.list();
  assert.equal(first.threads.length, 1000); assert.equal(first.partial, true);
  assert.equal(first.nextCursor, '1000');
  assert.equal(adapter.calls.filter(c => c[0] === 'list').length, 10);
  const more = await catalog.list({ loadMore: true });
  assert.equal(more.threads.length, 1100); assert.equal(more.nextCursor, '1100');
});

test('load-more reaching the end clears partial and archived catalogs remain independent', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.listThreads = async ({ cursor, archived }) => {
    if (archived) return { data: [thread('archived')], nextCursor: null };
    const offset = Number(cursor || 0);
    return { data: [thread(`chat-${offset}`)], nextCursor: offset < 10 ? String(offset + 1) : null };
  };
  assert.equal((await catalog.list()).partial, true);
  const complete = await catalog.list({ loadMore: true });
  assert.equal(complete.partial, false); assert.equal(complete.nextCursor, null);
  const archived = await catalog.list({ archived: true });
  assert.deepEqual(archived.threads.map(t => [t.id, t.archived]), [['archived', true]]);
  assert.equal((await catalog.list()).threads.length, 11);
});

test('invalid provider rows and cursor loops cannot become a complete successful catalog', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.listThreads = async () => ({ data: [thread('valid'), { id: '../private' }], nextCursor: 'same' });
  const result = await catalog.list();
  assert.equal(result.threads.length, 1); assert.equal(result.partial, true);
  assert.ok(result.warnings.length);
  await assert.rejects(catalog.detail('../private'), e => e.statusCode === 400);
});

test('optional unsupported metadata gracefully falls back to workspace groups', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.listProjects = adapter.memoryStatus = async () => { throw Object.assign(new Error('hidden'), { unsupported: true }); };
  const result = await catalog.list();
  assert.equal(result.available, true); assert.equal(result.projects[0].name, 'alpha');
  assert.equal(result.memory.available, false);
});

test('canonical provider projects group nested workspaces without changing Relay projects', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.rows = [thread('chat-1', { projectId: 'project-a', cwd: '/workspace/alpha/sub' }), thread('chat-2')];
  adapter.listProjects = async () => ({ data: [{ id: 'project-a', name: 'Alpha app', roots: [{ path: '/workspace/alpha' }] }], nextCursor: null });
  const result = await catalog.list();
  assert.equal(result.projects.length, 1); assert.equal(result.projects[0].name, 'Alpha app');
  assert.equal(result.projects[0].threadCount, 2);
});

test('history selects only bounded redacted visible messages and evidence, never resumes a chat', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.turns[0].items.push(
    { type: 'reasoning', summary: ['PRIVATE reasoning'], content: ['PRIVATE reasoning'] },
    { type: 'mcpToolCall', result: { text: 'PRIVATE tool output' } },
    { type: 'commandExecution', command: 'API_KEY=synthetic-secret npm test', aggregatedOutput: 'PRIVATE command output', status: 'completed', exitCode: 0 },
    { type: 'fileChange', status: 'completed', changes: [{ path: '/workspace/alpha/a.js', kind: { type: 'update' }, diff: 'PRIVATE diff' }] });
  const result = await catalog.detail('chat-1');
  assert.equal(result.summary.lastRequest, 'Fix the test');
  assert.equal(result.summary.lastResponse, 'The test passes.');
  assert.equal(result.summary.lastRecordedStatus, 'completed');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|synthetic-secret/);
  assert.match(result.contextText, /npm test/); assert.match(result.contextText, /a\.js/);
  assert.match(result.contextHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(adapter.calls.find(c => c[0] === 'read')[1], { threadId: 'chat-1', includeTurns: false });
  assert.equal(adapter.calls.find(c => c[0] === 'turns')[1].limit, 20);
  adapter.turns[0].items[1].text = 'Changed response';
  assert.notEqual((await catalog.detail('chat-1')).contextHash, result.contextHash);
});

test('history is capped at 20 turns, 200 items and 24000 characters of complete reviewable context', async t => {
  const { adapter, catalog } = await fixture(t);
  adapter.turns = Array.from({ length: 25 }, (_, n) => ({ id: `turn-${n}`, status: 'completed',
    items: Array.from({ length: 50 }, () => ({ type: 'agentMessage', text: `response-${n} ${'x'.repeat(6000)}` })) }));
  const result = await catalog.detail('chat-1');
  assert.equal(result.truncated, true); assert.ok(result.turns.length <= 20);
  assert.ok(result.turns.flatMap(t => t.items).length <= 200);
  assert.ok(result.contextText.length <= 24000);
  for (const turn of result.turns) for (const item of turn.items) if (item.text) assert.ok(result.contextText.includes(item.text));
});

test('deleted chats and unsupported history fail safely without provider diagnostic leakage', async t => {
  const { adapter, catalog } = await fixture(t);
  await assert.rejects(catalog.detail('missing'), e => e.statusCode === 404);
  adapter.listThreadTurns = async () => { throw Object.assign(new Error('SECRET'), { unsupported: true }); };
  const result = await catalog.detail('chat-1');
  assert.deepEqual(result.turns, []); assert.ok(result.warnings.length);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('memory discovery is metadata only and explicit reading is bounded, redacted and rejects symlinks', async t => {
  const { home, catalog } = await fixture(t);
  await mkdir(join(home, 'memories'));
  const path = join(home, 'memories', 'memory_summary.md');
  await writeFile(path, `token=synthetic-secret\n${'x'.repeat(70000)}`);
  const listed = await catalog.list();
  assert.equal(listed.memory.summaryAvailable, true);
  assert.equal(listed.memory.text, undefined);
  const memory = await catalog.memory();
  assert.equal(memory.available, true); assert.equal(memory.truncated, true);
  assert.ok(memory.text.length <= 65536); assert.doesNotMatch(memory.text, /synthetic-secret/);
  assert.match(memory.warning, /stale/i);
  await rm(path); await writeFile(join(home, 'auth.json'), 'never read');
  await symlink(join(home, 'auth.json'), path);
  assert.equal((await catalog.memory()).available, false);
  assert.equal((await catalog.list({ refresh: true })).memory.summaryAvailable, false);
});

test('catalog shutdown and errors never close a separate execution adapter', async t => {
  const { adapter, catalog } = await fixture(t);
  const executionAdapter = new Provider();
  adapter.failure = true;
  assert.equal((await catalog.list()).available, false);
  await catalog.close();
  assert.deepEqual(executionAdapter.calls, []);
});
