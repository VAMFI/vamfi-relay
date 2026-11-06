# Relay v0.3: daily work with durable execution

This phase builds on v0.2. It adds a durable waiting queue, finite reviewed plans, explicit recovery, local service commands, and provenance-labeled progress notes. Codex remains the only provider. No public deployment, cloud sharing, arbitrary plugins, or unbounded autonomous loop.

## Completion evidence

- Preserve v0.2 in a local Git commit; preserve all existing Relay state.
- Queue work across two projects without concurrent turns against the same project thread; honor the shared 1–3 worker cap. Keep the master responsive.
- Run an exact user-reviewed plan of 1–8 steps. Continue only after a real terminal provider result plus an explicit agent-reported checkpoint. Final goal completion still requires user review.
- Pause/cancel stops scheduling before requesting interruption. A stop acknowledgment is not terminal evidence. Resume never reruns finished steps. Failed/interrupted attempts remain recorded and require explicit retry acknowledgment.
- Restart holds never-started queued work and marks running attempts interrupted; no automatic side-effect replay. Explicit resume safely continues remaining work.
- Verify a ten-request two-project real-provider pilot, ordinary-chat exclusion, follow-up goal reuse, cancellation/recovery, browser UI and lifecycle commands. Separate fixture evidence from actual provider results.

## State (additive schema v3)

- `meta.version = '0.3.0'`, `schemaVersion = 3`.
- Existing `tasks.status` remains queued/running/waiting/completed/failed/cancelled/interrupted. Project tasks gain `queueState: 'waiting'|'starting'|'held'|null`, `queueReason`, optional `planId`, `stepId`, and `checkpoint`.
- Queued waiting/held tasks do not consume running capacity. Queued starting tasks reserve capacity. There can be many queued goals for a project, but at most one unfinished project task per goal and one executing/starting task per project. Queue limit: 50 unfinished project tasks.
- Work gains `notes: [{id,text,source:'external_update',createdAt}]`, `plan:null|Plan`, `planHistory:[]`, and `recoveryRequired:boolean`.
- Plan: `{id,status:'draft'|'running'|'paused'|'blocked'|'needs_review',steps,createdAt,updatedAt,approvedAt:null|string,approvedPermissionMode:null|string,autoContinue:boolean}`.
- Step: `{id,title,instructions,status:'pending'|'queued'|'running'|'finished'|'blocked'|'interrupted'|'cancelled',taskId:null|string,attemptIds:[],checkpoint:null|object}`. Title <=120, instructions <=6000, 1–8 steps.
- A task checkpoint is `{state:'ready'|'blocked',summary,createdAt,source:'agent_report'}`. It is an agent report alongside actual execution evidence, not independent proof. Restart-derived step checkpoints use `source:system_recovery` and cannot authorize continuation. A successful provider turn with no valid ready checkpoint cannot advance an approved plan.
- Changing a plan creates a new draft ID and archives the old plan. No changes while linked tasks remain unfinished. Completed execution records are never rewritten.
- Startup preserves waiting queue entries as `held` with a recovery reason. Prior starting/running/waiting work is interrupted. Approved unfinished plans become paused/blocked. No queue drains simply because Codex reconnects after restart until the work is explicitly resumed.

## Domain ownership / API

WorkBoard adds synchronous `setPlan(workId,{steps},{actor='user'}={})`, `approvePlan(workId,{planId,reviewed,autoContinue})`, and `addNote(workId,{text})`. Drafting does not grant execution authority. `approvePlan` requires reviewed=true, matching current planId, boolean autoContinue, no unfinished linked execution, and records current project permissions. Runtime owns scheduling and step results. Notes are explicitly reported updates, not fabricated provider tasks/evidence.

- `POST /api/work/:id/plan` `{steps:[{title,instructions}]}` creates a draft and returns the work item.
- `POST /api/work/:id/plan/start` `{planId,reviewed:true,autoContinue:boolean,retryInterrupted?:boolean}` approves the exact draft and queues its first unfinished step. Reapproving a failed/interrupted/cancelled step requires retry acknowledgment too.
- `POST /api/work/:id/resume` `{retryInterrupted?:boolean}` resumes held work or a paused/blocked approved plan. Retrying an uncertain/failed step requires retryInterrupted=true and creates a fresh task attempt. Finished steps are skipped. Permission mismatch requires a fresh plan approval.
- Existing `POST /api/work/:id/run` now queues instead of rejecting project/capacity contention; duplicate unfinished work for the same goal still returns409. Returns202 `{taskId,workId,queued:true}`. Completed/cancelled goals must be reopened explicitly.
- Existing pause/cancel updates act before draining the queue. Cancel queued entries; hold queued entries on pause. Active attempts request interruption and keep active guards until terminal confirmation.
- `POST /api/work/:id/notes` `{text}` adds a bounded (4000) external progress update without changing execution evidence.
- `GET /api/health` adds `{product:'vamfi-relay',instanceId,pid,dataKey,activeTasks}` for local service identification. `POST /api/service/stop` `{instanceId,stopRunning?:boolean}` verifies the instance, refuses active work unless explicitly requested, then gracefully closes after returning. Only standalone-server mode supports shutdown. Root integrates `server/service.mjs` helpers supplied by service lane.

## Provider tools and lifecycle

- Keep ordinary questions in chat. Reuse matching ongoing goals for follow-ups; avoid duplicate identical open goal definitions.
- Master tool `relay_plan` supports get/draft (never approve). Plans are reviewed once in UI before bounded automatic continuation. Master tools rotate once to version3, with visible history and bounded handoff retained.
- Project tool `relay_checkpoint` reports ready/blocked for the current planned step. Project sessions with older tool definitions rotate once to version3 with a bounded historical handoff; later turns/restarts reuse the new session. Retain old thread records and make rollover visible.
- Preserve actual command/file events, errors, result delivery and per-task immutable permission snapshots. Queue dispatch compares saved permissions with current project policy and never widens them. Plan continuation checks the approved permission mode.
- Scheduler scans FIFO, skips busy projects, and dispatches independent eligible projects. No automatic retry. A blocked/missing checkpoint halts the plan. Closing/disconnecting never drains queues.

## UI

Goal cards show running and queued counts separately. Goal detail shows ordered plan steps, checkpoint summaries, draft review/approve-and-start controls, auto-continue choice, pause/resume/cancel, retry acknowledgment when uncertain, and progress notes clearly separate from execution evidence. Show a concise Needs-you view for blocked/review/paused-after-recovery goals and approvals. Keep low-level logs in Activity. Sample mode is inert and illustrative.

## Local operations

Provide `npm run relay -- start|status|stop|backup|restore` with documented environment overrides; do not install a login service. Start is idempotent for the matching service and detects a conflicting port. Stop targets the verified HTTP instance, never an arbitrary PID. Backups are private local envelopes with integrity hashes. Restore only into an empty offline data directory; never overwrite existing state. Use disposable stores for tests. Root/store lane supplies a single-writer lock to avoid concurrent live stores using one database.

## Work tracking for this phase

Track this phase under the local Vamfi Relay project and its durable goal. Keep private record identifiers in local application state. The coordinating Codex chat manages implementation; record actual milestones as external progress notes once that endpoint exists. Do not invent Relay provider runs for work performed by these agents. At delivery, leave the goal needs_review with verification links and remaining limits.
