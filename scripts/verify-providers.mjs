#!/usr/bin/env node
// Explicit opt-in. Production adapters, disposable projects, existing native login.
// This script never reads credentials or edits provider configuration.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url), repo = resolve(dirname(script), '..');
const MAX_TURNS = 12, WAIT_MS = 180_000;
const active = task => task && ['queued', 'running', 'waiting'].includes(task.status);
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const help = `Usage: node scripts/verify-providers.mjs --live [--responsiveness-evidence FILE]

Uses real Codex and Hermes (existing native authentication); may incur provider costs.
Maximum: ${MAX_TURNS} startTurn calls across every child process, with no automatic retry.
Creates disposable coordinator, Codex Alpha and Hermes Beta projects. Evidence is
saved under ignored artifacts/local/provider-*.json; synthetic state is retained.

Proves concurrent natural master routing, casual-question filtering, scoped Hermes
MCP read, saved context, responsive master during Hermes, exact cancellation, and
Relay-process crash/receipt recovery. The normal path uses 11 top-level turns.
Kills only its own Relay harness child; never stops the Hermes gateway or app.
Does not prove gateway/OS crash recovery, lost-ACK recovery, write capability,
browser UX, provider billing limits, or that MCP is an operating-system sandbox.
Optional prior R6 responsiveness evidence is attributed as historical evidence,
not as a fresh responsiveness result for the current source or Hermes provider.

--help performs no provider initialization. Without --live no model is invoked.
`;

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') console.log(help);
else if (args.length === 1 && args[0] === '--live-worker' && process.send) await worker();
else if (args[0] === '--live' && (args.length === 1 || (args.length === 3 && args[1] === '--responsiveness-evidence'))) {
  try { await qualify(args[2]); }
  catch (error) { console.error(`Provider qualification failed: ${safeError(error)}`); process.exitCode = 1; }
} else { console.error('Opt-in required. See node scripts/verify-providers.mjs --help'); process.exitCode = 2; }

// Assertions use fixed messages: never serialize provider exception objects.
function safeError(error) { return String(error?.message || 'Unknown failure').replaceAll(repo, '<repo>').slice(0, 700); }

async function sourceHashes() {
  const result = {};
  for (const folder of ['server', 'web', 'scripts']) {
    for (const name of (await readdir(join(repo, folder), { recursive: true })).sort()) {
      if (/\.(mjs|js|jsx|css|py)$/.test(name)) result[`${folder}/${name}`] = hash(await readFile(join(repo, folder, name)));
    }
  }
  for (const name of ['package.json', 'package-lock.json', 'docs/PROVIDER-QUALIFICATION-CONTRACT.md']) {
    result[name] = hash(await readFile(join(repo, name)));
  }
  return result;
}

async function filesUnder(root) {
  const result = {};
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), 'Synthetic project acquired a symlink');
      if (info.isDirectory()) { result[relative(root, path) + '/'] = 'directory'; await visit(path); }
      else { assert.ok(info.isFile(), 'Synthetic project acquired a nonregular file'); result[relative(root, path)] = hash(await readFile(path)); }
    }
  }
  await visit(root); return result;
}

async function qualify(priorPath) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-provider-live-')));
  const paths = Object.fromEntries(['coordinator', 'alpha', 'beta'].map(name => [name, join(root, name)]));
  for (const path of Object.values(paths)) await mkdir(path);
  const markers = { alpha: `ALPHA_${randomUUID()}`, beta: `BETA_${randomUUID()}`, recovery: `RECOVERY_${randomUUID()}` };
  await writeFile(join(paths.alpha, 'witness.txt'), markers.alpha + '\n');
  await writeFile(join(paths.beta, 'witness.txt'), markers.beta + '\n');
  await writeFile(join(paths.beta, 'recovery.txt'), markers.recovery + '\n');
  // Enough bounded work to admit a real cancellation before the response finishes.
  await mkdir(join(paths.beta, 'cancellation'));
  for (let n = 0; n < 24; n++) await writeFile(join(paths.beta, 'cancellation', `${String(n).padStart(2, '0')}.txt`), `CANCEL_${randomUUID()}\n`);
  const originalFiles = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await filesUnder(path)])));
  const output = join(repo, 'artifacts', 'local', `provider-usecase-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await mkdir(dirname(output), { recursive: true });
  const evidence = { syntheticOnly: true, startedAt: new Date().toISOString(), node: process.version, root,
    sourceHashes: await sourceHashes(), maxTurns: MAX_TURNS, turns: 0, submissions: [], phases: [], toolEvents: [], terminals: [],
    limitations: ['Relay child-process crash only; gateway and OS remain running.', 'Admission was persisted before crash; no lost-ACK claim.',
      'No browser, operating-system sandbox, write, or dollar-budget claim.'] };
  const save = () => writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  let child, state, shuttingDown = false, interrupted = false;
  const onSignal = () => { interrupted = true; shuttingDown = true; };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const pending = new Map();
  let sequence = 0;

  function request(method, params = {}, timeout = 45_000) {
    assert.ok(child?.connected, 'Harness child is unavailable');
    const id = ++sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Harness RPC timed out: ${method}`)); }, timeout);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.send({ type: 'request', id, method, params }, error => {
        if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(new Error('Harness IPC failed')); }
      });
    });
  }
  async function open() {
    const current = fork(script, ['--live-worker'], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child = current;
    current.on('message', message => {
      if (message?.type === 'turn') {
        const { runId, provider, threadId } = message;
        const allowed = !shuttingDown && ['codex', 'hermes'].includes(provider) && typeof runId === 'string'
          && evidence.turns < MAX_TURNS && !evidence.submissions.some(item => item.runId === runId);
        if (allowed) { evidence.turns++; evidence.submissions.push({ runId, provider, threadId }); }
        if (current.connected) current.send({ type: 'grant', id: message.id, allowed });
      } else if (message?.type === 'tool') {
        const item = message.item;
        const text = `${item.tool}\n${item.input}\n${item.output}`;
        evidence.toolEvents.push({ runId: message.runId, threadId: message.threadId, turnId: message.turnId,
          tool: item.tool, status: item.status, input: String(item.input || '').slice(0, 8000),
          outputHash: hash(String(item.output || '')), betaMarkerSeen: text.includes(markers.beta), recoveryMarkerSeen: text.includes(markers.recovery),
          betaReadObserved: /read_file/.test(`${item.tool}\n${item.input}`) && text.includes('witness.txt') && String(item.output || '').includes(markers.beta) });
      } else if (message?.type === 'terminal') {
        evidence.terminals.push({ runId: message.runId, threadId: message.threadId, turnId: message.turnId, status: message.status });
      } else if (message?.type === 'response') {
        const entry = pending.get(message.id); if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
      }
    });
    current.on('error', () => {});
    current.on('exit', () => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Owned Relay child exited')); }
      pending.clear();
    });
    await request('open', { root, paths }, 60_000);
    state = await request('snapshot');
    evidence.providers = { codex: { status: state.connection.status, version: state.connection.version }, hermes: state.providers?.hermes };
  }
  async function snapshot() { state = await request('snapshot'); return state; }
  const task = id => state.tasks.find(item => item.id === id);
  async function wait(predicate, label, timeout = WAIT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('Qualification interrupted; settling owned provider work');
      await snapshot(); const value = predicate(); if (value) return value;
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function finish(id) {
    const value = await wait(() => task(id) && !active(task(id)) && task(id), 'terminal project/request');
    assert.equal(value.status, 'completed', 'Provider task did not complete'); return value;
  }
  const deliveries = id => state.messages.filter(item => item.taskId === id && item.source === 'project' && item.channel === 'master');
  async function phase(name, detail = {}) { evidence.phases.push({ name, passed: true, ...detail }); await save(); console.log(`PASS ${name}`); }
  async function gracefulClose() {
    if (!child) return;
    const current = child;
    await request('close', {}, 75_000);
    current.disconnect(); child = null;
    await new Promise((done, reject) => {
      if (current.exitCode !== null || current.signalCode !== null) return done();
      const timer = setTimeout(() => reject(new Error('Owned child did not close')), 5000);
      current.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
  async function crash() {
    const current = child;
    assert.ok(current?.pid && current.connected, 'Crash target must be the owned Relay child');
    const exited = new Promise(done => current.once('exit', done));
    assert.ok(current.kill('SIGKILL'), 'Owned child crash signal failed');
    await exited; child = null;
    // Native provider pipes close with their owner. No gateway signal is sent.
  }

  try {
    if (priorPath) {
      const bytes = await readFile(resolve(priorPath)), prior = JSON.parse(bytes);
      assert.equal(prior.status, 'passed', 'Prior responsiveness evidence did not pass');
      assert.ok(prior.phases?.some(item => item.name === 'responsive_master' && item.passed), 'Prior responsiveness witness missing');
      evidence.reusedResponsiveness = { sha256: hash(bytes), startedAt: prior.startedAt, finishedAt: prior.finishedAt,
        sourceHashes: prior.sourceHashes, scope: 'Historical Codex background responsiveness only; not current Hermes responsiveness.' };
    }
    await open();
    const goals = await request('setup');
    await snapshot();
    const count = state.workItems.length;
    const casual = await request('chat', { text: 'Why is the sky blue? Answer in one brief sentence; this is a casual question, not project work.' });
    await finish(casual.taskId);
    const master = state.mainThreadId;
    assert.equal(state.workItems.length, count, 'Casual question unexpectedly changed accepted goals');
    assert.equal(state.tasks.filter(item => item.kind !== 'request').length, 0, 'Casual question started project work');
    await phase('casual_question_not_goal', { masterThreadId: master, taskId: casual.taskId });

    const routed = {}, accepted = {};
    for (const name of ['alpha', 'beta']) {
      const projectName = name === 'alpha' ? 'Codex Alpha' : 'Hermes Beta';
      const assignment = name === 'alpha' ? 'use one read-only shell command to sleep for 45 seconds and then read witness.txt'
        : 'read witness.txt using its bounded project tools';
      const requestResult = await request('chat', { text: `Please continue the accepted goal "Inspect ${projectName} witness" in ${projectName}. Have that project's persistent session ${assignment} in its own project, report its exact contents, and keep the result in this conversation. Use its registered provider and read-only scope. Acknowledge once the work is started; do not wait or poll. Do not create another goal, send a separate specialist, or read the file yourself.` });
      const projectTask = await wait(() => state.tasks.find(item => item.parentTaskId === requestResult.taskId && item.kind === 'project' && item.turnId && active(item)), `active natural routing to ${projectName}`);
      assert.equal(projectTask.workId, goals[name].id, 'Request routed to wrong accepted goal');
      assert.equal(projectTask.provider, name === 'alpha' ? 'codex' : 'hermes', 'Wrong provider');
      assert.equal(projectTask.workspace, paths[name], 'Wrong project root');
      assert.equal(projectTask.permissionMode, 'read-only', 'Permissions broadened');
      if (name === 'beta') {
        assert.ok(active(task(accepted.alpha.task.id)), 'Alpha finished before Hermes admission; concurrent work not proven');
        await phase('concurrent_provider_projects', { alphaTaskId: accepted.alpha.task.id, betaTaskId: projectTask.id,
          alphaTurnId: task(accepted.alpha.task.id).turnId, betaTurnId: projectTask.turnId, bothActive: true });
      }
      accepted[name] = { request: requestResult, task: projectTask };
      await finish(requestResult.taskId);
    }
    for (const name of ['beta', 'alpha']) {
      const { request: requestResult, task: projectTask } = accepted[name];
      const completed = await finish(projectTask.id);
      assert.ok(completed.result.includes(markers[name]), 'Project did not return unpredictable marker');
      assert.ok(!completed.prompt.includes(markers[name]), 'Witness marker leaked into prompt');
      assert.equal(deliveries(projectTask.id).length, 1, 'Missing or duplicate attributable project result');
      assert.ok(deliveries(projectTask.id)[0].text.includes(markers[name]), 'Delivered result missing actual finding');
      assert.equal(state.mainThreadId, master, 'Master conversation changed');
      routed[name] = completed;
      if (name === 'beta') assert.ok(evidence.toolEvents.some(item => item.runId === projectTask.id && item.status === 'completed' && item.betaReadObserved), 'No actual scoped MCP file read witness');
      await phase(`natural_routing_${name}`, { requestId: requestResult.taskId, taskId: projectTask.id, provider: completed.provider, threadId: completed.threadId,
        workId: completed.workId, exactMarkerReturned: true, durableDeliveries: 1 });
    }
    assert.notEqual(routed.alpha.threadId, routed.beta.threadId, 'Project sessions were not isolated');
    assert.ok(!routed.beta.result.includes(markers.alpha), 'Other project marker crossed into Hermes result');

    const followup = await request('chat', { text: 'Continue the same accepted Hermes Beta witness goal in its existing persistent project session. Ask it to recall the exact witness marker from its own previous answer, without reading any file or using tools. Do not copy the marker into its request; the purpose is to check that the project remembers its own prior work. Acknowledge once started. Do not create another goal or specialist.' });
    await finish(followup.taskId);
    const followTask = await wait(() => state.tasks.find(item => item.parentTaskId === followup.taskId && item.kind === 'project'), 'persistent Hermes follow-up');
    const recalled = await finish(followTask.id);
    assert.equal(recalled.threadId, routed.beta.threadId, 'Hermes session not reused');
    assert.ok(!recalled.prompt.includes(markers.beta), 'Recall marker leaked into follow-up prompt');
    assert.ok(recalled.result.includes(markers.beta), 'Hermes did not recall saved context');
    assert.equal(evidence.toolEvents.filter(item => item.runId === recalled.id).length, 0, 'Recall reread tools instead of using session context');
    assert.equal(deliveries(recalled.id).length, 1, 'Follow-up result delivery duplicated');
    assert.equal(state.workItems.length, count, 'Project follow-ups created duplicate goals');
    await phase('hermes_saved_context', { taskId: recalled.id, threadId: recalled.threadId, rereadTools: 0 });

    const cancellation = await request('startControl', { name: 'Cancellation witness', objective: 'Qualify exact production Hermes cancellation.',
      instructions: 'Read each of the 24 files under cancellation individually, then return every exact file value with a brief comparison. Do not write files, read another directory, or access the network. The user may stop this run.' });
    const admitted = await wait(() => active(task(cancellation.taskId)) && task(cancellation.taskId).turnId && task(cancellation.taskId), 'Hermes cancellation admission');
    const cancelIdentity = { taskId: admitted.id, threadId: admitted.threadId, turnId: admitted.turnId };
    const beforeResponsive = { tasks: state.tasks.length, goals: state.workItems.length };
    const responsive = await request('chat', { text: 'Briefly confirm that this master chat remains available while the existing Hermes Beta analysis runs. Just answer in one sentence; do not wait for it, create goals, run project work or use tools.' });
    await finish(responsive.taskId);
    assert.ok(active(task(admitted.id)), 'Hermes finished before the master response; current responsiveness not proven');
    assert.equal(state.mainThreadId, master, 'Responsive reply changed master conversation');
    assert.equal(state.tasks.length, beforeResponsive.tasks + 1, 'Responsive status spawned work');
    assert.equal(state.workItems.length, beforeResponsive.goals, 'Responsive status created a goal');
    await phase('master_responsive_during_hermes', { masterThreadId: master, requestId: responsive.taskId, hermesTaskId: admitted.id, hermesStillActive: true });
    await request('cancel', { taskId: admitted.id }, 45_000);
    await wait(() => task(admitted.id) && !active(task(admitted.id)), 'provider-confirmed cancellation');
    assert.equal(task(admitted.id).status, 'cancelled', 'Cancel raced completion or lacked terminal cancellation');
    assert.ok(evidence.terminals.some(item => item.runId === admitted.id && item.turnId === admitted.turnId && item.status === 'interrupted'), 'Missing exact provider terminal interruption');
    await phase('production_cancellation', { ...cancelIdentity, providerTerminal: 'interrupted', toolPhase: 'No claim that cancellation occurred inside an active tool.' });

    const recovery = await request('startControl', { name: 'Crash receipt witness', objective: 'Recover this exact submitted run after Relay process restart without another submission.',
      instructions: 'Read recovery.txt and return its exact contents with a short explanation. Use only your bounded project tools. Do not read any other file or change anything.' });
    const bound = await wait(() => active(task(recovery.taskId)) && task(recovery.taskId).turnId && task(recovery.taskId), 'Hermes crash admission');
    const beforeCrash = { taskId: bound.id, threadId: bound.threadId, turnId: bound.turnId, tasks: state.tasks.length, turns: evidence.turns };
    await save(); await crash(); await open();
    assert.equal(state.mainThreadId, master, 'Restart changed master session');
    assert.equal(state.tasks.length, beforeCrash.tasks, 'Restart created tasks');
    assert.equal(evidence.turns, beforeCrash.turns, 'Restart submitted a prompt automatically');
    assert.equal(task(bound.id).providerOutcomeUnknown, true, 'Restart falsely claimed remote terminal outcome');
    assert.equal(task(bound.id).completedAt ?? null, null, 'Unknown remote run has terminal timestamp');
    await request('recover', { taskId: bound.id }, 45_000);
    const recovered = await finish(bound.id);
    assert.equal(recovered.threadId, beforeCrash.threadId, 'Recovery changed session');
    assert.equal(recovered.turnId, beforeCrash.turnId, 'Recovery changed admission');
    assert.ok(recovered.result.includes(markers.recovery), 'Recovered exact admission missing actual result');
    assert.equal(deliveries(bound.id).length, 1, 'Recovered result delivered more than once');
    await request('recover', { taskId: bound.id }); await snapshot();
    assert.equal(deliveries(bound.id).length, 1, 'Repeated receipt recovery duplicated delivery');
    assert.equal(evidence.turns, beforeCrash.turns, 'Receipt recovery replayed model submission');
    assert.equal(evidence.submissions.filter(item => item.runId === bound.id).length, 1, 'Same run submitted twice');
    await phase('relay_process_crash_receipt_recovery', { ...beforeCrash, finalStatus: recovered.status, submissions: 1, durableDeliveries: 1, replayedTurns: 0 });

    const goalsBeforeStatus = state.workItems.length;
    const status = await request('chat', { text: 'From this conversation and recorded results, briefly report the exact original witness markers found for Codex Alpha and Hermes Beta. Do not create goals, start work, read files or use project tools.' });
    const answer = await finish(status.taskId);
    assert.equal(state.mainThreadId, master, 'Post-restart master conversation changed');
    for (const name of ['alpha', 'beta']) assert.ok(answer.result.includes(markers[name]), 'Master lost attributable project finding');
    assert.equal(state.tasks.filter(item => item.parentTaskId === status.taskId).length, 0, 'Status question spawned work');
    assert.equal(state.workItems.length, goalsBeforeStatus, 'Status question created a goal');
    await phase('persistent_master_after_restart', { taskId: status.taskId, masterThreadId: master });
    shuttingDown = true;
    await gracefulClose();
    for (const [name, path] of Object.entries(paths)) assert.deepEqual(await filesUnder(path), originalFiles[name], 'Synthetic project files changed');
    evidence.finalSourceHashes = await sourceHashes();
    assert.deepEqual(evidence.finalSourceHashes, evidence.sourceHashes, 'Qualification source changed during execution');
    evidence.filesUnchanged = true; evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = safeError(error); throw error; }
  finally {
    shuttingDown = true;
    if (child) {
      try { await gracefulClose(); evidence.cleanup = 'Provider terminal settlement confirmed; owned child closed.'; }
      catch (error) {
        evidence.cleanup = 'Unconfirmed remote outcome: synthetic state retained for exact recovery; never infer provider termination from process exit.';
        evidence.cleanupError = safeError(error); evidence.status = 'failed'; process.exitCode = 1;
        // Release only the harness process; remote run is explicitly left unknown.
        if (child?.connected) await crash();
      }
    }
    evidence.cleanup ??= 'Provider terminal settlement confirmed; owned child closed.';
    evidence.finishedAt = new Date().toISOString(); await save();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    console.log(`Evidence: ${output}`);
    console.log(`Synthetic state retained: ${join(root, 'state')}`);
  }
}

async function worker() {
  // This private IPC worker cannot be launched with --live-worker alone in a shell.
  const [{ Store }, { Runtime }, { CodexAdapter }, { HermesAdapter }, { codexCommand }, { redact }] = await Promise.all([
    import('../server/store.mjs'), import('../server/runtime.mjs'), import('../server/adapters/codex.mjs'),
    import('../server/adapters/hermes.mjs'), import('../server/codex-command.mjs'), import('../server/security.mjs'),
  ]);
  let store, runtime, paths, grants = 0;
  const pendingGrants = new Map();
  const send = value => { if (process.connected) process.send(value); };
  function budget(adapter, provider) {
    const start = adapter.startTurn.bind(adapter);
    adapter.startTurn = async input => {
      const id = ++grants;
      const allowed = await new Promise((done, reject) => {
        const timer = setTimeout(() => { pendingGrants.delete(id); reject(new Error('Turn budget authority unavailable')); }, 5000);
        pendingGrants.set(id, { done, timer });
        send({ type: 'turn', id, provider, runId: input.runId, threadId: input.threadId });
      });
      if (!allowed) throw new Error('Qualification turn budget exhausted or duplicate submission refused');
      return start(input);
    };
  }
  process.on('message', async message => {
    if (message?.type === 'grant') {
      const entry = pendingGrants.get(message.id); if (!entry) return;
      pendingGrants.delete(message.id); clearTimeout(entry.timer); entry.done(message.allowed === true); return;
    }
    if (message?.type !== 'request') return;
    try {
      const p = message.params; let result;
      if (message.method === 'open') {
        assert.ok(!runtime, 'Worker already opened'); paths = p.paths;
        store = new Store(join(p.root, 'state'), paths.coordinator);
        const codex = new CodexAdapter({ command: await codexCommand(), cwd: repo });
        const hermes = new HermesAdapter(); budget(codex, 'codex'); budget(hermes, 'hermes');
        hermes.on('notification', ({ method, params = {} }) => {
          // The production adapter intentionally normalizes away native runId.
          // Bind its already-validated thread/admission to our persisted task.
          const run = store.state.tasks.find(item => item.provider === 'hermes' && item.threadId === params.threadId && item.turnId === params.turnId);
          if (!run) return;
          if (method === 'item/completed' && params.item?.type === 'providerTool') send({ type: 'tool', ...params, runId: run.id });
          if (method === 'turn/completed') send({ type: 'terminal', runId: run.id, threadId: params.threadId, turnId: params.turnId, status: params.turn?.status });
        });
        runtime = new Runtime(store, codex, { hermes }); await runtime.connect(); await runtime.connectProvider('hermes'); result = { opened: true };
      } else if (!runtime) throw new Error('Open the worker first');
      else if (message.method === 'snapshot') result = store.snapshot();
      else if (message.method === 'setup') {
        result = {};
        for (const [name, title, provider] of [['alpha', 'Codex Alpha', 'codex'], ['beta', 'Hermes Beta', 'hermes']]) {
          const project = await runtime.board.registerProject({ name: title, workspace: paths[name], permissionMode: 'read-only', provider });
          result[name] = runtime.board.createWork({ projectId: project.id, title: `Inspect ${title} witness`, objective: 'Read witness.txt in the project and report its exact contents without changing files.' });
        }
      } else if (message.method === 'chat') result = await runtime.chat(p.text);
      else if (message.method === 'startControl') {
        const project = store.state.projects.find(item => item.workspace === paths.beta);
        const goal = runtime.board.createWork({ projectId: project.id, title: p.name, objective: p.objective });
        result = runtime.startProject(goal.id, p.instructions);
      } else if (message.method === 'cancel') { await runtime.cancel(p.taskId); result = { requested: true }; }
      else if (message.method === 'recover') result = await runtime.recoverTask(p.taskId);
      else if (message.method === 'close') { await runtime.close(); store.close(); result = { closed: true }; }
      else throw new Error('Unsupported harness command');
      send({ type: 'response', id: message.id, result });
    } catch (error) { send({ type: 'response', id: message.id, error: redact(safeError(error)) }); }
  });
  process.on('disconnect', () => process.exit(0));
}
