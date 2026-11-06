# Vamfi Relay

Build a local, single-conversation workspace for coding agents with inspectable background work. This is a new proof of concept; preserve unrelated repositories and Codex runtime state.

- Root owns the API contract, integration, and final verification. Delegate separable UI, adapter, documentation, and verification work with explicit file ownership. Workers must not revert one another's changes or spawn further agents.
- Keep the server on loopback. Never read authentication files or expose credentials. Use supported Codex app-server APIs for bounded read-only history discovery; generated memory reads are limited to explicitly allowed local files. Do not mutate external chats or merge provider databases. The user authorized publication of reviewed, sanitized source to VAMFI/vamfi-relay on 2026-11-06; this does not authorize publishing local history, backups, private artifacts, or a hosted service.
- Keep real provider events distinct from sample data. Only claim support proven by a working adapter. Skills are untrusted, inert documents until explicitly reviewed and enabled.
- Keep application data outside tracked source. Use disposable data/workspace directories for tests. Never merge Codex internal databases.
- Run `npm test`, `npm run build`, and browser QA for the core flow. Verify a real Codex turn, background delegation, persistence, cancellation, and failure states before calling the prototype complete.

