#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = JSON.parse(readFileSync('scenario.json', 'utf8'));
const log = (value) => appendFileSync('wire.jsonl', `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
log({ argv: process.argv.slice(2), pid: process.pid });

if ((scenario.shutdown === 'stubborn' && process.argv[2] === 'app-server') || scenario.mcp === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

if (process.argv[2] === 'mcp') {
  if (scenario.mcp === 'timeout' || scenario.mcp === 'stubborn') setInterval(() => {}, 1000);
  else if (scenario.mcp === 'invalid') process.stdout.write('not valid JSON');
  else if (scenario.mcp === 'shape') send({ servers: [] });
  else {
    const rows = [['Name', 'Command', 'Args', 'Env', 'Cwd', 'Status', 'Auth'],
      ...(scenario.mcpNames ?? ['configured-server']).map((name) =>
        [name, '/nonexistent-fixture-command', '-', '-', '-', 'enabled', 'Unsupported'])];
    if (rows.length === 1) process.stdout.write('No MCP servers configured yet.\n');
    else {
      const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
      for (const row of rows) process.stdout.write(`${row.map((value, column) => value.padEnd(widths[column])).join('  ')}\n`);
    }
  }
} else {
  let initialized = false;
  let sequence = 0;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    log(message);
    const { id, method, params } = message;
    if (!method) return send({ method: 'mock/responded', params: { response: message } });
    if (method === 'initialize') {
      if (scenario.initialize === 'timeout') return;
      if (scenario.initialize === 'exit') return process.exit(7);
      if (scenario.initialize === 'invalid') return process.stdout.write('private malformed output\n');
      return send({ id, result: { userAgent: 'vamfi_relay/0.147.0 (mock)',
        codexHome: '/mock/private', platformFamily: 'unix', platformOs: 'macos' } });
    }
    if (method === 'initialized') { initialized = true; return; }
    if (!initialized) return send({ id, error: { code: -32600, message: 'Not initialized' } });
    if (method === 'account/read') {
      return send({ id, result: { requiresOpenaiAuth: true,
        account: scenario.authenticated === false ? null
          : { type: 'chatgpt', email: 'private@example.invalid', planType: 'plus' } } });
    }
    if (['thread/list', 'thread/read', 'thread/turns/list', 'project/list', 'memory/status'].includes(method)) {
      const catalog = scenario.catalog || {};
      if (catalog.timeout === method) return;
      if (catalog.errors?.[method]) return send({ id, error: catalog.errors[method] });
      if (method === 'thread/list') return send({ id, result: { data: catalog.threads || [], nextCursor: null } });
      if (method === 'thread/read') return send({ id, result: { thread: catalog.threads?.find(thread => thread.id === params.threadId) } });
      if (method === 'thread/turns/list') return send({ id, result: { data: catalog.turns || [], nextCursor: null } });
      if (method === 'project/list') return send({ id, result: { data: catalog.projects || [], nextCursor: null } });
      return send({ id, result: catalog.memory || { v2Ready: false, v2ConsolidatedThreads: 0 } });
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      const threadId = params.threadId ?? `thread-${++sequence}`;
      const sandbox = params.sandbox === 'workspace-write'
        ? { type: 'workspaceWrite', writableRoots: [params.cwd], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: 'readOnly', networkAccess: false };
      if (scenario.permissions === 'mismatch') sandbox.type = 'dangerFullAccess';
      send({ id, result: { thread: { id: threadId }, cwd: params.cwd,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox,
        runtimeWorkspaceRoots: [params.cwd] } });
      return send({ method: 'thread/started', params: { thread: { id: threadId } } });
    }
    if (method === 'turn/start') {
      const text = params.input[0].text;
      if (text === 'timeout') return;
      if (text === 'exit') {
        process.stderr.write('FAKE_SECRET_ONLY_FOR_TEST_DO_NOT_FORWARD\n');
        return process.exit(9);
      }
      if (text === 'rpc-error') return send({ id, error: { code: -32600,
        message: 'FAKE_SECRET_ONLY_FOR_TEST_DO_NOT_FORWARD', data: { token: 'fake-test-token' } } });
      if (text === 'invalid') return process.stdout.write('FAKE_SECRET_ONLY_FOR_TEST_DO_NOT_FORWARD\n');
      if (text === 'oversize') return process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
      const turnId = 'turn-1';
      send({ id, result: { turn: { id: turnId } } });
      if (text === 'request' || text === 'cancel' || text === 'resolved') {
        send({ id: 'server-request-1', method: 'item/tool/call', params: {
          threadId: params.threadId, turnId, callId: 'call-1', tool: 'relay_delegate',
          arguments: { task: 'Read the fixture.' },
        } });
        if (text === 'resolved') send({ method: 'serverRequest/resolved',
          params: { threadId: params.threadId, requestId: 'server-request-1' } });
      } else {
        // Split a multibyte UTF-8 character across writes to exercise stream decoding.
        const delta = Buffer.from(`${JSON.stringify({ method: 'item/agentMessage/delta',
          params: { threadId: params.threadId, turnId, delta: 'Hello 🌿' } })}\n`);
        process.stdout.write(delta.subarray(0, delta.length - 5));
        process.stdout.write(delta.subarray(delta.length - 5));
        send({ method: 'turn/completed', params: { threadId: params.threadId,
          turn: { id: turnId, status: 'completed' } } });
      }
      return;
    }
    if (method === 'turn/interrupt') {
      send({ id, result: {} });
      return send({ method: 'turn/completed', params: { threadId: params.threadId,
        turn: { id: params.turnId, status: 'interrupted' } } });
    }
    send({ id, error: { code: -32601, message: 'Unsupported fixture method' } });
  });
}
