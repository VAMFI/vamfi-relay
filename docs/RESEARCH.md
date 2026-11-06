# Research and design rationale

Research updated **2026-11-06**. These are primary-source integration decisions, not a substitute for runtime verification. The latest provider and browser evidence belongs in [the verification log](VERIFICATION.md).

## Existing chats without taking ownership

Codex app-server exposes stored thread metadata through `thread/list` and `thread/read`. [Reading a stored thread](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming) does not resume it or subscribe to its events. [Listing thread turns](https://learn.chatgpt.com/docs/app-server#list-thread-turns) supports paginated history without resuming a chat.

**Relay decision:** discover bounded metadata and group chats by their recorded directory; fetch history only when requested. Retain source identity and display discovery limits. Treat a working directory as a grouping key, not proof of semantic project membership. A separate app-server connection cannot establish the live state of every desktop-owned process, so those chats display unknown external live status.

Continuing a discovered chat means reviewing bounded context for a Relay-owned conversation and project session. It does not resume or change the original chat. Source text remains untrusted context and never becomes permission to execute. A model request is a separate user action with the ordinary provider usage implications.

## Protocol and installed versions

The [app-server interface](https://learn.chatgpt.com/docs/app-server) provides initialization, threads, turns, streamed events, and approvals over newline-delimited stdio. Relay owns a local child process behind a narrow adapter. Dynamic tools support Relay-controlled planning and worker execution; they remain experimental.

Generated schemas were inspected for the installed PATH CLI **0.147** and app-bundled **0.163.0-alpha.10.2**. Documentation may describe newer fields and methods than an installed binary. Historical local execution found that PATH 0.147 could not run the configured model, while the app-bundled binary supported the exercised execution flow. Neither result certifies every CLI version. Prefer an executable macOS app-bundled CLI, retain a PATH fallback, and allow `RELAY_CODEX_BIN`.

The earlier bundled CLI required `code_mode_host`, `shell_tool`, and `unified_exec` for observed workspace commands. Those features did not require remote hosts or native plugins. Actual execution, not the model's self-description, established the result. New discovery and handoff behavior needs its own current evidence.

## Generated memory as supplementary context

[Codex memory documentation](https://learn.chatgpt.com/docs/customization/memories) distinguishes local generated memory from ChatGPT memory. Eligibility and asynchronous generation mean that memory is not a complete or necessarily current account history.

**Relay decision:** display a bounded read of the known local generated summary when present. Do not traverse the home directory, rewrite generated memory, read raw authentication files, or merge Codex databases. Use thread metadata for grouping and keep missing or stale context explicit. A memory summary can help a person orient themselves; it does not establish the current state of a repository or a completed outcome.

## Work that the dashboard can substantiate

[Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) describes delegated work and permission inheritance. A role description is not a sandbox boundary, and more workers consume more model work.

**Relay decision:** use bounded Relay-owned worker sessions with explicit read-only policy and inspectable parent/run records. Project executors use their registered permission setting. Read-only limits writes, not every read beyond a workspace. Live status, task completion, plan checkpoints, and goal acceptance remain separate facts. Ordinary questions and historical chats do not become goals automatically.

## Source distribution

The prototype ships as source with a lockfile, MIT license, and notices for included dependencies. `npm ci` installs that locked dependency graph. The package remains private to avoid accidental npm publication. The local CLI's optional browser action uses `execFile` with an argument array and no shell; see [Node child-process documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).

GitHub [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) is configured separately from a repository security policy. The release process must enable it before claiming that the report form is available.

## Limits of this research

Primary documentation establishes an integration route. It does not prove authorization availability, compatibility on every operating system, crash recovery, prompt-injection resistance, or usability. The [v0.4 contract](WORK-V4-CONTRACT.md) and version-specific verification log define the required evidence.

Relay is an independent Vamfi project. Public hosting, community sharing, other coding-agent providers, and arbitrary-agent plugins remain outside the local prototype.
