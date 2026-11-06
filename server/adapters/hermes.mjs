import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redact } from '../security.mjs';

const VERSION = '0.23.0';
const MAX_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,180}$/.test(value);
const threadIdentifier = value => identifier(value) && value.startsWith('hermes:local-');
const terminal = new Set(['completed', 'interrupted', 'failed']);
function failure(message, context = {}, uncertain = false) {
  return Object.assign(new Error(message), { code: uncertain ? 'HERMES_UNCERTAIN' : 'HERMES_REJECTED',
    provider: 'hermes', uncertain, ...Object.fromEntries(['threadId', 'runId', 'turnId']
      .filter(key => identifier(context[key])).map(key => [key, context[key]])) });
}

/** Private bridge to Hermes's native same-user gateway client. Closing it does not stop remote work. */
export class HermesAdapter extends EventEmitter {
  constructor({ hermesRoot = process.env.RELAY_HERMES_ROOT || join(homedir(), '.hermes', 'hermes-agent'),
    pythonCommand, bridgePath = fileURLToPath(new URL('../hermes-bridge.py', import.meta.url)),
    requestTimeoutMs = 30_000, cancelTimeoutMs = 30_000 } = {}) {
    super();
    for (const value of [requestTimeoutMs, cancelTimeoutMs]) if (!Number.isFinite(value) || value <= 0) throw new TypeError('Timeout must be positive.');
    this.root = resolve(hermesRoot); this.command = pythonCommand || join(this.root, 'venv', 'bin', 'python');
    this.bridge = resolve(bridgePath); this.timeout = requestTimeoutMs; this.cancelTimeout = cancelTimeoutMs;
    this.child = null; this.connection = null; this.connecting = null; this.sequence = 0;
    this.pending = new Map(); this.threads = new Map(); this.runs = new Map(); this.submitted = new Set(); this.closing = false;
  }

  async connect() {
    if (this.connection) return { ...this.connection };
    if (this.connecting) return this.connecting;
    if (this.closing) throw failure('Hermes is closing.');
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    if (process.env.HERMES_TUI_GATEWAY_URL?.trim()) throw failure('Remote Hermes gateway overrides are unsupported by this local adapter.');
    const env = { ...process.env };
    // A native local bootstrap must never be redirected to an arbitrary websocket endpoint.
    delete env.HERMES_TUI_GATEWAY_URL; delete env.PYTHONPATH; delete env.PYTHONHOME;
    const child = spawn(this.command, [this.bridge, '--root', this.root, '--node', process.execPath],
      { cwd: this.root, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_BYTES) return this.detached('Hermes protocol size limit exceeded.');
        if (line.trim()) this.receive(line);
        if (this.child !== child) return;
      }
      if (Buffer.byteLength(buffer) > MAX_BYTES) this.detached('Hermes protocol size limit exceeded.');
    });
    child.on('error', () => this.child === child && this.detached('Hermes native bridge could not start.'));
    child.on('close', () => this.child === child && this.detached('Hermes gateway bridge disconnected.'));
    child.stdout.on('error', () => this.child === child && this.detached('Hermes output connection failed.'));
    child.stdin.on('error', () => this.child === child && this.detached('Hermes input connection failed.'));
    try {
      const result = await this.request('connect', {});
      if (result?.version !== VERSION || result?.qualified !== true) throw failure('Hermes version or read-only scope is unsupported.');
      this.connection = { provider: 'hermes', version: VERSION, authenticated: true, permissionMode: 'read-only' };
      return { ...this.connection };
    } catch (error) { this.detached('Hermes connection could not be qualified.'); throw error; }
  }

  request(method, params, timeout = this.timeout) {
    if (!this.child?.stdin.writable) return Promise.reject(failure('Connect Hermes before continuing.'));
    if (this.pending.size >= 32) return Promise.reject(failure('Hermes request queue is full.'));
    const id = ++this.sequence;
    const encoded = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(encoded) > MAX_BYTES) return Promise.reject(failure('Hermes request exceeds the size limit.'));
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('Hermes did not confirm the request. Check its outcome before continuing.', params, method.startsWith('turn/')));
      }, timeout);
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method, context: params });
      this.child.stdin.write(encoded, error => { if (error) this.detached('Hermes input connection failed.'); });
    });
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return this.detached('Hermes sent malformed protocol data.'); }
    if (!object(message)) return this.detached('Hermes sent malformed protocol data.');
    if (message.method === 'notification') return this.notification(message.params);
    if (message.method === 'disconnect') return this.detached('Hermes gateway connection was lost.');
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) {
      const context = { threadId: pending.context.threadId ?? pending.context.id,
        runId: pending.context.runId, ...(identifier(message.error.turnId) ? { turnId: message.error.turnId } : {}) };
      const uncertain = message.error.uncertain === true;
      pending.reject(failure(uncertain ? 'Hermes outcome is uncertain. Check the saved run before retrying.'
        : 'Hermes rejected the request or could not confirm the required read-only scope.', context, uncertain));
    } else if (object(message.result)) pending.resolve(message.result);
    else pending.reject(failure('Hermes returned an invalid response.', {}, pending.method === 'turn/start'));
  }

  options(input) {
    if (input.permissionMode !== undefined && input.permissionMode !== 'read-only') throw new TypeError('Hermes supports read-only project work only.');
    if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length)) throw new TypeError('Hermes custom tools are unsupported.');
    if (typeof input.workspace !== 'string' || !isAbsolute(input.workspace) || input.workspace.includes('\0')) throw new TypeError('An absolute project workspace is required.');
    if (input.developerInstructions !== undefined && (typeof input.developerInstructions !== 'string' || input.developerInstructions.length > 12000)) throw new TypeError('Invalid Hermes project instructions.');
    return { workspace: resolve(input.workspace), permissionMode: 'read-only', developerInstructions: input.developerInstructions || '' };
  }

  async startThread(input) {
    const settings = this.options(input);
    if (!this.connection || this.closing) throw failure('Connect Hermes before starting a session.');
    const result = await this.request('thread/start', { ...settings, requestId: `relay-${randomUUID()}` });
    return this.acceptThread(result, settings);
  }

  async resumeThread(input) {
    if (!threadIdentifier(input.id)) throw failure('A Relay-owned Hermes session is required.');
    const settings = this.options({ ...this.threads.get(input.id), ...input });
    if (!this.connection || this.closing) throw failure('Connect Hermes before resuming a session.');
    if (this.runs.has(input.id)) {
      const previous = this.threads.get(input.id);
      if (!previous || previous.workspace !== settings.workspace) throw failure('An unfinished Hermes run cannot change its project scope.');
      // Outcome-only recovery can reattach an already owned run. It never submits
      // or mutates its frozen session; recover() inspects native scope again.
      return { id: input.id };
    }
    const result = await this.request('thread/resume', { ...settings, id: input.id });
    if (result.id !== input.id) throw failure('Hermes resumed a different session.');
    return this.acceptThread(result, settings);
  }

  acceptThread(result, settings) {
    if (!threadIdentifier(result.id) || result.workspace !== settings.workspace || result.permissionMode !== 'read-only' || result.qualified !== true) {
      throw failure('Hermes did not confirm the required session scope.');
    }
    this.threads.set(result.id, settings);
    return { id: result.id };
  }

  async startTurn({ threadId, text, runId }) {
    if (!identifier(runId)) throw new TypeError('A stable saved run identifier is required.');
    if (!this.connection || !this.threads.has(threadId) || this.closing) throw failure('Resume an owned Hermes session before submitting work.');
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new TypeError('Hermes prompt must contain 1–32000 characters.');
    if (this.runs.has(threadId)) throw failure('Hermes session already has unfinished work.');
    if (this.submitted.has(runId)) throw failure('This run was already submitted. Recover its outcome without resubmitting.', { threadId, runId }, true);
    const run = { threadId, runId, turnId: null, terminal: false };
    this.runs.set(threadId, run); this.submitted.add(runId);
    try {
      const result = await this.request('turn/start', { threadId, text, runId });
      if (!identifier(result.id) || (run.turnId && run.turnId !== result.id)) throw failure('Hermes admission identity was not confirmed.', { threadId, runId }, true);
      run.turnId = result.id;
      return { id: result.id };
    } catch (error) {
      // A gateway can admit a prompt before the bridge loses its acknowledgment.
      if (error.uncertain !== true && error.code === 'HERMES_REJECTED') this.runs.delete(threadId);
      else Object.assign(error, { uncertain: true, code: 'HERMES_UNCERTAIN', threadId, runId, ...(run.turnId ? { turnId: run.turnId } : {}) });
      throw error;
    }
  }

  notification(event) {
    if (!object(event) || !object(event.params)) return;
    const p = event.params, run = this.runs.get(p.threadId);
    const turnId = p.turnId ?? p.turn?.id;
    if (!run || p.runId !== run.runId || !identifier(turnId) || (run.turnId && run.turnId !== turnId) || run.terminal) return;
    run.turnId = turnId;
    const base = { threadId: run.threadId, turnId };
    if (event.method === 'turn/started') this.emit('notification', { method: event.method, params: { ...base, turn: { id: turnId } } });
    else if (event.method === 'item/agentMessage/delta' && typeof p.delta === 'string') this.emit('notification', { method: event.method,
      params: { ...base, itemId: `${run.threadId}:${turnId}:answer`, delta: redact(p.delta.slice(0,16000)) } });
    else if (event.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') this.emit('notification', { method: event.method,
      params: { ...base, item: { id: `${run.threadId}:${turnId}:answer`, type: 'agentMessage', text: redact(p.item.text.slice(0,64000)), phase: 'final_answer' } } });
    else if (event.method === 'item/completed' && p.item?.type === 'providerTool' && typeof p.item.tool === 'string') this.emit('notification', { method: event.method,
      params: { ...base, item: { id: `${run.threadId}:${turnId}:${String(p.item.id).slice(0,100)}`, type: 'providerTool',
        tool: p.item.tool.slice(0,200), status: ['running','completed','failed'].includes(p.item.status) ? p.item.status : 'unknown',
        input: redact(String(p.item.input ?? '').slice(0,8000)), output: redact(String(p.item.output ?? '').slice(0,16000)) } } });
    else if (event.method === 'turn/completed' && terminal.has(p.turn?.status)) {
      run.terminal = true; this.runs.delete(run.threadId);
      this.emit('notification', { method: event.method, params: { ...base, turn: { id: turnId, status: p.turn.status,
        ...(p.turn.status === 'failed' ? { error: { message: 'Hermes reported a failed project turn.' } } : {}) } } });
    }
  }

  async recover({ threadId, runId, turnId }) {
    if (!threadIdentifier(threadId) || !identifier(runId) || (turnId !== undefined && !identifier(turnId))) throw failure('An exact Hermes session and run are required for recovery.');
    if (!this.connection) throw failure('Connect Hermes before checking its outcome.');
    let existing = this.runs.get(threadId);
    if (existing && (existing.runId !== runId || (turnId && existing.turnId && existing.turnId !== turnId))) throw failure('A different owned Hermes run is still unresolved.');
    if (!existing) {
      // Reserve before transport I/O: a terminal event may follow the receipt
      // in the same stdout chunk, before this promise's continuation runs.
      // Failed recovery leaves the reservation uncertain rather than unowned.
      existing = { threadId, runId, turnId: turnId || null, terminal: false };
      this.runs.set(threadId, existing);
    }
    const result = await this.request('turn/recover', { threadId, runId, ...(turnId ? { turnId } : {}) });
    if (result.threadId !== threadId || result.runId !== runId || !['unknown','running',...terminal].includes(result.state)
      || (result.turnId !== undefined && !identifier(result.turnId)) || (turnId && result.turnId && result.turnId !== turnId)) throw failure('Hermes recovery identity was not confirmed.', { threadId, runId, turnId }, true);
    // A terminal event or another reconciliation may have changed ownership
    // while the receipt was in flight. Never replace a newer run or resurrect
    // an admission whose terminal event we already observed.
    if (this.runs.get(threadId) === existing && !existing?.terminal) {
      if (['running', 'unknown'].includes(result.state)) {
        const run = existing ?? { threadId, runId, terminal: false };
        run.turnId = result.turnId || turnId || run.turnId || null;
        this.runs.set(threadId, run);
      }
      if (terminal.has(result.state)) {
        if (existing) existing.terminal = true;
        this.runs.delete(threadId);
      }
    }
    return { state: result.state, threadId, runId, ...(result.turnId ? { turnId: result.turnId } : {}),
      ...(typeof result.result === 'string' ? { result: redact(result.result.slice(0,64000)) } : {}) };
  }

  async interrupt({ threadId, turnId }) {
    const run = this.runs.get(threadId);
    if (!run || !identifier(turnId) || run.turnId !== turnId) throw failure('Only an exact owned Hermes admission can be cancelled.');
    let result;
    try { result = await this.request('turn/interrupt', { threadId, turnId, runId: run.runId }, this.cancelTimeout + this.timeout); }
    catch (error) { if (run.terminal) return; throw error; }
    if (run.terminal) return;
    if (!terminal.has(result.state) || result.turnId !== turnId) throw failure('Hermes cancellation was not confirmed.', { threadId, turnId, runId: run.runId }, true);
    this.notification({ method: 'turn/completed', params: { threadId, runId: run.runId, turn: { id: turnId, status: result.state } } });
  }

  detached(message) {
    const child = this.child;
    this.child = null; this.connection = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure(message, { threadId: pending.context.threadId, runId: pending.context.runId }, pending.method.startsWith('turn/')));
    }
    this.pending.clear();
    child?.kill('SIGTERM');
    if (child) this.emit('disconnect', { provider: 'hermes', uncertain: this.runs.size > 0, message });
  }

  async close() {
    if (this.closing) throw failure('Hermes shutdown is already in progress.');
    this.closing = true;
    try {
      if (this.runs.size && !this.connection) throw failure('Hermes remote work remains uncertain; reconnect and check its outcome.', {}, true);
      for (const run of [...this.runs.values()]) {
        if (run.terminal) continue;
        if (!run.turnId) {
          const result = await this.recover(run);
          if (terminal.has(result.state)) continue;
          if (result.state !== 'running' || !result.turnId) throw failure('Hermes remote work remains uncertain.', run, true);
          run.turnId = result.turnId;
        }
        await this.interrupt(run);
      }
      if (this.child) {
        await this.request('close', {});
        const child = this.child; this.child = null; this.connection = null;
        child.stdin.end();
        await new Promise((resolveExit, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(failure('Hermes bridge exit was not confirmed.')); }, 5000);
          child.once('close', () => { clearTimeout(timer); resolveExit(); });
        });
      }
    } finally { this.closing = false; }
  }
}
