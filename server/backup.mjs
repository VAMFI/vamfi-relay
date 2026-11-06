import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync, existsSync, chmodSync, constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { acquireStoreLock } from './store.mjs';
import { canonicalDataDir } from './service.mjs';

const FORMAT = 'vamfi-relay-backup';
const FORMAT_VERSION = 1;
const MAX_BYTES = 256 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;
const nullableString = value => value === null || string(value);
const taskStatuses = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);
const workStatuses = new Set(['planned', 'active', 'blocked', 'needs_review', 'paused', 'completed', 'cancelled']);
const permissions = new Set(['read-only', 'workspace-write']);

/** Reject unsupported or structurally unsafe input before creating any database. */
export function validateBackupState(state) {
  const invalid = () => { throw new Error('The backup does not contain a supported Relay state shape.'); };
  if (!object(state) || ![2, 3].includes(state.schemaVersion)
      || !object(state.meta) || !string(state.meta.version) || !string(state.meta.timezone)
      || !object(state.connection) || state.connection.provider !== 'codex'
      || !object(state.settings) || !string(state.settings.workspace)
      || !permissions.has(state.settings.permissionMode)
      || !Number.isInteger(state.settings.maxWorkers) || state.settings.maxWorkers < 1 || state.settings.maxWorkers > 3
      || !nullableString(state.mainThreadId)) invalid();
  for (const name of ['threads', 'tasks', 'messages', 'events', 'approvals', 'skills', 'projects', 'workItems']) {
    if (!Array.isArray(state[name])) invalid();
    const ids = new Set();
    for (const item of state[name]) {
      if (!object(item) || !string(item.id) || ids.has(item.id)) invalid();
      ids.add(item.id);
    }
  }
  for (const task of state.tasks) if (!taskStatuses.has(task.status)) invalid();
  for (const thread of state.threads) if (!string(thread.role) || !string(thread.status)) invalid();
  for (const message of state.messages) if (!string(message.role) || typeof message.text !== 'string') invalid();
  for (const project of state.projects) {
    if (!string(project.name) || !string(project.workspace) || !permissions.has(project.permissionMode) || !nullableString(project.threadId)) invalid();
  }
  for (const work of state.workItems) {
    if (!string(work.projectId) || !string(work.title) || !workStatuses.has(work.status) || !Array.isArray(work.evidence)) invalid();
    if (state.schemaVersion === 3) {
      if (!Array.isArray(work.notes) || !Array.isArray(work.planHistory)) invalid();
      for (const note of work.notes) if (!object(note) || !string(note.id) || typeof note.text !== 'string' || note.source !== 'external_update') invalid();
      for (const plan of [...work.planHistory, ...(work.plan ? [work.plan] : [])]) {
        if (!object(plan) || !string(plan.id) || !['draft', 'running', 'paused', 'blocked', 'needs_review'].includes(plan.status)
            || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 8) invalid();
        for (const step of plan.steps) if (!object(step) || !string(step.id) || !string(step.title) || !string(step.instructions)
            || !['pending', 'queued', 'running', 'finished', 'blocked', 'interrupted', 'cancelled'].includes(step.status) || !Array.isArray(step.attemptIds)) invalid();
      }
    }
  }
  return state;
}

const checksum = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
function payloadOf(envelope) {
  return { format: envelope.format, formatVersion: envelope.formatVersion, createdAt: envelope.createdAt, state: envelope.state };
}

export function validateBackupEnvelope(envelope) {
  if (!object(envelope) || envelope.format !== FORMAT || envelope.formatVersion !== FORMAT_VERSION) throw new Error('Unsupported Relay backup format or version.');
  if (!string(envelope.createdAt) || !Number.isFinite(Date.parse(envelope.createdAt)) || !/^[a-f0-9]{64}$/.test(envelope.sha256 || '')) throw new Error('Invalid Relay backup metadata.');
  const expected = Buffer.from(checksum(payloadOf(envelope)), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(envelope.sha256, 'hex'))) throw new Error('Backup checksum mismatch. No data was restored.');
  validateBackupState(envelope.state);
  return envelope;
}

function readEnvelope(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Backup must be a regular JSON file no larger than 256 MiB.');
    let envelope;
    try { envelope = JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw new Error('Backup is not valid JSON.'); }
    return validateBackupEnvelope(envelope);
  } finally { closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Link publishes atomically and fails if the destination already exists.
function writePrivateFile(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, path); syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function createBackup({ dataDir, outputFile }) {
  const directory = canonicalDataDir(dataDir);
  const db = new DatabaseSync(join(directory, 'relay.sqlite'), { readOnly: true });
  let state;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const row = db.prepare('SELECT value FROM state WHERE id = 1').get();
    if (!row || typeof row.value !== 'string') throw new Error('The data directory has no durable Relay snapshot.');
    try { state = JSON.parse(row.value); }
    catch { throw new Error('The durable Relay snapshot is not valid JSON.'); }
    validateBackupState(state);
    db.exec('COMMIT');
  } finally { db.close(); }
  const payload = { format: FORMAT, formatVersion: FORMAT_VERSION, createdAt: new Date().toISOString(), state };
  const envelope = { ...payload, sha256: checksum(payload) };
  const path = resolve(outputFile);
  const encoded = JSON.stringify(envelope, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('The backup exceeds the supported 256 MiB limit.');
  writePrivateFile(path, encoded);
  return { path, sha256: envelope.sha256, schemaVersion: state.schemaVersion };
}

export function restoreBackup({ inputFile, dataDir }) {
  const envelope = readEnvelope(resolve(inputFile));
  const directory = canonicalDataDir(dataDir);
  const release = acquireStoreLock(directory);
  const temporary = join(directory, `.relay-restore-${randomUUID()}.sqlite`);
  let db;
  try {
    if (readdirSync(directory).some(name => name !== 'relay.lock')) throw new Error('Restore requires an empty offline data directory; existing data is never overwritten.');
    const fd = openSync(temporary, 'wx', 0o600); closeSync(fd);
    db = new DatabaseSync(temporary);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO state(id,value) VALUES (1,?)').run(JSON.stringify(envelope.state));
    db.close(); db = undefined;
    chmodSync(temporary, 0o600);
    if (readdirSync(directory).some(name => name !== 'relay.lock' && name !== basename(temporary))) throw new Error('The restore destination changed; no existing data was overwritten.');
    linkSync(temporary, join(directory, 'relay.sqlite')); syncDirectory(directory);
    return { dataDir: directory, schemaVersion: envelope.state.schemaVersion, sha256: envelope.sha256 };
  } finally {
    db?.close();
    if (existsSync(temporary)) unlinkSync(temporary);
    release();
  }
}
