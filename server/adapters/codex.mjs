import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isAbsolute, resolve } from 'node:path';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const CATALOG_SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'exec', 'subAgent',
  'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const DISABLED_FEATURES = [
  'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'remote_plugin',
  'hooks', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'image_generation',
  'code_mode', 'enable_mcp_apps', 'skill_mcp_dependency_install', 'skill_search',
  'tool_suggest', 'memories', 'goals',
];

// These are process/thread overrides only. Never rewrite the user's configuration.
const SAFE_CONFIG = Object.freeze({
  ...Object.fromEntries(DISABLED_FEATURES.map((name) => [`features.${name}`, false])),
  // The default local host supplies model-visible execution. It is distinct
  // from remote hosts and external tools, whose feature gates remain disabled.
  'features.code_mode_host': true,
  'features.shell_tool': true,
  'features.unified_exec': true,
  approval_policy: 'on-request',
  approvals_reviewer: 'user',
  sandbox_mode: 'read-only',
  'sandbox_workspace_write.network_access': false,
  'sandbox_workspace_write.writable_roots': [],
  'sandbox_workspace_write.exclude_tmpdir_env_var': true,
  'sandbox_workspace_write.exclude_slash_tmp': true,
  'shell_environment_policy.inherit': 'core',
  'skills.include_instructions': false,
  'analytics.enabled': false,
  web_search: 'disabled',
});

const has = (object, key) => Object.hasOwn(object, key);
const validId = (id) => typeof id === 'string' || Number.isSafeInteger(id);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tomlValue = (value) => object(value)
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(',')}}`
  : JSON.stringify(value);
const configArgs = (config) => Object.entries(config).flatMap(([key, value]) =>
  ['-c', `${key}=${tomlValue(value)}`]);

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  return value;
}

function catalogId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError('A valid catalog thread identifier is required.');
  }
  return value;
}

function pageParams(cursor, limit, maximum) {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw new TypeError('Invalid catalog page limit.');
  if (cursor != null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 2048)) {
    throw new TypeError('Invalid catalog page cursor.');
  }
  return { ...(cursor == null ? {} : { cursor }), limit };
}

function validateTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw new TypeError('Dynamic tools must be an array.');
  const names = new Set();
  const checkFunction = (tool) => {
    if (!object(tool) || tool.type !== 'function'
      || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name ?? '')
      || typeof tool.description !== 'string' || tool.inputSchema === undefined
      || (has(tool, 'deferLoading') && typeof tool.deferLoading !== 'boolean')) {
      throw new TypeError('Invalid Codex dynamic function tool definition.');
    }
  };
  for (const tool of tools) {
    if (tool?.type === 'namespace') {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name ?? '')
        || typeof tool.description !== 'string' || !Array.isArray(tool.tools)) {
        throw new TypeError('Invalid Codex dynamic tool namespace.');
      }
      const nested = new Set();
      for (const fn of tool.tools) {
        checkFunction(fn);
        if (nested.has(fn.name)) throw new TypeError('Duplicate dynamic tool name.');
        nested.add(fn.name);
      }
    } else checkFunction(tool);
    if (names.has(tool.name)) throw new TypeError('Duplicate dynamic tool name.');
    names.add(tool.name);
  }
  // Snapshot caller-owned definitions and reject non-JSON values/circular structures.
  return JSON.parse(JSON.stringify(tools));
}

function sandboxPolicy(permissionMode, workspace) {
  return permissionMode === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    : { type: 'readOnly', networkAccess: false };
}

/** A private stdio connection to one owned Codex app-server process. */
export class CodexAdapter extends EventEmitter {
  #command;
  #cwd;
  #timeout;
  #child = null;
  #connecting = null;
  #connection = null;
  #nextId = 1;
  #pending = new Map();
  #serverRequests = new Map();
  #threads = new Map();
  #config = { ...SAFE_CONFIG };
  #auxiliary = new Set();
  #owned = new Map();
  #terminating = new WeakMap();
  #shutdown = Promise.resolve();
  #epoch = 0;

  constructor({ command = 'codex', cwd = process.cwd(), requestTimeoutMs = 30_000 } = {}) {
    super();
    this.#command = requireString(command, 'Codex command');
    this.#cwd = resolve(cwd);
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be positive.');
    }
    this.#timeout = requestTimeoutMs;
  }

  connect() {
    if (this.#connection) return Promise.resolve({ ...this.#connection });
    if (this.#connecting) return this.#connecting;
    const epoch = this.#epoch;
    const attempt = (async () => {
      await this.#shutdownBarrier();
      if (epoch !== this.#epoch) throw new Error('Codex connection closed.');
      return this.#connect();
    })();
    this.#connecting = attempt;
    attempt.finally(() => {
      if (this.#connecting === attempt) this.#connecting = null;
    }).catch(() => {});
    return attempt;
  }

  async #connect() {
    const epoch = this.#epoch;
    await this.#disableMcpServers(this.#cwd);
    if (epoch !== this.#epoch) throw new Error('Codex connection closed.');
    const child = spawn(this.#command,
      ['app-server', '--listen', 'stdio://', ...configArgs(this.#config)],
      { cwd: this.#cwd, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.#trackChild(child);
    this.#child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.#child !== child) return;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
          this.#stop('Codex protocol message exceeded the size limit.');
          return;
        }
        if (line.trim()) this.#receive(line);
        if (this.#child !== child) return;
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        this.#stop('Codex protocol message exceeded the size limit.');
      }
    });
    child.stdout.on('error', () => {
      if (this.#child === child) this.#stop('Codex output connection failed.');
    });
    child.stdin.on('error', () => {
      if (this.#child === child) this.#stop('Codex input connection failed.');
    });
    child.on('error', (error) => {
      if (this.#child === child) this.#stop(error.code === 'ENOENT'
        ? 'Codex executable was not found.' : 'Codex process could not be started.');
    });
    child.on('close', (code) => {
      if (this.#child === child) this.#stop(Number.isInteger(code)
        ? `Codex process exited (code ${code}).` : 'Codex process exited.');
    });

    try {
      const result = await this.#request('initialize', {
        clientInfo: { name: 'vamfi_relay', title: 'Vamfi Relay', version: '0.4.0' },
        capabilities: { experimentalApi: true },
      });
      this.#write({ method: 'initialized', params: {} });
      // account/read exposes identity metadata, never tokens. Only retain this boolean.
      const account = await this.#request('account/read', { refreshToken: false });
      const version = typeof result?.userAgent === 'string'
        ? result.userAgent.match(/\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1]
        : undefined;
      this.#connection = { version: version ?? 'unknown', authenticated: Boolean(account?.account) };
      return { ...this.#connection };
    } catch (error) {
      if (this.#child === child) this.#stop('Codex connection initialization failed.');
      throw error;
    }
  }

  async #disableMcpServers(workspace) {
    // Empty TOML tables merge with configured servers rather than clearing them.
    // Ask the CLI for the resolved names; do not read configuration/auth files,
    // retain server details, log output, or initialize the listed MCP servers.
    const names = await new Promise((resolveNames, reject) => {
      const child = spawn(this.#command,
        ['mcp', 'list', ...configArgs(SAFE_CONFIG)],
        { cwd: workspace, shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      this.#trackChild(child);
      this.#auxiliary.add(child);
      let buffer = '';
      const names = new Set();
      let columns = null;
      let empty = false;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        buffer = '';
        if (error) {
          this.#waitForShutdown([child]);
          reject(new Error(error));
        } else resolveNames(value);
      };
      const parseLine = (rawLine) => {
        if (!rawLine.trim()) return;
        if (rawLine.startsWith('No MCP servers configured')) {
          if (names.size || columns) throw new Error();
          empty = true;
          return;
        }
        const header = rawLine.match(/^Name\s+(Command|Url)\s+/);
        if (header && !empty) {
          columns = { endName: rawLine.indexOf(header[1]),
            status: rawLine.indexOf('Status'), auth: rawLine.indexOf('Auth') };
          if (columns.status < columns.endName || columns.auth < columns.status) throw new Error();
          return;
        }
        if (!columns || empty) throw new Error();
        const name = rawLine.slice(0, columns.endName).trim();
        const status = rawLine.slice(columns.status, columns.auth).trim();
        if (!name || /[\r\n\0]/.test(name) || !['enabled', 'disabled'].includes(status)) throw new Error();
        names.add(name);
        if (names.size > 1024) throw new Error();
      };
      const timer = setTimeout(() => finish('Codex MCP configuration check timed out.'), this.#timeout);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return finish('Codex MCP configuration check exceeded the size limit.');
        try {
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            // Discard URLs, command arguments, environment and auth columns immediately.
            parseLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        } catch { finish('Codex returned an unsupported MCP configuration listing.'); }
      });
      child.stdout.on('error', () => finish('Codex MCP configuration check failed.'));
      child.on('error', (error) => finish(error.code === 'ENOENT'
        ? 'Codex executable was not found.' : 'Codex MCP configuration check failed.'));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return finish('Codex MCP configuration check failed.');
        try {
          if (buffer) parseLine(buffer);
          if (!empty && !columns) throw new Error();
          finish(null, [...names]);
        } catch { finish('Codex returned an unsupported MCP configuration listing.'); }
      });
    });
    // A root inline table handles names containing dots. Codex's dotted CLI key
    // parser does not honor quoted path segments; quoted per-name keys can fail.
    this.#config.mcp_servers = { ...this.#config.mcp_servers,
      ...Object.fromEntries(names.map((name) => [name, { enabled: false }])) };
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.#stop('Codex sent invalid JSON.');
      return;
    }
    if (!object(message)) {
      this.#stop('Codex sent an invalid protocol message.');
      return;
    }
    if (typeof message.method === 'string') {
      const params = message.params ?? {};
      if (has(message, 'id')) {
        if (!validId(message.id)) return this.#stop('Codex sent an invalid request identifier.');
        // This POC uses the existing CLI sign-in and does not host auth/attestation flows.
        if (message.method.startsWith('account/') || message.method === 'attestation/generate') {
          this.#write({ id: message.id, error: { code: -32601, message: 'Authentication flow is not supported.' } });
          return;
        }
        if (this.#serverRequests.has(message.id)) return this.#stop('Codex reused a pending request identifier.');
        this.#serverRequests.set(message.id, { method: message.method, params });
        this.emit('request', { id: message.id, method: message.method, params });
      } else {
        if (message.method.startsWith('account/')) return;
        if (message.method === 'serverRequest/resolved') this.#serverRequests.delete(params.requestId);
        if (message.method === 'turn/completed') this.#invalidateRequests(params.threadId, params.turn?.id);
        this.emit('notification', { method: message.method, params });
      }
      return;
    }
    if (!validId(message.id) || (!has(message, 'result') && !has(message, 'error'))) {
      this.#stop('Codex sent an invalid protocol response.');
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (has(message, 'error')) {
      const suffix = Number.isInteger(message.error?.code) ? ` (code ${message.error.code})` : '';
      const error = new Error(`Codex rejected ${pending.method}${suffix}.`);
      error.code = Number.isInteger(message.error?.code) ? message.error.code : 'CODEX_RPC_ERROR';
      // Older providers can reject experimental methods as a serde unknown variant.
      // Classify only that exact method shape, retaining no provider diagnostics/data.
      error.unsupported = error.code === -32601 || (error.code === -32600
        && typeof message.error?.message === 'string'
        && ['', 'Invalid request: '].some(prefix => message.error.message.startsWith(`${prefix}unknown variant \`${pending.method}\`, expected `)));
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  #write(message) {
    const child = this.#child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) throw new Error('Codex is not connected.');
    const data = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) throw new Error('Codex request exceeded the size limit.');
    child.stdin.write(data, (error) => {
      if (error && this.#child === child) this.#stop('Codex input connection failed.');
    });
  }

  #request(method, params) {
    return new Promise((resolveRequest, reject) => {
      if (!this.#child) return reject(new Error('Codex is not connected.'));
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        // The server may already have acted; closing prevents an orphan live turn.
        this.#stop(`Codex ${method} timed out; the provider connection was stopped.`);
      }, this.#timeout);
      this.#pending.set(id, { method, resolve: resolveRequest, reject, timer });
      try { this.#write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #invalidateRequests(threadId, turnId) {
    for (const [id, request] of this.#serverRequests) {
      if (request.params.threadId === threadId
        && (!turnId || !request.params.turnId || request.params.turnId === turnId)) {
        this.#serverRequests.delete(id);
      }
    }
  }

  #threadOptions(options) {
    const workspace = requireString(options.workspace, 'Workspace');
    if (!isAbsolute(workspace)) throw new TypeError('Workspace must be an absolute path.');
    const permissionMode = options.permissionMode ?? 'read-only';
    if (!['read-only', 'workspace-write'].includes(permissionMode)) {
      throw new TypeError('Unsupported permission mode.');
    }
    if (options.developerInstructions !== undefined && typeof options.developerInstructions !== 'string') {
      throw new TypeError('Developer instructions must be text.');
    }
    return { workspace: resolve(workspace), permissionMode,
      developerInstructions: options.developerInstructions, tools: validateTools(options.tools) };
  }

  async #openThread(method, options) {
    if (!this.#connection) throw new Error('Codex is not connected.');
    const child = this.#child;
    const settings = this.#threadOptions(options);
    try { await this.#disableMcpServers(settings.workspace); } catch (error) {
      this.#stop('Codex workspace MCP configuration could not be verified.');
      throw error;
    }
    if (this.#child !== child || !this.#connection) throw new Error('Codex connection closed.');
    const params = {
      cwd: settings.workspace,
      runtimeWorkspaceRoots: [settings.workspace],
      sandbox: settings.permissionMode,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      config: { ...this.#config },
      ...(settings.developerInstructions === undefined ? {} : { developerInstructions: settings.developerInstructions }),
    };
    if (method === 'thread/start') {
      if (settings.tools !== undefined) params.dynamicTools = settings.tools;
    } else {
      params.threadId = requireString(options.id, 'Thread identifier');
      params.excludeTurns = true;
      // 0.147.0 has no dynamicTools field on ThreadResumeParams. Codex restores
      // persisted tools. The runtime must retain its toolSpecVersion and may not
      // change definitions when resuming an existing v0.1 thread.
      const previous = this.#threads.get(options.id);
      if (previous?.tools && settings.tools !== undefined
        && JSON.stringify(previous.tools) !== JSON.stringify(settings.tools)) {
        throw new Error('Dynamic tools cannot be changed when resuming a thread.');
      }
    }
    const result = await this.#request(method, params);
    const expected = sandboxPolicy(settings.permissionMode, settings.workspace);
    if (typeof result?.thread?.id !== 'string' || !result.thread.id
      || result.approvalPolicy !== 'on-request' || result.approvalsReviewer !== 'user'
      || result.sandbox?.type !== expected.type || result.sandbox.networkAccess === true
      || result.cwd !== settings.workspace
      || (Array.isArray(result.runtimeWorkspaceRoots)
        && result.runtimeWorkspaceRoots.some((root) => root !== settings.workspace))
      || (settings.permissionMode === 'workspace-write'
        && ((result.sandbox.writableRoots ?? []).some((root) => root !== settings.workspace)
          || result.sandbox.excludeTmpdirEnvVar !== true || result.sandbox.excludeSlashTmp !== true))
      || (method === 'thread/resume' && result.thread.id !== options.id)) {
      this.#stop('Codex did not confirm the requested thread permissions.');
      throw new Error('Codex did not confirm the requested thread permissions.');
    }
    this.#threads.set(result.thread.id, settings);
    return { id: result.thread.id };
  }

  startThread(options) { return this.#openThread('thread/start', options); }

  // These read APIs never add to #threads, resume a session, or subscribe to it.
  // Source: https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming
  async listThreads({ cursor, limit = 100, archived = false } = {}) {
    if (typeof archived !== 'boolean') throw new TypeError('Archived must be a boolean.');
    return this.#request('thread/list', { ...pageParams(cursor, limit, 100),
      sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [],
      sourceKinds: CATALOG_SOURCE_KINDS, archived, useStateDbOnly: true });
  }

  async readThread({ threadId, includeTurns = false }) {
    if (includeTurns !== false) throw new TypeError('Catalog reads must request metadata only.');
    return this.#request('thread/read', { threadId: catalogId(threadId), includeTurns: false });
  }

  async listThreadTurns({ threadId, cursor, limit = 20, sortDirection = 'desc', itemsView = 'full' }) {
    if (!['asc', 'desc'].includes(sortDirection) || !['full', 'summary', 'notLoaded'].includes(itemsView)) {
      throw new TypeError('Invalid catalog history view.');
    }
    return this.#request('thread/turns/list', { threadId: catalogId(threadId),
      ...pageParams(cursor, limit, 20), sortDirection, itemsView });
  }

  async listProjects({ cursor, limit = 100 } = {}) {
    return this.#request('project/list', { ...pageParams(cursor, limit, 100), sortKey: 'position' });
  }

  async memoryStatus() { return this.#request('memory/status', {}); }

  resumeThread(options) {
    return this.#openThread('thread/resume', { ...this.#threads.get(options.id), ...options });
  }

  async startTurn({ threadId, text }) {
    const settings = this.#threads.get(requireString(threadId, 'Thread identifier'));
    if (!this.#connection || !settings) throw new Error('Resume or start this thread before sending a turn.');
    requireString(text, 'Turn text');
    const result = await this.#request('turn/start', {
      threadId, input: [{ type: 'text', text }],
      cwd: settings.workspace, runtimeWorkspaceRoots: [settings.workspace],
      approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandboxPolicy: sandboxPolicy(settings.permissionMode, settings.workspace),
    });
    if (typeof result?.turn?.id !== 'string' || !result.turn.id) {
      this.#stop('Codex did not return a turn identifier.');
      throw new Error('Codex did not return a turn identifier.');
    }
    return { id: result.turn.id };
  }

  async interrupt({ threadId, turnId }) {
    requireString(threadId, 'Thread identifier');
    requireString(turnId, 'Turn identifier');
    this.#invalidateRequests(threadId, turnId);
    try { await this.#request('turn/interrupt', { threadId, turnId }); } catch (error) {
      this.#stop('Codex cancellation failed; the provider connection was stopped.');
      throw error;
    }
  }

  respond(requestId, result) {
    if (!this.#serverRequests.has(requestId)) throw new Error('Codex request is no longer pending.');
    this.#write({ id: requestId, result });
    this.#serverRequests.delete(requestId);
  }

  #trackChild(child) {
    const owned = { closed: false };
    owned.exited = new Promise(resolveExit => child.once('close', () => {
      owned.closed = true;
      this.#auxiliary.delete(child);
      this.#owned.delete(child);
      this.#terminating.delete(child);
      resolveExit();
    }));
    this.#owned.set(child, owned);
  }

  #terminate(child) {
    const previous = this.#terminating.get(child);
    if (previous) return previous;
    const owned = this.#owned.get(child);
    if (!owned || owned.closed) return Promise.resolve();
    const stopping = new Promise((resolveStop, reject) => {
      const signal = name => {
        try { child.kill(name); }
        catch { reject(new Error('The owned Codex process could not be stopped.')); }
      };
      // Keep both timers referenced: an owning service must not exit before
      // termination is observed or its bounded shutdown fails explicitly.
      const force = setTimeout(() => signal('SIGKILL'), 1000);
      const deadline = setTimeout(() => reject(new Error('The owned Codex process did not confirm exit.')), 5000);
      owned.exited.then(() => { clearTimeout(force); clearTimeout(deadline); resolveStop(); });
      signal('SIGTERM');
    });
    this.#terminating.set(child, stopping);
    return stopping;
  }

  #shutdownBarrier() {
    // A prior failure remains authoritative while any owned process lacks an
    // observed close event. An explicit retry may recover only once all closed.
    if (this.#owned.size === 0) this.#shutdown = Promise.resolve();
    return this.#shutdown;
  }

  #waitForShutdown(children) {
    const waiting = Promise.all([this.#shutdownBarrier(), ...children.map(child => this.#terminate(child))]).then(() => {});
    // Protocol error callbacks initiate shutdown without awaiting it. Retain
    // the result so close/reconnect still observe any termination failure.
    waiting.catch(() => {});
    this.#shutdown = waiting;
    return waiting;
  }

  #stop(message) {
    const child = this.#child;
    const hadConnection = Boolean(child || this.#auxiliary.size || this.#connection);
    this.#epoch++;
    const stopping = this.#waitForShutdown([...this.#owned.keys()]);
    this.#child = null;
    this.#connection = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
    this.#serverRequests.clear();
    this.#threads.clear();
    child?.stdin.destroy();
    if (hadConnection) this.emit('disconnect', { message });
    return stopping;
  }

  close() { return this.#stop('Codex connection closed.'); }
}

export default CodexAdapter;
