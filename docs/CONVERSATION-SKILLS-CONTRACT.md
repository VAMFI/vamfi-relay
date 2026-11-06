# Conversation controls and skill revision provenance

Status: implemented and locally verified; see [verification](VERIFICATION.md). These two bounded gaps were identified by independent review against the accepted full product goal after background delivery was verified.

## Conversation controls

An original user request shows its currently active worker/project assignments through exact saved parent-task links, even after the master response ends. Each row exposes title, actual status, recorded provider/access and existing Inspect, Open goal and Stop controls. No title-based inference or unrelated assignments. Three rows initially; explicit expansion for more. Terminal work uses its durable result receipt. Sample data is inert; a stop request does not optimistically claim termination. Desktop/mobile and keyboard behavior must remain usable.

## Skills

A stable skill identity may acquire a new reviewed Markdown revision. Reuse the existing content preview and safety validation. POST `/api/skills/:id/revisions` accepts `{content, hash, reviewed:true, expectedHash}`. Require the exact preview hash and current expected hash; refuse stale review, changed name, blocked content and excessive revision history. New revision is disabled by default, with an explicit separate enable action. Preserve at most twenty prior revisions; reaching the bound refuses further changes instead of erasing provenance.

Retain revision number, revision ID, content hash and reviewed timestamp. Existing skills are revision one with a stable legacy identity. Keep prior snapshots for inspection. Requests capture immutable selected-skill receipts before any asynchronous session startup, and inject exactly that accepted content. Later revision or disable operations cannot change what a recorded request used. Receipts include stable skill ID, name, revision ID/number and content hash. Unsupported providers receive no silently inherited skill content.

The UI reuses Markdown preview/review for revision, shows revision history and exposes selected-skill receipts in task detail. Skills remain inert documents: no installs, scripts, network access or implicit privilege change.

## Evidence

Focused tests must establish exact active-parent association, disabled sample actions, reviewed/stale revision validation, disabled new revision, unchanged old receipt and async-startup consistency. Browser checks cover revision preview/review/enable, inspect historical receipt, active-assignment controls and mobile layout. Existing regressions/build, independent review and final public CI remain required. Raw user skill content is excluded from public evidence.
