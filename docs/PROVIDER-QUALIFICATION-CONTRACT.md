# Provider qualification: Hermes read-only project work

Status: implemented and locally qualified; public CI is the remaining delivery gate. The user selected Hermes as the second provider and required an update before tests. The installed official stable release was updated and verified before the first protocol probe. Claude remains deferred.

## Outcome and scope

One persistent Codex master conversation can delegate a bounded read-only project analysis to an explicitly selected Hermes provider, inspect the actual tools/results, and continue the same project session. Goals, requests, project boundaries and durable results keep the same Relay ownership model. Existing Codex work remains compatible. Provider support is advertised per proven capability; this slice does not promise Hermes writes, coordinator tools, external-chat control, native history discovery or automatic plans.

## Modules and order

| Module | Responsibility | Dependency |
| --- | --- | --- |
| bounded-project-tools | An owned MCP server with bounded list/read/literal-search operations inside one exact registered project | Existing workspace validation and redaction |
| hermes-transport | Documented gateway JSON-RPC through the installed native client, frozen effective-tool proof, session identity, honest terminal/cancellation evidence | bounded-project-tools and successful protocol probe |
| provider-routing | Explicit project/provider choice and persisted provider provenance within the existing master workflow | hermes-transport |
| provider-qualification | Real witnesses, failure/restart/denial checks, browser inspection, independent review and public CI | All preceding modules |

## Hard boundaries

- Use the installed unmodified official Hermes binary and its native authentication. Relay never opens, copies, stores or intermediates credential files.
- Before inference require the exact owned MCP tool set and suppression of inherited rules, memory, skills and active hooks/plugins. Metadata probes reveal only relevant booleans/counts, never raw configuration. Unsupported profiles fail closed.
- Any temporary supported profile setting used for a bounded qualification probe must preserve unrelated configuration and restore the previous selected field in a finally path. A reusable adapter needs a documented, race-safe configuration strategy; a manual probe workaround is not a shipped architecture.
- Tools expose only list_files, read_file and search_files under an immutable root. Reject traversal, absolute paths, symlinks, hardlinked files, sensitive filenames, nonregular/binary files and excessive work/output. Bind opened file identity to the validated path and recheck before returning data. Literal search only, no shell, arbitrary file access, writes or network.
- MCP restrictions are a tool boundary, not an operating-system sandbox. Installed provider behavior and host configuration remain compatibility requirements.
- Closing a CLI viewer is not cancellation. A cancelled state requires the exact owned gateway admission's terminal outcome. Unknown termination retains the work slot and exposes recovery; restart never replays a prompt automatically.
- Bind every session and run to its provider, project, original request and saved permissions. Refuse external IDs and overlapping turns. Never silently switch providers on failure.

## Acceptance

1. Unit/protocol tests exercise bounded reads, denials, malformed streams, duplicate/stale events, cancellation uncertainty, session ownership and no automatic restart replay.
2. Actual Hermes reads an unpredictable marker from a disposable project through the owned MCP tool and returns it. The prompt does not contain the marker. A follow-up reuses that exact session; a second project remains isolated.
3. A real cancellation yields the provider terminal cancellation witness. Failure or detached transport never becomes false completion.
4. The Codex master delegates a Hermes task, responds while it runs and receives one attributable durable result. Dashboard and conversation show the correct provider, scope and actual task state.
5. Restart preserves provenance/context and does not duplicate execution or delivery. Reviewed optional skills remain inert unless explicitly enabled, and unsupported provider skill execution is clearly unavailable.
6. Existing Codex tests and real use case remain valid. New source passes clean installation/build, browser desktop/mobile inspection, independent review and public CI.

Implementation uses the repository's Node test runner and Vite build (`npm test`, `npm run build`). Public delivery uses the reviewed source allowlist and manifest; local profiles, credentials, history and raw verification artifacts are excluded. Completion evidence must state version, capabilities and material limits.

## Transport decision

A no-inference probe of Hermes v0.23.0 established the documented gateway session-create path with explicit per-session toolsets, owned editor MCP, ignored rules, bounded turns and frozen configuration. Creation retry reused the same identity; another native client resumed it with the same scope. Configuration remained unchanged. The installed native client performs its own same-user bootstrap; Relay does not open authentication files. This native-client seam is pinned to the qualified release and is not an independently versioned SDK. [Gateway local sessions](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions), [programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration).

## Qualification result

The production adapter passed the bounded two-provider pilot, exact cancellation, Relay-process crash recovery, independent review, clean installation and desktop/mobile checks described in [verification](VERIFICATION.md). Cold gateway/OS crash behavior and real lost-acknowledgment fault injection remain unqualified. They are not implied by the Relay-process restart witness. Full intermediate-event replay is not implemented.
