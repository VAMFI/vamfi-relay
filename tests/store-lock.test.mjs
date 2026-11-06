import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, access, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, acquireStoreLock } from '../server/store.mjs';

const moduleUrl = new URL('../server/store.mjs', import.meta.url).href;
const locked = error => error.code === 'RELAY_STORE_LOCKED' && error.statusCode === 409;
async function directory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-lock-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
const lockData = pid => ({ pid, nonce: randomUUID(), createdAt: new Date().toISOString() });

test('same-process and cross-process contenders cannot touch a live store', async t => {
  const directory = await directoryFor(t);
  const first = new Store(directory, directory); t.after(() => first.close());
  first.change(state => { state.tasks.push({ id: 'live-attempt', status: 'running', kind: 'project' }); });
  const original = first.db.prepare('SELECT value FROM state WHERE id=1').get().value;
  const lock = await stat(join(directory, 'relay.lock'));
  assert.equal(lock.mode & 0o777, 0o600);
  assert.throws(() => new Store(directory, directory), locked);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { Store } from ${JSON.stringify(moduleUrl)}; try { const store = new Store(process.argv[1], process.argv[1]); store.close(); process.exitCode=2; } catch(error) { console.log(error.code); process.exitCode=error.code==='RELAY_STORE_LOCKED'?0:3; }`, directory], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /RELAY_STORE_LOCKED/);
  assert.equal(first.db.prepare('SELECT value FROM state WHERE id=1').get().value, original);
  first.close(); first.close();
  await assert.rejects(access(join(directory, 'relay.lock')), error => error.code === 'ENOENT');
  const next = new Store(directory, directory); next.close();
});

// Separate helper name avoids shadowing the local directory variable in tests.
const directoryFor = directory;

test('dead-owner locks recover, while malformed and symlink locks fail closed', async t => {
  const path = await directoryFor(t); const file = join(path, 'relay.lock');
  await writeFile(file, JSON.stringify(lockData(deadPid())), { mode: 0o600 });
  const release = acquireStoreLock(path);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
  release(); release();
  await writeFile(file, 'unverifiable owner', { mode: 0o600 });
  assert.throws(() => acquireStoreLock(path), locked); assert.equal(await readFile(file, 'utf8'), 'unverifiable owner');
  await unlink(file); const target = join(path, 'unrelated-fixture'); await writeFile(target, 'leave untouched'); await symlink(target, file);
  assert.throws(() => acquireStoreLock(path), locked); assert.equal(await readFile(target, 'utf8'), 'leave untouched');
  await assert.rejects(access(join(path, 'relay.sqlite')), error => error.code === 'ENOENT');
});

test('release only removes its own lock and constructor failure releases ownership', async t => {
  const path = await directoryFor(t); const file = join(path, 'relay.lock');
  const release = acquireStoreLock(path);
  await unlink(file); const replacement = lockData(process.pid); await writeFile(file, JSON.stringify(replacement), { mode: 0o600 });
  release(); assert.equal(JSON.parse(await readFile(file, 'utf8')).nonce, replacement.nonce);
  await unlink(file);
  const db = new DatabaseSync(join(path, 'relay.sqlite')); db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
  db.prepare('INSERT INTO state VALUES(1,?)').run('{invalid'); db.close();
  assert.throws(() => new Store(path, path), SyntaxError);
  await assert.rejects(access(file), error => error.code === 'ENOENT');
  const recovered = acquireStoreLock(path); recovered();
});

test('concurrent stale-lock recovery never admits overlapping owners', async t => {
  const path = await directoryFor(t); await writeFile(join(path, 'relay.lock'), JSON.stringify(lockData(deadPid())), { mode: 0o600 });
  const code = `import { acquireStoreLock } from ${JSON.stringify(moduleUrl)}; import { openSync,closeSync,unlinkSync } from 'node:fs'; import { join } from 'node:path'; let release; try { release=acquireStoreLock(process.argv[1]); } catch(e) { if(e.code==='RELAY_STORE_LOCKED') { console.log('locked'); process.exit(0); } throw e; } const marker=join(process.argv[1],'active-owner'); try { closeSync(openSync(marker,'wx')); } catch(e) { console.log('overlap'); release(); process.exit(5); } setTimeout(()=>{unlinkSync(marker);release();console.log('acquired');},40);`;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, output, errors }));
  })));
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  assert.ok(results.some(result => result.output.includes('acquired')));
  assert.ok(results.every(result => !result.output.includes('overlap')));
});
