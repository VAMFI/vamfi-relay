# Codex workspace prototype capability map

Authorized scope: the user's 2026-11-06 instruction to complete all phases autonomously and publish a verified open-source GitHub prototype supersedes the earlier qualification-only draft and its per-phase confirmation gates. Independent review and observed acceptance remain required.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| codex-catalog | Discover existing local chats and native projects through supported read-only provider APIs; read bounded history and optional generated memory | Existing adapter transport |
| workspace-dashboard | Group, search and inspect chats across projects; distinguish live Relay activity, recorded history and unknown external status | codex-catalog |
| conversation-handoff | Continue selected work through one master conversation using an exact reviewed, bounded context copy; keep source chats unchanged | codex-catalog, existing Relay runtime |
| oss-preview | Reproducible local installation, independent review, synthetic and real acceptance, sanitized GitHub release and green CI | workspace-dashboard, conversation-handoff |

Build order: codex-catalog → workspace-dashboard and conversation-handoff → oss-preview. Existing goals, queues, plans, approvals and recovery remain the execution foundation.

Discovery and execution use separate app-server processes. Catalog failure cannot interrupt owned work. External provider state is never inserted into Relay's owned task/thread records. User-selected handoff provenance may be stored with the new Relay request; bulk discovered history is ephemeral and excluded from daily exports and backups.

The initial prototype does not take control of an external desktop thread. It reads its history without resuming it and starts a clearly labeled Relay continuation. Cross-process live supervision is not established by the available APIs; unknown means unknown.
