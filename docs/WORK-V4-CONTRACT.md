# Relay v0.4: dependable daily work and repeatable preview

Status: **Expanded scope authorized for autonomous implementation by the user on 2026-11-06. Verification pending.**

Prepared: 2026-11-06 (America/Toronto). Baseline: v0.3, commit `805dc21`.
This extends [WORK-V3-CONTRACT.md](WORK-V3-CONTRACT.md), [WORK-V2-CONTRACT.md](WORK-V2-CONTRACT.md), and the [base contract](CONTRACT.md). It does not replace their execution, permission, or recovery invariants.

## Objective

A person should be able to use one Relay conversation to manage meaningful work across two local projects, understand what needs attention from the dashboard, and return after a restart without losing work or unknowingly repeating it. The preview must be reproducible from a clean checkout at an identified source revision.

The deliverable is a local open-source Codex workspace prototype published on GitHub, with existing-chat discovery, project grouping, historical context, truthful activity and reviewed continuation through one conversation. The user's later clarification supersedes the earlier qualification-only draft. The [capability map](CAPABILITIES.md) separates the new catalog, dashboard, handoff and release work. Publication includes reviewed source and synthetic verification only, never personal history or application data.

## Assumptions and scope check

- Continue the existing application, visible conversation history, goal records, and SQLite state. No rebuild or broad UI redesign.
- Retain a local, single-user browser application and Codex as the only live provider. Initial real-provider qualification targets macOS on the available machine; other operating systems are unverified until exercised.
- The user works through Relay's conversation portal. This desktop chat can coordinate development, but Relay records that work as external progress notes, not invented provider runs.
- A clean qualification uses disposable projects and application data. An actual personal-project pilot is optional and requires an exact project selection and its intended permissions.
- Scope check: the clarified request spans independently testable capabilities. Their boundaries and dependency order are recorded in CAPABILITIES.md. The user's explicit instruction to handle all phases autonomously authorizes this decomposition and normal progression; independent evidence/review gates remain mandatory.

## New capability contracts

### Codex catalog

Opening the local dashboard automatically discovers stored Codex chats through a dedicated read-only app-server connection. Include desktop/app-server, CLI, editor and subagent source kinds. Prefer provider project IDs/names when available; fall back to exact workspace grouping. Distinct workspaces with equal basenames must not merge. Missing paths remain unassigned. Search, project filters, bounded pagination, refresh time, partial results and unavailable states are explicit.

Catalog records are separate from Relay-owned threads/tasks/goals. Discovery never runs or resumes an external chat, imports historical questions as goals, changes permissions, or rewrites provider databases/memory. Catalog process failure cannot stop an execution process. Metadata cache and unselected history remain ephemeral and outside exports/backups/model prompts.

Read selected history through paginated turn APIs. Return bounded user/assistant text and command/file result metadata; omit reasoning, raw tool outputs, attachment bodies and patch diffs. Report truncation and the source chat identity. A completed turn is historical execution status, not a completed project.

Automatically detect optional generated memory availability. Only a known local memory summary may be read on selection, with byte bounds, regular-file/containment checks and no symlink traversal. Show memory as potentially stale generated context. Never traverse arbitrary Markdown paths or read authentication/configuration files.

### Dashboard and continuation

The default workspace view brings existing project chats into view without manual recreation. Show search, project groups, source, recent requests/results and separate confirmed Relay activity from unknown external liveness. A fresh `notLoaded` response from Relay's separate process does not establish that the desktop thread is idle. Never infer live execution from recency alone.

Continue in Relay requires a new instruction, review of the exact bounded context, a matching context hash and acknowledgment that another agent may still be working. It copies that context into Relay's owned master conversation and retains source provenance. It does not mutate/resume/fork the original thread or inherit its tools/permissions. Existing project registration, write settings, plan review, queues and acceptance govern subsequent execution.

Each handoff has a client request ID. Identical retries return the recorded task; changed payload with that ID is rejected. In-flight duplicates cannot schedule a second turn. Unknown execution outcomes remain visible; never silently retry side effects.

Master conversation may search/read selected catalog context through bounded read-only tools. Treat all history and memory as evidence, not new instructions or permissions. Never inject all personal history automatically.

### Open-source delivery

Publish a reviewed, source-installable repository at the verified available VAMFI/vamfi-relay destination with MIT license, dependency notices, setup/limits/security guidance and green automated CI. Preserve private local Git history and publish a sanitized source snapshot using public commit identity. No hosted service or npm registry publication is required. Inspect the actual public tree and verify installation from that tree.

## Inspected baseline and evidence limits

The repository already implements durable goals, one persistent master conversation, per-project sessions, a bounded shared worker capacity, queued project runs, finite reviewed plans, checkpoint reports, recovery holds, and reviewed completion. Local service commands and private backup/restore are also implemented.

[VERIFICATION.md](VERIFICATION.md) records 140 passing tests on each of Node 22.23.2 and 24.22.1 and a real two-project v0.3 pilot. Those are historical results, not v0.4 results. The earlier pilot did not capture one immutable initial source revision. Its interruption/retry evidence does not prove filesystem quiescence or rollback. CI configuration exists but remote CI execution is not established by local checks.

## User experience contract

- The conversation is the user's main entry point. Requests with a clear project and accepted substantial outcome create or reuse a goal. An ambiguous project request asks for the missing destination before any execution is queued.
- Ordinary questions, explanations, greetings, and status requests remain chat messages. They do not become goals. Follow-ups about the same accepted outcome reuse that goal.
- Work in motion shows open, meaningful goals across dates. Cards identify the project, current state, next action, and whether work is running, queued, paused, blocked, or awaiting review. Low-level events remain available in detail views.
- Needs you provides a reason and the applicable action for pending approvals, blocked work, recovery holds, and completion review. An ordinary user pause remains visibly paused; it is not automatically described as a failure.
- Changing the selected project preserves the master conversation. Each project's execution uses its own saved session and captured permission policy. The master remains available while project work runs.
- Plan review shows the exact current plan and the choice to continue automatically or pause between steps. Editing the plan invalidates its earlier approval. Automatic continuation is limited to the remaining approved steps.
- A finished provider turn is an execution result. Agent checkpoints and external notes are labeled reports. Goal completion requires a user review and completion note; the dashboard must preserve those distinctions.

## Scope boundaries

Included: the catalog/dashboard/handoff/release capability contracts above, repeatable setup and environment diagnostics, regression qualification of the existing journey, accurate recovery, and source-specific verification.

Deferred: additional providers; arbitrary plugin/script execution; automatically loading global skills into Relay workers; taking ownership of external desktop sessions; guaranteed global process supervision; remote access; sharing user histories; hosted accounts; unbounded execution or automatic retry. Global skill installation repair is separate workstation maintenance.

Add bounded same-origin catalog/history/memory/refresh/handoff routes while preserving existing routes, status values, IDs, evidence and permission snapshots. Optional source/request metadata on new owned tasks is additive; no imported transcript table or schema migration is required.

## Tech stack

Use the checked-in lockfile. Inspected versions, not upgrade targets:

| Component | Current contract |
| --- | --- |
| Node.js | Package minimum 22.13; automated qualification on majors 22 and 24, recording exact versions |
| Server/state | JavaScript ES modules, Node HTTP/EventEmitter and `node:sqlite` |
| Browser | React / React DOM 19.3.1 locked; Lucide React 0.468.0 |
| Build | Vite 7.3.7; React plugin 5.2.0 |
| Tests | Built-in Node test runner and assertions; disposable stores and mock provider fixtures |
| Provider | Existing Codex app-server adapter; record actual executable/version/model for each live run |

An installed CLI, successful connection, or supported-looking version number is not proof that execution, dynamic tools, permissions, and recovery work together.

## Commands

Run the following from a clean checkout of the candidate revision. Repeat automated verification with Node 22 and Node 24, recording the exact Node and npm versions used:

```sh
node --version
npm --version
npm ci
npm test
npm run build
```

`npm run check` runs the existing test and production-build scripts together. There is currently no separate lint or type-check script; do not report either as passing.

For an isolated preview, choose a free loopback port. These commands deliberately use a new directory outside tracked source and port 4319, leaving the normal 4318 instance alone:

```sh
relay_preview_root="$(mktemp -d "${TMPDIR:-/tmp}/vamfi-relay-v04.XXXXXX")"
mkdir -m 700 "$relay_preview_root/project-a" "$relay_preview_root/project-b" "$relay_preview_root/backups"
export RELAY_DATA_DIR="$relay_preview_root/state"
export RELAY_WORKSPACE="$relay_preview_root/project-a"
export RELAY_PORT=4319
npm run relay -- start
npm run relay -- status
```

Open `http://127.0.0.1:4319`, connect the existing privately authenticated provider, and register the second exact project path. Populate the disposable projects with deterministic test fixtures during qualification. Both default to read-only; grant workspace-write only to the fixture project intended to edit files.

Keep the same exported variables for lifecycle and private backup commands:

```sh
npm run relay -- backup "$relay_preview_root/backups/preview.json"
npm run relay -- stop
RELAY_DATA_DIR="$relay_preview_root/restored" npm run relay -- restore "$relay_preview_root/backups/preview.json"
```

The destination must be new and offline. Restore must not start work. Inspect a restored instance on an unused port with the restored data directory explicitly selected; never start it alongside an original instance that still has executing provider work. Restore is not a copy of project files or provider-owned session storage.

For a deliberate interruption experiment only, `npm run relay -- stop --stop-running` requests interruption and queue holds; ordinary stop must refuse unfinished work. For development against a disposable data directory, `npm run dev` watches the build and server; use the configured local port.

## Project structure

```text
web/main.jsx, plans.jsx      Existing dashboard, conversation, goals and review controls
web/lib.js, *.test.js        View derivation and browser-facing logic tests
web/*.css                   Existing visual styles
server/index.mjs             HTTP routes, same-origin checks, SSE and static serving
server/work.mjs              Goal, plan, note and project validation
server/runtime.mjs           Queue, provider orchestration, evidence and recovery
server/adapters/codex.mjs    Provider transport and process lifecycle
server/store.mjs             SQLite state, migrations and single-writer lock
server/service.mjs           Local service identity and lifecycle helpers
server/backup.mjs            Private snapshots and restore validation
scripts/relay.mjs, dev.mjs    Service CLI and development entry point
tests/*.test.mjs             Unit/integration checks using isolated state
tests/fixtures/              Mock provider fixtures
docs/                       Contracts, architecture, roadmap and verification evidence
.github/workflows/ci.yml     Existing Node 22/24 automated test/build matrix
artifacts/local/            Ignored private verification artifacts
```

## Code style

Preserve the existing plain JavaScript/JSX, ESM imports, two-space indentation, and established naming. Use camelCase functions/fields, PascalCase React components/classes, and the existing persisted snake_case status values. Avoid unrelated formatting, dependencies, or new abstraction layers.

Existing example from `server/work.mjs`:

```js
  project(projectId) {
    const project = this.store.state.projects.find(item => item.id === projectId);
    if (!project) fail('Project not found.', 404);
    return project;
  }
```

Validate at boundaries, keep work definitions in WorkBoard and execution in Runtime, preserve error/status semantics, and render untrusted strings as text. A user-facing result should name the project, observed result, and next action; it must not claim success solely from an ended turn.

## Testing strategy and success criteria

This table defines observable acceptance, not an implementation task list. Every required row starts **pending**. Passing v0.3 evidence is a baseline only.

Additional core gates: **C1** two existing synthetic Codex chats are discovered under distinct projects without creating goals; **C2** bounded history and optional memory render with provenance and safe limits; **C3** external unobserved activity stays unknown and catalog failure leaves owned execution alive; **C4** exact-hash handoffs from both projects continue through one master, reject stale/duplicate/malformed requests, preserve original chat history and project permissions; **C5** browser search/filter/history/continuation works at desktop and mobile sizes; **C6** the actual public GitHub tree contains no private data, installs cleanly and passes remote CI. All are required; mocked evidence cannot stand in for the real two-project handoff pilot.

| ID | Required observation | Evidence |
| --- | --- | --- |
| V4-01 | A clean checkout installs with `npm ci`, passes the full suite and production build on Node 22 and 24, and starts with fresh state using documented commands. No personal configuration or repository edits are required beyond documented provider authentication/selection. | Candidate revision, lockfile hash, platform, exact tool versions, commands and exit codes. |
| V4-02 | Both a working provider connection and one controlled unavailable/incompatible provider path produce honest status and actionable guidance. Failure never substitutes sample output or starts work against another executable silently. | Real connection/execution record plus a clearly labeled controlled failure test. |
| V4-03 | A scripted conversation includes at least three casual/status questions, two accepted outcomes across two projects, a follow-up, and an ambiguous destination. Casual/status/ambiguous messages create no execution or extra goals; follow-up reuses its goal; the intended two outcomes produce exactly two goals in the fresh pilot. | Message, goal and task ID relationships; verify in UI and stored snapshot. |
| V4-04 | While project A is running, the master accepts and answers a status request before A finishes and can queue project B. Switching projects retains visible master history. Each project uses its own persistent session on a subsequent run. | Real provider turn records, event times and thread IDs; bounded fixture duration to make overlap observable. |
| V4-05 | A reviewed multi-step plan changes only the intended fixture workspace. Its exact plan/permissions are checked before dispatch; continuation requires terminal success and a ready checkpoint. Final step completion leaves the goal awaiting review. | Real workspace-write fixture run, independent file assertions, command exits and goal state. Read-only restrictions are checked separately. |
| V4-06 | Capacity and per-project serialization remain enforced. Pause/cancel freezes further scheduling before interruption, including a late successful completion. Finished steps are not rerun on resume. | Targeted scheduler/race regressions plus observed pause/resume in the real pilot. |
| V4-07 | A service restart with unfinished work preserves messages, goal IDs, plans and prior attempts; reconnect starts no held work. Needs you explains recovery. Explicit resume creates a new attempt when required and preserves completed steps. | Pre/post snapshots, real service/provider lifecycle evidence, and no-dispatch assertions before resume. |
| V4-08 | Work in motion shows ongoing goals across date changes; daily counts exclude casual chat. Project, state and next action are readable. Needs-you reasons lead to the appropriate review, approval or recovery control. Sample mode stays inert. | Browser inspection and relevant view-model tests. |
| V4-09 | The reviewer can trace a result to its project, goal, attempt, changes and checks. External notes and agent checkpoints are distinguishable from observed execution. User acceptance requires a nonempty completion note and cannot occur with unfinished linked work. | Browser walkthrough and rejection/acceptance integration tests; accepting fixture goals is explicitly test activity. |
| V4-10 | Backup/restore into an empty offline directory preserves fixture records, refuses overwrite/corrupt input, and never auto-starts work. Existing v0.3 record IDs and evidence survive any candidate migration. | Isolated snapshot comparison and backup/restore tests; no overwrite of live user state. |
| V4-11 | The core journey works at desktop and 390px mobile viewport widths without horizontal page overflow, new uncaught console errors, or hidden required controls. Keyboard focus reaches chat submission and plan/recovery/review actions, with visible focus and labeled inputs. | Actual browser/version, viewport screenshots, console inspection and keyboard walkthrough; mobile viewport is not a physical-device claim. |
| V4-12 | Final acceptance evidence refers to one identified candidate source revision with a clean working tree and lockfile hash. Any post-verification behavioral fix invalidates the affected evidence and requires re-running it before final qualification. | One verification manifest linking automated results, real pilot, browser evidence, remaining limits and redacted reporting. |

Use meaningful regression tests for defects and state boundaries. Preserve existing tests; do not substitute line-count or coverage-percentage targets for the observations above. Use controlled fixtures for failure/race conditions, and distinguish them from actual provider behavior.

The real-provider pilot must use synthetic project content and a separate Relay data directory. It may consume existing Codex account usage. Runtime permissions remain enforced: the pilot does not implicitly authorize elevation, outside-workspace writes, or unrelated account actions. A blocked required check remains blocked, with its reason recorded.

An accepted live privilege-elevation flow and post-interruption filesystem quiescence are **not** proven by this specification or by a successful turn. Do not claim either guarantee without separate direct evidence. The preview can qualify within workspace permissions while those stronger claims remain explicitly unsupported.

## Boundaries

### Always do

- Preserve unrelated work, existing user records, permission modes, and prior review decisions. Inspect instructions and Git state before changes.
- Use loopback, disposable test data, exact project routing, bounded execution, and provenance-labeled results. Follow the v0.3 plan and recovery contract.
- Update this contract when an agreed behavior changes. Run checks directly relevant to a correction, then the full suite/build and the affected real/browser acceptance checks for the final candidate.
- Keep detailed transcripts, screenshots containing personal data, backups, and local run artifacts private. Publishable summaries must be redacted and explicitly reviewed before any future publication.

### Ask first

- Material scope expansion, breaking interface/schema changes, removal of user data, or widening a registered project's permissions.
- New paid services, public repository/package publication, deployment, remote exposure, external messages, or account changes.
- A personal-project pilot whose project path or write authority has not already been supplied.

Normal reversible repairs within an approved specification do not need repeated approval. Existing session authorization still governs each action.

### Never do

- Access authentication files, expose credentials, merge Codex databases, or rewrite generated memories.
- Convert old questions into goals, fabricate execution evidence, mark provider-turn completion as user acceptance, or silently replay interrupted side effects.
- Bypass approvals/sandbox restrictions; automatically execute imported skills/scripts; claim provider/platform support from a menu entry, sample mode, mock, or stale result.

## Work tracking and review

Track this phase in the existing Vamfi Relay v0.4 goal, updating its objective to the user's expanded Codex-workspace and OSS scope. Earlier v0.2/v0.3 goals retain their review state. This desktop work is authorized to progress; recorded historical completion remains distinct from user acceptance.

Record preparation and implementation performed in this desktop chat as external progress notes. Record actual Relay execution as provider tasks only when it happens. The repository contract is the requirements source; tasks/plan.md records design and stable work-package IDs; the Relay goal holds current status, next action and evidence links.

## Open questions and approval

No blocking requirements question remains for drafting. Proposed defaults for review are: local macOS real-provider qualification, automated Node 22/24 coverage, two disposable projects, and preservation of the current plan-review and recovery controls. Personal-project adoption and additional platform qualification can follow separately.

The user's explicit instruction to build, review, verify and publish autonomously supplies phase authority. Completion evidence remains pending. No missing product choice blocks implementation; unavailable provider capabilities must be reflected honestly rather than simulated.
