# Prototype contract

Working name: **Vamfi Relay**. One conversation. Every agent in view. Name is provisional, not trademark-cleared.

This independent prototype owns a new Codex conversation. It does not take over the active desktop chat or import the user's entire history. Existing Vamfi projects remain untouched. Only Codex is a live provider in v0.1; an explicit sample mode and documented adapter contract make other integrations possible without claiming unimplemented support.

## Frontend API (same origin)

- `GET /api/state` returns the snapshot below.
- `GET /api/events` SSE sends event `state` with the full snapshot on change; client also loads state on mount/reconnect.
- `POST /api/connect` `{}` connects the installed Codex app server.
- `POST /api/settings` `{workspace,permissionMode,maxWorkers}` updates settings only when idle. Permission modes: `read-only` (default), `workspace-write`; workers always read-only. Max workers 1-3.
- `POST /api/chat` `{text,skillIds?:[]}` sends one main-thread request, responds 202 `{taskId}`. Busy main request returns 409.
- `POST /api/tasks/:id/cancel` `{}` interrupts task and descendants.
- `POST /api/approvals/:id` `{decision:'accept'|'decline'}` responds only to a pending runtime request.
- `POST /api/skills/preview` `{content}` returns `{name,description,content,hash,warnings,blocked}`. Markdown-only, size bounded; no script/archive/path imports.
- `POST /api/skills` `{content,reviewed:true,hash}` saves an explicitly reviewed document disabled by default.
- `POST /api/skills/:id` `{enabled:boolean}` explicitly enables/disables a saved skill; enabled skills are optional context for future user turns only.
- `GET /api/export?date=YYYY-MM-DD` downloads a redacted local JSON activity report.
- `GET /api/demo` returns isolated sample snapshot. No sample records enter live state or model prompts.

Errors are JSON `{error:string}`. No general-purpose RPC proxy, shell API, or filesystem API.

## Snapshot

`{meta:{version,now,timezone},connection:{provider:'codex',status:'disconnected'|'connecting'|'connected'|'error',version?,message?},settings:{workspace,permissionMode,maxWorkers},mainThreadId,threads:[],tasks:[],messages:[],events:[],approvals:[],skills:[]}`

Thread `{id,parentId:null|string,title,role:'coordinator'|'worker',status,createdAt,updatedAt,workspace}`.
Task `{id,threadId,parentTaskId:null|string,title,prompt,kind:'request'|'worker',status:'queued'|'running'|'waiting'|'completed'|'failed'|'cancelled'|'interrupted',createdAt,startedAt,completedAt,result,error?,tokens?:number}`.
Message `{id,threadId,role:'user'|'assistant'|'system',text,createdAt,status:'streaming'|'complete'|'error'}`.
Event `{id,threadId?,taskId?,type,title,detail,createdAt}`. Do not render untrusted HTML.
Approval `{id,threadId,taskId?,title,description,kind,status:'pending'|'accepted'|'declined'|'expired',createdAt}`.
Skill `{id,name,description,content,hash,warnings:[],enabled,createdAt}`.

## Adapter interface

`CodexAdapter` extends EventEmitter. Constructor optional `{command:'codex',cwd,requestTimeoutMs}`. Methods `connect()` -> `{version}`, `startThread({workspace,permissionMode,developerInstructions,tools?})` -> `{id}`, `resumeThread({id,workspace,permissionMode,developerInstructions,tools?})`, `startTurn({threadId,text})` -> `{id}`, `interrupt({threadId,turnId})`, `respond(requestId,result)`, `close()`.

Emits `notification` `{method,params}` for normalized raw protocol notifications, `request` `{id,method,params}` for server requests, `disconnect` `{message}`. Never expose raw stderr or credentials. Provider implementation owns initialize/initialized handshake, pending RPC rejection/timeouts, and child process lifecycle. Runtime supplies dynamic `relay_delegate` tool with task instructions; its result returns actual worker result to the coordinator. Native uncontrolled fanout disabled for this POC so app owns worker cap, lifecycle and attribution.

## Acceptance

1. Live persistent main-thread chat streams a real Codex answer and resumes after server restart.
2. Coordinator can call relay_delegate; bounded read-only worker runs in a distinct background thread and returns its actual result to the main conversation. Dashboard displays both.
3. Daily counts, timeline, search/filter and task detail use actual timestamps/status; sample view visibly labeled and isolated.
4. Cancellation, provider disconnect and approval lifecycle cannot silently report success or leave runnable stale approvals.
5. Skill review/import/enable is explicit; no auto-execution or writes to installed skills.
6. Local-only server enforces Host/Origin, validation, redaction and no access to arbitrary files/RPC.
7. Meaningful automated tests and desktop/mobile browser checks pass; limitations documented. Public/community sharing deferred.
