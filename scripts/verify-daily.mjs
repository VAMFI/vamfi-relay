#!/usr/bin/env node
// Explicit opt-in: real Codex usage, synthetic temp projects, existing sign-in.
// No authentication files are read. Evidence stays in ignored artifacts/local.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { codexCommand } from '../server/codex-command.mjs';
import { dailyWork } from '../web/daily-lib.js';
import { dayKey } from '../web/lib.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Opt-in required: node scripts/verify-daily.mjs --live');
    process.exitCode = 2;
  } else await qualify();
}

async function qualify() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-daily-live-')));
  const paths = Object.fromEntries(['coordinator', 'alpha', 'beta'].map(name => [name, join(root, name)]));
  for (const path of Object.values(paths)) await mkdir(path);
  const markers = { alpha: `ALPHA_${randomUUID()}`, beta: `BETA_${randomUUID()}` };
  for (const name of ['alpha', 'beta']) await writeFile(join(paths[name], 'witness.txt'), markers[name] + '\n');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const sourceHashes = async () => {
    const hashes = {};
    for (const folder of ['server', 'web']) for (const name of (await readdir(join(repo, folder), { recursive: true })).sort()) {
      if (/\.(mjs|js|jsx|css)$/.test(name)) hashes[`${folder}/${name}`] = hash(await readFile(join(repo, folder, name)));
    }
    hashes['scripts/verify-daily.mjs'] = hash(await readFile(join(repo, 'scripts/verify-daily.mjs')));
    return hashes;
  };
  const output = join(repo, 'artifacts', 'local', `daily-usecase-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await mkdir(dirname(output), { recursive: true });
  const evidence = { syntheticOnly: true, startedAt: new Date().toISOString(), root, node: process.version,
    sourceHashes: await sourceHashes(), phases: [], turns: 0, provider: null };
  const save = () => writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  let store, runtime;
  const command = await codexCommand();
  async function open() {
    store = new Store(join(root, 'state'), paths.coordinator);
    const adapter = new CodexAdapter({ command, cwd: repo });
    const startTurn = adapter.startTurn.bind(adapter);
    adapter.startTurn = async input => { assert.ok(++evidence.turns <= 8, 'Provider turn budget'); return startTurn(input); };
    runtime = new Runtime(store, adapter);
    evidence.provider = await runtime.connect();
  }
  const task = id => store.state.tasks.find(t => t.id === id);
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  const finish = async id => {
    await wait(() => !['queued', 'running', 'waiting'].includes(task(id)?.status), 'terminal provider response');
    assert.equal(task(id).status, 'completed', task(id).error); return task(id);
  };
  const view = () => dailyWork(store.snapshot(), dayKey(new Date(), store.state.meta.timezone));
  try {
    await open();
    const goals = {};
    for (const name of ['alpha', 'beta']) {
      const project = await runtime.board.registerProject({ name: `Synthetic ${name}`, workspace: paths[name], permissionMode: 'read-only' });
      goals[name] = runtime.board.createWork({ projectId: project.id, title: `Inspect ${name} witness`, objective: 'Use an independent read-only specialist to inspect the local witness file and report its exact content.' });
    }
    for (const name of ['alpha', 'beta']) {
      console.log(`START goal-scoped specialist ${name}`);
      const request = await runtime.chat(`For existing goal ${goals[name].id}, call relay_delegate with workId ${goals[name].id}, title "Inspect ${name} witness", and instructions "Read witness.txt in the assigned project directory and report its exact content. Do not change any files or access any other project." This independent review is explicitly requested. Return the specialist's actual finding in this conversation. Do not create other goals, use history, or run a project execution.`);
      await wait(() => store.state.tasks.some(t => t.parentTaskId === request.taskId && t.kind === 'worker'), 'accepted specialist');
      const worker = store.state.tasks.find(t => t.parentTaskId === request.taskId && t.kind === 'worker');
      assert.equal(worker.workId, goals[name].id);
      assert.equal(worker.workspace, paths[name]); assert.equal(worker.permissionMode, 'read-only');
      const during = view();
      assert.ok(during.requests.some(r => r.taskId === request.taskId && r.goals.some(g => g.id === goals[name].id)));
      if (['queued', 'running', 'waiting'].includes(task(worker.id).status)) assert.ok(during.assignments.some(a => a.task.id === worker.id && a.work.id === goals[name].id));
      const response = await finish(request.taskId);
      assert.equal(task(worker.id).status, 'completed');
      assert.ok(task(worker.id).result.includes(markers[name]), 'Specialist read the unpredictable file marker');
      assert.ok(response.result.includes(markers[name]), 'Master returned the actual specialist finding');
      assert.ok(view().progress.some(p => p.taskId === worker.id && p.kind === 'report'));
      assert.equal(view().reviewed.length, 0);
      evidence.phases.push({ name: `specialist_${name}`, passed: true, requestId: request.taskId, workerId: worker.id, workId: goals[name].id }); await save();
      console.log(`PASS goal-scoped specialist ${name}`);
    }
    const masterId = store.state.mainThreadId;
    const count = store.state.tasks.length;
    await runtime.close(); store.close();
    await open();
    assert.equal(store.state.mainThreadId, masterId); assert.equal(store.state.tasks.length, count);
    assert.equal(view().requests.length, 2); assert.equal(view().reviewed.length, 0);
    const status = await runtime.chat('Give a brief status of the two existing witness reviews from the recorded results. Do not delegate, execute commands, or create or update goals.');
    await finish(status.taskId);
    assert.equal(store.state.mainThreadId, masterId);
    assert.equal(store.state.workItems.length, 2); assert.equal(store.state.tasks.filter(t => t.kind === 'worker').length, 2);
    assert.equal(view().requests.length, 2); // Casual status is not a work request.
    for (const name of ['alpha', 'beta']) {
      assert.equal(await readFile(join(paths[name], 'witness.txt'), 'utf8'), markers[name] + '\n');
      assert.deepEqual(await readdir(paths[name]), ['witness.txt']);
    }
    evidence.phases.push({ name: 'restart_and_casual_status', passed: true, sameMaster: true, replayedWorkers: 0, filesUnchanged: true });
    evidence.finalSourceHashes = await sourceHashes();
    assert.deepEqual(evidence.finalSourceHashes, evidence.sourceHashes, 'Source changed during qualification');
    evidence.status = 'passed'; console.log('PASS restart, casual status, and unchanged source');
  } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
  finally {
    evidence.finishedAt = new Date().toISOString(); await save();
    try { await runtime?.close(); } finally { store?.close(); }
    console.log(`Evidence: ${output}`);
  }
}
