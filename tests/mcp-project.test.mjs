import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../server/mcp-project.mjs', import.meta.url));
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialize = [rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })];

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'relay-mcp-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

async function run(root, lines, args = ['--root', root]) {
  const child = spawn(process.execPath, [executable, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP process did not exit within its test deadline.')); }, 5000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, replies: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [] }); });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(`${lines.join('\n')}\n`);
  return done;
}

test('stdio MCP negotiates the fixed version, advertises only three tools and returns actual scoped file content', async t => {
  const root = await fixture(t), marker = randomUUID();
  await fs.writeFile(path.join(root, 'notes.md'), `review ${marker}\n`);
  const result = await run(root, [...initialize, rpc(2, 'ping'), rpc(3, 'tools/list'),
    rpc(4, 'tools/call', { name: 'read_file', arguments: { path: 'notes.md' } }),
    rpc(5, 'tools/call', { name: 'search_files', arguments: { query: marker } })]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.replies.length, 5, 'notifications must not receive replies');
  assert.equal(result.replies[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(result.replies[0].result.capabilities, { tools: {} });
  assert.deepEqual(result.replies[1].result, {});
  assert.deepEqual(result.replies[2].result.tools.map(tool => tool.name), ['list_files', 'read_file', 'search_files']);
  const read = result.replies[3].result;
  assert.equal(read.isError, false);
  assert.equal(JSON.parse(read.content[0].text).text, `review ${marker}\n`);
  assert.equal(JSON.parse(result.replies[4].result.content[0].text).matches[0].line, 1);
});

test('malformed JSON, invalid requests, unavailable methods, bad arguments and denied files have bounded protocol errors', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_PRIVATE_FIXTURE');
  const result = await run(root, ['{', '[]', rpc(10, 'tools/list'), ...initialize,
    rpc(11, 'shell', { command: 'pwd' }), rpc(12, 'tools/call', { name: 'exec', arguments: {} }),
    rpc(13, 'tools/call', { name: 'read_file', arguments: { path: '.env' } }),
    rpc(14, 'tools/call', { name: 'read_file', arguments: { path: 'x', root: '/' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'ignored/notification' }), rpc(15, 'ping')]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.replies.slice(0, 3).map(reply => reply.error.code), [-32700, -32600, -32002]);
  assert.equal(result.replies.find(r => r.id === 11).error.code, -32601);
  assert.equal(result.replies.find(r => r.id === 12).error.code, -32602);
  assert.equal(result.replies.find(r => r.id === 13).result.isError, true);
  assert.equal(result.replies.find(r => r.id === 14).error.code, -32602);
  assert.ok(!result.stdout.includes('SYNTHETIC_PRIVATE_FIXTURE'));
  assert.ok(!result.stdout.includes(root));
  assert.deepEqual(result.replies.at(-1).result, {});
});

test('oversized input is rejected without buffering the remainder and replies never exceed 64KiB', async t => {
  const root = await fixture(t);
  const huge = 'x'.repeat(256 * 1024 + 1);
  const result = await run(root, [huge]);
  assert.equal(result.code, 1);
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].error.code, -32600);
  for (const line of result.stdout.trim().split('\n')) assert.ok(Buffer.byteLength(line) <= 64 * 1024);
});

test('escaped content and long request IDs cannot make an oversized protocol reply', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'quotes.txt'), '\\"'.repeat(20000));
  const result = await run(root, [...initialize,
    rpc(2, 'tools/call', { name: 'read_file', arguments: { path: 'quotes.txt' } }),
    rpc('i'.repeat(100000), 'ping')]);
  assert.equal(result.code, 0);
  for (const line of result.stdout.trim().split('\n')) assert.ok(Buffer.byteLength(line) <= 64 * 1024);
  assert.equal(result.replies[1].result.isError, false);
  assert.equal(JSON.parse(result.replies[1].result.content[0].text).truncated, true);
  assert.equal(result.replies.at(-1).error.code, -32600);
});

test('rejects relative, missing, sensitive and injected root options before serving requests', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.ssh'));
  for (const args of [[], ['--root', '.'], ['--root', path.join(root, 'missing')], ['--root', path.join(root, '.ssh')], ['--root', root, '--root', '/']]) {
    const result = await run(root, [rpc(1, 'ping')], args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(root));
  }
});
