import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadonlyProject, PROJECT_TOOLS } from './readonly-project.mjs';

export const MCP_LIMITS = Object.freeze({ lineBytes: 256 * 1024, replyBytes: 64 * 1024 });
const PROTOCOL_VERSION = '2024-11-05';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorReply = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const resultReply = (id, result) => ({ jsonrpc: '2.0', id, result });

/** A fixed-root, dependency-free stdio server. It exposes no shell, writes, environment or network tools. */
export async function serveProjectMcp({ root, input = process.stdin, output = process.stdout }) {
  const project = await createReadonlyProject(root);
  let initialized = false, ready = false;
  async function send(reply) {
    let line = JSON.stringify(reply);
    if (Buffer.byteLength(line) + 1 > MCP_LIMITS.replyBytes) {
      line = JSON.stringify(errorReply(reply.id, -32603, 'Result exceeds the bounded response limit. Narrow the request.'));
    }
    await new Promise((resolve, reject) => output.write(`${line}\n`, error => error ? reject(error) : resolve()));
  }
  async function receive(line) {
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { await send(errorReply(null, -32700, 'Invalid JSON message.')); return; }
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
        || (message.params !== undefined && !object(message.params))) {
      await send(errorReply(null, -32600, 'Invalid JSON-RPC request.')); return;
    }
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !(typeof message.id === 'string' && Buffer.byteLength(message.id) <= 128 || Number.isSafeInteger(message.id))) {
      await send(errorReply(null, -32600, 'Invalid request identifier.')); return;
    }
    if (!hasId) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      return;
    }
    const { id, method, params = {} } = message;
    if (method === 'ping') { await send(resultReply(id, {})); return; }
    if (method === 'initialize') {
      if (initialized || typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) {
        await send(errorReply(id, -32602, 'Invalid initialization request.')); return;
      }
      initialized = true;
      await send(resultReply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'vamfi-relay-project', version: '1.0.0' } }));
      return;
    }
    if (!ready) { await send(errorReply(id, -32002, 'Complete initialization before using project tools.')); return; }
    if (method === 'tools/list') {
      if (Object.keys(params).length) { await send(errorReply(id, -32602, 'This tool list has no pagination or filters.')); return; }
      await send(resultReply(id, { tools: PROJECT_TOOLS })); return;
    }
    if (method !== 'tools/call') { await send(errorReply(id, -32601, 'Method is not available.')); return; }
    if (Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))
        || !PROJECT_TOOLS.some(tool => tool.name === params.name) || (params.arguments !== undefined && !object(params.arguments))) {
      await send(errorReply(id, -32602, 'Unknown tool or invalid tool arguments.')); return;
    }
    try {
      const result = await project.call(params.name, params.arguments ?? {});
      await send(resultReply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false }));
    } catch (error) {
      if (error.code === 'INVALID_ARGUMENTS') await send(errorReply(id, -32602, 'Invalid read-only tool arguments.'));
      else await send(resultReply(id, { content: [{ type: 'text', text: 'Path is unavailable or denied by the read-only project policy.' }], isError: true }));
    }
  }
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (pending.length + end - start > MCP_LIMITS.lineBytes) {
        await send(errorReply(null, -32600, 'Message exceeds the bounded input limit.'));
        return 1;
      }
      pending = Buffer.concat([pending, bytes.subarray(start, end)]);
      if (newline < 0) break;
      if (pending.length) await receive(pending);
      pending = Buffer.alloc(0);
      start = newline + 1;
    }
  }
  if (pending.length) { await send(errorReply(null, -32700, 'Message must end with a newline.')); return 1; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--root' || !path.isAbsolute(args[1])) throw new Error('Invalid options');
    process.exitCode = await serveProjectMcp({ root: args[1] });
  } catch {
    process.stderr.write('Cannot start the read-only project server. Supply one accessible, permitted absolute --root directory.\n');
    process.exitCode = 1;
  }
}
