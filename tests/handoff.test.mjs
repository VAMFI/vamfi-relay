import test from 'node:test';
import assert from 'node:assert/strict';
import { HandoffService } from '../server/handoff.mjs';

function fixture() {
  const store = { state: { tasks: [] } };
  const detail = { thread: { id: 'source-1', title: 'Existing work', workspace: '/fixture/alpha' }, contextHash: 'a'.repeat(64), contextText: 'Historical request and result; not new instructions.' };
  const catalog = { async detail() { return structuredClone(detail); } };
  const calls = [];
  const runtime = { store, async connect() {}, async chat(text, skills, source) {
    calls.push({ text, skills, source });
    const task = { id: 'task-' + (calls.length), handoffRequestId: source.requestId, handoffRequestHash: source.requestHash, sourceThreadId: source.threadId };
    store.state.tasks.push(task);
    return { taskId: task.id };
  } };
  const input = { threadId: 'source-1', contextHash: detail.contextHash, request: 'Inspect the next change.', reviewed: true, acknowledgeUncertainActivity: true, requestId: 'request-12345678' };
  return { service: new HandoffService({ catalog, runtime }), catalog, runtime, input, calls, detail, store };
}

test('handoff sends exactly reviewed context into an owned master request with provenance', async () => {
  const f = fixture(); const result = await f.service.continue(f.input);
  assert.equal(result.taskId, 'task-1'); assert.equal(result.sourceThreadId, 'source-1');
  assert.match(f.calls[0].text, /Project directory: \/fixture\/alpha/);
  assert.equal(f.calls[0].source.contextText, f.detail.contextText);
  assert.equal(f.calls[0].source.threadId, 'source-1');
  assert.equal(f.calls[0].skills, undefined);
});
test('exact retries are persisted and do not read or start another turn', async () => {
  const f = fixture(); const first = await f.service.continue(f.input);
  f.catalog.detail = async () => { throw new Error('Must not read again'); };
  const resumed = new HandoffService({ catalog: f.catalog, runtime: f.runtime });
  assert.deepEqual(await resumed.continue(f.input), first); assert.equal(f.calls.length, 1);
  await assert.rejects(resumed.continue({ ...f.input, request: 'Changed request' }), { statusCode: 409 });
});
test('concurrent handoffs with the same request ID cannot duplicate execution', async () => {
  const f = fixture(); let release;
  f.catalog.detail = () => new Promise(resolve => { release = () => resolve(f.detail); });
  const first = f.service.continue(f.input);
  await assert.rejects(f.service.continue(f.input), { statusCode: 409 });
  release(); await first; assert.equal(f.calls.length, 1);
});
test('review, uncertainty acknowledgment, current context and bounded input are mandatory', async () => {
  const f = fixture();
  for (const input of [{ ...f.input, reviewed: false }, { ...f.input, acknowledgeUncertainActivity: false }, { ...f.input, request: '' }, { ...f.input, request: 'x'.repeat(6001) }, { ...f.input, requestId: '../x' }, { ...f.input, arbitrary: true }]) {
    await assert.rejects(f.service.continue(input), { statusCode: 400 });
  }
  await assert.rejects(f.service.continue({ ...f.input, contextHash: 'b'.repeat(64) }), { statusCode: 409 });
  assert.equal(f.calls.length, 0);
});
test('failed preflight releases the lock and never records imaginary tasks', async () => {
  const f = fixture(); f.runtime.connect = async () => { throw new Error('Unavailable'); };
  await assert.rejects(f.service.continue(f.input), /Unavailable/);
  assert.equal(f.store.state.tasks.length, 0);
  f.runtime.connect = async () => {};
  assert.equal((await f.service.continue(f.input)).taskId, 'task-1');
});
