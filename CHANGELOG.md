# Changelog

Versions below describe the local prototype. Verification records distinguish shipped source behavior, fixture results, and real-provider checks.

## 0.4.0 — 2026-11-06 (open-source preview)

### Added

- A project-grouped catalog of existing Codex chats, with history loaded on demand through app-server.
- A local generated-memory summary view and reviewed, bounded context handoff into Relay-owned work.
- Bounded history retrieval during master conversation requests, without changing original Codex chats.
- Optional `npm run relay -- start --open` browser opening after the matching local service is ready.
- GitHub source-install instructions, private security reporting guidance, and dependency notices.
- An explicit public-source export allowlist with content hashes; existing Git history and personal runtime artifacts remain private.

### Clarified

- Discovered chats have unknown external live status; Relay's live activity applies to work it owns.
- Continuing in Relay preserves the original Codex chat and does not silently resume or edit it.
- macOS is the initial real-provider qualification platform. Other coding agents, public hosting, npm distribution, and cloud/community sharing are outside this prototype.

Local qualification passed the [v0.4 acceptance contract](docs/WORK-V4-CONTRACT.md) use case: ten phases, two projects, one master conversation, reviewed handoff, and restart/retry controls. Automated and desktop/mobile browser checks also passed. The clean public snapshot passed installation and both [GitHub CI jobs](https://github.com/VAMFI/vamfi-relay/actions/runs/42176481339); see [verification](docs/VERIFICATION.md) for exact evidence and limits.

## 0.3.0 — 2026-11-05

### Added

- Durable per-project queues and reviewed plans containing 1–8 steps.
- Explicit continuation policy, agent checkpoints, external progress notes, and a Needs you view.
- Held work after restart, explicit retry acknowledgment, and preserved earlier attempts.
- Local start/status/stop commands and private snapshot backup/restore.

### Fixed

- Late completion during cancellation no longer schedules the next plan step.
- Shutdown retains service identity and the writer lock until owned provider exit is confirmed.

## 0.2.0 — 2026-11-05

### Added

- Persistent project sessions and explicit per-project permissions.
- Goals independent of ordinary conversation, evidence review, and explicit completion.

## 0.1.0 — 2026-11-05

### Added

- Local master conversation, bounded read-only background workers, and Codex app-server integration.
- Live and sample views, activity history, and reviewed Markdown-only skill import.
