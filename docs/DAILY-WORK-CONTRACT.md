# Daily work and agent assignments

Status: implementation contract, 2026-11-06. This extends the v0.4 foundation;
the full product goal also requires a separately qualified second provider.
The user authorized autonomous specification, implementation and verification.

## Objective and design

The overview answers five questions: what did I ask, what changed on the selected
day, who is working now, what needs me, and what happens next? Keep the existing
cream, rust and green visual language, readable text and goal cards. Replace the
event-volume chart and decorative overview panel with useful daily records and
agent assignments. The primary action opens the persistent master conversation.
Codex workspace remains available for discovery; the dashboard is the home view.

Current state and daily history are different: ongoing goals and active/queued/
held assignments are current across all dates. Requests, reports, observed tool
events, progress notes and reviewed outcomes use the workspace timezone and the
selected date. They are labelled accordingly. Empty days retain ongoing work.
Search filters visible work records without turning global metrics into a hidden
subset. Panels show a bounded first page with an explicit way to expand it.

## Record contract

- Only an existing goal or explicit parent-task relationship establishes project
  work. Casual chat never becomes a work card or completed goal metric.
- A successful master action on a goal records a `work_request` event with
  `taskId`, `workId` and `projectId`, once per request/goal pair. This links the
  original user message without silently treating goal titles as user quotes.
  Older project runs can supply an exact parent request; missing provenance
  stays missing. A request touching two goals appears once with both links.
- Daily progress uses timestamped run outcomes, goal progress notes, observed
  command/file events, and explicit reviewed completion. Command text/output is
  inspected in the task detail; never parse it to invent a passing test count.
  Agent reports and external notes are labelled as such. A completed run alone
  is not a verified outcome or a completed goal.
- New explicit completion reviews save immutable `work_review` events with the
  review note and completion timestamp. Reopening does not erase the receipt.
  Legacy completed goals use their existing note; older reopened reviews cannot
  be reconstructed. Full recorded text remains expandable after reopening.
- Assignments show task, recorded role, provider, parent request/run, project,
  goal, exact saved permission scope, queue/running/held state, and latest result
  or checkpoint. Unknown fields say unknown; current project permissions must
  not be substituted for historical task permissions. Task detail exposes the
  original instructions and observations; goal detail exposes next action and
  reviewed controls. No fabricated persona or live status for external chats.
- `relay_delegate` may name a valid open goal using optional `workId`. Its worker
  uses that goal's registered project directory, always read-only, with explicit
  goal/project/parent links. Without it the worker remains unassigned master
  support. Paused/closed goals require reopening; the worker gets no new tools.
- Read models derive from the existing snapshot and do not mutate it. Additive
  optional event metadata needs no database migration. No external catalog
  contents, memory or personal data are added to sample data or public source.

## Structure, style and commands

`web/daily-lib.js` owns pure projection; `web/daily-lib.test.js` covers its
semantics. `web/daily.jsx` and `web/daily.css` own the panels; `web/main.jsx`
integrates them. Runtime provenance lives in `server/runtime.mjs` with behavioral
tests in `tests/runtime-work.test.mjs`. Source distribution includes new files
through the existing explicit allowlist in `scripts/prepare-release.mjs`.

Use existing plain JS, named exports, immutable projections, React text rendering
and semantic buttons. Example: `dayKey(record.createdAt, timeZone) === date`.
No new dependencies, provider protocol or arbitrary skill execution.

- Focused: `node --test web/daily-lib.test.js tests/runtime-work.test.mjs`
- Regression: `npm test`
- Build: `npm run build`
- Browser fixture: `node scripts/preview-fixture.mjs`
- Real-provider opt-in: `node scripts/verify-daily.mjs --live` (synthetic projects,
  normal existing Codex usage, maximum eight turns, no new credentials).

## Verification and boundaries

1. Two goals in different projects, one multi-goal request, a casual question,
   yesterday's running task, today's terminal attempt and a held queue produce
   correct daily/current lists without duplicates or false completion.
2. Agent-reported success, observed tool activity, external notes and explicit
   reviewed completion remain distinguishable. Invalid dates, missing records,
   cyclic ancestry and changed project permissions do not misattribute work.
3. Runtime tests prove origin links and goal-scoped delegation, including denied
   closed goals, read-only workers, current bounds and no new authority.
4. Desktop and 390px browser checks exercise date/search, request/task/goal
   links, master navigation, empty states, expansion and literal untrusted text;
   no overflow or console errors. Sample actions remain inert.
   Daily export includes task creation, startup, terminal outcomes or observed
   activity on the selected local day, plus original request ancestry. A job
   begun on an earlier day must not disappear from its completion day's export.
5. Full tests/build and independent review pass. Release export includes all new
   source files and no local data. Existing live state is preserved on upgrade.

Always preserve source evidence and unrelated work. Ask only for materially new
authority, expense or destructive actions. Never infer tests passed from prose,
edit provider storage, execute imported skills, or mark a goal complete from a
turn finishing. No new open product question blocks this slice.
