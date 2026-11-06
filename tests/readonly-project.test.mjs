import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadonlyProject, READONLY_LIMITS } from '../server/readonly-project.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'relay-readonly-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  return { base, root, project: await createReadonlyProject(root) };
}

test('lists sorted relative files, reads unpredictable text and searches literal text with line provenance', async t => {
  const { root, project } = await fixture(t);
  const marker = randomUUID();
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'index.js'), `first\n${marker} [a.*]\nlast\n`);
  await fs.writeFile(path.join(root, 'README.md'), 'ordinary project');
  assert.deepEqual((await project.call('list_files', {})).files.map(f => f.path), ['README.md', 'src/index.js']);
  assert.deepEqual(await project.call('read_file', { path: 'src/index.js' }), { path: 'src/index.js', text: `first\n${marker} [a.*]\nlast\n`, truncated: false });
  assert.deepEqual((await project.call('search_files', { query: '[a.*]' })).matches,
    [{ path: 'src/index.js', line: 2, text: `${marker} [a.*]` }]);
  assert.equal((await project.call('search_files', { query: '.*' })).matches.length, 1);
  assert.equal((await project.call('search_files', { query: '^first' })).matches.length, 0);
});

test('rejects traversal, absolute paths, NUL, Windows paths and attempts to change the root', async t => {
  const { base, project } = await fixture(t);
  await fs.writeFile(path.join(base, 'outside.txt'), randomUUID());
  for (const unsafe of ['../outside.txt', 'src/../../outside.txt', '/etc/passwd', 'src/../good', 'x\0y', 'C:\\data\\file', '..\\outside.txt', 'file://outside']) {
    await assert.rejects(project.call('read_file', { path: unsafe }));
  }
  await assert.rejects(project.call('list_files', { root: base }));
  await assert.rejects(project.call('read_file', { path: '.', command: 'pwd' }));
  await assert.rejects(project.call('shell', { command: 'pwd' }));
  await assert.rejects(createReadonlyProject('.'));
});

test('denies sensitive files and directories from reads, listings and searches', async t => {
  const { root, project } = await fixture(t);
  const paths = ['.env', '.env.example', '.npmrc', 'auth.json', 'credentials.json', 'server.key', 'private.pem', '.git/config', '.relay/state.json', 'node_modules/pkg/index.js', '.ssh/config', '.hermes/config.yaml'];
  for (const filename of paths) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.writeFile(path.join(root, filename), 'SYNTHETIC_PRIVATE_FIXTURE');
    await assert.rejects(project.call('read_file', { path: filename }), undefined, filename);
  }
  await fs.writeFile(path.join(root, 'safe.txt'), 'safe');
  assert.deepEqual((await project.call('list_files', {})).files.map(f => f.path), ['safe.txt']);
  assert.deepEqual((await project.call('search_files', { query: 'SYNTHETIC_PRIVATE_FIXTURE' })).matches, []);
});

test('rejects sibling aliases, symlink ancestors, hardlinks, directories and binary content', async t => {
  const { base, root, project } = await fixture(t);
  const sibling = path.join(base, 'project-sibling');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'outside'), randomUUID());
  await fs.symlink(sibling, path.join(root, 'alias'));
  await fs.symlink(path.join(sibling, 'outside'), path.join(root, 'file-link'));
  await fs.link(path.join(sibling, 'outside'), path.join(root, 'hard-link'));
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([65, 0, 66]));
  await fs.writeFile(path.join(root, 'invalid-utf8'), Buffer.from([0xff, 0xfe]));
  for (const filename of ['alias/outside', 'file-link', 'hard-link', '.', 'binary', 'invalid-utf8']) {
    await assert.rejects(project.call('read_file', { path: filename }), undefined, filename);
  }
  assert.ok(!(await project.call('list_files', {})).files.some(f => /alias|link/.test(f.path)));
  assert.deepEqual((await project.call('search_files', { query: 'outside' })).matches, []);
});

test('redacts complete bounded text before searching or truncating a UTF-8-safe display prefix', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'config.txt'), 'visible\nAPI_KEY=SYNTHETIC_PRIVATE_FIXTURE\n');
  assert.equal((await project.call('read_file', { path: 'config.txt' })).text, 'visible\nAPI_KEY=[REDACTED]\n');
  assert.deepEqual((await project.call('search_files', { query: 'SYNTHETIC_PRIVATE_FIXTURE' })).matches, []);
  await fs.writeFile(path.join(root, 'long.txt'), '🙂'.repeat(20000));
  const result = await project.call('read_file', { path: 'long.txt' });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= READONLY_LIMITS.readTextBytes);
  assert.ok(!result.text.includes('�'));
  await fs.writeFile(path.join(root, 'oversized'), Buffer.alloc(READONLY_LIMITS.fileBytes + 1, 65));
  await assert.rejects(project.call('read_file', { path: 'oversized' }));
});

test('holds a fixed root identity and refuses replacement with another directory or symlink', async t => {
  const { base, root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'original');
  await fs.rename(root, path.join(base, 'old-project'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'file'), 'replacement');
  await assert.rejects(project.call('read_file', { path: 'file' }));
  await assert.rejects(project.call('list_files', {}));
});

test('rejects sensitive names in original and canonical root ancestry', async t => {
  const { base } = await fixture(t);
  for (const directory of ['.hermes', '.claude', '.config', '.relay', 'node_modules', '.env.local', 'credentials']) {
    const root = path.join(base, directory, 'nested');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'session.json'), 'SYNTHETIC_PRIVATE_RUNTIME_CONTEXT');
    await assert.rejects(createReadonlyProject(root), undefined, directory);
  }
  await fs.symlink(path.join(base, '.hermes'), path.join(base, 'safe-alias'));
  await assert.rejects(createReadonlyProject(path.join(base, 'safe-alias', 'nested')));
});

test('search retains original line numbers after full-block and multiline value redaction', async t => {
  const { root, project } = await fixture(t);
  const marker = randomUUID();
  const text = `before\n-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\nneedle\nAPI_KEY="one\ntwo"\nlast needle\n`;
  await fs.writeFile(path.join(root, 'notes.txt'), text);
  assert.deepEqual((await project.call('search_files', { query: 'needle' })).matches,
    [{ path: 'notes.txt', line: 5, text: 'needle' }, { path: 'notes.txt', line: 8, text: 'last needle' }]);
  assert.deepEqual((await project.call('search_files', { query: marker })).matches, []);
  assert.deepEqual((await project.call('search_files', { query: 'two' })).matches, []);
});

test('hyphenated credentials are absent from scoped reads and searches', async t => {
  const { root, project } = await fixture(t);
  const marker = randomUUID();
  await fs.writeFile(path.join(root, 'config.yaml'), `api-key: ${marker}\nX-API-Key: ${marker}\nordinary: visible\n`);
  const result = await project.call('read_file', { path: 'config.yaml' });
  assert.ok(!result.text.includes(marker));
  assert.ok(result.text.includes('ordinary: visible'));
  assert.deepEqual((await project.call('search_files', { query: marker })).matches, []);
});

test('uses no-follow nonblocking opens and rejects a file replaced after opening before returning any bytes', async t => {
  const { root, project } = await fixture(t);
  const filename = path.join(root, 'file');
  await fs.writeFile(filename, randomUUID());
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (target, flags, ...rest) => {
    assert.ok(flags & constants.O_NOFOLLOW);
    assert.ok(flags & constants.O_NONBLOCK);
    const handle = await originalOpen(target, flags, ...rest);
    if (target === await fs.realpath(filename)) {
      await fs.rename(filename, path.join(root, 'old-file'));
      await fs.writeFile(filename, 'replacement');
    }
    return handle;
  });
  await assert.rejects(project.call('read_file', { path: 'file' }));
});

test('rejects an ancestor replaced during reading and a hardlink added during reading', async t => {
  const { root, project } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'file'), randomUUID());
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    let altered = false;
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!altered) {
        altered = true;
        await fs.rename(path.join(root, 'src'), path.join(root, 'old-src'));
        await fs.mkdir(path.join(root, 'src'));
        await fs.link(path.join(root, 'old-src', 'file'), path.join(root, 'src', 'file'));
      }
      return result;
    };
    return handle;
  });
  await assert.rejects(project.call('read_file', { path: 'src/file' }));
});

test('enforces argument, file-count and depth bounds and signals incomplete listings/searches', async t => {
  const { root, project } = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  for (const filename of ['a', 'b', 'nested/c']) await fs.writeFile(path.join(root, filename), 'match');
  const listing = await project.call('list_files', { maxDepth: 0, limit: 1 });
  assert.equal(listing.files.length, 1);
  assert.equal(listing.truncated, true);
  const search = await project.call('search_files', { query: 'match', limit: 1 });
  assert.equal(search.matches.length, 1);
  assert.equal(search.truncated, true);
  for (const args of [{ limit: -1 }, { limit: 201 }, { maxDepth: 9 }, { maxDepth: 1.5 }]) await assert.rejects(project.call('list_files', args));
  for (const query of ['', 'x'.repeat(257), null]) await assert.rejects(project.call('search_files', { query }));
});

test('denies FIFO, oversized and binary-tail files without returning a partial text prefix', async t => {
  const { root, project } = await fixture(t);
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  await fs.writeFile(path.join(root, 'tail'), Buffer.concat([Buffer.alloc(30 * 1024, 65), Buffer.from([0])]));
  for (const filename of ['pipe', 'tail']) await assert.rejects(project.call('read_file', { path: filename }));
  assert.ok(!(await project.call('list_files', {})).files.some(file => file.path === 'pipe'));
});

test('rejects a newly added hardlink and content mutations even when the path and inode stay the same', async t => {
  const { root, project } = await fixture(t);
  const filename = path.join(root, 'file');
  await fs.writeFile(filename, 'original');
  const originalOpen = fs.open;
  let mode = 'hardlink';
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args), originalRead = handle.read.bind(handle);
    let altered = false;
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!altered) {
        altered = true;
        if (mode === 'hardlink') await fs.link(filename, path.join(root, 'alias'));
        else await fs.writeFile(filename, 'modified');
      }
      return result;
    };
    return handle;
  });
  await assert.rejects(project.call('read_file', { path: 'file' }));
  await fs.unlink(path.join(root, 'alias'));
  mode = 'modify';
  await assert.rejects(project.call('read_file', { path: 'file' }));
});

test('refuses directory names gathered while an ancestor was replaced', async t => {
  const { root, project } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'file'), randomUUID());
  const originalOpendir = fs.opendir;
  t.mock.method(fs, 'opendir', async (...args) => {
    const dir = await originalOpendir(...args);
    if (args[0].endsWith('/src')) {
      await fs.rename(path.join(root, 'src'), path.join(root, 'old-src'));
      await fs.mkdir(path.join(root, 'src'));
    }
    return dir;
  });
  await assert.rejects(project.call('list_files', { path: 'src' }));
});

test('read results fit the facade JSON byte cap even for heavily escaped text', async t => {
  const { root, project } = await fixture(t);
  await fs.writeFile(path.join(root, 'escaped'), '\\"'.repeat(30000));
  const result = await project.call('read_file', { path: 'escaped' });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READONLY_LIMITS.resultBytes);
  assert.equal(result.truncated, true);
});

test('search scans at most 200 files or 2MiB and reports incompleteness', async t => {
  const { root, project } = await fixture(t);
  for (let i = 0; i < 201; i++) await fs.writeFile(path.join(root, `f${String(i).padStart(3, '0')}`), 'ordinary');
  const boundedFiles = await project.call('search_files', { query: 'absent' });
  assert.equal(boundedFiles.filesSearched, 200);
  assert.equal(boundedFiles.truncated, true);
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(root, `f${String(i).padStart(3, '0')}`), 'x'.repeat(128 * 1024));
  const boundedBytes = await project.call('search_files', { query: 'absent' });
  assert.ok(boundedBytes.filesSearched <= 16);
  assert.equal(boundedBytes.truncated, true);
});

test('bounds even directory entries that are denied and never returned', async t => {
  const { root, project } = await fixture(t);
  for (let i = 0; i < READONLY_LIMITS.entries + 1; i++) await fs.writeFile(path.join(root, `.env.${i}`), 'synthetic');
  const result = await project.call('list_files', {});
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, true);
});
