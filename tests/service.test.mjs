import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonicalDataDir, dataKey, serviceIdentity, serviceOptions, inspectService, startService, stopService } from '../server/service.mjs';
import { runCli, openBrowser } from '../scripts/relay.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/relay.mjs', import.meta.url));

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'relay-service-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return { instance, port: instance.address().port };
}

async function unusedPort() {
  const instance = http.createServer();
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const port = instance.address().port;
  await new Promise(resolve => instance.close(resolve));
  return port;
}

test('service identity canonicalizes aliases and missing descendants without creating them', async t => {
  const path = await directory(t);
  await mkdir(join(path, 'real')); await symlink(join(path, 'real'), join(path, 'alias'));
  const real = join(path, 'real', 'future'); const alias = join(path, 'alias', 'future');
  assert.equal(dataKey(real), dataKey(alias));
  const identity = serviceIdentity(real);
  assert.equal(identity.product, 'vamfi-relay'); assert.equal(identity.pid, process.pid);
  assert.equal(identity.dataKey, dataKey(alias)); assert.notEqual(identity.instanceId, serviceIdentity(real).instanceId);
  await mkdir(real);
  assert.equal(canonicalDataDir(alias), canonicalDataDir(real));
  assert.equal(identity.dataKey, dataKey(real));
});

test('foreign services and different data directories are conflicts and never receive stop', async t => {
  const path = await directory(t); let stops = 0;
  const identity = serviceIdentity(path);
  let health = { ok: true, ...identity };
  const { port } = await server(t, (req, res) => {
    if (req.url === '/api/service/stop') stops++;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(health));
  });
  assert.equal((await inspectService({ port, dataDir: path })).state, 'running');
  assert.equal((await inspectService({ port, dataDir: join(path, 'other') })).state, 'conflict');
  await assert.rejects(stopService({ port, dataDir: join(path, 'other') }), /different data directory/);
  health = { ok: true, version: 'legacy' };
  await assert.rejects(startService({ port, dataDir: path }), /valid Relay identity/);
  await assert.rejects(stopService({ port, dataDir: path }), /valid Relay identity/);
  assert.equal(stops, 0);
});

test('stop uses the observed instance and same-origin HTTP; active-work refusal is preserved', async t => {
  const dataDir = await directory(t); const identity = serviceIdentity(dataDir);
  const bodies = [];
  const { port, instance } = await server(t, async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, ...identity, activeTasks: 1 })); return; }
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/service/stop');
    assert.equal(req.headers.origin, `http://127.0.0.1:${port}`);
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); bodies.push(body); assert.equal(body.instanceId, identity.instanceId);
    if (!body.stopRunning) { res.statusCode = 409; res.end(JSON.stringify({ error: 'Active work requires --stop-running.' })); return; }
    res.end(JSON.stringify({ ok: true })); setImmediate(() => instance.close());
  });
  await assert.rejects(stopService({ port, dataDir }), /Active work/);
  assert.equal((await stopService({ port, dataDir }, { stopRunning: true })).state, 'stopped');
  assert.deepEqual(bodies.map(body => body.stopRunning), [false, true]);
});
test('a service awaiting shutdown is not reported as a successful start', async t => {
  const dataDir=await directory(t),identity=serviceIdentity(dataDir),output=[];
  const {port}=await server(t,(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,...identity,stopping:true,activeTasks:0}));});
  await assert.rejects(startService({port,dataDir}),/still stopping/);
  await runCli(['status'],{env:{RELAY_PORT:String(port),RELAY_DATA_DIR:dataDir},write:line=>output.push(line)});
  assert.match(output[0],/shutdown is not yet confirmed/);
});

test('CLI validates options and reports an unused loopback port without creating data', async t => {
  const path = await directory(t); const port = await unusedPort(); const output = [];
  const env = { RELAY_PORT: String(port), RELAY_DATA_DIR: join(path, 'new') };
  assert.equal(await runCli(['status'], { env, write: line => output.push(line) }), 0);
  assert.match(output[0], /not running/);
  assert.equal((await stat(env.RELAY_DATA_DIR).catch(() => null)), null);
  assert.throws(() => serviceOptions({ RELAY_PORT: '0' }), /RELAY_PORT/);
  await assert.rejects(runCli(['stop', '--force'], { env }), /Usage/);
  await assert.rejects(runCli(['backup'], { env }), /Usage/);
  const help = [];
  assert.equal(await runCli(['--help'], { write: line => help.push(line) }), 0);
  assert.match(help[0], /start \[--open\]/);
  for (const args of [['status', '--open'], ['stop', '--open'], ['start', '--open', '--open'], ['start', '--stop-running'], ['help', '--open']]) {
    await assert.rejects(runCli(args, { env }), /Usage/);
  }
});

test('browser opener uses a fixed executable and one loopback URL argument without a shell', async () => {
  const calls = [];
  const url = 'http://127.0.0.1:4318';
  for (const platform of ['darwin', 'linux', 'win32']) {
    await openBrowser(url, { platform, launch: async (...args) => calls.push(args) });
  }
  assert.deepEqual(calls.map(call => call[0]), ['/usr/bin/open', 'xdg-open', 'explorer.exe']);
  for (const [, args, options] of calls) {
    assert.deepEqual(args, [url]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
  }
  await assert.rejects(openBrowser('http://127.0.0.1:4318; whoami'), /Only the local/);
  await assert.rejects(openBrowser('https://example.com'), /Only the local/);
  await assert.rejects(openBrowser(url, { platform: 'unsupported' }), /No browser opener/);
});

test('start opens only the verified matching instance and browser failure does not hide its running state', async t => {
  const dataDir = await directory(t); const identity = serviceIdentity(dataDir); const opened = []; const output = [];
  let health = { ok: true, ...identity };
  const { port } = await server(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(health)); });
  const options = { env: { RELAY_PORT: String(port), RELAY_DATA_DIR: dataDir }, write: line => output.push(line), open: async url => opened.push(url) };
  await runCli(['start'], options);
  assert.equal(opened.length, 0);
  assert.equal(await runCli(['start', '--open'], options), 0);
  assert.deepEqual(opened, [`http://127.0.0.1:${port}`]);
  assert.equal(await runCli(['start', '--open'], { ...options, open: async () => { throw new Error('no desktop'); } }), 0);
  assert.match(output.at(-1), /is running, but the browser could not be opened/);
  health = { ok: true, ...serviceIdentity(join(dataDir, 'other')) };
  await assert.rejects(runCli(['start', '--open'], options), /different data directory/);
  assert.equal(opened.length, 1);
});

test('a shutdown acknowledgment without disappearance remains a failure and leaves the listener alone', async t => {
  const dataDir = await directory(t); const identity = serviceIdentity(dataDir);
  let stopRequests = 0;
  const { port } = await server(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') res.end(JSON.stringify({ ok: true, ...identity }));
    else { stopRequests++; res.statusCode = 202; res.end(JSON.stringify({ stopping: true })); }
  });
  await assert.rejects(stopService({ port, dataDir, stopTimeoutMs: 40 }), /has not stopped yet/);
  assert.equal(stopRequests, 1);
  assert.equal((await inspectService({ port, dataDir })).service.instanceId, identity.instanceId);
});

test('production startup refuses a data directory with a live writer and preserves its lock', { timeout: 5000 }, async t => {
  const dataDir = await directory(t); const port = await unusedPort();
  const { acquireStoreLock } = await import('../server/store.mjs');
  const release = acquireStoreLock(dataDir);
  try {
    await assert.rejects(startService({ dataDir, port, startTimeoutMs: 2000 }), /exited during startup/);
    assert.equal((await inspectService({ port, dataDir })).state, 'offline');
    assert.equal((await stat(join(dataDir, 'relay.sqlite')).catch(() => null)), null);
    assert.ok((await stat(join(dataDir, 'relay.lock'))).isFile());
  } finally { release(); }
});

test('production CLI starts detached, is idempotent, reports identity, and stops its disposable service', { timeout: 30000 }, async t => {
  const path = await mkdtemp(join(tmpdir(), 'relay-service-cli-')); const port = await unusedPort();
  const env = { ...process.env, RELAY_PORT: String(port), RELAY_DATA_DIR: join(path, 'data'), RELAY_WORKSPACE: path };
  const options = serviceOptions(env);
  t.after(async () => {
    const stopped = await stopService(options).then(() => true, () => false);
    if (stopped) await rm(path, { recursive: true, force: true });
  });
  const first = await exec(process.execPath, [cli, 'start'], { env, timeout: 15000 });
  assert.match(first.stdout, /Relay started/);
  const observed = await inspectService(options);
  assert.equal(observed.state, 'running'); assert.notEqual(observed.service.pid, process.pid);
  const second = await exec(process.execPath, [cli, 'start'], { env, timeout: 15000 });
  assert.match(second.stdout, /already running/);
  assert.equal((await inspectService(options)).service.instanceId, observed.service.instanceId);
  assert.match((await exec(process.execPath, [cli, 'status'], { env })).stdout, /Relay is running/);
  assert.equal((await stat(join(options.dataDir, 'relay-service.log'))).mode & 0o777, 0o600);
  assert.match((await exec(process.execPath, [cli, 'stop'], { env, timeout: 15000 })).stdout, /Relay stopped/);
  assert.equal((await inspectService(options)).state, 'offline');
  assert.match((await exec(process.execPath, [cli, 'stop'], { env })).stdout, /already stopped/);
});
