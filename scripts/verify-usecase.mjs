#!/usr/bin/env node
/** Opt-in, real-provider qualification. Creates only synthetic chats and temp workspaces.
 * Run: node scripts/verify-usecase.mjs --live
 * Uses the existing private Codex sign-in; consumes normal provider usage. No remote writes.
 * Artifacts are ignored and contain synthetic IDs/outcomes, never the discovered catalog.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { codexCommand } from '../server/codex-command.mjs';
import { createApp } from '../server/index.mjs';

export function assertSourceUnchanged(before, after) {
  assert.deepEqual(after, before, 'Source changed during qualification; rerun against the final candidate.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Opt-in required: node scripts/verify-usecase.mjs --live\nCreates synthetic Codex chats and disposable projects using your existing sign-in.');
    process.exitCode = 2;
  } else await qualify();
}

async function qualify() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = await mkdtemp(join(tmpdir(), 'vamfi-relay-v04-'));
  const output = join(repo, 'artifacts', 'local', `v04-usecase-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await mkdir(dirname(output), { recursive: true });
  const paths = Object.fromEntries(['coordinator', 'alpha', 'beta', 'memory'].map(name => [name, join(root, name)]));
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  await mkdir(join(paths.memory, 'memories'));
  await writeFile(join(paths.memory, 'memories', 'memory_summary.md'), 'Synthetic qualification memory: Alpha and Beta are disposable projects.\n');
  for (const name of ['alpha', 'beta']) await writeFile(join(paths[name], 'context.txt'), `${name.toUpperCase()}_CONTEXT_V04\n`);
  const digest = data => createHash('sha256').update(data).digest('hex');
  async function sourceHashes() {
    const hashes = {};
    for (const folder of ['server', 'web']) for (const name of (await readdir(join(repo, folder), { recursive: true })).sort()) {
      if (!/\.(mjs|js|jsx|css)$/.test(name)) continue;
      hashes[`${folder}/${name}`] = digest(await readFile(join(repo, folder, name)));
    }
    for (const name of ['package.json', 'package-lock.json', 'scripts/verify-usecase.mjs']) hashes[name] = digest(await readFile(join(repo, name)));
    return hashes;
  }
  const evidence = { schemaVersion: 1, pilot: 'v0.4 real Codex use case', startedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`, node: process.version, model: 'Provider default; no model override',
    syntheticOnly: true, root, sourceHashes: await sourceHashes(), phases: [], turns: [], operations: [], commands: [], interruptions: [] };
  let app, base, sourceAdapter, generation = 0;
  const sourceIds = [];
  const save = () => writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
  async function wait(predicate, reason, timeout = 180_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(200); }
    throw new Error(`Timed out: ${reason}`);
  }
  async function phase(name, fn) {
    const record = { name, startedAt: new Date().toISOString(), status: 'running' }; evidence.phases.push(record); await save();
    console.log(`START ${name}`);
    try { Object.assign(record, await fn(), { status: 'passed', finishedAt: new Date().toISOString() }); console.log(`PASS ${name}`); }
    catch (error) { record.status = 'failed'; record.error = error.message; throw error; }
    finally { await save(); }
  }
  function observe(adapter, label) {
    for (const method of ['startThread', 'resumeThread']) {
      const original = adapter[method].bind(adapter);
      adapter[method] = async options => {
        const result = await original(options);
        evidence.operations.push({ generation, label, method, threadId: result.id, workspace: relative(root, options.workspace), permissionMode: options.permissionMode, at: new Date().toISOString() });
        return result;
      };
    }
    const start = adapter.startTurn.bind(adapter);
    adapter.startTurn = async input => {
      assert.ok(evidence.turns.length < 30, 'Provider turn safety budget exceeded');
      const turn = { label, generation, threadId: input.threadId, promptHash: digest(input.text), startedAt: new Date().toISOString() };
      evidence.turns.push(turn); const result = await start(input); turn.turnId = result.id; return result;
    };
    const interrupt = adapter.interrupt.bind(adapter);
    adapter.interrupt = async input => {
      const item = { label, generation, ...input, requestedAt: new Date().toISOString() }; evidence.interruptions.push(item);
      await interrupt(input); item.acknowledgedAt = new Date().toISOString();
    };
    adapter.on('notification', ({ method, params }) => {
      if (method === 'turn/completed') {
        const turn = evidence.turns.findLast(item => item.threadId === params.threadId && (!item.turnId || item.turnId === params.turn.id));
        if (turn) Object.assign(turn, { status: params.turn.status, finishedAt: new Date().toISOString() });
      }
      if (method === 'item/completed' && params.item?.type === 'commandExecution') evidence.commands.push({
        label, generation, threadId: params.threadId, turnId: params.turnId, exitCode: params.item.exitCode,
        status: params.item.status, commandHash: digest(params.item.command ?? ''), at: new Date().toISOString() });
    });
    return adapter;
  }
  async function request(path, body, expected = 200) {
    const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${path.replace(/[a-f0-9-]{32,}/g, ':id')} expected ${expected}; got ${response.status}: ${result.error || ''}`);
    return result;
  }
  const task = id => app.store.state.tasks.find(item => item.id === id);
  const goal = id => app.store.state.workItems.find(item => item.id === id);
  const attempts = id => app.store.state.tasks.filter(item => item.workId === id && item.kind === 'project');
  async function finish(id) {
    await wait(() => task(id) && !['running', 'waiting', 'queued'].includes(task(id).status), 'provider task terminal');
    assert.equal(task(id).status, 'completed', `Synthetic task did not complete: ${task(id).error || task(id).status}`); return task(id);
  }
  async function chat(text) { const result = await request('/api/chat', { text }, 202); return finish(result.taskId); }
  const command = await codexCommand();
  evidence.providerExecutable = command;
  async function startApp() {
    generation++;
    app = await createApp({ workspace: paths.coordinator, dataDir: join(root, 'state'), codexHome: paths.memory,
      adapter: observe(new CodexAdapter({ command, cwd: repo }), 'relay'), catalogAdapter: new CodexAdapter({ command, cwd: repo }) });
    await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
    base = `http://127.0.0.1:${app.server.address().port}`; await request('/api/connect', {});
  }
  let masterId, alpha, beta, workA, workB, hashes, initialA, initialB, handoffA;
  try {
    await phase('create_two_real_synthetic_source_chats', async () => {
      sourceAdapter = observe(new CodexAdapter({ command, cwd: repo }), 'synthetic-source');
      const info = await sourceAdapter.connect(); evidence.provider = info;
      sourceAdapter.on('request', item => sourceAdapter.respond(item.id, { decision: 'decline', success: false, contentItems: [{ type: 'inputText', text: 'Qualification does not grant extra authority.' }] }));
      for (const name of ['alpha', 'beta']) {
        const source = await sourceAdapter.startThread({ workspace: paths[name], permissionMode: 'read-only', tools: [], developerInstructions: 'Read only context.txt in this disposable workspace. Use /bin/bash with login false if a shell is required. Do not access other directories or create any files. Finish concisely.' });
        sourceIds.push(source.id);
        const started = await sourceAdapter.startTurn({ threadId: source.id, text: `This is the synthetic ${name} project. Read context.txt and quote the single project fact. Do not create goals or change files.` });
        await wait(() => evidence.turns.find(item => item.turnId === started.id)?.status, 'source chat completes');
        assert.equal(evidence.turns.find(item => item.turnId === started.id).status, 'completed');
      }
      await sourceAdapter.close(); sourceAdapter = null; return { sourceIds };
    });
    await startApp();
    await phase('discover_group_read_without_importing_or_false_activity', async () => {
      const catalog = await request('/api/codex/catalog');
      assert.equal(catalog.available, true);
      const rows = sourceIds.map(id => catalog.threads.find(item => item.id === id));
      assert.ok(rows.every(Boolean), 'Synthetic chats missing from catalog'); assert.notEqual(rows[0].projectKey, rows[1].projectKey);
      for (const row of rows) assert.equal(row.activity.state, 'unknown');
      const details = await Promise.all(sourceIds.map(id => request(`/api/codex/threads/${id}`)));
      for (let index = 0; index < 2; index++) assert.match(details[index].summary.lastResponse, new RegExp(index === 0 ? 'ALPHA_CONTEXT_V04' : 'BETA_CONTEXT_V04'));
      hashes = details.map(item => item.contextHash); assert.equal(app.store.state.workItems.length, 0); assert.equal(app.store.state.tasks.length, 0);
      const memory = await request('/api/codex/memory'); assert.equal(memory.available, true); assert.match(memory.text, /Synthetic qualification memory/);
      assert.ok(!JSON.stringify(app.store.snapshot()).includes('Synthetic qualification memory'));
      return { distinctProjects: 2, selectedHistoryHashes: hashes, externalActivity: 'unknown', importedGoals: 0 };
    });
    alpha = await request('/api/projects', { name: 'Qualification Alpha', workspace: paths.alpha, permissionMode: 'workspace-write' }, 201);
    beta = await request('/api/projects', { name: 'Qualification Beta', workspace: paths.beta, permissionMode: 'workspace-write' }, 201);
    await request('/api/settings', { defaultProjectId: alpha.id, maxWorkers: 1 });
    await phase('casual_and_ambiguous_messages_do_not_create_goals', async () => {
      for (const text of ['Hello. Reply briefly.', 'Explain what a dashboard is in one sentence.', 'What work is active right now?', 'I want to improve a project but have not chosen which project or objective yet. Ask me for the missing destination and scope; do not execute.']) await chat(text);
      assert.equal(app.store.state.workItems.length, 0); assert.equal(app.store.state.tasks.filter(item => item.kind === 'project').length, 0);
      masterId = app.store.state.mainThreadId; return { masterId, casualMessages: 3, ambiguousMessages: 1, goals: 0 };
    });
    await phase('reviewed_handoffs_create_two_meaningful_goals_in_one_master', async () => {
      for (const [index, name, project] of [[0, 'Alpha', alpha], [1, 'Beta', beta]]) {
        await request('/api/settings', { defaultProjectId: project.id, maxWorkers: 1 });
        const body = { threadId: sourceIds[index], contextHash: hashes[index], requestId: randomUUID(), reviewed: true, acknowledgeUncertainActivity: true,
          request: `Use the reviewed ${name} history. I accept a substantial ongoing goal for registered project ID ${project.id}: create and independently verify a bounded ${name} marker using a two-step plan. Create exactly one durable goal titled "${name} qualification" with relay_work. In your response include the earlier ${name.toUpperCase()}_CONTEXT_V04 fact. Do not execute or draft a plan yet; I will submit and review the exact finite steps next.` };
        await request('/api/codex/handoff', { ...body, requestId: randomUUID(), contextHash: '0'.repeat(64) }, 409);
        const accepted = await request('/api/codex/handoff', body, 202);
        assert.deepEqual(await request('/api/codex/handoff', body, 202), accepted);
        await request('/api/codex/handoff', { ...body, request: 'Changed request' }, 409);
        await finish(accepted.taskId);
        assert.match(task(accepted.taskId).result, new RegExp(`${name.toUpperCase()}_CONTEXT_V04`));
        assert.equal(app.store.state.mainThreadId, masterId);
        assert.equal(app.store.state.workItems.filter(item => item.projectId === project.id).length, 1);
        if (index === 0) handoffA = { body, accepted };
      }
      assert.equal(app.store.state.workItems.length, 2); assert.equal(app.store.state.tasks.filter(item => item.kind === 'project').length, 0);
      workA = app.store.state.workItems.find(item => item.projectId === alpha.id).id;
      workB = app.store.state.workItems.find(item => item.projectId === beta.id).id;
      await chat('For the existing Alpha qualification goal, summarize its next action. This is a follow-up, not a new goal.'); assert.equal(app.store.state.workItems.length, 2);
      return { masterId, workA, workB, staleContextRejected: true, duplicateIdempotent: true, followUpReusedGoal: true };
    });
    const shell = 'Use the shell tool with shell /bin/bash and login false. Run exactly the following bounded command in this workspace; do not use Python or a heredoc. ';
    const checkpoint = ' After command completion, independently read the files to verify the exact bytes, then call relay_checkpoint with ready only if the assigned checks pass. Finish immediately; do not perform later steps.';
    await phase('review_exact_two_step_plans_and_queue_both_projects', async () => {
      await request(`/api/work/${workA}/plan`, { steps: [
        { title: 'Write Alpha marker once', instructions: shell + "printf 'write\\n' >> write-count.txt; printf 'alpha-v04\\n' > marker.txt; sleep 45" + checkpoint },
        { title: 'Verify Alpha marker and write check', instructions: shell + "test \"$(cat marker.txt)\" = alpha-v04 && test \"$(cat write-count.txt)\" = write && printf 'checked\\n' > checked.txt" + checkpoint },
      ] });
      await request(`/api/work/${workB}/plan`, { steps: [
        { title: 'Write Beta marker once', instructions: shell + "printf 'write\\n' >> write-count.txt; printf 'beta-v04\\n' > marker.txt" + checkpoint },
        { title: 'Verify Beta after bounded pause', instructions: shell + "sleep 45; test \"$(cat marker.txt)\" = beta-v04 && test \"$(cat write-count.txt)\" = write && printf 'checked\\n' > checked.txt" + checkpoint },
      ] });
      await request(`/api/work/${workA}/plan/start`, { planId: 'obsolete', reviewed: true, autoContinue: true }, 409);
      await request(`/api/work/${workA}/plan/start`, { planId: goal(workA).plan.id, reviewed: false, autoContinue: true }, 400);
      initialA = await request(`/api/work/${workA}/plan/start`, { planId: goal(workA).plan.id, reviewed: true, autoContinue: true }, 202);
      await wait(() => task(initialA.taskId)?.turnId, 'Alpha starts');
      initialB = await request(`/api/work/${workB}/plan/start`, { planId: goal(workB).plan.id, reviewed: true, autoContinue: true }, 202);
      assert.equal(task(initialB.taskId).status, 'queued');
      await request(`/api/work/${workB}`, { status: 'paused' }); assert.equal(task(initialB.taskId).queueState, 'held');
      const status = await chat('What are the current Alpha and Beta goal states? Answer briefly while Alpha continues; do not create or run new work.');
      assert.equal(task(initialA.taskId).status, 'running', 'Master did not answer before Alpha finished');
      assert.equal(app.store.state.mainThreadId, masterId);
      return { alphaAttempt: initialA.taskId, betaHeldAttempt: initialB.taskId, concurrentMasterTask: status.id, capacity: 1 };
    });
    await phase('alpha_auto_continues_with_real_files_and_observed_checks', async () => {
      await wait(() => goal(workA).status === 'needs_review' || goal(workA).status === 'blocked', 'Alpha plan settles');
      assert.equal(goal(workA).status, 'needs_review'); assert.equal(goal(workA).completedAt, null);
      assert.equal(await readFile(join(paths.alpha, 'marker.txt'), 'utf8'), 'alpha-v04\n');
      assert.equal(await readFile(join(paths.alpha, 'write-count.txt'), 'utf8'), 'write\n');
      assert.equal(await readFile(join(paths.alpha, 'checked.txt'), 'utf8'), 'checked\n');
      assert.equal(attempts(workA).length, 2); assert.equal(attempts(workA)[0].threadId, attempts(workA)[1].threadId);
      assert.ok(goal(workA).plan.steps.every(item => item.status === 'finished' && item.checkpoint?.state === 'ready'));
      assert.ok(task(initialB.taskId).turnId == null);
      return { attempts: attempts(workA).map(item => item.id), projectThread: attempts(workA)[0].threadId, filesVerified: 3, status: goal(workA).status };
    });
    await phase('restart_preserves_one_master_and_holds_unfinished_work', async () => {
      const before = { messages: app.store.state.messages.length, plans: [goal(workA).plan.id, goal(workB).plan.id], count: evidence.turns.length };
      await app.close(); app = null; await startApp(); await delay(1200);
      assert.equal(evidence.turns.length, before.count); assert.equal(app.store.state.mainThreadId, masterId);
      assert.equal(app.store.state.messages.length, before.messages); assert.deepEqual([goal(workA).plan.id, goal(workB).plan.id], before.plans);
      assert.equal(task(initialB.taskId).queueState, 'held'); assert.equal(goal(workB).recoveryRequired, true);
      assert.deepEqual(await request('/api/codex/handoff', handoffA.body, 202), handoffA.accepted);
      const answer = await chat('After restart, briefly report the two existing qualification goals and keep both goals unchanged.');
      assert.equal(answer.threadId, masterId); assert.equal(app.store.state.workItems.length, 2);
      return { noAutomaticReplay: true, preservedMessages: before.messages, masterId, durableHandoffRetry: true };
    });
    let stopped, finishedStep;
    await phase('explicit_beta_resume_then_real_interruption_after_first_finished_step', async () => {
      const resumed = await request(`/api/work/${workB}/resume`, {}, 202); assert.equal(resumed.taskId, initialB.taskId);
      await wait(() => attempts(workB).length === 2 && attempts(workB)[1].turnId, 'Beta second step starts');
      assert.equal(goal(workB).plan.steps[0].status, 'finished');
      finishedStep = structuredClone(goal(workB).plan.steps[0]); stopped = attempts(workB)[1].id;
      await request(`/api/tasks/${stopped}/cancel`, {});
      await wait(() => !['running', 'waiting', 'queued'].includes(task(stopped).status), 'Beta interruption confirmation');
      assert.equal(task(stopped).status, 'cancelled'); assert.equal(goal(workB).plan.status, 'paused');
      await request(`/api/work/${workB}/resume`, {}, 409);
      return { cancelledAttempt: stopped, finishedStepId: finishedStep.id, interruptionAcknowledged: evidence.interruptions.some(item => item.turnId === task(stopped).turnId && item.acknowledgedAt) };
    });
    await phase('restart_and_explicit_retry_preserve_completed_steps', async () => {
      const count = evidence.turns.length; await app.close(); app = null; await startApp(); await delay(1200);
      assert.equal(evidence.turns.length, count); assert.deepEqual(goal(workB).plan.steps[0], finishedStep);
      await request(`/api/work/${workB}/resume`, {}, 409);
      const retry = await request(`/api/work/${workB}/resume`, { retryInterrupted: true }, 202); assert.notEqual(retry.taskId, stopped);
      await finish(retry.taskId); await wait(() => goal(workB).status === 'needs_review' || goal(workB).status === 'blocked', 'Beta plan settles');
      assert.equal(goal(workB).status, 'needs_review'); assert.deepEqual(goal(workB).plan.steps[0], finishedStep);
      assert.equal(attempts(workB).length, 3); assert.equal(attempts(workB).filter(item => item.stepId === finishedStep.id).length, 1);
      assert.equal(attempts(workB)[0].threadId, task(retry.taskId).threadId);
      for (const [name, marker] of [['alpha', 'alpha-v04\n'], ['beta', 'beta-v04\n']]) {
        assert.equal(await readFile(join(paths[name], 'marker.txt'), 'utf8'), marker);
        assert.equal(await readFile(join(paths[name], 'write-count.txt'), 'utf8'), 'write\n');
        assert.equal(await readFile(join(paths[name], 'checked.txt'), 'utf8'), 'checked\n');
        assert.equal(await readFile(join(paths[name], 'context.txt'), 'utf8'), `${name.toUpperCase()}_CONTEXT_V04\n`);
        assert.deepEqual((await readdir(paths[name])).sort(), ['checked.txt', 'context.txt', 'marker.txt', 'write-count.txt']);
      }
      await request(`/api/work/${workA}/resume`, {}, 202); assert.equal(attempts(workA).length, 2);
      return { retryAttempt: retry.taskId, finishedStepsNotReplayed: true, filesVerified: 8, bothGoalsAwaitReview: true };
    });
    await phase('source_chats_unchanged_and_final_source_bound', async () => {
      const after = await Promise.all(sourceIds.map(id => request(`/api/codex/threads/${id}`)));
      assert.deepEqual(after.map(item => item.contextHash), hashes); assert.ok(after.every(item => item.thread.activity.state === 'unknown'));
      assert.equal(app.store.state.workItems.length, 2); assert.equal(app.store.state.mainThreadId, masterId);
      evidence.finalSourceHashes = await sourceHashes();
      evidence.changedSourceDuringRun = [...new Set([...Object.keys(evidence.sourceHashes), ...Object.keys(evidence.finalSourceHashes)])]
        .filter(file => evidence.finalSourceHashes[file] !== evidence.sourceHashes[file]);
      assertSourceUnchanged(evidence.sourceHashes, evidence.finalSourceHashes);
      return { originalChatsUnchanged: true, goals: 2, masterId, changedSourceDuringRun: evidence.changedSourceDuringRun };
    });
    evidence.outcome = 'passed';
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = error.message; process.exitCode = 1; console.error(`FAIL ${error.message}`);
  } finally {
    try { await sourceAdapter?.close(); await app?.close(); } catch (error) { evidence.shutdownError = error.message; evidence.outcome = 'failed'; process.exitCode = 1; }
    evidence.finishedAt = new Date().toISOString(); await save(); console.log(`Evidence: ${output}`);
    console.log(`Synthetic workspace retained for inspection: ${root}`);
  }
}
