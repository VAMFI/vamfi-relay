#!/usr/bin/env node
/** Synthetic browser QA only. No Codex executable, user history, model, or network provider.
 * Run: npm run build && node scripts/preview-fixture.mjs
 * Optional chat markers: [fixture-slow] waits 15 seconds; [fixture-fail] fails the fake turn.
 * RELAY_FIXTURE_BACKGROUND=1 seeds a fictional background specialist result.
 * RELAY_FIXTURE_PROVIDERS=1 seeds three active synthetic project assignments after
 * a finished master request. One Hermes outcome starts unknown; Check outcome
 * inspects that exact run and Stop interrupts it without another admission.
 * [fixture-hold] keeps synthetic assignments active for up to ten minutes.
 * SIGINT/SIGTERM closes all clients and deletes this run's disposable state.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

const port = Number(process.env.RELAY_FIXTURE_PORT || 4320);
const providerScenarios = process.env.RELAY_FIXTURE_PROVIDERS === '1';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RELAY_FIXTURE_PORT must be 1024–65535.');
const directory = await mkdtemp(join(tmpdir(), 'vamfi-relay-synthetic-'));
const alpha = join(directory, 'demo-alpha');
const beta = join(directory, 'demo-beta');
const memoryHome = join(directory, 'synthetic-memory');
await Promise.all([mkdir(alpha), mkdir(beta), mkdir(join(memoryHome, 'memories'), { recursive: true })]);
await writeFile(join(memoryHome, 'memories', 'memory_summary.md'),
  '# SYNTHETIC DEMONSTRATION MEMORY\n\nDemo Alpha is a sample accessibility project. Demo Beta is a sample calendar project.\n'
  + 'All chats, history, memory and responses on this preview server are fictional browser fixtures. No real Codex account is connected.\n'
  + 'Untrusted content stays literal: <img src=x onerror=alert(1)>\n');

const recordedAt = Date.parse('2026-11-06T12:00:00Z') / 1000;
const sources = [
  { id: 'demo-alpha-source', name: 'Demo Alpha — resume the accessibility investigation and inspect the deliberately long chat title <img src=x onerror=alert(1)> without losing context',
    preview: 'Synthetic source chat. Keyboard navigation was investigated; implementation still needs review.', cwd: alpha,
    projectId: 'demo-alpha', source: 'vscode', parentThreadId: null, status: { type: 'notLoaded' } },
  { id: 'demo-alpha-review', name: 'Demo Alpha — independent review',
    preview: 'Synthetic specialist history. Found a missing keyboard focus indicator.', cwd: alpha,
    projectId: 'demo-alpha', source: { subAgent: 'review' }, parentThreadId: 'demo-alpha-source', status: { type: 'active', activeFlags: [] } },
  { id: 'demo-beta-source', name: 'Demo Beta — calendar synchronization',
    preview: 'Synthetic source chat. Calendar retry behavior needs a bounded follow-up.', cwd: beta,
    projectId: 'demo-beta', source: 'cli', parentThreadId: null, status: { type: 'idle' } },
].map((thread, index) => ({ ...thread, createdAt: recordedAt - 3600, updatedAt: recordedAt - index * 600 }));

class SyntheticExecution extends EventEmitter {
  sequence = 0;
  turnSequence = 0;
  threads = [];
  pending = new Map();
  constructor(provider = 'codex') { super(); this.provider = provider; }
  async connect() { return { version: 'SYNTHETIC-PREVIEW', authenticated: false, synthetic: true }; }
  async startThread(options) {
    const thread = { id: this.provider === 'hermes' ? `hermes:local-synthetic-${++this.sequence}` : `demo-relay-${++this.sequence}`, name: 'Demo Relay master — synthetic conversation',
      preview: 'Synthetic Relay-owned continuation. No model or command execution.', cwd: options.workspace,
      createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, source: 'appServer', status: { type: 'idle' } };
    this.threads.push(thread); return { id: thread.id };
  }
  async resumeThread(options) { return { id: options.id }; }
  async startTurn({ threadId, text }) {
    const turnId = this.provider === 'hermes' ? `synthetic-hermes-turn-${++this.turnSequence}` : `demo-turn-${++this.turnSequence}`;
    const thread = this.threads.find(thread => thread.id === threadId);
    thread.status = { type: 'active', activeFlags: [] }; thread.updatedAt = Date.now() / 1000;
    this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    const fail = text.includes('[fixture-fail]');
    const timer = setTimeout(() => {
      this.pending.delete(turnId); thread.status = { type: 'idle' }; thread.updatedAt = Date.now() / 1000;
      if (!fail) {
        const project = text.includes('demo-beta-source') ? 'Demo Beta' : text.includes('demo-alpha-source') ? 'Demo Alpha' : 'the demo workspace';
        const request = text.match(/My next request: ([^\n]*)/)?.[1] || text.split('\n')[0];
        const response = `SYNTHETIC FIXTURE RESPONSE — no model or project commands ran.\n\n`
          + `The same Relay master conversation received the request for ${project}: ${request.slice(0, 300)}\n\n`
          + 'The reviewed source excerpt was included as historical context. The source chat remains unchanged. '
          + 'This ordinary request created no new goal. Browser QA can inspect the linked request and source identifier.';
        this.emit('notification', { method: 'item/completed', params: { threadId, turnId,
          item: { id: `demo-message-${turnId}`, type: 'agentMessage', phase: 'final_answer', text: response } } });
      }
      this.emit('notification', { method: 'turn/completed', params: { threadId,
        turn: { id: turnId, status: fail ? 'failed' : 'completed',
          ...(fail ? { error: { message: 'Synthetic fixture failure requested; no real work was attempted.' } } : {}) } } });
    }, text.includes('[fixture-hold]') ? 600000 : text.includes('[fixture-slow]') ? 15000 : 800);
    this.pending.set(turnId, { timer, threadId });
    return { id: turnId };
  }
  async interrupt({ threadId, turnId }) {
    clearTimeout(this.pending.get(turnId)?.timer); this.pending.delete(turnId);
    const thread = this.threads.find(thread => thread.id === threadId); if (thread) thread.status = { type: 'idle' };
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
  }
  respond() {}
  async close() { for (const pending of this.pending.values()) clearTimeout(pending.timer); this.pending.clear(); }
}

class SyntheticHermes extends SyntheticExecution {
  receipts = new Map();
  constructor() {
    super('hermes');
    this.on('notification', ({ method, params }) => {
      if (method !== 'turn/completed') return;
      const receipt = [...this.receipts.values()].find(item => item.threadId === params.threadId && item.turnId === params.turn.id);
      if (receipt) receipt.state = params.turn.status;
    });
  }
  async connect() { return { version: 'SYNTHETIC-HERMES-PREVIEW', authenticated: false, synthetic: true }; }
  async startThread(options) {
    if (options.permissionMode !== 'read-only' || options.tools?.length) throw new Error('Synthetic Hermes permits read-only project fixtures only.');
    return super.startThread(options);
  }
  async resumeThread(options) {
    if (!this.threads.some(thread => thread.id === options.id)) throw new Error('Synthetic Hermes session identity was not found.');
    return { id: options.id };
  }
  async startTurn(options) {
    if (typeof options.runId !== 'string' || this.receipts.has(options.runId)) throw new Error('Synthetic Hermes needs a new exact run ID.');
    const turn = await super.startTurn(options);
    const receipt = { threadId: options.threadId, runId: options.runId, turnId: turn.id, state: 'running' };
    this.receipts.set(options.runId, receipt);
    if (options.text.includes('[fixture-outcome-unknown]')) {
      throw Object.assign(new Error('SYNTHETIC fixture: admission acknowledgement was lost; no real provider was contacted.'),
        { uncertain: true, ...receipt });
    }
    return turn;
  }
  async recover({ threadId, runId, turnId }) {
    const receipt = this.receipts.get(runId);
    if (!receipt || receipt.threadId !== threadId || (turnId && receipt.turnId !== turnId)) throw new Error('Synthetic Hermes recovery identity mismatch.');
    return { ...receipt, ...(receipt.state === 'completed' ? { result: 'SYNTHETIC fixture completed; no real model or commands ran.' } : {}) };
  }
  async interrupt({ threadId, turnId }) {
    const receipt = [...this.receipts.values()].find(item => item.threadId === threadId && item.turnId === turnId);
    if (!receipt) throw new Error('Synthetic Hermes interruption identity mismatch.');
    if (receipt.state === 'running') await super.interrupt({ threadId, turnId });
    return { turnId, state: receipt.state };
  }
  async close() {
    for (const receipt of this.receipts.values()) if (receipt.state === 'running') await this.interrupt(receipt);
    await super.close();
  }
}

class SyntheticDiscovery extends EventEmitter {
  constructor(execution) { super(); this.execution = execution; }
  async connect() { return { version: 'SYNTHETIC-PREVIEW', authenticated: false }; }
  async listThreads({ archived = false }) { return { data: archived ? [] : [...sources, ...this.execution.threads], nextCursor: null }; }
  async readThread({ threadId }) { return { thread: [...sources, ...this.execution.threads].find(thread => thread.id === threadId) }; }
  async listProjects() { return { data: [
    { id: 'demo-alpha', name: 'Demo Alpha · synthetic', roots: [{ path: alpha }] },
    { id: 'demo-beta', name: 'Demo Beta · synthetic', roots: [{ path: beta }] },
  ], nextCursor: null }; }
  async memoryStatus() { return { v2Ready: true, v2ConsolidatedThreads: 3 }; }
  async listThreadTurns({ threadId }) {
    const betaChat = threadId === 'demo-beta-source';
    const request = betaChat ? 'Investigate the synthetic calendar retry behavior.'
      : 'Investigate keyboard focus. Treat <img src=x onerror=alert(1)> as literal untrusted text.';
    const response = betaChat ? 'Synthetic observation: duplicate events could appear after a retry. No production calendar was accessed.'
      : 'Synthetic observation: the focus indicator is missing. A small fix and keyboard verification remain. No real project was changed.';
    return { data: [{ id: `demo-history-${threadId}`, status: 'completed', startedAt: recordedAt - 1200,
      completedAt: recordedAt - 1000, items: [
        { type: 'userMessage', content: [{ type: 'text', text: request }] },
        { type: 'commandExecution', command: 'npm test -- synthetic-fixture', status: 'completed', exitCode: 0,
          aggregatedOutput: 'This synthetic command was never executed.' },
        { type: 'agentMessage', text: response },
      ] }], nextCursor: null };
  }
  async close() {}
}

const execution = new SyntheticExecution();
const hermes = new SyntheticHermes();
let app;
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => { if (app) await app.close(); await rm(directory, { recursive: true, force: true }); })();
  try { await stopping; } catch { process.exitCode = 1; console.error('Synthetic preview cleanup failed.'); }
}
async function waitForFixture(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Synthetic preview scenario did not reach its expected state.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function seedProviderScenarios(betaProject) {
  // Preserve the standalone background-result scenario when both flags are on.
  await waitForFixture(() => !app.store.state.tasks.some(task => ['queued', 'running', 'waiting'].includes(task.status)));
  await app.runtime.settings({ maxWorkers: 3 });
  app.runtime.updateProject(betaProject.id, { provider: 'hermes', permissionMode: 'read-only' });
  const gamma = join(directory, 'demo-gamma');
  await mkdir(gamma);
  const gammaProject = await app.runtime.board.registerProject({ name: 'Demo Gamma · synthetic unknown outcome', workspace: gamma, provider: 'hermes', permissionMode: 'read-only' });
  const projects = [app.runtime.board.project(app.store.state.settings.defaultProjectId), app.runtime.board.project(betaProject.id), gammaProject];
  const goals = projects.map((project, index) => app.runtime.board.createWork({ projectId: project.id,
    title: ['SYNTHETIC Codex inspection', 'SYNTHETIC Hermes inspection', 'SYNTHETIC Hermes outcome check'][index],
    objective: 'Browser-only scenario. Inspect the original assignment and controls; no real model, commands, or project changes occur.' }));
  const request = await app.runtime.chat('SYNTHETIC PREVIEW: inspect Demo Alpha and Demo Beta in the background, and keep Demo Gamma’s uncertain run inspectable. No real work is requested.');
  const taskIds = goals.map((goal, index) => app.runtime.startProject(goal.id,
    `[fixture-hold] ${index === 2 ? '[fixture-outcome-unknown] ' : ''}Synthetic project inspection for browser QA only. No real model or commands run.`,
    { parentTaskId: request.taskId }).taskId);
  await waitForFixture(() => app.store.state.tasks.find(task => task.id === request.taskId)?.status === 'completed'
    && taskIds.every((id, index) => {
      const task = app.store.state.tasks.find(item => item.id === id);
      return index === 2 ? task?.providerOutcomeUnknown === true && task.status === 'waiting' : task?.status === 'running';
    }));
  app.store.change(() => app.store.event('fixture', 'Synthetic provider scenarios ready',
    'A finished master request has three active fictional assignments. Check outcome inspects Demo Gamma; Stop terminates the same saved run. No real provider was contacted.',
    { taskId: request.taskId }));
}
try {
  app = await createApp({ workspace: alpha, dataDir: join(directory, 'state'), adapter: execution,
    hermesAdapter: hermes, catalogAdapter: new SyntheticDiscovery(execution), codexHome: memoryHome, onShutdown: stop });
  app.runtime.updateProject(app.store.state.settings.defaultProjectId, { name: 'Demo Alpha · synthetic preview' });
  const betaProject = await app.runtime.board.registerProject({ name: 'Demo Beta · synthetic preview', workspace: beta });
  await app.runtime.connect();
  app.store.change(state => {
    state.meta.synthetic = true;
    app.store.event('fixture', 'Synthetic browser preview', 'All sources, memory and responses are fictional. No real Codex account or user history is connected.');
  });
  if (process.env.RELAY_FIXTURE_BACKGROUND === '1') {
    const work = app.runtime.board.createWork({ projectId: app.store.state.settings.defaultProjectId,
      title: 'Review the synthetic navigation', objective: 'Inspect the fictional finding and its original assignment.' });
    const request = await app.runtime.chat('Please assign an independent background review of the synthetic navigation.');
    const parent = app.store.state.tasks.find(task => task.id === request.taskId);
    app.runtime.delegateBackground(parent, { title: 'Synthetic navigation specialist', workId: work.id,
      instructions: 'Fixture finding: the navigation focus order is correct. Render <img src=x onerror=alert(1)> literally. No real commands ran.' }, 'fixture-background-call');
  }
  if (providerScenarios) await seedProviderScenarios(betaProject);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`SYNTHETIC Vamfi Relay preview: http://127.0.0.1:${port}/`);
  console.log('Fictional source chats and memory; no real Codex connection. Stop with Ctrl-C to remove disposable state.');
  if (providerScenarios) console.log('SYNTHETIC provider scenarios: open Conversation for three active project assignments. Demo Gamma starts Outcome unknown; Check outcome then Stop inspect and end that same run. Assignments last up to ten minutes.');
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'Synthetic preview port is already in use.' : 'Synthetic preview could not start.');
  await stop(); process.exitCode = 1;
}
