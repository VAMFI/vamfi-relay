# Verification log

## v0.4 Codex workspace prototype — 2026-11-06

Status: **local and clean-export qualification passed; source push and remote CI pending**. The documentation editor inspected the real-provider report and browser record described below. Automated and rendered-check results were supplied by the integration lead; the documentation editor did not independently repeat model inference or browser interaction. Historical sections below remain historical.

| Check | Current recorded result | Interpretation |
| --- | --- | --- |
| Full automated suite | 174/174 passed from the clean exported tree on Node 22.23.2 and Node 24.22.1 | Includes catalog, handoff, HTTP boundaries, runtime, service, and browser-library tests; fixtures do not establish live inference |
| Production build | `npm run build` passed | Built browser assets; visual acceptance remains separate |
| Dependency audit | `npm audit` reported zero vulnerabilities, including development dependencies | Point-in-time advisory result, not a security certification |
| CLI browser option | Ten service tests passed on Node 22.23.2, including `start --open`, failure fallback, option validation, identity conflict, and real disposable service lifecycle | Browser executable invocation is fixture-checked; operating-system qualification is separate |
| Existing local state | Backup and upgrade retained existing tasks, messages, goals, identifiers, and project permission settings | Private state and identifiers are deliberately excluded from this public report |
| Actual local catalog | Existing chats across multiple projects were discovered; external activity remained unknown and discovery created no goals | Private titles, paths, history, and memory are not published |
| Current real-provider flow | Ten phases passed; 16 real provider turns (15 completed, one intentionally interrupted), 14 commands all exit 0 | Two disposable projects, reviewed source-context continuation, original source preservation, and one responsive master |
| Current rendered application | Desktop/mobile Chromium checks passed; zero console errors or warnings | Synthetic provider events in a real browser; separate from live model execution |
| Clean public snapshot | Fresh `npm ci`, 174 tests on both Node versions, production build, and start/status/HTTP/stop smoke passed | Exported bytes and manifest must match the reviewed source; existing local Git history is excluded |
| GitHub source and CI | Pending publication and remote result | Local tests are not remote CI; a prepared snapshot is not a public repository |

### Actual provider pilot and source binding

The inspected local report `artifacts/local/v04-usecase-2026-11-06T06-36-31.523Z.json` records a successful run from **06:36:31 to 06:40:31 UTC on 2026-11-06**, using Node 22.23.2 on macOS arm64 and Codex **0.163.0-alpha.10.2** with the provider-default model. All source chats and project contents were synthetic. Private provider IDs and local paths remain outside this public report.

The ten passed phases created two source chats, discovered/grouped/read them without importing goals or inferring external activity, kept casual and ambiguous messages out of goals, and continued reviewed context into two meaningful project goals in one master. Stale context was rejected, identical handoff retries returned the original task, and a follow-up reused its goal. Reviewed two-step plans respected capacity one; the master answered while Alpha was active. Both restarts preserved the master and held unfinished work without replay. Beta's intentional interruption required explicit retry acknowledgment; completed steps were retained. Eight expected files, including source context, markers, checks, and write counts, were inspected. Each project's marker was written once. Both goals remained awaiting user review, and original source chats were unchanged.

Initial and final **27-file source hash maps matched exactly**. A post-run check confirmed the same 26 application files; only the verification harness then changed to strengthen its fail-on-source-change guard and executable metadata. Four direct guard probes passed: equal maps accepted, changed/added/deleted files rejected. That later harness edit was not a rerun of the model pilot. An earlier pilot stopped on a test-only `undefined` versus `null` expectation; its failure record was retained, corrected, and followed by the successful run above.

### Browser qualification

The inspected local record `artifacts/local/v04-browser.json` records synthetic provider events exercised in a real Chromium browser. Checks covered project grouping, search and project/activity filters, unknown external activity, required handoff review, copied context reaching the master, and no goal creation from an ordinary continuation. Memory preview stayed local; sample mode remained inert. Injected HTML stayed literal with zero injected images. Dialog Tab navigation and Escape focus restoration passed; failure and cancellation remained visible.

At **390 CSS pixels** wide, the page's scroll width was 390 and the dialog's width/scroll width were both 364, with the hidden sidebar excluded from the visible mobile layout. The run recorded zero console errors and warnings. This is targeted interaction/visual evidence, not a broad accessibility or performance certification. The public image `docs/assets/sample-dashboard.jpg` contains fictional sample data; private screenshots and raw reports are excluded from release exports.

### Source release boundary

The preliminary clean export exposed a packaging defect: the exporter wrote every file with mode `0644`, removing the mock provider executable's `0755` permission. The clean-tree suite consequently had **24 adapter failures** with `EACCES`/provider configuration errors. The corrected exporter preserves executable mode (`0755` for executable source, otherwise `0644`) and records it in the manifest. Two focused release regressions passed, covering permissions, exclusions, manifest/overwrite behavior, and source-change guard failures. The corrected clean exported tree then passed all 174 tests on both Node versions, its production build, and a separate CLI/HTTP service smoke. The preliminary 172-test suite predated these two additional tests. This failure was in packaging, not a change to the previously exercised application code.

The source export uses an explicit file allowlist and records per-file SHA-256 values plus an aggregate digest. It excludes personal agent configuration, local task tracking, application data, installed dependencies, build output, private evidence, and Git history. Public history must start from that reviewed snapshot using a public commit identity. The exporter performs bounded path/identifier checks; it is not a comprehensive secret scanner. A separate review of all exported files remains required.

Runtime limits remain explicit: external Codex liveness is unknown; a handoff copies bounded context into Relay-owned work and does not resume the source chat; generated memory may be stale; read-only is not filesystem read isolation; a successful turn or checkpoint is not user acceptance. Other agent providers and full Linux/Windows qualification are outside current evidence.

## v0.3 durable queue and reviewed plans — 2026-11-05

Status: **local verification passed, with a recovered pilot failure and explicit limits**. The integration lead supplied the execution results below, and the documentation editor inspected the pilot report at `artifacts/local/work-v3-pilot.json`. Its outcome is `passed_with_recovered_failure`, preserving the unsuccessful attempt rather than presenting a clean first-pass run.

**Final regression result: 140/140 tests passed on Node 22.23.2 and 140/140 on Node 24.22.1; the production build passed.** This includes the final cancellation-race and shutdown fixes, **20 runtime-plan regressions**, and **22 adapter tests** covering lifecycle and cleanup. These automated checks are distinct from the actual provider pilot below; they do not establish one immutable source set for the entire pilot.

### Real Codex pilot

The disposable two-project pilot used Codex `0.163.0-alpha.10.2`, made **23 API requests** (**17 workflow**, three connection, and three setup requests), started **nine actual provider turns** (**four master, five project**), and passed **ten intended workflow phases**. These are different measures: the pilot did not make ten model turns. The report retains an additional failed historical phase and its recovery.

| Flow | Observed evidence |
| --- | --- |
| Ordinary conversation and goal reuse | An ordinary question created zero goals; actual master `relay_work` calls managed durable goals and `relay_plan` drafted the exact finite plan |
| Explicit plan review | Execution required review of the current plan ID; drafting alone did not start it |
| Queue and capacity | A one-worker cap queued work; pausing held the waiting entry and explicit resume reused that never-started attempt |
| Responsive master | The master answered while Alpha project work was active |
| Planned execution | Alpha produced two `ready` agent checkpoints; exact marker, count, and check files were inspected independently of those reports |
| Restart without replay | Held Beta work remained held after restart; the saved master thread resumed without automatic project execution |
| Real interruption and retry | Beta received a provider interrupt and terminal `cancelled` status; retry required acknowledgment and created a new attempt in the same Beta thread |
| Finished-step preservation | Resuming did not rerun Alpha's finished steps; its two attempt IDs and single write-count line remained intact |
| Completion boundary | Both fixture goals remained `needs_review`; successful plan steps did not mark them accepted |
| Provider shutdown | Awaiting adapter close left no recorded owned provider PID running in the recovery process |

The initial Beta Python heredoc attempted temporary-file behavior that encountered a sandbox restriction and an escalation request. Elevation was **not approved**. The state and failed history were preserved, the plan was revised and reviewed with an explicit `python3.11 -c` command, and the bounded recovery succeeded without elevation. This is not evidence of a successfully accepted live privilege-approval flow.

The interruption test observed acknowledgment and terminal cancellation, then immediately performed the acknowledged retry. It did **not** sample filesystem activity throughout the original command's 12-second window before retry. Filesystem quiescence and rollback of the interrupted command are therefore unproven; retry explicitly accepts uncertain earlier effects. Initial-run source hashes were not captured. The report's `sourceLoads` identifies the fresh recovery process, including the updated shutdown barrier, rather than proving one immutable source set for the entire pilot.

### Browser, review, and local operations

Browser QA used controlled fixtures for plan lifecycle interactions and separately inspected the live and sample views. It confirmed exact-plan review is required before start; a queued run shows zero running and one queued; pause holds work and resume reuses the same waiting attempt; two finished steps show `agent_report` checkpoints; external progress notes remain distinct from execution evidence; retry stays disabled until acknowledgment and retains the earlier attempt; and Needs you displays the applicable work and approvals. Desktop and **390×844 CSS-pixel** mobile checks passed with no horizontal overflow and no console errors. Fixture rendering does not substitute for the real execution evidence above.

An actual read-only review of Relay found a race where cancelling a planned task could still allow a late successful completion to advance the plan. The runtime now freezes plan scheduling before requesting interruption. The fix passed the 20 targeted runtime-plan regressions reported above. Shutdown also now awaits owned provider exit; if confirmation fails, the service and writer lock remain. Controlled protocol fixtures passed, and the real recovery process's owned-provider exit was observed.

The local service and backup implementation provides identified `start`, `status`, and `stop [--stop-running]`, private snapshot envelopes, integrity checking, and restore only into an empty offline destination. The final full suite includes local lifecycle/backup/restore checks. The integration lead reports live migration retained **16 tasks, 35 messages, and two goals**, with all existing IDs preserved, and saved a private backup. Phase milestones are external progress notes, not invented provider tasks. Personal backups and ignored local evidence must never be committed or published.

Remaining limits: checkpoints are agent reports, not independent proof; final goal completion requires user review and a note. Codex is the only real adapter, and experimental app-server dynamic tools remain a compatibility dependency. A read-only policy restricts changes but does not hide other readable files. An accepted live privilege-approval flow, strong post-interruption filesystem quiescence, and compatibility with other provider/CLI configurations are not established. No public release, hosted deployment, or remote CI result is claimed.

## Historical v0.2 goal-based workflow — 2026-11-05

Status: **implemented and verified locally**. The final source passed 83 tests on Node 22.23.2 and the same 83 tests on Node 24.22.1. `npm run check` also produced a successful Vite production build. These runs include stale-turn attribution, cancellation before a turn ID arrives, exact-path registration, project permissions, additive migration, goal-only metrics, completion review, and concurrent project orchestration.

Real Codex `0.163.0-alpha.10.2` ran seven completed turns and four command executions (all exit 0) in isolated disposable projects. Observed outcomes: an ordinary question created zero goals; actual `relay_work` and `relay_run` calls created and launched durable work; two project sessions stayed active while the master answered; follow-up work reused the project thread; an explicit run after graceful restart resumed the same provider thread. Restart plus three idle seconds caused no automatic rerun. Both goals remained `needs_review`. The ignored harness and protocol evidence are `.relay/work-v2-smoke.mjs` and `.relay/work-v2-smoke-results.json`.

The isolated provider run preceded the final stale-event/cancellation/path guards. Those guards subsequently passed dedicated regressions and both full test suites. The final running source was then exercised through the live browser: a real read-only review of Relay used three command executions, finished as a recorded local task, delivered its result to the master conversation, and left its goal awaiting review. This source inspection is recorded as review evidence, not full acceptance by itself.

Browser verification covered goal creation, next-action editing, visibility across dates, pausing, explicit reviewed completion, retained completed history, project registration, sample isolation, live project-run startup/results, and preserved master history. Desktop and 390-by-844 CSS-pixel layouts were inspected; the mobile dashboard and goal dialog had no horizontal overflow (scroll width 390). No console errors were observed. Temporary viewport overrides were cleared.

The live v0.1 database migrated with all 12 earlier task records and 24 messages preserved, no automatic promotion into goals, and no automatic execution. The actual Relay build was registered as a separate meaningful goal and reviewed through a real project run. The existing provider coordinator will rotate once on its next message to install the v0.2 tools, preserving visible history and a bounded recent-message handoff; this rollover is covered by automated tests, not claimed as live migration inference evidence.

Screenshots: `artifacts/local/work-v2-dashboard.png` and `artifacts/local/work-v2-mobile.png`. The new ignored verification record is `artifacts/local/work-v2-verification.json`. These artifacts are local only. No active provider tasks remained after verification.

Limits at the v0.2 checkpoint: Codex was the only real provider; goal classification used model instructions rather than a guaranteed intent classifier; that version had no waiting queue or unattended continuation. Live active-crash recovery and live approval prompts were not exercised for v0.2; controlled tests covered lifecycle and approval edge cases. No remote CI, publication, or deployment was performed.

## Historical v0.1 evidence

Status at that checkpoint: **core local proof of concept and additional isolated write check verified**. Date: **2026-11-05**. The following counts and digest describe the earlier source, not later versions.

This record incorporates execution evidence supplied by the integration lead. The documentation editor checked implementation details for executable selection, workspace defaults, local tool configuration, and npm scripts; it did not independently repeat the test, browser, or inference runs. [CONTRACT.md](CONTRACT.md#acceptance) defines acceptance, and [ROADMAP.md](ROADMAP.md#verification-status) tracks scope and future gates. Fixture-tested behavior is identified separately from live provider behavior below.

## Automated and browser checks

| Check | Environment or flow | Reported result |
| --- | --- | --- |
| `npm run check` | Node 22.23.2; test suite including `web/*.test.js`, then build | 55 passed, 0 failed; Vite 7.3.7 production build passed |
| Separate test run | Node 24 | Same 55 tests passed |
| `npm audit --omit=dev` | Production dependency audit | 0 reported vulnerabilities; development dependencies excluded |
| Desktop browser | 1280×720 | Menus, filters, task details, dates, sample view, and actual worker result worked |
| Mobile browser | 390×844 | Core flows worked; scroll width 390; hidden sidebar absent from accessibility tree |
| Connection and error controls | Connect button, reconnect, failed-task error, Stop | Exercised successfully; live cancellation result recorded below |
| Browser console | Tested desktop/mobile flows | No console errors |
| Sample separation | Explicit sample view and return to live state | Sample remained isolated |
| Skill lifecycle | Preview, review/save, disabled initial state, explicit enable | Passed |
| Skill selection | Optional skill picker for a future request | Passed |
| Local export | Download activity report and inspect JSON | Download completed; JSON checked |

Local screenshots were captured at `artifacts/local/dashboard-desktop.jpg`, `artifacts/local/dashboard-mobile.jpg`, and `artifacts/local/worker-result.jpg`. These are ignored local artifacts and may not exist in another checkout; they are not published assets or required documentation dependencies.

The ignored local record `artifacts/local/verification.json` contains checks, actual task IDs/statuses, and per-file hashes for 25 code, test, and configuration files. Its final aggregate source digest is `fc9748961d2282a2069bdfc32836b55b48350cdc435ee1bfef279adbac4a9a02`. This includes the final workspace-switch help-copy clarification, after which the build passed again; that copy change did not alter behavior. The digest identifies the recorded source set, not a published release or every repository file. No active tasks remained in the final local state.

The final 55-test run supersedes the earlier 53-test interim result. CI is configured in the repository but has not run remotely. A passing production-dependency audit is not a security certification.

## CLI compatibility

| CLI | Observed result | Limit |
| --- | --- | --- |
| PATH `codex`, version `0.147` | Live inference rejected the configured `gpt-6-astra` model because a newer CLI was required | Not usable for that tested model/configuration; this is not a claim that every model fails |
| App-bundled `codex`, version `0.163.0-alpha.10.2` | Initialization/schema checks and the live core flows below passed | Evidence applies to this local installation and configuration; other versions remain unverified |

The server now prefers an executable macOS app-bundled CLI unless `RELAY_CODEX_BIN` explicitly selects another executable. It checks ChatGPT.app before Codex.app, then falls back to `codex` on PATH. The current local setup can use `npm start` without a CLI environment override. This selection logic is not a general compatibility certification, especially for an alpha build.

## Live provider evidence

The initial live reply did not have working filesystem tools. Enabling the local `code_mode_host`, `shell_tool`, and `unified_exec` features corrected execution. The following outcomes were then observed with Codex `0.163.0-alpha.10.2`.

| Check | Observed result | Evidence retained |
| --- | --- | --- |
| Main-thread workspace read | README read command completed with exit 0; the task accurately described the file | Private task record |
| Background delegation | Read-only worker read the README with exit 0; its actual result returned to the coordinator; both tasks completed | Private parent and worker records |
| Distinct worker thread | Worker executed in a separate provider thread and its result was inspected in the UI | Private provider-thread record |
| Live cancellation | UI Stop led to provider-confirmed cancelled status; no active tasks remained | Private task record |
| Restart and resume | Same main thread continued after restart and recalled the worker result without using tools; task completed | Private task and resumed-thread records |
| Provider failure | A real CLI 400 response was surfaced as a failed task and inspected in the browser | Earlier incompatible CLI/model attempt |

## Controlled fixture coverage

The automated suite covers provider disconnection and stale-approval behavior using controlled mocks/fixtures. This provides reproducible lifecycle checks but is not a live provider approval demonstration. No live approval prompt was exercised in this run. Live cancellation above establishes the observed active-task Stop flow; it should not be generalized to every possible provider timing or failure sequence.

## Additional validation

**Passed:** a separate `createApp`/`Runtime` instance used an ephemeral port and disposable canonical workspace/data directories under `/private/tmp`. One actual model turn ran in `workspace-write` mode using bundled Codex `0.163.0-alpha.10.2`.

The workspace contained only `relay-smoke.txt`, with exact content `Vamfi Relay write check\n` (including the trailing newline). There was no delegation and zero pending approvals. Three real `commandExecution` events returned exit codes **0, 69, and 0**. The intermediate failure recovered; its cause is unconfirmed and is not omitted from this record. No `fileChange` event occurred because the write used a shell command.

The task reached terminal `completed` state, the provider was closed, and the disposable fixture was deleted. This proves the observed isolated write flow; it does not demonstrate a live approval prompt.

## Interpretation limits

Read-only restricts changes; it does not hide other readable files. The selected workspace and task instructions guide scope but do not provide filesystem read confinement. Provider permissions, available tools, and observed behavior must each be checked separately.

Only Codex has a real adapter. Sample mode, mock-provider tests, and protocol schema checks cannot prove another provider works. At the v0.1 checkpoint, no public repository, public sharing, multi-user deployment, arbitrary-agent plugin execution, or remote CI execution had been performed. Later publication status is recorded in the current-version section.
