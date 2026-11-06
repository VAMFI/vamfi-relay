import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, realpathSync, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, linkSync, unlinkSync, fstatSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';
import { reconcileWorkerResult } from './worker-results.mjs';

export const timestamp = () => new Date().toISOString();
export const id = () => randomUUID();
export const active = task => ['queued', 'running', 'waiting'].includes(task.status);

const lockProblem = () => Object.assign(new Error('This Relay data directory is already locked, or its owner cannot be safely verified.'), { statusCode: 409, code: 'RELAY_STORE_LOCKED' });
function readLock(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw lockProblem();
    const owner = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.nonce)) throw lockProblem();
    return { ...owner, inode: info.ino, device: info.dev };
  } finally { closeSync(descriptor); }
}
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function sameLock(left, right) {
  return left.pid === right.pid && left.nonce === right.nonce && left.inode === right.inode && left.device === right.device;
}
function releaseOwnedLock(file, owner) {
  let current;
  try { current = readLock(file); } catch (error) { if (error.code === 'ENOENT') return; throw lockProblem(); }
  if (sameLock(current, owner)) unlinkSync(file);
}

/** Acquire a process-owned private lock before opening or restoring the database. */
export function acquireStoreLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(directory);
  const file = join(canonical, 'relay.lock');
  const candidate = join(canonical, `.relay-lock-${process.pid}-${id()}.tmp`);
  const metadata = { pid: process.pid, nonce: id(), createdAt: timestamp() };
  const descriptor = openSync(candidate, 'wx', 0o600);
  let owner;
  try {
    writeFileSync(descriptor, JSON.stringify(metadata)); fsyncSync(descriptor);
    const info = fstatSync(descriptor); owner = { ...metadata, inode: info.ino, device: info.dev };
  } catch (error) {
    closeSync(descriptor); unlinkSync(candidate); throw error;
  }
  closeSync(descriptor);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Link a fully written file atomically: contenders never see partial metadata.
        linkSync(candidate, file);
        let released = false;
        return () => { if (!released) { releaseOwnedLock(file, owner); released = true; } };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      let existing;
      try { existing = readLock(file); } catch (error) { if (error.code === 'ENOENT') continue; throw lockProblem(); }
      if (ownerAlive(existing.pid)) throw lockProblem();
      // Serialize stale-owner removal so two contenders cannot delete a new owner's lock.
      // An abandoned recovery guard fails closed; it is never guessed to be safe to remove.
      const recovery = join(canonical, 'relay.lock.recovery');
      try { linkSync(candidate, recovery); } catch { throw lockProblem(); }
      try {
        let current;
        try { current = readLock(file); } catch (error) { if (error.code === 'ENOENT') continue; throw lockProblem(); }
        if (!sameLock(existing, current)) continue;
        if (ownerAlive(current.pid)) throw lockProblem();
        unlinkSync(file);
      } finally { releaseOwnedLock(recovery, owner); }
    }
    throw lockProblem();
  } finally { unlinkSync(candidate); }
}

function migrate(state, initialWorkspace) {
  const now = timestamp();
  state.meta ??= {};
  if (state.schemaVersion > 3) throw new Error('This Relay state requires a newer application version.');
  state.meta.version = '0.4.0';
  state.schemaVersion = 3;
  state.settings ??= { workspace: initialWorkspace, permissionMode: 'read-only', maxWorkers: 2 };
  state.projects ??= [];
  state.workItems ??= [];
  state.coordinatorWorkspace ??= state.settings.workspace || initialWorkspace;
  let workspace = state.settings.workspace || initialWorkspace;
  // Preserve a legacy unavailable path for inspection; execution validates it again.
  try { workspace = realpathSync(workspace); } catch {}
  let selected = state.projects.find(project => project.id === state.settings.defaultProjectId);
  if (!selected) {
    selected = state.projects.find(project => project.workspace === workspace);
    if (!selected) {
      const baseName = (basename(workspace).trim() || 'Default project').slice(0, 90);
      let name = baseName;
      let suffix = 2;
      while (state.projects.some(project => project.name.toLowerCase() === name.toLowerCase())) name = `${baseName} (${suffix++})`;
      selected = {
        id: id(), name, workspace,
        permissionMode: ['read-only', 'workspace-write'].includes(state.settings.permissionMode) ? state.settings.permissionMode : 'read-only',
        threadId: null, createdAt: now, updatedAt: now,
      };
      state.projects.push(selected);
    }
    state.settings.defaultProjectId = selected.id;
  }
  const coordinatorIds = new Set(state.threads.filter(thread => thread.role === 'coordinator').map(thread => thread.id));
  for (const message of state.messages) {
    if (!message.channel && coordinatorIds.has(message.threadId)) message.channel = 'master';
  }
  for (const work of state.workItems) {
    work.evidence ??= [];
    work.notes ??= [];
    work.plan ??= null;
    work.planHistory ??= [];
    work.recoveryRequired ??= false;
  }
}

export class Store {
  constructor(directory, workspace) {
    this.releaseLock = acquireStoreLock(directory);
    try {
    this.db = new DatabaseSync(join(directory, 'relay.sqlite'));
    chmodSync(join(directory, 'relay.sqlite'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare('SELECT value FROM state WHERE id = 1').get();
    this.state = row ? JSON.parse(row.value) : {
      meta: { version: '0.4.0', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      connection: { provider: 'codex', status: 'disconnected' },
      settings: { workspace, permissionMode: 'read-only', maxWorkers: 2 },
      mainThreadId: null, threads: [], tasks: [], messages: [], events: [], approvals: [], skills: [],
    };
    migrate(this.state, workspace);
    this.state.connection = { provider: 'codex', status: 'disconnected', message: 'Connect your local Codex to continue.' };
    if(this.state.providers?.hermes)this.state.providers.hermes={status:'disconnected',version:this.state.providers.hermes.version,readOnly:true};
    const interrupted = new Map();
    const held = new Map();
    const remoteUnknown = new Set();
    for (const task of this.state.tasks.filter(active)) {
      // Hermes execution belongs to its gateway; a Relay restart only detaches.
      // Preserve capacity until an explicit outcome check or stop confirms it.
      if (task.provider === 'hermes' && (task.turnStarting || task.turnId || task.providerOutcomeUnknown)) {
        task.status = 'waiting'; task.queueState = null; task.providerOutcomeUnknown = true;
        task.stopError = 'Hermes may still be running. Check its recorded outcome or stop this exact run before retrying.';
        delete task.interruptSent;
        if (task.workId) remoteUnknown.add(task.workId);
        continue;
      }
      if (task.kind === 'project' && task.status === 'queued' && ['waiting', 'held'].includes(task.queueState)) {
        task.queueState = 'held';
        task.queueReason = 'Relay restarted before this queued run began. Explicitly resume this work to allow scheduling.';
        if (task.workId) {
          if (!held.has(task.workId)) held.set(task.workId, []);
          held.get(task.workId).push(task);
        }
        continue;
      }
      task.status = 'interrupted'; task.completedAt = timestamp();
      if (task.kind === 'project') { task.queueState = null; task.queueReason = ''; }
      task.error = task.kind === 'worker'
        ? 'Relay restarted. This specialist was interrupted and was not automatically rerun. Review its assignment before requesting a new one.'
        : task.workId
        ? 'Relay restarted. This run was not automatically rerun. Review it and explicitly start a new project run to resume.'
        : 'Relay restarted. This task was not automatically rerun. Reconnect and send a new message to continue.';
      if (task.workId) {
        if (!interrupted.has(task.workId)) interrupted.set(task.workId, []);
        interrupted.get(task.workId).push(task);
      }
    }
    for (const work of this.state.workItems) {
      if (remoteUnknown.has(work.id)) {
        work.recoveryRequired = true; if(!['paused','cancelled','completed'].includes(work.status))work.status = 'blocked'; work.updatedAt = timestamp();
        work.nextAction = 'Check the existing Hermes run outcome or stop it. Reconnecting never repeats its prompt.';
      }
      const runs = interrupted.get(work.id);
      const queued = held.get(work.id);
      if (runs?.length || queued?.length) {
        work.recoveryRequired = true;
        work.updatedAt = timestamp();
        if (!['paused', 'cancelled', 'completed'].includes(work.status)) work.status = runs?.length ? 'blocked' : 'paused';
        work.nextAction = runs?.length
          ? 'Review the interrupted run, reconnect Codex, and explicitly start or resume the remaining work with retry acknowledgment.'
          : 'This queued work was held after restart. Explicitly resume it when ready.';
      }
      for (const task of runs || []) {
        if (!work.evidence.some(evidence => evidence.taskId === task.id)) {
          work.evidence.push({ taskId: task.id, summary: task.error, status: 'interrupted', createdAt: task.completedAt });
        }
      }
      const plan = work.plan;
      if (!plan) continue;
      for (const step of plan.steps) {
        const task = (runs || []).find(task => task.planId === plan.id && task.stepId === step.id);
        if (task && step.status !== 'finished') {
          step.status = 'interrupted';
          // This is observed restart state, never fabricated agent-reported checkpoint evidence.
          step.checkpoint = { state: 'blocked', summary: task.error, createdAt: task.completedAt, source: 'system_recovery' };
        }
        if ((queued || []).some(task => task.planId === plan.id && task.stepId === step.id) && step.status !== 'finished') step.status = 'queued';
      }
      if (plan.approvedAt && plan.steps.some(step => step.status !== 'finished')) {
        plan.status = runs?.length || plan.steps.some(step => ['blocked', 'interrupted'].includes(step.status)) ? 'blocked' : 'paused';
        plan.updatedAt = timestamp(); work.recoveryRequired = true;
        if (!['paused', 'cancelled', 'completed', 'blocked'].includes(work.status)) work.status = 'paused';
        if (!runs?.length && !queued?.length) work.nextAction = 'The approved plan is paused after restart. Explicitly resume its unfinished steps.';
      }
    }
    for (const approval of this.state.approvals.filter(a => a.status === 'pending')) approval.status = 'expired';
    for (const thread of this.state.threads) thread.status = 'idle';
    for (const message of this.state.messages.filter(m => m.status === 'streaming')) message.status = 'error';
    for (const task of this.state.tasks) reconcileWorkerResult(this.state, task);
    this.persist();
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.releaseLock();
      throw error;
    }
  }
  persist() {
    this.state = redact(this.state);
    this.db.prepare('INSERT INTO state(id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(this.state));
  }
  change(fn) { fn(this.state); this.persist(); this.onChange?.(); }
  snapshot() { return structuredClone({ ...this.state, meta: { ...this.state.meta, now: timestamp() } }); }
  event(type, title, detail = '', refs = {}) {
    const event = { id: id(), createdAt: timestamp(), type, title, detail: String(detail).slice(0,16000), ...refs };
    this.state.events.push(redact(event));
    return event;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.releaseLock(); }
  }
}
