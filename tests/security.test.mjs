import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { redact, validateRequest, normalizeWorkspace } from '../server/security.mjs';

const rejected = error => error.statusCode === 403;
const request = (host, origin, method = 'POST') => ({ method, headers: { host, ...(origin === undefined ? {} : { origin }) } });

test('redacting a bounded long memory line does not rescan every suffix', () => {
  const line = 'x'.repeat(128 * 1024);
  const started = performance.now();
  assert.equal(redact(line), line);
  assert.ok(performance.now() - started < 1500, 'Redaction must remain responsive on the bounded history input.');
  assert.equal(redact('prefix OPENAI_API_KEY=CANARY_VALUE'), 'prefix OPENAI_API_KEY=[REDACTED]');
});

test('redact removes synthetic credentials recursively while preserving useful prose and counts', () => {
  const input = {
    messages: [{ text: 'Explain how API keys work; tokens count usage.' }], tokens: 120,
    settings: { apiKey: 'CANARY_OBJECT_KEY', OPENAI_API_KEY: 'CANARY_ENV_KEY', nested: [{ password: 'CANARY_PASSWORD' }] },
    detail: 'OPENAI_API_KEY=CANARY_ASSIGNMENT\nclient_secret: "CANARY_QUOTED"\nAuthorization: Bearer CANARY_BEARER\nhttps://user:CANARY_URL@example.test',
    pem: 'before\n-----BEGIN RSA PRIVATE KEY-----\nCANARY_PRIVATE\n-----END RSA PRIVATE KEY-----\nafter',
    prefix: 'sk-proj-CANARY_SYNTHETIC_TOKEN',
  };
  const result = redact(input);
  assert.equal(result.messages[0].text, input.messages[0].text);
  assert.equal(result.tokens, 120);
  assert.equal(result.pem, 'before\n[REDACTED]\nafter');
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.deepEqual(redact(result), result, 'repeated export/state redaction must be stable');
  assert.equal(input.settings.apiKey, 'CANARY_OBJECT_KEY');
  assert.deepEqual(redact(null), null);
});

test('workspace rejects a configured runtime directory even through its alternate canonical path', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'relay-runtime-test-'));
  const previous = process.env.CODEX_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const runtime = path.join(base, 'runtime');
  const alias = path.join(base, 'runtime-alias');
  await mkdir(runtime);
  await symlink(runtime, alias);
  process.env.CODEX_HOME = alias;
  await assert.rejects(normalizeWorkspace(runtime), error => error.statusCode === 400);
  await assert.rejects(normalizeWorkspace(alias), error => error.statusCode === 400);
});

test('redact preserves ordinary structured data and safely handles JSON prototype keys', () => {
  const input = JSON.parse('{"__proto__":{"text":"ordinary"},"taskId":"abc","enabled":false,"count":3}');
  assert.deepEqual(redact(input), input);
  assert.equal({}.text, undefined);
  assert.equal(redact('The password reset form should describe the API key field.'), 'The password reset form should describe the API key field.');
});

test('redact recognizes hyphenated credential assignments and headers while preserving ordinary prose', () => {
  const input = 'api-key: SYNTHETIC_CANARY_ONE\nX-API-Key: SYNTHETIC_CANARY_TWO\nclient-secret="SYNTHETIC_CANARY_THREE"\nordinary: visible\n';
  assert.equal(redact(input), 'api-key: [REDACTED]\nX-API-Key: [REDACTED]\nclient-secret="[REDACTED]"\nordinary: visible\n');
  assert.equal(redact('Describe the api-key field and X-API-Key header.'), 'Describe the api-key field and X-API-Key header.');
  assert.equal(redact('123-password=SYNTHETIC_CANARY --password=SYNTHETIC_CANARY'), '123-password=[REDACTED] --password=[REDACTED]');
  const started = performance.now();
  const longKey = 'word-'.repeat(16000);
  assert.equal(redact(longKey), longKey);
  assert.ok(performance.now() - started < 1500, 'Hyphenated input must not restart at every suffix.');
});

test('optional line preservation redacts complete multiline secrets without changing later source line numbers', () => {
  const input = 'before\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE\n-----END PRIVATE KEY-----\nneedle\nAPI_KEY="one\ntwo"\nlast needle\n';
  const kept = redact(input, { preserveLines: true });
  assert.equal(kept.split('\n').length, input.split('\n').length);
  assert.equal(kept.split('\n')[4], 'needle');
  assert.equal(kept.split('\n')[7], 'last needle');
  assert.ok(!kept.includes('SYNTHETIC_PRIVATE'));
  assert.ok(!kept.includes('one'));
  assert.ok(!kept.includes('two'));
  assert.equal(redact(input).split('\n')[2], 'needle', 'default redaction keeps its existing compact output');
  assert.equal(redact(kept, { preserveLines: true }), kept);
  const auth = 'Authorization: Bearer\nSYNTHETIC_AUTH_VALUE\nafter';
  assert.equal(redact(auth, { preserveLines: true }).split('\n')[2], 'after');
});

test('request boundary accepts all exact loopback hosts with matching origins', () => {
  for (const host of ['localhost:4317', '127.0.0.1:4317', '[::1]:4317']) {
    assert.doesNotThrow(() => validateRequest(request(host, `http://${host}`), 4317));
    assert.doesNotThrow(() => validateRequest(request(host, undefined, 'GET'), 4317));
  }
});

test('request boundary rejects missing/cross origins, DNS rebinding and wrong ports', () => {
  for (const host of ['localhost', 'localhost:4318', 'attacker.test:4317', 'localhost.attacker.test:4317', '127.0.0.2:4317', '127.1:4317', 'localhost.:4317', 'localhost:04317', 'user@localhost:4317', ' localhost:4317']) {
    assert.throws(() => validateRequest(request(host, `http://${host}`), 4317), rejected);
  }
  for (const origin of [undefined, 'null', 'https://localhost:4317', 'http://127.0.0.1:4317', 'http://localhost:4317/', 'http://attacker.test', ['http://localhost:4317']]) {
    assert.throws(() => validateRequest(request('localhost:4317', origin), 4317), rejected);
  }
  assert.throws(() => validateRequest({ ...request('localhost:4317', 'http://localhost:4317'), rawHeaders: ['Host', 'localhost:4317', 'Host', 'attacker.test'] }, 4317), rejected);
  assert.throws(() => validateRequest({ method: 'GET', headers: { host: 'localhost:4317', 'sec-fetch-site': 'cross-site' } }, 4317), rejected);
});

test('workspace selection canonicalizes safe symlinks and rejects files, missing paths and sensitive symlinks', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'relay-workspace-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'project');
  const sensitive = path.join(base, '.codex');
  await mkdir(workspace);
  await mkdir(sensitive);
  await mkdir(path.join(sensitive, 'nested'));
  await writeFile(path.join(base, 'file'), 'test');
  await symlink(workspace, path.join(base, 'safe-link'));
  await symlink(sensitive, path.join(base, 'unsafe-link'));
  assert.equal(await normalizeWorkspace(path.join(base, 'safe-link')), await realpath(workspace));
  for (const input of ['.', '/', '', null, path.join(base, 'file'), path.join(base, 'missing'), sensitive, path.join(sensitive, 'nested'), path.join(base, 'unsafe-link')]) {
    await assert.rejects(normalizeWorkspace(input), error => error.statusCode === 400);
  }
});
