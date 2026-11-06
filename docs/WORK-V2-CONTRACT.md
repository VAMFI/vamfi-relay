# Work goals and one master conversation

This change separates durable project outcomes from provider turns. Existing messages, tasks and events remain; no old prompt is automatically promoted into a goal. The overview shows ongoing work across all days, while daily statistics summarize goal-related activity only.

This extends [CONTRACT.md](CONTRACT.md): the work, project, and coordinator-continuity rules here supersede its v0.1 single-workspace behavior. The implementation is locally verified; see [VERIFICATION.md](VERIFICATION.md) for test results, observed provider behavior, and remaining limits.

## State additions

- `projects`: `{id,name,workspace,permissionMode:'read-only'|'workspace-write',threadId:null|string,createdAt,updatedAt}`.
- `workItems`: `{id,projectId,title,objective,nextAction,status:'planned'|'active'|'blocked'|'needs_review'|'paused'|'completed'|'cancelled',createdAt,updatedAt,completedAt:null|string,evidence:[],completionNote?}`.
- Evidence: `{taskId,summary,status,createdAt}` from actual project execution.
- `coordinatorWorkspace`: stable original coordinator directory; `settings.defaultProjectId` selects the default project without resetting the master conversation.
- Tasks retain provider-turn status. New `kind:'project'`, `projectId`, `workId`, `workspace`, and `permissionMode` identify project execution. Tasks with no `workId` never become dashboard goals.
- Messages with `channel:'master'` belong to the visible conversation. Existing coordinator messages remain visible. Raw worker messages stay in task details. One background result notification per finished project task appears in the master conversation.

## HTTP additions

- `POST /api/projects` `{name,workspace,permissionMode?}` registers an existing validated directory. Defaults to read-only; duplicate canonical paths return the existing project without silently broadening access.
- `POST /api/projects/:id` `{name?,permissionMode?}` changes a registered project's name or policy while that project is idle. Its canonical workspace is immutable. A permission change applies when its saved provider session is next resumed.
- `POST /api/work` `{projectId,title,objective,nextAction?}` creates a planned goal, not a provider turn.
- `POST /api/work/:id` `{status?,title?,objective?,nextAction?,reviewed?,completionNote?}` updates a goal. Completion requires explicit user review and a nonempty completion note; model tools cannot mark goals completed. Active execution prevents changing its title/objective or marking complete. Pausing/cancelling first requests interruption of associated runs.
- `POST /api/work/:id/run` `{instructions?}` accepts a project run asynchronously and returns 202 `{taskId,workId}` before provider execution finishes. Uses the registered project's saved permissions and directory. One active run per project; all project runs and specialist workers share the 1–3 background limit. There is no waiting queue: busy returns 409 without overwriting context. An accepted task may briefly have `queued` status while its provider session opens; this is startup reservation, not scheduled backlog.
- Existing `POST /api/settings` accepts `defaultProjectId` and `maxWorkers`. Selecting a default preserves the master conversation. The legacy `workspace`/`permissionMode` settings path resolves a project and its policy instead of resetting the master.
- Existing chat endpoint retains its signature. The master stays responsive while project runs execute, with one coordinator turn at a time.

Project and work arrays are returned in existing state snapshots and server-sent events. There are no separate project/work listing endpoints.

## Model tools

- `relay_projects`: list registered projects, or register an exact absolute directory supplied in the current user message; tool registration is read-only only.
- `relay_work`: list/create/update substantial ongoing work. Everyday questions and status checks do not create work. Reuse a related goal for follow-ups. Cannot claim completion; propose `needs_review` with evidence instead.
- `relay_run`: start an asynchronous project run for a work item; returns promptly. Results arrive in the visible chat and bounded project/work context is supplied on later coordinator turns.
- Existing `relay_delegate` remains a bounded read-only specialist tool. It creates execution records, not standalone goals.

Registered project runs can write only when the user configured workspace-write. The coordinator remains read-only. No automatic broad project scan, provider-history import, or permission escalation. Directory validation is not a filesystem read jail.

## Continuity and migration

Use one persistent execution thread per registered project and resume it across requests/restarts. It is independent of the read-only master and other projects. Never queue multiple provider turns against one project thread. Match notifications by exact turn ID before a single starting run.

Old dynamic tool definitions cannot be replaced on a resumed v1 thread. Upgrade to a v2 coordinator once, retain the complete visible history, and pass a bounded, explicitly labeled handoff of recent coordinator messages. Later workspace changes preserve this coordinator. Record the upgrade honestly; do not claim the provider thread ID stayed identical during migration.

Migration creates a project from the previous workspace when needed, retains its saved project permission mode, and preserves old tasks without creating goals for them. The stable coordinator directory is separate from the selected default project.

Project execution completion means `needs_review`, never goal success. Failures/interruption mean `blocked` with the actual cause; user-paused/cancelled goals retain that state. Restart does not replay side effects. Model-side work updates cannot replace system-collected evidence. Only explicitly reviewed completion with a nonempty completion note counts toward completed-goal statistics; legacy task completions do not.

Codex is the only implemented provider. The adapter boundary and possible additional agents are extension points, not current support. Relay remains local and single-user; live model traffic uses the configured Codex service.

## Acceptance

1. “Why can't you inspect?” stays in chat and creates no dashboard card.
2. A substantial accepted project job creates one persistent goal; follow-ups attach to it.
3. Active goals persist across date changes; completed/paused/cancelled work is absent from Work in motion.
4. Two registered projects can execute separately while the single master chat answers status questions; project sessions are reused and permissions remain scoped.
5. Background results reach both the goal and master chat; a finished response cannot silently complete a goal.
6. Existing state migrates without deleting or reclassifying past conversation records; restart preserves project mappings and prevents duplicate execution.
7. Verify goal creation, project registration, run, review completion, filtering, mobile layout, and real provider routing against the implemented version.
