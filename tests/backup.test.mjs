import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, acquireStoreLock } from '../server/store.mjs';
import { createBackup, restoreBackup, validateBackupEnvelope } from '../server/backup.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-backup-'));
  const dataDir = join(directory, 'data');
  const store = new Store(dataDir, directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dataDir, store, outputFile: join(directory, 'backup.json') };
}

function readState(directory) {
  const db = new DatabaseSync(join(directory, 'relay.sqlite'), { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value); }
  finally { db.close(); }
}

function resign(envelope) {
  const { format, formatVersion, createdAt, state } = envelope;
  envelope.sha256 = createHash('sha256').update(JSON.stringify({ format, formatVersion, createdAt, state })).digest('hex');
  return envelope;
}

test('backup reads a live committed snapshot without recovery or mutation, then restores privately', t => {
  const { directory, dataDir, store, outputFile } = fixture(t);
  store.change(state => {
    state.tasks.push({ id: 'running-at-backup', status: 'running', kind: 'project' });
    state.approvals.push({ id: 'approval-at-backup', status: 'pending' });
  });
  const before = structuredClone(store.state);
  const result = createBackup({ dataDir, outputFile });
  assert.equal(result.schemaVersion, 3);
  assert.equal(statSync(outputFile).mode & 0o777, 0o600);
  const envelope = validateBackupEnvelope(JSON.parse(readFileSync(outputFile, 'utf8')));
  assert.deepEqual(envelope.state, before);
  assert.deepEqual(store.state, before);
  assert.deepEqual(readState(dataDir), before);
  const restored = join(directory, 'restored');
  restoreBackup({ inputFile: outputFile, dataDir: restored });
  assert.deepEqual(readState(restored), before);
  assert.equal(statSync(join(restored, 'relay.sqlite')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(restored), ['relay.sqlite']);
});

test('read-only backup excludes uncommitted changes in an open SQLite writer', t => {
  const { dataDir, store, outputFile } = fixture(t);
  const before = structuredClone(store.state);
  store.db.exec('BEGIN IMMEDIATE');
  store.db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify({ ...before, mainThreadId: 'uncommitted-thread' }));
  try {
    createBackup({ dataDir, outputFile });
    assert.deepEqual(JSON.parse(readFileSync(outputFile, 'utf8')).state, before);
  } finally { store.db.exec('ROLLBACK'); }
});

test('backup publication and restore never overwrite existing files or nonempty state', t => {
  const { directory, dataDir, outputFile } = fixture(t);
  createBackup({ dataDir, outputFile });
  const original = readFileSync(outputFile);
  assert.throws(() => createBackup({ dataDir, outputFile }), /EEXIST/);
  assert.deepEqual(readFileSync(outputFile), original);
  const occupied = join(directory, 'occupied'); mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep.txt'), 'keep');
  assert.throws(() => restoreBackup({ inputFile: outputFile, dataDir: occupied }), /empty offline/);
  assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(occupied), ['keep.txt']);
});

test('restore refuses a live writer lock even for a directory with no database', t => {
  const { directory, dataDir, outputFile } = fixture(t);
  createBackup({ dataDir, outputFile });
  const target = join(directory, 'locked');
  const release = acquireStoreLock(target);
  try {
    assert.throws(() => restoreBackup({ inputFile: outputFile, dataDir: target }), { code: 'RELAY_STORE_LOCKED' });
    assert.equal(existsSync(join(target, 'relay.sqlite')), false);
    assert.deepEqual(readdirSync(target), ['relay.lock']);
  } finally { release(); }
});

test('corruption, unsupported formats and invalid state shapes fail before creating the restore directory', t => {
  const { directory, dataDir, outputFile } = fixture(t);
  createBackup({ dataDir, outputFile });
  const original = JSON.parse(readFileSync(outputFile, 'utf8'));
  const variants = [
    { ...structuredClone(original), sha256: '0'.repeat(64) },
    { ...structuredClone(original), formatVersion: 99 },
    resign({ ...structuredClone(original), state: { ...original.state, tasks: ['bad task'] } }),
    resign({ ...structuredClone(original), state: { ...original.state, schemaVersion: 99 } }),
  ];
  for (const [index, envelope] of variants.entries()) {
    const path = join(directory, `bad-${index}.json`);
    const target = join(directory, `target-${index}`);
    writeFileSync(path, JSON.stringify(envelope));
    assert.throws(() => restoreBackup({ inputFile: path, dataDir: target }), /checksum|Unsupported|shape/);
    assert.equal(existsSync(target), false);
  }
});

test('schema v2 backups remain restorable without an implicit migration', t => {
  const { directory, dataDir, store, outputFile } = fixture(t);
  store.change(state => { state.schemaVersion = 2; state.meta.version = '0.2.0'; });
  createBackup({ dataDir, outputFile });
  const target = join(directory, 'v2');
  restoreBackup({ inputFile: outputFile, dataDir: target });
  assert.equal(readState(target).schemaVersion, 2);
  assert.equal(readState(target).meta.version, '0.2.0');
});

test('backup of missing data does not initialize a store or directory', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'missing');
  assert.throws(() => createBackup({ dataDir, outputFile: join(directory, 'backup.json') }));
  assert.equal(existsSync(dataDir), false);
  assert.deepEqual(readdirSync(directory), []);
});
