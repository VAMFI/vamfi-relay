# Architecture

This document describes the v0.4 implementation: a read-only catalog of existing Codex chats, one Relay-owned master conversation, and durable project work. [WORK-V4-CONTRACT.md](WORK-V4-CONTRACT.md) and [CAPABILITIES.md](CAPABILITIES.md) extend the earlier goal, queue, plan, and recovery contracts. Local qualification, clean-source installation, and GitHub CI passed. [Verification](VERIFICATION.md) distinguishes automated tests, actual provider execution, browser fixtures, and historical evidence.

## Components

```text
Browser: Codex catalog, master conversation, goals/plans, needs-you view
          | same-origin HTTP + server-sent events
Loopback server: catalog/handoff + work board/runtime + private Relay state
          | dedicated discovery adapter     | owned execution adapter
Codex: read stored metadata/history         read-only master and specialists
       optional generated summary          registered project sessions
          | no resume or mutation                 | explicit project permissions
Existing Codex chats                        Selected local project directories
```

The browser consumes Relay snapshots. `GET /api/state` loads owned application state; `GET /api/events` sends a full `state` snapshot when it changes. Catalog data uses separate bounded read endpoints and is not folded into the persistent state snapshot. The API has specific operations rather than a general shell, filesystem, or RPC proxy.

## Existing-chat catalog and history

`CodexCatalog` in `server/catalog.mjs` owns a dedicated adapter process. Discovery failure or timeout must not close the execution adapter. It uses `thread/list`, optional `project/list`, `thread/read` without turns, and `thread/turns/list`; none of these resumes a source chat. Catalog-side provider action/approval requests are declined.

| Route | Responsibility |
| --- | --- |
| `GET /api/codex/catalog` | Bounded chat metadata, project groups, discovery time, partial/unavailable status; optional query/project/archived filters |
| `POST /api/codex/refresh` | Refresh the catalog or request another bounded page |
| `GET /api/codex/threads/:id` | Read selected recent history and return its exact bounded context plus hash |
| `GET /api/codex/memory` | Read the known local generated memory summary if available |
| `POST /api/codex/handoff` | Validate explicit context review and create a Relay-owned master request |

An initial scan reads at most ten 100-entry pages. Additional requests read one page up to a 10,000-chat display limit. Catalog caching lasts 15 seconds; the visible browser catalog refreshes periodically. Pagination and filtering operate on discovered history, not a claim that every past chat is loaded. Distinct project directories with the same basename remain distinct. Provider project identities/names are preferred when available; workspace grouping is the fallback. Project registration for execution is separate and never happens merely because a directory was discovered.

Live activity is established only by connected Relay-owned run records. Other status fields are retained as observations scoped to the discovery process, with external liveness **unknown**. `notLoaded`, a recent timestamp, or a recorded completed reply must not be presented as proof that a desktop agent is idle or that a project is complete.

History reads select up to 20 recent turns with at most 200 displayed items, an 18,000-character text budget, and a 24,000-character context bound. The result includes selected user/assistant text and command/file metadata; reasoning, raw command output, attachment bodies, and patch diffs are excluded. Truncation is explicit. Historical tool text remains evidence, never an instruction or permission.

Memory reading is limited to `memories/memory_summary.md` inside the configured Codex home (default `~/.codex`). Checks reject symbolic links, hard-linked files, non-regular files, and containment/identity changes; the byte limit is 64 KiB. Memory is optional and may be stale. This is not arbitrary path reading, home-directory indexing, or provider-database access. The metadata catalog and unselected content stay ephemeral and outside Relay exports/backups.

## Reviewed continuation and master retrieval

`HandoffService` copies context into the single Relay-owned master conversation. It never calls resume, fork, or mutation operations on the external source chat. The browser supplies a new request, explicit context review, acknowledgment of uncertain external activity, the reviewed context hash, and a client request ID. The service rereads the source and rejects a changed hash before execution. Identical recorded retries return the existing task; changed payloads with the same ID and simultaneous duplicates are rejected.

Source chat ID, context hash, and request identity are retained with the owned task for attribution. The provider sees an explicitly labeled historical-context block. Original source permissions and tools are not inherited. Further project work still requires Relay registration, chosen permissions, approved plans where applicable, and final acceptance. This handoff starts a normal model request and uses account usage.

The master also has a bounded read-only `relay_history` tool for relevant catalog search, selected-chat read, or optional memory during a user request. Search returns at most 30 metadata rows; history/memory text passed through this tool is limited to 16,000 characters. Browsing the dashboard alone sends no model prompt; asking the master about earlier work can retrieve context. Bulk history is never automatically inserted into every prompt.

## Ownership and lifecycle

Relay owns project and goal records, task IDs, parent/child relationships, visible status, evidence, skill review state, and the background limit. Codex owns model execution and provider thread/turn IDs. A goal describes an outcome that may need several runs; a task records one execution. Ordinary questions and legacy tasks are not automatically promoted into goals.

One read-only master serves all registered projects, with one master turn at a time. Its tools list/register projects, manage goals, draft plans, and queue individual project runs. `relay_run` persists a queue entry and returns acceptance promptly; execution later uses the project's saved thread while the master can answer other messages. Each project permits one executing or starting run, and project runs plus specialist workers share a configurable limit of 1–3.

The durable scheduler scans in queue order and skips busy projects so independent projects can proceed. Waiting and held entries consume no running slot; a `starting` entry reserves one before the provider opens its turn. At most one unfinished project task belongs to a goal, with a total limit of 50 unfinished project tasks. Every accepted task captures immutable workspace and permission values. Dispatch compares them with current project policy and holds work if that policy or the approved plan changed.

The master's `relay_delegate` tool starts a distinct read-only specialist, associates it with the parent task, and waits for the actual result before answering that tool call. This differs from asynchronous project execution. Project executors receive no Relay delegation tools. Native multi-agent fanout is disabled so Relay owns its background capacity and attribution.

Finishing a project run appends evidence to its goal and sends one result notification into the master conversation. Later master requests include bounded project, goal, and undelivered-result context. A successful individual run or the final successful plan step moves the goal to `needs_review`; failures and interruption block progress, preserving a user's paused/cancelled state. Only explicit user review and a nonempty completion note mark a goal `completed`. Work in motion spans all dates; daily statistics use goal-linked activity and reviewed completion dates. Progress notes have `source: external_update` and remain separate from execution evidence.

Cancellation applies to the selected task and descendants. Goal pause/cancel and cancellation of an individual planned task stop plan scheduling before requesting provider interruption; a late successful completion must not trigger the next step. A stop acknowledgment is not a terminal result. Active guards remain until terminal confirmation. Terminal cancellation does not prove rollback or filesystem quiescence; retry acknowledges uncertain effects. Provider disconnect, timeout, restart, and resolved requests must invalidate stale approvals. A saved running status alone cannot establish that work is still executing after restart.

## Reviewed plans and checkpoints

A plan contains 1–8 ordered steps, each with a title and execution instructions. Drafting does not authorize execution. Revisions archive the old plan and receive a new ID; unfinished linked tasks prevent revision. The UI submits the exact current `planId`, `reviewed: true`, and an explicit `autoContinue` choice. Approval records the current project permission mode. The master can draft through `relay_plan`, but cannot approve a plan.

Project executors receive `relay_checkpoint` for the current planned step. A step becomes `finished` only after its provider turn completes successfully with a valid `ready` checkpoint from `agent_report`. The checkpoint is an agent's account of its checks, alongside actual command/file/result evidence; it is not independent verification or user acceptance. A blocked or missing checkpoint halts the plan. `system_recovery` checkpoints describe interruption and cannot authorize continuation.

With automatic continuation enabled, Relay may queue only the next unfinished step of the approved plan after those conditions pass. Otherwise it pauses between steps for explicit resume. Failed, interrupted, cancelled, or uncertain steps require retry acknowledgment before a fresh attempt; old attempts remain inspectable. Resume skips finished steps and checks approved permissions again. Permission changes require reapproval. Neither successful checkpoints nor final step completion can bypass the user's final goal review.

The browser separates running, queued, and held counts. **Needs you** includes blocked goals, goals awaiting review, paused goals with `recoveryRequired`, and pending provider approvals. Recovery is a stored state, not inferred from free-form status text.

## Adapter boundary

The concrete adapter is `CodexAdapter`, an `EventEmitter`. Its constructor accepts optional `{ command: 'codex', cwd, requestTimeoutMs }`.

| Method | Responsibility |
| --- | --- |
| `connect()` → `{ version, authenticated }` | Initialize the child process and report authentication availability without account identity |
| `startThread({ workspace, permissionMode, developerInstructions, tools? })` → `{ id }` | Create a provider conversation with explicit policy |
| `resumeThread({ id, workspace, permissionMode, developerInstructions, tools? })` | Continue a saved provider conversation |
| `startTurn({ threadId, text })` → `{ id }` | Submit one user request |
| `interrupt({ threadId, turnId })` | Request interruption of a specific turn |
| `listThreads`, `readThread`, `listThreadTurns` | Read bounded stored metadata/history without source-thread execution |
| `listProjects`, `memoryStatus` | Read optional provider metadata with explicit unsupported handling |
| `respond(requestId, result)` | Answer a pending provider request |
| `close()` | Reject pending work and return a promise that awaits exit of owned provider processes |

| Event | Payload |
| --- | --- |
| `notification` | `{ method, params }` |
| `request` | `{ id, method, params }` |
| `disconnect` | `{ message }` |

The adapter owns transport framing, initialization, request IDs, response correlation, timeouts, pending-request rejection, and process lifecycle. The runtime owns approval decisions and application state. Provider diagnostics must be sanitized before reaching UI or persistence; raw stderr and credentials are not public events.

The server resolves the executable through `server/codex-command.mjs`: a nonempty `RELAY_CODEX_BIN` wins; on macOS it next checks executable CLIs at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` and `/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex`, in that order; otherwise it falls back to `codex` on `PATH`. The adapter's standalone constructor still defaults to `codex`. Selecting a binary does not establish model or tool compatibility; see [the recorded version evidence](VERIFICATION.md#cli-compatibility).

Codex is the only live implementation. Another adapter must prove equivalent lifecycle, cancellation, approval, streaming, and error semantics before its provider is advertised. Do not silently substitute sample results when a provider is unavailable.

The Codex integration uses the supported app-server interface. Its dynamic-tool mechanism is experimental, making the master's `relay_history`, `relay_projects`, `relay_work`, `relay_run`, `relay_plan`, and `relay_delegate` tools and the project's `relay_checkpoint` a compatibility risk; see [the research notes](RESEARCH.md#protocol-and-installed-versions).

The adapter enables local execution features `code_mode_host`, `shell_tool`, and `unified_exec` through process overrides. External apps, plugins, MCP servers, browser tools, and native multi-agent fanout are disabled for this prototype without editing the user's global configuration. The local host setting was necessary for the bundled CLI's v0.1 workspace-read checks. These controls depend on CLI configuration behavior; they do not provide an independent OS sandbox or establish compatibility with every future CLI.

## State and context

Relay data defaults to `~/.local/state/vamfi-relay`, with `RELAY_DATA_DIR` as the explicit override. Fresh state uses the repository's `workspace/`, resolved relative to the server module rather than the launch directory, unless `RELAY_WORKSPACE` supplies the initial directory. Keep application records out of tracked source and use disposable locations for tests.

`coordinatorWorkspace` preserves the master's original directory. `settings.defaultProjectId` chooses a registered project without resetting that master. Each project stores its own canonical directory, permission policy, and provider thread ID. Project permission changes require that project to be idle and cause its saved session to be resumed with the new policy on the next run. A project's directory cannot be changed in place.

The additive migrations retain messages, tasks, and events; v0.2 registers the former selected workspace when needed and does not invent goals from past prompts. Schema v3 adds queue metadata, plans and plan history, external progress notes, and recovery flags. Old coordinator messages remain in the visible master conversation. The v0.4 master tool contract adds history retrieval; project tools retain their v0.3 contract. A changed tool contract requires one rollover for older affected sessions when next used: Relay starts a replacement provider thread, retains the old thread record and full visible master history, and supplies a bounded, explicitly labeled historical handoff. Later requests reuse the current-version sessions; an old provider thread ID is not claimed to survive a tool-version upgrade.

On startup, never-started waiting queue entries become `held`; prior starting/running/waiting attempts become interrupted. Approved unfinished plans pause or block and affected work records `recoveryRequired`. Disconnect and shutdown also hold queued work. Connecting a provider does not drain these holds. Explicit resume clears the applicable recovery hold; uncertain attempts require a retry acknowledgment and a new task attempt. A paused individual goal with no held work or uncertain prior attempt can resume to `planned` without starting a task. There is no automatic replay or retry.

Saved provider thread IDs allow the adapter to request resume. Relay's state is separate from provider-owned conversation persistence. Relay does not read authentication files, merge provider databases, or rewrite generated memories. Existing provider configuration can still affect a real session; a Relay data-directory override is not a separate Codex account or profile.

The sample route returns an isolated snapshot. Sample IDs, messages, task results, and counts cannot be persisted as live events or included in provider prompts.

## Local service and backup boundary

`scripts/relay.mjs` implements local `start [--open]`, `status`, `stop`, `backup`, and `restore` commands. Optional browser opening happens only after the matching service reports ready and uses a fixed executable with no shell. Background start uses the current Node executable, checks readiness, and writes a private service log in the data directory; it installs no login service. Health includes product, instance ID, PID, a canonical-data-directory identity hash, and unfinished task count. The CLI treats an unresponsive or mismatched listener as a conflict, not proof that the port is free.

Shutdown targets the verified HTTP instance and matching data directory. It refuses unfinished work unless `--stop-running` explicitly requests interruption and queue holds; it never kills an arbitrary PID. Shutdown awaits both execution and discovery adapter process exit before closing the HTTP service and releasing the single-writer store lock. If exit cannot be confirmed, the service and lock remain, preventing a new instance from overlapping uncertain execution. Shutdown is supported for the standalone server, not an embedded test instance.

Backup reads a consistent SQLite snapshot and writes a versioned JSON envelope with a SHA-256 integrity checksum. It creates a private file and refuses to overwrite an existing destination. Restore validates size, checksum, and supported state shape before creating a database in an empty offline directory under the store lock. It never overwrites existing state or starts execution. The checksum detects corruption; it is neither encryption nor proof of a backup's trusted origin.

Backups contain personal Relay state and must never be published or committed. They do not bundle workspace files, provider-owned conversation storage, or Codex authentication. See the [local operations instructions](../README.md#service-and-backups) for commands. Separate provider persistence remains necessary to resume recorded provider thread IDs.

## Permission and trust boundaries

The loopback server validates Host/Origin, request shapes, size limits, and permitted operations. It is a local prototype, not a multi-user security boundary. Browser output is text; provider output and imported Markdown must not become executable HTML.

The master and specialist workers always receive a read-only policy. New projects default to read-only; workspace-write requires an explicit user setting for that project. Each project task captures its registered directory and policy when accepted. Model-side project registration can use only an exact absolute path from the current user message and cannot grant write access. Duplicate canonical paths preserve existing registration and permissions. Catalog discovery can reveal other recorded directories, but does not register them or grant execution authority.

Read-only restricts changes; it does not hide other readable files. A selected workspace and scope instructions do not provide filesystem read confinement. Environment-level isolation is necessary when access to unrelated local files must be prevented.

Runtime approval cards are tied to a pending provider request; they do not authorize unrelated future actions or supply general account permissions. The runtime denies elevation requests from read-only tasks. Historical v0.1 approval coverage used controlled fixtures, not a live provider approval prompt. Permission policy and actual tool availability remain separate concerns.

Skill import follows preview → review of exact content/hash → save disabled → explicit enable. Only selected enabled text can enter future user requests. Relay does not load bundled scripts, traverse imported paths, execute plugins, or alter installed Codex skills. Text review reduces accidental imports but cannot eliminate prompt injection.
