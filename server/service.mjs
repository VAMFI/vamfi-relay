import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, mkdirSync, openSync, closeSync, fchmodSync, fstatSync, constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

export const PRODUCT = 'vamfi-relay';
const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
const root = resolve(dirname(entry), '..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Resolve existing ancestors as well, so a new directory under a symlink has
// the same identity before and after the server creates it.
export function canonicalDataDir(directory) {
  let current = resolve(directory);
  const missing = [];
  while (true) {
    try { return join(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
    }
  }
}

export function dataKey(directory) {
  return createHash('sha256').update(canonicalDataDir(directory)).digest('hex');
}

export function serviceIdentity(directory) {
  return { product: PRODUCT, instanceId: randomUUID(), pid: process.pid, dataKey: dataKey(directory) };
}

function positiveInteger(value, fallback, name, minimum = 1, maximum = 60000) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be ${minimum}–${maximum}.`);
  return number;
}

export function serviceOptions(env = process.env) {
  return {
    port: positiveInteger(env.RELAY_PORT, 4318, 'RELAY_PORT', 1024, 65535),
    dataDir: canonicalDataDir(env.RELAY_DATA_DIR || join(homedir(), '.local', 'state', PRODUCT)),
    startTimeoutMs: positiveInteger(env.RELAY_START_TIMEOUT_MS, 10000, 'RELAY_START_TIMEOUT_MS'),
    stopTimeoutMs: positiveInteger(env.RELAY_STOP_TIMEOUT_MS, 10000, 'RELAY_STOP_TIMEOUT_MS'),
  };
}

function request(port, path, { method = 'GET', body, timeoutMs = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const base = `http://127.0.0.1:${port}`;
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(base + path, {
      method,
      headers: encoded === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) },
    }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { req.destroy(new Error('The local service returned an oversized response.')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error('The port did not return a valid Relay response.')); return; }
        resolve({ status: res.statusCode, value });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('The local service did not respond in time.')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(encoded);
  });
}

/** Only ECONNREFUSED proves no listener; other failures remain conflicts. */
export async function inspectService({ port, dataDir, timeoutMs } = {}) {
  let response;
  try { response = await request(port, '/api/health', { timeoutMs }); }
  catch (error) {
    return error.code === 'ECONNREFUSED'
      ? { state: 'offline' }
      : { state: 'conflict', reason: error.message };
  }
  const health = response.value;
  if (response.status !== 200 || health?.ok !== true || health.product !== PRODUCT
      || typeof health.instanceId !== 'string' || !/^[\w-]{8,128}$/.test(health.instanceId)
      || !Number.isSafeInteger(health.pid) || health.pid < 1
      || !/^[a-f0-9]{64}$/.test(health.dataKey || '')) {
    return { state: 'conflict', reason: 'The port is occupied by a service without a valid Relay identity.' };
  }
  if (health.dataKey !== dataKey(dataDir)) return { state: 'conflict', reason: 'The port belongs to Relay using a different data directory.' };
  return { state: 'running', service: health };
}

function conflict(status, port) {
  return new Error(`Port ${port} is unavailable: ${status.reason} Choose another RELAY_PORT.`);
}

export async function startService(options = serviceOptions(), env = process.env) {
  const existing = await inspectService(options);
  if (existing.state === 'running' && existing.service.stopping) throw new Error('Relay is still stopping and retains its state lock. Check status and retry stop before starting again.');
  if (existing.state === 'running') return { ...existing, alreadyRunning: true };
  if (existing.state === 'conflict') throw conflict(existing, options.port);
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const logFile = join(options.dataDir, 'relay-service.log');
  const log = openSync(logFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let child;
  try {
    if (!fstatSync(log).isFile()) throw new Error('The service log must be an ordinary file.');
    fchmodSync(log, 0o600);
    child = spawn(process.execPath, [entry], {
      cwd: root, detached: true, stdio: ['ignore', log, log],
      env: { ...env, RELAY_PORT: String(options.port), RELAY_DATA_DIR: options.dataDir },
    });
  } finally { closeSync(log); }
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure ??= new Error(`The local service exited during startup (code ${code}). Check ${logFile}.`); });
  child.unref();
  const deadline = Date.now() + (options.startTimeoutMs ?? 10000);
  while (Date.now() < deadline) {
    const current = await inspectService(options);
    if (current.state === 'running') return { ...current, alreadyRunning: false, logFile };
    if (current.state === 'conflict') throw conflict(current, options.port);
    if (failure) throw failure;
    await delay(100);
  }
  throw new Error(`The service has not reported ready. Check ${logFile} and run relay status before retrying.`);
}

export async function stopService(options = serviceOptions(), { stopRunning = false } = {}) {
  const current = await inspectService(options);
  if (current.state === 'offline') return current;
  if (current.state === 'conflict') throw conflict(current, options.port);
  const instanceId = current.service.instanceId;
  const response = await request(options.port, '/api/service/stop', { method: 'POST', body: { instanceId, stopRunning }, timeoutMs: options.stopTimeoutMs ?? 10000 });
  if (response.status !== 200 && response.status !== 202) throw new Error(response.value?.error || `The service refused shutdown (${response.status}).`);
  const deadline = Date.now() + (options.stopTimeoutMs ?? 10000);
  while (Date.now() < deadline) {
    const observed = await inspectService(options);
    if (observed.state === 'offline') return { state: 'stopped', instanceId };
    if (observed.state === 'running' && observed.service.instanceId !== instanceId) return { state: 'stopped', instanceId, replaced: true };
    await delay(100);
  }
  throw new Error('Shutdown was requested, but the service has not stopped yet. Run relay status; no PID was killed.');
}
