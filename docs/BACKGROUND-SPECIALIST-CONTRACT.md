# Background specialists and durable results

Status: accepted implementation contract, 2026-11-06. This is the next slice
of the user's authorized local, one-conversation product goal. It preserves
the existing synchronous specialist interface and Codex qualification.

## Outcome

A user can continue the master conversation while an accepted specialist works
on a project. That specialist's actual outcome appears in the same conversation
even when the original master response has ended or failed. A response finishing
is not a completed goal, and a queued acknowledgment is not a result.

## Interface and lifecycle

- Add `relay_delegate_background` with the existing `title`, `instructions` and
  optional `workId` fields. Return `{accepted:true, taskId, status:'queued'}`
  immediately after durable admission, before provider startup. Preserve the
  existing `relay_delegate` request and observed-result response. Share worker
  validation and launch logic rather than creating a second scheduler.
- Persist `deliveryMode:'background'`, original request, exact goal/project,
  saved read-only workspace/permission, creation time and a three-minute
  deadline before any provider await. Use the existing shared worker capacity
  and three-assignments-per-request limit. Reject excess capacity explicitly.
- Deduplicate replay of one provider tool call by `(parentTaskId, callId)` and
  a canonical input hash. Same key/different payload is a conflict. A distinct
  new model call is a distinct intent; do not claim semantic deduplication.
- Natural parent completion or failure does not cancel an accepted background
  assignment. Explicit Stop on an active parent still cascades, as do task and
  goal pause/cancel. Recheck cancellation, goal eligibility and canonical
  workspace before and after asynchronous startup. Startup cannot escape a
  pause or shutdown. Synchronous workers retain their existing parent rules.
- A deadline requests interruption. Until a provider terminal event or confirmed
  disconnect, keep the task and capacity visibly uncertain; interruption ACK or
  a failed stop request is not proof that work stopped. Never retry automatically.

## Durable delivery

- Terminal background outcomes create one local master-channel message with a
  deterministic `worker-result:<taskId>` identifier, exact task/goal/project
  links, worker source, status and bounded actual result/error. Persist status,
  result and notification atomically. This adds no model turn.
- After Store restart recovery converts unfinished work to interrupted, reconcile
  missing terminal notifications using the same rule. Repeated restart or late
  provider events must not duplicate a message or change a terminal result.
- Include bounded undelivered worker results in later master context alongside
  project results. Acknowledge only IDs included in a successful master turn;
  failure leaves them pending. Notification persistence and model-context
  acknowledgment are separate. This promises one durable local notification,
  not exactly-once model processing.
- Existing state/SSE and task details expose the result. Label it Specialist
  update and link to its original assignment; keep the daily dashboard's exact
  attribution and report/review distinction. No new result polling API is needed.

## Completion witnesses

1. A deliberately delayed provider startup returns accepted promptly; a second
   master request completes while the worker is still running.
2. Natural parent completion/failure before and after startup preserves the
   assignment. Explicit stop/pause/cancel prevents late startup. Worker scope,
   admission replay, payload mismatch, bounds and capacity are tested.
3. Repeated finish/reconnect/restart yields one visible result. Failed master
   requests retain undelivered context. Restart creates an interrupted receipt
   without a new provider thread/turn. Timeout ACK alone does not release a slot.
4. A real Codex specialist reads an unpredictable project witness while the
   master remains responsive; its result appears without another model prompt.
   Then verify a later master can use the recorded result and restart adds no
   duplicate assignment or notification. Preserve source hashes and raw evidence
   privately; use only synthetic project data.
5. Browser task/goal drill-down and master result labels work on desktop/mobile.
   Existing synchronous behavior and all regressions/build pass, followed by
   independent review, allowlisted source export and post-merge CI.

This does not add write permissions, arbitrary new tools, automatic retries,
external chat control, unlimited specialist runs or another provider. Second-
provider research proceeds separately and must qualify its declared capabilities.
