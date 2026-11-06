# Security policy

## Supported scope

Vamfi Relay is an early local, single-user prototype. Security fixes target the current main branch. Older prototype versions do not have a maintenance guarantee. Keep the service on loopback; it has no user-account system and is not designed for public hosting or exposure through a tunnel.

## Report a vulnerability privately

Use GitHub's [Report a vulnerability form](https://github.com/VAMFI/vamfi-relay/security/advisories/new). Include the affected commit/version, runtime and Codex version, the expected boundary, a minimal reproduction using synthetic data, and the impact you observed.

Do not submit credentials, raw Codex authentication files, real conversation histories, private project files, memory summaries, databases, or backup archives. If private reporting is unavailable, open an issue requesting a security contact without including exploit details or sensitive material.

Please allow maintainers to assess a report before public disclosure. This volunteer project does not promise a response deadline or a bug bounty.

## Important boundaries

- Relay-owned records, logs, catalog metadata, exports, and backups may contain personal information. Backups are not encrypted.
- Codex authenticates through its own installation. Relay must not read or copy raw authentication files.
- Discovery reads stored thread information through app-server. It must not take ownership of, resume, or modify existing desktop chats.
- A reviewed handoff copies bounded context into Relay-owned sessions. That context remains untrusted and conveys no execution authority.
- Read-only provider permissions restrict writes, not all filesystem reads. The selected workspace is not a strong privacy boundary.
- Imported skills remain inert until reviewed and explicitly enabled. This review does not certify their safety.
- Provider requests can use remote model services and consume account usage. Local UI storage is not a promise of offline inference.

Report failures of these boundaries, same-origin protections, data-directory isolation, request bounds, and recovery behavior. Use disposable workspaces when investigating; do not test against another person's installation or account.
