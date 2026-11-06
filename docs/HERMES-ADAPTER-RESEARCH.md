# Hermes adapter: researched contract and qualification

Date: 2026-11-06. Scope: a second provider for Relay-owned, read-only project analysis. This document records transport research; the subsequent production adapter qualification and its limits are in [verification](VERIFICATION.md). The native transport, restricted MCP selection, real file reading, reconnect and active cancellation have been exercised independently.

## Version and update boundary

Research began with a clean source checkout at `8359e760be499fd8e804242e7606d81dde931abb`, version 0.20.0. The coordinator preserved that revision, installed official stable **v0.23.0**, commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`, using the supported PM installation path, and restarted the existing gateway. Subsequent ACP initialization reported 0.23.0; `hermes acp --check` passed. Tests began only after that update.

The supported manual source sequence is a source-only rollback ref, fetch the release tag, detach at its verified commit, then `./venv/bin/python -m pm.cli install`. Preserve dirty work before any checkout change. A source ref does not roll back migrated runtime data. Do not back up credentials, profiles or chat databases into Relay. The old updater's `--no-backup` skips its archive, but does not suppress its profile credential backfill; it was therefore excluded. [Updating and manual maintenance](https://hermes-agent.nousresearch.com/docs/getting-started/updating), [release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0), [PM installation implementation](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/pm/cli.py), [old updater](https://github.com/NousResearch/hermes-agent/blob/8359e760be499fd8e804242e7606d81dde931abb/hermes_cli/update_cmd.py).

## Chosen transport and authentication

Use the **canonical gateway JSON-RPC interface**, with a small local Python bridge using the installed, version-pinned `hermes_cli.gateway_client.connect_gateway()` native transport. The public documentation explicitly supports custom hosts and frozen local-session policies. The Python helper is an implementation dependency, not an independently versioned SDK: reject an unqualified release or missing runtime capabilities. Do not launch a second execution owner through the older TUI server. [Programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration), [canonical local sessions](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions).

The native helper obtains a one-use ticket through Hermes' same-user control socket and verifies the gateway identity/protocol. Relay must not read, copy, persist or print OAuth/API credentials, dashboard tokens, authentication files, ticket responses or WebSocket authentication headers. Authentication and model routing remain Hermes-owned. Refuse remote URL overrides for this local adapter. The live witness used the existing native authentication successfully; it did not log in, copy credentials or change the selected provider. [Native transport source](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/hermes_cli/gateway_client.py), [classic gateway client](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-classic-cli).

ACP remains useful for editors, but its public `session/new` does not forward an explicit toolset selection. A temporary ACP profile-setting probe demonstrated frozen session policy and restored every config field, but global setting changes introduce races with other clients. Production must use per-session gateway fields. Headless CLI exits are unsuitable cancellation evidence: Ctrl-C exits 130 while accepted gateway work continues, and an input-required exit 3 also detaches. [ACP implementation](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/acp_adapter/gateway_server.py), [headless behavior](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/hermes_cli/gateway_chat.py).

## Exact initial policy

Check `runtime.describe` for source `acp`, the required creation parameters, and capabilities `durable-admission-v1`, `event-replay-v1`, `acp-editor-policy-v1` and `acp-session-mcp-v1`. The local bridge's create call is:

```python
snapshot = await client.rpc(
    "session.create",
    request_id=durable_create_id,
    source="acp",
    cwd=validated_project_root,
    toolsets=["no_mcp"],
    ignore_rules=True,
    max_turns=6,
    hidden=True,
    editor={
        "mcp_servers": [{
            "name": owned_server_name,
            "command": absolute_node_executable,
            "args": [absolute_relay_mcp_script, "--root", validated_project_root],
            "env": [],
        }],
        "edit_approval_policy": "ask",
    },
)
```

The MCP arguments must match the implemented server CLI; the example expresses the contract, not an executable launch recipe. `no_mcp` is a validated sentinel excluding profile-configured MCP servers; editor MCP is added separately. An empty toolset array also worked on the inspected profile, but can merge configured MCP servers and is insufficient as the general policy. Verify the returned `info.launch_request` flags and require exactly the owned editor-MCP toolset before submitting work. Failed or partial discovery must fail closed. [Policy selection](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_policy.py), [sentinel validation](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/hermes_cli/toolset_validation.py), [editor MCP ownership](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_local_mcp.py).

`ignore_rules` suppresses workspace/profile rules, SOUL identity and persistent memory in the executing agent. It does not independently suppress every custom hook, plugin callback or arbitrary configured system instruction. Before each run, inspect only eligibility metadata: no configured shell/outbound hooks, no enabled runtime hook callbacks, no custom context engine or system-prompt injection. Do not dump config, prompts or plugin errors. `plugins.list` showed 59 enabled built-in/provider/platform registrations, zero hooks and five globally registered A2A tools; those registrations were absent from the restricted session selection. Registration count is not permission count. A conflicting profile or changed policy is an unsupported configuration until separately qualified. [Execution flags](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_execution.py), [runtime plugin metadata](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_discovery.py).

Hermes may expose `tool_search`, `tool_describe` and `tool_call` instead of direct MCP schemas. This occurred in the real witness. The pinned dispatcher rebuilds the session-only raw catalog and rejects underlying tools outside that catalog. Accept these wrappers only with the exact owned toolset and audited MCP schemas; do not infer broad access from globally registered tools or treat a pre-turn empty individual-tool inventory as proof of discovery failure. [Selection and wrapper dispatch](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/model_tools.py), [scope enforcement](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/tools/tool_search.py).

## Lifecycle, events and recovery

Persist create ID, logical session ID, submission ID, admission ID and replay cursor in Relay's own store. A repeated identical create request reused the same logical ID. Compression may rotate private transcript storage without changing the public logical ID.

| Operation | Gateway request / required interpretation |
| --- | --- |
| Submit | `prompt.submit {session_id, submission_id: RelayTaskUUID, text, finite:true}`. Journal the submission ID before sending. Admission is not completion. |
| Receipt | `prompt.receipt {session_id, admission_id, include_result:true}`. Status is `queued`, `started`, `unknown` or `terminal`; preserve outcome and execution generation. |
| Resume | `session.resume {session_id, editor:{mcp_servers:[same owned server]}}`. Validate policy again; never resume an arbitrary external conversation. |
| Cancel | `prompt.cancel {session_id, admission_id}`. Await that admission's terminal receipt; running cancellation produced `interrupted`, queued cancellation may produce `cancelled`. |
| Replay | `session.events.since {session_id, replay_epoch, last_sequence}`. On `snapshot_required`, resume and reconcile the snapshot. |
| Detach | `session.detach {session_id, subscription_id}` or close the native client. Neither proves remote work stopped. |

Native notifications have method `event`; `params` contains `type`, `session_id`, `payload`, `replay_epoch`, `seq`, and turn-scoped admission/generation fields. Observed types included `message.start`, `message.delta`, `message.complete`, `tool.start`, `tool.complete`, `session.info` and `session.usage`. Normalize them into `session`, `text.delta`, `tool.started`, `tool.finished`, `usage`, `checkpoint`, `completed`, `cancelled`, `failed` and `unknown` events, keyed by Relay task and provider admission. Do not forward arbitrary native snapshots: they can contain private system prompts, histories and ownership metadata. [Event envelope](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_events.py), [receipts and controls](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_controls.py).

Terminal receipts supply `result.final_response`, `completed`, `failed`, `interrupted`, `failure_reason`, token counts and available usage/cost fields. Normalize bounded error codes, not raw exceptions or arbitrary provider diagnostics. Never convert partial output, an acknowledgment, process exit or a cancellation request into success. Max turns and an application deadline are bounds, not a dollar spending guarantee. [Result settlement](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_results.py).

For a lost submit acknowledgment, first match `snapshot.pending[].input_id` to Relay's submission UUID. Otherwise inspect only this Relay-owned session's user rows: **`display_metadata.submission_id` matches the UUID and wire `message_id` is the admission ID**. This mapping was verified for all three real turns through `prompt.receipt`. Ignore `gateway_input_owner`. If there is no trustworthy match, retain unknown state without resubmitting. Gateway restart can mark a started admission unknown; it must not replay. A transport crash must keep the execution slot reserved until reconciliation establishes a terminal state. [Submission correlation](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_display.py), [public receipt contract](https://github.com/NousResearch/hermes-agent/blob/v0.23.0/gateway/session_contract.py).

## Observed evidence and remaining gates

Ignored local scripts/evidence under `artifacts/local/hermes-probe-*` contain sanitized aggregate results. No authentication data or personal chat history was retained. Exactly three real model turns were run:

1. Read an unpredictable synthetic file marker absent from the prompt; the completed terminal result returned it exactly.
2. A fresh native transport resumed the same logical session and returned that marker from saved conversation context with no new MCP read.
3. The owned MCP entered a deliberately delayed read; exact-admission cancellation returned terminal `interrupted`. Project hashes were unchanged across resume/cancel, and profile config bytes remained unchanged throughout the gateway probes.

The initial live probe stopped after discovering the legitimate progressive-disclosure wrappers; source review established their session scope before the remaining two turns. This is transport/reconnect evidence, **not a cold gateway restart, production MCP denial test or completed Relay integration**.

The research identified these follow-up gates. The current verification log records which the production adapter proved and which remain unqualified:

- Application-enforced project-relative reads, bounded output, symlink/traversal/sibling denial, and absence of write/shell/network tools, including through wrappers.
- Live use of the production MCP server; synthetic file mutation checks; meaningful checkpoint/result mapping without fabricated progress.
- Relay restart and cold gateway restart reconciliation, durable submission mapping, no duplicate work after lost acknowledgments, and unknown outcomes retaining their execution slots.
- Cancellation during an actual tool call, timeout cleanup, failed discovery/auth/transport behavior, and no process-wide gateway kill or unrelated session mutation.
- Browser workflow, concurrent Codex/Hermes runs, version/capability rejection, reviewed diagnostics and an explicit local-only support statement.

This initial capability is bounded project analysis. Editing, command execution, background delegation within Hermes, importing historical Hermes conversations and public sharing remain outside its qualified scope. Shared-profile eligibility checks are not an operating-system sandbox; concurrent profile customization must be detected and treated conservatively.
