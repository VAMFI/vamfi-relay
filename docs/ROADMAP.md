# Roadmap

Vamfi Relay is a local, single-user Codex workspace. The current deliverable is a source-installable open-source prototype: discover existing chats by project, inspect relevant context, and continue meaningful work through one master conversation. [The v0.4 contract](WORK-V4-CONTRACT.md) and [capability map](CAPABILITIES.md) define that scope.

## Verification status

**v0.4 local qualification passed.** The integration lead reports 174/174 tests passing from the clean exported tree on Node 22.23.2 and Node 24.22.1, a production build, and zero reported vulnerabilities from the complete dependency audit. The real-provider pilot passed ten phases across two projects and one master conversation; desktop/mobile browser checks passed with synthetic provider events. Clean exported-tree installation, both Node suites, the build and service lifecycle passed. The public source passed [GitHub CI](https://github.com/VAMFI/vamfi-relay/actions/runs/42176481339) on both Node versions.

| v0.4 gate | Current evidence or remaining work |
| --- | --- |
| Existing chat discovery and grouping | Implementation and automated tests cover bounded pagination, grouping, unknown external activity, unsupported methods, and isolated discovery failures; actual local discovery was inspected without promoting history into goals |
| History and generated memory | Bounded read-only views with truncation and path protections; private history remains outside public artifacts |
| Reviewed continuation | Real pilot verified stale-context rejection, duplicate retry identity, goal reuse, reviewed continuation, and unchanged source chats |
| One conversation across projects | Real two-project pilot retained one master, created two meaningful goals, and answered while project work was active |
| Browser use | Real Chromium with synthetic provider events: catalog, reviewed handoff, keyboard dialogs, sample isolation, mobile width 390 without overflow, and zero console errors |
| Recovery and existing records | Existing records/permissions preserved; real pilot verified two restarts without replay and explicit retry without rerunning completed steps |
| Reproducible source distribution | Explicit source export excludes private history/configuration/data; clean install, 174 tests on both Node versions, production build and service lifecycle passed |
| Public GitHub delivery | Reviewed public tree, private vulnerability reporting enabled, fresh public history, and both remote CI jobs passed |

The [verification log](VERIFICATION.md) records exact versions, commands, evidence sources, and limits. The private local catalog is not a public release artifact.

## Current scope

The dashboard automatically discovers stored Codex chats with provider project metadata or recorded-directory grouping. It shows history and generated memory as potentially incomplete evidence. Live execution is established from Relay-owned runs; external chats retain unknown live status. Discovery never runs or resumes those source chats.

A reviewed handoff copies bounded context into one Relay-owned master conversation. It preserves the source chat and does not inherit its execution permissions. Project registration, explicit write settings, reviewed finite plans, bounded queues, interruption/retry acknowledgment, and final review govern subsequent work. Ordinary questions stay in chat.

This release remains local and Codex-only. Source distribution on GitHub is separate from running a public service or publishing an npm package.

## Historical qualification

The v0.3 baseline passed 140 tests on each of Node 22.23.2 and Node 24.22.1, a build, desktop/mobile checks, and a disposable two-project real-provider pilot. That pilot made nine provider turns across ten intended workflow phases, retained a recovered sandbox failure, and demonstrated queues, exact plan review, checkpoints, responsive master chat, held restarts, and acknowledged retries. It did not establish one immutable source set or post-interruption filesystem quiescence.

The v0.2 baseline passed 83 tests on both Node versions and a build; its isolated provider run exercised project goals, persistent sessions, responsive chat, and explicit review. Earlier v0.1 reading, delegation, cancellation, restart/resume, and write evidence remain in the verification log. These results do not substitute for v0.4 discovery and handoff acceptance.

## Next: broader local compatibility

After the current acceptance gates pass, prioritize clean-install reports from additional users, supported CLI versions, and Linux/Windows. Use evidence from those runs to decide what needs simplifying. Verify a successfully accepted live privilege-approval flow before advertising that flow from direct evidence. Stronger post-interruption guarantees need dedicated filesystem observations, not inference from an acknowledgment.

More structured retrieval, retention/deletion controls, and reviewed memory proposals may follow demonstrated daily-use needs. The current memory view is not a cross-project knowledge system. Add another coding agent only when its real adapter passes equivalent lifecycle, permission, cancellation, and result-delivery checks.

## Later: community sharing

Public sharing and multi-user use require a separate design for authentication, authorization, tenant isolation, secrets, retention, abuse prevention, and deployment operations. Arbitrary-agent plugin execution requires its own capability and trust model. Neither is part of this local prototype's acceptance.
