import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';

const command = fileURLToPath(new URL('./fixtures/mock-codex.mjs', import.meta.url));
const tools = [{ type: 'function', name: 'relay_delegate', description: 'Run bounded background work.',
  inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } }];

async function fixture(t, scenario = {}, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'relay-adapter-'));
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify(scenario));
  const adapter = new CodexAdapter({ command, cwd, requestTimeoutMs: 1500, ...options });
  t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
  const wire = async (directory = cwd) => (await readFile(join(directory, 'wire.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  return { adapter, cwd, wire };
}

async function started(t, scenario = {}, options = {}) {
  const f = await fixture(t, scenario, options);
  await f.adapter.connect();
  f.thread = await f.adapter.startThread({ workspace: f.cwd, permissionMode: 'read-only', tools });
  return f;
}

test('handshake, scoped configuration, streaming, and resume preserve runtime settings', async (t) => {
  const { adapter, cwd, wire } = await fixture(t, { mcpNames: ['global.server'] });
  const [first, second] = await Promise.all([adapter.connect(), adapter.connect()]);
  assert.deepEqual(first, { version: '0.147.0', authenticated: true });
  assert.deepEqual(second, first);
  assert.doesNotMatch(JSON.stringify(first), /private|email|codexHome/);
  const workspace = join(cwd, 'project');
  await mkdir(workspace);
  await writeFile(join(workspace, 'scenario.json'), JSON.stringify({ mcpNames: ['project-server'] }));
  const thread = await adapter.startThread({ workspace, permissionMode: 'workspace-write',
    developerInstructions: 'Use the approved workspace.', tools });
  const notices = [];
  adapter.on('notification', (notification) => notices.push(notification));
  const complete = new Promise((resolve) => adapter.on('notification', (event) => {
    if (event.method === 'turn/completed') resolve(event);
  }));
  assert.deepEqual(await adapter.startTurn({ threadId: thread.id, text: 'Hello' }), { id: 'turn-1' });
  assert.equal((await complete).params.turn.status, 'completed');
  assert.equal(notices.find((event) => event.method === 'item/agentMessage/delta').params.delta, 'Hello 🌿');
  assert.deepEqual(await adapter.resumeThread({ id: thread.id }), thread);
  const transcript = await wire();
  assert.equal(transcript.filter((message) => message.method === 'initialize').length, 1);
  const initIndex = transcript.findIndex((message) => message.method === 'initialize');
  assert.equal(transcript[initIndex].params.capabilities.experimentalApi, true);
  assert.equal(transcript[initIndex + 1].method, 'initialized');
  assert.equal(transcript[initIndex + 2].method, 'account/read');
  const launch = transcript.find((message) => message.argv?.[0] === 'app-server').argv;
  for (const setting of ['features.multi_agent=false', 'features.apps=false', 'features.plugins=false',
    'features.browser_use=false', 'features.computer_use=false', 'web_search="disabled"',
    'features.code_mode_host=true', 'features.shell_tool=true', 'features.unified_exec=true',
    'features.code_mode=false',
    'mcp_servers={"global.server"={"enabled"=false}}']) assert.ok(launch.includes(setting), setting);
  const start = transcript.find((message) => message.method === 'thread/start').params;
  const resume = transcript.find((message) => message.method === 'thread/resume').params;
  assert.deepEqual(start.dynamicTools, tools);
  assert.equal(start.config['features.code_mode_host'], true);
  assert.equal(start.config['features.shell_tool'], true);
  assert.equal(start.config['features.unified_exec'], true);
  assert.equal(start.config['features.multi_agent'], false);
  assert.equal(start.config['features.apps'], false);
  assert.equal(start.config['features.plugins'], false);
  assert.equal(start.config.mcp_servers['project-server'].enabled, false);
  for (const field of ['cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'developerInstructions']) {
    assert.deepEqual(resume[field], start[field]);
  }
  assert.equal(Object.hasOwn(resume, 'dynamicTools'), false);
  const turn = transcript.find((message) => message.method === 'turn/start').params;
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.equal(turn.approvalsReviewer, 'user');
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [workspace],
    networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
});

test('account status reports unauthenticated without initiating login', async (t) => {
  const { adapter } = await fixture(t, { authenticated: false });
  assert.deepEqual(await adapter.connect(), { version: '0.147.0', authenticated: false });
});

test('catalog methods read bounded metadata and history without starting or resuming threads', async t => {
  const { adapter, wire } = await fixture(t, { catalog: {
    threads: [{ id: 'external-1', cwd: '/project', status: { type: 'notLoaded' } }],
    turns: [{ id: 'turn-1', status: 'completed', items: [] }],
    projects: [{ id: 'project-1', name: 'Project', roots: [{ path: '/project' }] }],
    memory: { v2Ready: true, v2ConsolidatedThreads: 21 },
  } });
  await adapter.connect();
  const listed = await adapter.listThreads();
  assert.equal(listed.data[0].id, 'external-1');
  assert.equal((await adapter.readThread({ threadId: 'external-1' })).thread.id, 'external-1');
  assert.equal((await adapter.listThreadTurns({ threadId: 'external-1' })).data[0].id, 'turn-1');
  assert.equal((await adapter.listProjects()).data[0].name, 'Project');
  assert.equal((await adapter.memoryStatus()).v2ConsolidatedThreads, 21);
  const transcript = await wire();
  const params = method => transcript.find(row => row.method === method).params;
  assert.equal(params('thread/list').limit, 100);
  assert.equal(params('thread/list').useStateDbOnly, true);
  assert.deepEqual(params('thread/list').modelProviders, []);
  assert.ok(params('thread/list').sourceKinds.includes('subAgent'));
  assert.deepEqual(params('thread/read'), { threadId: 'external-1', includeTurns: false });
  assert.deepEqual(params('thread/turns/list'), { threadId: 'external-1', limit: 20, sortDirection: 'desc', itemsView: 'full' });
  assert.deepEqual(params('project/list'), { limit: 100, sortKey: 'position' });
  assert.deepEqual(params('memory/status'), {});
  assert.equal(transcript.some(row => ['thread/start', 'thread/resume', 'turn/start'].includes(row.method)), false);
  await assert.rejects(adapter.readThread({ threadId: 'external-1', includeTurns: true }), /metadata/);
  await assert.rejects(adapter.listThreadTurns({ threadId: 'external-1', limit: 21 }), /limit/);
});

test('unsupported catalog RPC classification never reveals provider messages or treats unrelated validation as unsupported', async t => {
  const { adapter } = await fixture(t, { catalog: { errors: {
    'project/list': { code: -32600, message: 'unknown variant `project/list`, expected one of PRIVATE_SECRET_METHODS' },
    'memory/status': { code: -32600, message: 'invalid request PRIVATE_SECRET' },
    'thread/turns/list': { code: -32601, message: 'PRIVATE_SECRET' },
  } } });
  await adapter.connect();
  await assert.rejects(adapter.listProjects(), error => error.unsupported === true && !/PRIVATE/.test(JSON.stringify(error)));
  await assert.rejects(adapter.memoryStatus(), error => error.unsupported !== true && !/PRIVATE/.test(JSON.stringify(error)));
  await assert.rejects(adapter.listThreadTurns({ threadId: 'external-1' }), error => error.unsupported === true);
  assert.deepEqual((await adapter.listThreads()).data, []);
});

test('timing out a dedicated catalog provider cannot interrupt execution on a different provider', async t => {
  const execution = await started(t);
  const catalog = await fixture(t, { catalog: { timeout: 'thread/list' } }, { requestTimeoutMs: 250 });
  await catalog.adapter.connect();
  const pendingRequest = once(execution.adapter, 'request');
  await execution.adapter.startTurn({ threadId: execution.thread.id, text: 'request' });
  const [request] = await pendingRequest;
  let executionDisconnected = false;
  execution.adapter.on('disconnect', () => { executionDisconnected = true; });
  await assert.rejects(catalog.adapter.listThreads(), /timed out/);
  const response = new Promise(resolve => execution.adapter.on('notification', event => {
    if (event.method === 'mock/responded') resolve(event.params.response);
  }));
  execution.adapter.respond(request.id, { success: true });
  assert.equal((await response).result.success, true);
  assert.equal(executionDisconnected, false);
  assert.equal((await execution.wire()).filter(row => row.argv?.[0] === 'app-server').length, 1);
});

test('dynamic request response is forwarded exactly once', async (t) => {
  const { adapter, thread } = await started(t);
  const requestEvent = once(adapter, 'request');
  await adapter.startTurn({ threadId: thread.id, text: 'request' });
  const [request] = await requestEvent;
  assert.equal(request.method, 'item/tool/call');
  const returned = new Promise((resolve) => adapter.on('notification', (event) => {
    if (event.method === 'mock/responded') resolve(event.params.response);
  }));
  const result = { success: true, contentItems: [{ type: 'inputText', text: 'Actual worker result.' }] };
  adapter.respond(request.id, result);
  assert.deepEqual(await returned, { id: request.id, result });
  assert.throws(() => adapter.respond(request.id, result), /no longer pending/);
});

test('long-running dynamic requests are not subject to client RPC timeouts', async (t) => {
  const { adapter, thread } = await started(t, {}, { requestTimeoutMs: 250 });
  const requestEvent = once(adapter, 'request');
  await adapter.startTurn({ threadId: thread.id, text: 'request' });
  const [request] = await requestEvent;
  let disconnected = false;
  adapter.on('disconnect', () => { disconnected = true; });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(disconnected, false);
  assert.doesNotThrow(() => adapter.respond(request.id,
    { success: true, contentItems: [{ type: 'inputText', text: 'Worker finished.' }] }));
});

test('interrupt invalidates requests while preserving completion notifications', async (t) => {
  const { adapter, thread } = await started(t);
  const pendingRequest = once(adapter, 'request');
  const turn = await adapter.startTurn({ threadId: thread.id, text: 'cancel' });
  const [request] = await pendingRequest;
  const completed = once(adapter, 'notification');
  const interrupted = adapter.interrupt({ threadId: thread.id, turnId: turn.id });
  assert.throws(() => adapter.respond(request.id, { success: true }), /no longer pending/);
  await interrupted;
  const [event] = await completed;
  assert.equal(event.method, 'turn/completed');
  assert.equal(event.params.turn.status, 'interrupted');
});

test('server-resolved requests cannot receive stale approvals', async (t) => {
  const { adapter, thread } = await started(t);
  const resolved = new Promise((resolve) => adapter.on('notification', (event) => {
    if (event.method === 'serverRequest/resolved') resolve(event);
  }));
  await adapter.startTurn({ threadId: thread.id, text: 'resolved' });
  await resolved;
  assert.throws(() => adapter.respond('server-request-1', {}), /no longer pending/);
});

test('RPC errors expose only method/code and leave the connection usable', async (t) => {
  const { adapter, thread } = await started(t);
  await assert.rejects(adapter.startTurn({ threadId: thread.id, text: 'rpc-error' }), (error) => {
    assert.equal(error.code, -32600);
    assert.doesNotMatch(error.message, /FAKE_SECRET|fake-test-token/);
    return /turn\/start/.test(error.message);
  });
  assert.deepEqual(await adapter.startTurn({ threadId: thread.id, text: 'Hello' }), { id: 'turn-1' });
});

test('RPC timeouts reject every pending call and stop the process', async (t) => {
  const { adapter, thread } = await started(t, {}, { requestTimeoutMs: 250 });
  const disconnected = once(adapter, 'disconnect');
  const results = await Promise.allSettled([
    adapter.startTurn({ threadId: thread.id, text: 'timeout' }),
    adapter.startTurn({ threadId: thread.id, text: 'timeout' }),
  ]);
  assert.ok(results.every((result) => result.status === 'rejected' && /timed out/.test(result.reason.message)));
  assert.match((await disconnected)[0].message, /timed out/);
  await assert.rejects(adapter.startTurn({ threadId: thread.id, text: 'Hello' }), /Resume or start/);
});

for (const [scenario, expected] of [['exit', /exited/], ['invalid', /invalid JSON/], ['oversize', /size limit/]]) {
  test(`process ${scenario} rejects work without exposing provider diagnostics`, async (t) => {
    const { adapter, thread } = await started(t);
    const disconnected = once(adapter, 'disconnect');
    await assert.rejects(adapter.startTurn({ threadId: thread.id, text: scenario }), expected);
    assert.doesNotMatch((await disconnected)[0].message, /FAKE_SECRET/);
  });
}

test('initialization timeout and missing executable fail with sanitized errors', async (t) => {
  const { adapter } = await fixture(t, { initialize: 'timeout' }, { requestTimeoutMs: 250 });
  await assert.rejects(adapter.connect(), /initialize timed out/);
  const missing = new CodexAdapter({ command: '/nonexistent-relay-codex', requestTimeoutMs: 250 });
  t.after(() => missing.close());
  await assert.rejects(missing.connect(), /executable was not found/);
});

for (const mcp of ['invalid', 'shape', 'timeout']) {
  test(`MCP preflight fails closed for ${mcp} listings`, async (t) => {
    const { adapter, wire } = await fixture(t, { mcp }, { requestTimeoutMs: 250 });
    await assert.rejects(adapter.connect(), /MCP configuration/);
    assert.equal((await wire()).some((message) => message.argv?.[0] === 'app-server'), false);
  });
}

test('close cancels a configuration check in progress', async (t) => {
  const { adapter } = await fixture(t, { mcp: 'timeout' });
  const connecting = adapter.connect();
  adapter.close();
  await assert.rejects(connecting, /MCP configuration|closed/);
});

test('close waits for stubborn provider exit and reconnect cannot overlap shutdown', async (t) => {
  const { adapter, cwd, wire } = await fixture(t);
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify({ shutdown: 'stubborn' }));
  // The MCP listing must exit normally; only the provider stays alive on SIGTERM.
  await adapter.connect();
  const oldPid = (await wire()).find(message => message.argv?.[0] === 'app-server').pid;
  let closed = false;
  const closing = Promise.resolve(adapter.close()).then(() => { closed = true; });
  await writeFile(join(cwd, 'scenario.json'), '{}');
  const reconnecting = adapter.connect();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(closed, false, 'shutdown must observe exit before allowing lock release');
  assert.equal((await wire()).filter(message => message.argv?.[0] === 'app-server').length, 1);
  await closing; await reconnecting;
  assert.throws(() => process.kill(oldPid, 0), error => error.code === 'ESRCH');
  const providers = (await wire()).filter(message => message.argv?.[0] === 'app-server');
  assert.equal(providers.length, 2); assert.notEqual(providers[1].pid, oldPid);
});

test('close waits for an owned stubborn MCP preflight to exit', async (t) => {
  const { adapter, wire } = await fixture(t, { mcp: 'stubborn' });
  const connecting = adapter.connect();
  const rejected = assert.rejects(connecting, /MCP configuration|closed/);
  let transcript;
  for (let index = 0; index < 100; index++) {
    transcript = await wire().catch(() => []);
    if (transcript.length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(transcript.length, 'the disposable MCP process started');
  let closed = false;
  const closing = Promise.resolve(adapter.close()).then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(closed, false);
  await closing; await rejected;
  assert.throws(() => process.kill(transcript[0].pid, 0), error => error.code === 'ESRCH');
});

for (const retry of ['close', 'reconnect']) test(`failed shutdown permits ${retry} only after every owned process confirms exit`, async (t) => {
  const { adapter, cwd, wire } = await fixture(t);
  await writeFile(join(cwd, 'scenario.json'), JSON.stringify({ shutdown: 'stubborn' }));
  await adapter.connect();
  const oldPid = (await wire()).find(message => message.argv?.[0] === 'app-server').pid;
  const originalKill = ChildProcess.prototype.kill;
  let ownedChild;
  const blockedKill = t.mock.method(ChildProcess.prototype, 'kill', function (signal) {
    if (this.pid === oldPid) { ownedChild = this; throw new Error('Synthetic owned-process signal failure.'); }
    return originalKill.call(this, signal);
  });
  try {
    await assert.rejects(adapter.close(), /owned Codex process could not be stopped/);
    await assert.rejects(adapter.close(), /owned Codex process could not be stopped/);
    await assert.rejects(adapter.connect(), /owned Codex process could not be stopped/);
    assert.equal((await wire()).filter(message => message.argv?.[0] === 'app-server').length, 1);
  } finally {
    blockedKill.mock.restore();
    if (ownedChild) {
      const exited = once(ownedChild, 'close');
      originalKill.call(ownedChild, 'SIGKILL');
      await exited;
    }
  }
  await writeFile(join(cwd, 'scenario.json'), '{}');
  if (retry === 'close') await adapter.close();
  await adapter.connect();
  assert.equal((await wire()).filter(message => message.argv?.[0] === 'app-server').length, 2);
  assert.throws(() => process.kill(oldPid, 0), error => error.code === 'ESRCH');
});

test('effective permission mismatch terminates the provider', async (t) => {
  const { adapter, cwd } = await fixture(t, { permissions: 'mismatch' });
  await adapter.connect();
  const disconnected = once(adapter, 'disconnect');
  await assert.rejects(adapter.startThread({ workspace: cwd }), /did not confirm/);
  assert.match((await disconnected)[0].message, /permissions/);
});

test('unsupported permissions and malformed or changed tools fail before a turn', async (t) => {
  const { adapter, cwd, thread } = await started(t);
  await assert.rejects(adapter.startThread({ workspace: cwd, permissionMode: 'danger-full-access' }), /permission mode/);
  await assert.rejects(adapter.startThread({ workspace: cwd, tools: [{ name: 'legacy-shape' }] }), /dynamic function/);
  await assert.rejects(adapter.resumeThread({ id: thread.id, tools: [] }), /cannot be changed/);
});
