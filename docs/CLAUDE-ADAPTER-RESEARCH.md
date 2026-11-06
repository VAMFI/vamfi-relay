# Claude adapter research contract

Status: **proposed; implementation and live qualification pending**. Research snapshot: 2026-11-06.

## Evidence and scope

Read-only inspection found Claude Code **2.1.227**. Installed `claude --help` exposes the flags below. The documented `claude auth status --json` check, reduced to a boolean without retaining account details, returned **authenticated: false**. No model invocation, authentication action, credential-file read, or provider-session mutation was performed. Live qualification requires the user's own provider authentication.

The first capability is **read-only project analysis** through a Relay-owned stdio MCP server. Keep the existing coordinator; Claude does not initially receive routing/delegation powers, shell execution, writes, network tools, external-chat continuation, or arbitrary provider-history discovery. Do not claim implementation or provider parity from this research.

## Proposed invocation

Use the user's unmodified installed CLI, an argument array, and prompt input on stdin. Spawn from a Relay-owned session directory outside the source repository; store application state outside tracked source. Example limits below are qualification defaults, not a billing guarantee.

```js
const argv = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--tools', '',
  '--permission-mode', 'dontAsk',
  '--allowedTools',
  'mcp__relay_project__list_files,mcp__relay_project__read_file,mcp__relay_project__search_files',
  '--mcp-config', JSON.stringify({ mcpServers: { relay_project: {
    type: 'stdio', command: absoluteNodePath,
    args: [absoluteOwnedMcpPath, '--root', validatedProjectRoot],
  } } }),
  '--strict-mcp-config', '--setting-sources', '',
  '--settings', JSON.stringify({
    disableAllHooks: true, autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
  }),
  '--disable-slash-commands', '--no-chrome',
  '--prompt-suggestions', 'false',
  '--max-turns', '6', '--max-budget-usd', '0.50',
  isNewSession ? '--session-id' : '--resume', relayOwnedSessionUuid,
];
const environmentOverrides = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
```

Add `--json-schema` only when implementing a validated final checkpoint. The interaction between structured output and disabled built-in tools needs a live test. Never interpolate a prompt into a shell command. Do not use `--continue` (implicit latest session), `--no-session-persistence`, or undocumented CLI control messages. `--bare` suppresses subscription authentication; `--safe-mode` suppresses MCP. [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless execution](https://code.claude.com/docs/en/headless), [environment controls](https://code.claude.com/docs/en/env-vars).

## Isolation and version limits

The MCP server is the file-access boundary: provide only bounded list, read, and literal search operations; reject absolute paths, traversal, symlink escapes, sensitive files, unsupported file types, and oversized results. It must expose no shell, environment inspection, arbitrary filesystem, write, or network primitive. Use validated static executable paths and a fixed project root, never a model-selected root. Avoid path-check/read races and fail closed when confinement cannot be established.

The CLI itself is **not an OS sandbox**. Empty setting sources do not remove managed policy or global configuration; managed hooks can survive `disableAllHooks`. Ordinary plugins, memory, and file attachments must be suppressed and tested. Never bypass organization policy. Unexpected tools/plugins/MCP servers must make the run unsupported rather than silently broaden scope. Startup inspection cannot undo hooks that already ran. [Configuration loading](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [settings reference](https://code.claude.com/docs/en/settings-reference).

Current documentation describes versions newer than 2.1.227:

- Before **2.1.246**, strict MCP sessions could wait on approvals for ignored project servers. A controlled working directory reduces this exposure; test startup with hostile project configuration. [MCP documentation](https://code.claude.com/docs/en/mcp).
- Native `blockReadsOutsideWorkingDirectories` requires **2.1.257** and is unavailable here. Do not substitute broad native `Read` permissions for the owned MCP boundary. [Settings reference](https://code.claude.com/docs/en/settings-reference).
- Before **2.1.277**, resumed print sessions reset cost totals; newer releases restore prior spend. Version-gate accounting, avoid double counting, and label costs as estimates. Budgets may overshoot. [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

Installed help warns that invalid settings are silently ignored in print mode. Validate generated configuration and qualify actual behavior for each supported version; recognizing a flag is insufficient.

## Provider-neutral lifecycle proposal

These are proposed internal operations, not existing exported APIs:

| Operation | Required behavior |
| --- | --- |
| `probe()` | Return `{installed, version, authenticated, capabilities}`; installation alone never means ready. |
| `openSession({projectId, root})` | Allocate and persist an owned UUID and controlled directory. |
| `resumeSession({sessionId, projectId})` | Require an owned, matching project binding; refuse external IDs and concurrent turns. |
| `run({sessionId, runId, prompt, limits})` | Spawn one bounded invocation and emit normalized events. |
| `cancel({runId})` / `close()` | Stop only owned processes; await confirmed termination and child cleanup. |

Normalized events carry `{runId, sessionId, sequence, type}` with these payloads:

- `started`: observed provider version and validated capabilities.
- `text`: bounded assistant text delta; never expose hidden reasoning.
- `tool`: actual owned-MCP call ID, tool name, status, and bounded evidence reference.
- `usage`: token counts, estimated cost, and whether totals cover the invocation or session.
- `checkpoint`: validated structured report with explicit `agent_report` provenance.
- `finished`: `completed | failed | cancelled | interrupted`, sanitized error code, and process-exit evidence.

Parse stdout as bounded NDJSON. Relevant provider fields are `type`, `subtype`, `session_id`, assistant `message.id/content`, and `stream_event.event`. Final `result` includes `is_error`, `usage`, `total_cost_usd`, `permission_denials`, and optional `structured_output`. Handle `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, and `error_max_structured_output_retries`. Ignore unknown optional fields; reject malformed required lifecycle data. Deduplicate partial/complete text and repeated message IDs. [Message schemas](https://code.claude.com/docs/en/agent-sdk/typescript), [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output).

A successful result alone is insufficient: require `subtype: success`, `is_error: false`, valid required checkpoint, no contradictory failure/cancellation, and successful process closure. Checkpoints are agent claims, not independent verification or an executed Relay tool call. [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs).

Fail closed on malformed streams, missing final results, missing/disconnected required MCP, unexpected capabilities, deadlines, and process errors. Normalize errors to bounded codes such as `auth_required`, `capability_mismatch`, `mcp_unavailable`, `protocol_error`, `budget_exceeded`, and `process_failed`; do not persist raw stderr/account diagnostics. Terminate the owned process group, escalate within a bounded deadline, and confirm CLI/MCP cleanup before releasing the project lock. On restart mark unfinished runs interrupted; never automatically replay their prompts.

## Authentication and distribution boundary

Relay must not collect, copy, or intermediate subscription tokens or implement Claude.ai login. Sign-in stays in Anthropic's own flow. Official guidance permits end users to authenticate the unmodified Claude Code binary with their own subscription under its product/platform conditions; running it in a product requires applicable Commercial Terms and conditions, including no usage resale/intermediation or modification of built-in authentication. Third-party SDK applications should use API keys or supported cloud authentication. Require a separately installed official binary; Relay's OSS license does not relicense Claude Code. [Legal and authentication conditions](https://code.claude.com/docs/en/legal-and-compliance).

## Required acceptance witnesses

All gates remain **pending**; fixture-only tests do not qualify the provider.

1. After independent user authentication, read a disposable project file containing a freshly generated unpredictable marker that was not included in the prompt. Record an actual MCP read and the matching answer.
2. Request a write, a sibling-project read, traversal, and an external symlink read. Verify denial, unchanged files, and no leaked marker/content. Test sensitive-file and size limits directly.
3. Seed disposable project hooks/plugins/MCP configuration. Verify it does not execute or appear as an available capability; reject any unsupported isolation outcome.
4. Continue the owned session with a second prompt, then switch projects and verify session/context separation.
5. Restart Relay; verify the owned session can continue, prior events render once, completed prompts are not replayed, and an unfinished run becomes interrupted without automatic execution.
6. Cancel during a live read and inject startup/stream/process failures. Verify terminal status, child cleanup, lock release, and absence of false completion.
7. Exercise budget/turn limits and invalid or absent checkpoints; automatic next-step execution must remain blocked.
8. Inspect the real dashboard: streaming, actual read evidence, qualification state, failure/cancellation, and persisted history must agree with the observed provider process.
