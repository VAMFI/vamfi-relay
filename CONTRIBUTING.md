# Contributing

Vamfi Relay helps a person manage Codex work across projects without following a growing collection of chats. Contributions should improve a specific part of that journey or fix an observed failure. Capability claims need working evidence.

## Start here

Read [AGENTS.md](AGENTS.md), [the current contract](docs/WORK-V4-CONTRACT.md), and [architecture](docs/ARCHITECTURE.md). Use Node.js 22.13 or newer and the source-install steps in the [README](README.md#run-locally). Keep the lockfile; use `npm ci`.

Before editing, inspect instructions and the working tree. Preserve other contributors' changes. Keep parallel responsibilities explicit.

## Make a bounded change

1. Describe the user-visible problem and the smallest observable success condition.
2. Match the existing contract, or propose a contract change before implementation.
3. Add meaningful checks for changed behavior, especially discovery, lifecycle, privacy, and permissions.
4. Run `npm test` and `npm run build`. Inspect the rendered application when the UI changes.
5. Report exact commands and results, provider/runtime versions when relevant, and remaining limitations. Distinguish fixtures, sample data, and actual model execution.

Use disposable `RELAY_DATA_DIR` and `RELAY_WORKSPACE` directories outside the repository. A live provider test uses your own authorized Codex session and may consume account usage. Do not attach raw provider transcripts, real catalogs, generated memory, private project paths, databases, backups, or credentials to a public issue or pull request. Use synthetic fixtures and sanitized screenshots.

## Boundaries to preserve

- Loopback service, same-origin API, bounded inputs, and untrusted text rendered safely.
- Discovered chats remain read-only context. Do not resume, rename, or write to a user's original chat during discovery or handoff.
- External live status remains unknown unless the integration can establish it. Relay-owned runtime events do not prove global Codex process visibility.
- The master and specialists are read-only. A registered project needs explicit workspace-write selection; registration or discovery does not grant it.
- One provider until another adapter passes equivalent streaming, approval, cancellation, persistence, and recovery checks.
- Plans need exact review before execution. Restarted work stays held until explicit resume; uncertain attempts need an acknowledged retry.
- Sample data is inert and separate from live records, prompts, metrics, and exports.
- Skills are reviewed Markdown, disabled by default. No implicit script or native plugin execution.
- No direct authentication-file reads, provider-database merging, generated-memory edits, or recursive home-directory indexing.

## Review and licensing

Describe the final behavior and its evidence. Include sanitized screenshots for visual changes and flag protocol-version dependencies. Update relevant docs and [the changelog](CHANGELOG.md). Keep [verification](docs/VERIFICATION.md) explicit about what is pending and what was observed; local checks are not remote CI results.

Contributions are distributed under the project's [MIT license](LICENSE). Only submit material you may distribute and preserve dependency attribution. Do not add dependencies, publish packages, or deploy shared services as an incidental part of a change.

For vulnerabilities, use [private security reporting](SECURITY.md), not a public reproduction containing sensitive details.
