import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRelease, RELEASE_FILES } from '../scripts/prepare-release.mjs';
import { assertSourceUnchanged } from '../scripts/verify-usecase.mjs';

test('public source export preserves the executable provider fixture and exact manifest', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'relay-export-check-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, 'release');
  const manifest = await prepareRelease(target);
  const fixture = 'tests/fixtures/mock-codex.mjs';
  assert.equal((await stat(join(target, fixture))).mode & 0o777, 0o755);
  assert.equal(manifest.files.find(file => file.path === fixture).mode, 0o755);
  assert.equal((await stat(join(target, 'README.md'))).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(await readFile(join(target, 'SOURCE-MANIFEST.json'), 'utf8')), manifest);
  assert.deepEqual(manifest.files.map(file => file.path), RELEASE_FILES);
  const roots = await readdir(target);
  for (const excluded of ['.git', '.codex', '.agents', 'artifacts', 'tasks', 'node_modules', 'dist']) assert.ok(!roots.includes(excluded));
  await assert.rejects(prepareRelease(target), { code: 'EEXIST' });
});

test('live qualification refuses changed, added, or deleted source files', () => {
  const before = { 'server/example.mjs': 'original' };
  assert.doesNotThrow(() => assertSourceUnchanged(before, { ...before }));
  for (const after of [{ 'server/example.mjs': 'changed' }, { ...before, 'web/added.js': 'new' }, {}]) {
    assert.throws(() => assertSourceUnchanged(before, after), /Source changed during qualification/);
  }
});
