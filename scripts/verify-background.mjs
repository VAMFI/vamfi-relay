#!/usr/bin/env node
// Opt-in real Codex usage against disposable synthetic data; never reads auth files.
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Opt-in required: node scripts/verify-background.mjs --live'); process.exitCode = 2;
  } else await qualify();
}

async function qualify() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-background-live-')));
  const coordinator = join(root, 'coordinator'), projectPath = join(root, 'project');
  await mkdir(coordinator); await mkdir(projectPath);
  const marker = `BACKGROUND_${randomUUID()}`;
  await writeFile(join(projectPath, 'witness.txt'), marker + '\n');
  const sourceHashes = async () => {
    const result = {};
    for (const folder of ['server', 'web']) for (const name of (await readdir(join(repo, folder), { recursive: true })).sort()) {
      if (/\.(mjs|js|jsx|css)$/.test(name)) result[`${folder}/${name}`] = createHash('sha256').update(await readFile(join(repo, folder, name))).digest('hex');
    }
    result['scripts/verify-background.mjs'] = createHash('sha256').update(await readFile(join(repo, 'scripts/verify-background.mjs'))).digest('hex');
    return result;
  };
  const output = join(repo, 'artifacts', 'local', `background-usecase-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await mkdir(dirname(output), { recursive: true });
  const evidence = { syntheticOnly: true, startedAt: new Date().toISOString(), root, node: process.version,
    sourceHashes: await sourceHashes(), phases: [], turns: 0 };
  const save = () => writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  let store, runtime;
  const command = await codexCommand();
  const open = async () => {
    store = new Store(join(root, 'state'), coordinator);
    const adapter = new CodexAdapter({ command, cwd: repo });
    const start = adapter.startTurn.bind(adapter);
    adapter.startTurn = async input => { assert.ok(++evidence.turns <= 8, 'Provider turn budget'); return start(input); };
    runtime = new Runtime(store, adapter); evidence.provider = await runtime.connect();
  };
  const task = id => store.state.tasks.find(t => t.id === id);
  const active = item => item && ['queued', 'running', 'waiting'].includes(item.status);
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  const finish = async id => {
    await wait(() => task(id) && !active(task(id)), 'terminal provider response');
    assert.equal(task(id).status, 'completed', task(id).error); return task(id);
  };
  try {
    await open();
    const project = await runtime.board.registerProject({ name: 'Synthetic background project', workspace: projectPath });
    const goal = runtime.board.createWork({ projectId: project.id, title: 'Inspect a background witness', objective: 'Read the exact witness through an independent specialist while the master remains available.' });
    console.log('START asynchronous specialist and responsive master');
    const origin = await runtime.chat(`For existing goal ${goal.id}, assign exactly one independent read-only specialist to that goal in the background, titled "Inspect delayed witness", with instructions "Use one shell command to sleep for 45 seconds, then read witness.txt in your assigned workspace and report its exact content. Do not change files or read another directory." This bounded independent read-only review is explicitly requested. Once accepted, acknowledge the task and finish your response promptly; do not wait or poll. Do not create any other work or run commands yourself.`);
    await wait(() => store.state.tasks.some(t => t.parentTaskId === origin.taskId && t.kind === 'worker') || !active(task(origin.taskId)), 'background admission or master response');
    const worker = store.state.tasks.find(t => t.parentTaskId === origin.taskId && t.kind === 'worker');
    assert.ok(worker, 'Natural-language request routed to a specialist');
    assert.equal(worker.deliveryMode, 'background'); assert.equal(worker.workId, goal.id);
    assert.equal(worker.workspace, projectPath); assert.equal(worker.permissionMode, 'read-only');
    await finish(origin.taskId); assert.ok(active(task(worker.id)), 'Master finished while the specialist was active');
    const master = store.state.mainThreadId;
    const quick = await runtime.chat('Briefly confirm that I can use this master conversation while the accepted specialist works. Do not delegate, wait, run commands, or change goals.');
    await finish(quick.taskId); assert.ok(active(task(worker.id)), 'Second master response completed during specialist work');
    assert.equal(store.state.mainThreadId, master);
    evidence.phases.push({ name: 'responsive_master', passed: true, originId: origin.taskId, workerId: worker.id, nextRequestId: quick.taskId }); await save();
    console.log('PASS master remained responsive; waiting for actual specialist result');
    const beforeDeliveryTurns = evidence.turns;
    await finish(worker.id);
    const receipts = () => store.state.messages.filter(m => m.id === `worker-result:${worker.id}`);
    assert.equal(receipts().length, 1); assert.equal(receipts()[0].channel, 'master'); assert.equal(receipts()[0].source, 'worker');
    assert.ok(receipts()[0].text.includes(marker)); assert.ok(task(worker.id).result.includes(marker));
    assert.equal(evidence.turns, beforeDeliveryTurns, 'Result appeared without an additional model turn');
    assert.notEqual(store.state.workItems.find(w => w.id === goal.id).status, 'completed');
    evidence.phases.push({ name: 'durable_actual_result', passed: true, noDeliveryModelTurn: true, receipts: 1 }); await save();
    const followup = await runtime.chat('Report the exact witness from the finished background specialist result in your supplied Relay context. Do not read files, use tools, or start any work.');
    assert.ok((await finish(followup.taskId)).result.includes(marker));
    assert.ok(task(worker.id).contextDeliveredAt, 'Successful master turn acknowledged delivered context');
    assert.equal(store.state.tasks.filter(t => t.kind === 'worker').length, 1);
    const beforeRestart = { tasks: store.state.tasks.length, messages: store.state.messages.length, turns: evidence.turns };
    await runtime.close(); store.close(); await open();
    assert.equal(store.state.mainThreadId, master); assert.equal(store.state.tasks.length, beforeRestart.tasks);
    assert.equal(store.state.messages.length, beforeRestart.messages); assert.equal(receipts().length, 1);
    assert.equal(evidence.turns, beforeRestart.turns); assert.equal(await readFile(join(projectPath, 'witness.txt'), 'utf8'), marker + '\n');
    assert.deepEqual(await readdir(projectPath), ['witness.txt']);
    evidence.phases.push({ name: 'context_and_restart', passed: true, sameMaster: true, replayedWorkers: 0, duplicatedMessages: 0, filesUnchanged: true });
    evidence.finalSourceHashes = await sourceHashes(); assert.deepEqual(evidence.finalSourceHashes, evidence.sourceHashes, 'Source changed during qualification');
    evidence.status = 'passed'; console.log('PASS durable result, later context and restart without replay');
  } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
  finally { evidence.finishedAt = new Date().toISOString(); await save(); try { await runtime?.close(); } finally { store?.close(); } console.log(`Evidence: ${output}`); }
}
