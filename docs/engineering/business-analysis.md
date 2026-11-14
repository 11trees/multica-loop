# Business analysis protocol and native checkpoints

The four authoring definitions are imported from the read-only LoopWork baseline
`17982f2b93100b42d65ed650869c9cc97ff92b5a`. YAML comments were removed; parsed
definitions, declared fields, instructions, phase order and rendering flags match
the source. The native API/CLI and coordinator execute these checkpoints;
standalone reading, version-bound native comments and shared Web/Desktop controls
are connected. [End to End](end-to-end.md) adds initially authorized downstream
roles and an automatic approved-specification handoff.

| Stage | Definition | Completion or return |
| --- | --- | --- |
| Intent | [idea-context.yaml](../../packages/command-chain/definitions/idea-context.yaml) | Requires problem, actors, goals and success; decisions must be closed |
| Business design | [business-design.yaml](../../packages/command-chain/definitions/business-design.yaml) | Requires summary, actors, scenarios, flows, rules, scope and success; intent gaps exclude all solution blocks |
| Specification | [requirement-spec.yaml](../../packages/command-chain/definitions/requirement-spec.yaml) | Requires draft, verification and final; upstream gaps name one responsibility target and exclude final |
| Independent review | [spec-review.yaml](../../packages/command-chain/definitions/spec-review.yaml) | Requires findings and verdict; blocking gaps name one responsibility target, require a gap finding and exclude approval; otherwise a complete approved specification is required |

The platform-independent [business module](../../packages/command-chain/business.ts)
exports stage profiles, a host-supplied binding/decision-mode contract, builtin
handlers and a conclusion compiler. Return conclusions include stable gap keys,
evidence, responsibility target and reason. They never stand for approved
specifications, native task completion, independent code verification or delivered
software. Review structure does not prove the semantic correctness of its findings.

Intent and design reuse the authenticated decision protocol. Asking a human
pauses the current phase; only a host-provided answer matching a published option
can resolve that choice. Resume fences the preceding run. Rewinding to proposal
invalidates resolutions and downstream artifacts while retaining historical
questions and answers. It cannot convert a previously requested human choice to
agent authority. Specification and review have no question commands; missing
upstream decisions return to the responsible stage.

Conclusions revalidate required blocks, fields, cardinality, closed decisions,
human-choice provenance, phase history and frozen workspace/issue/revision/code
bindings. The compiler returns structured artifact and question history as well
as the public document. Public rendering retains declared research labels, links,
applicability, limitations and confidence, while omitting internal item keys and
blocks marked `render: false`. A sole final Markdown specification is preserved
without wrapping or heading changes. Return documents contain only the declared
gap block; internal drafts and review notes remain available as structured history.

## Verification and integration boundary

`business.test.ts` uses actual definitions and temporary SQLite databases. It
covers all four normal paths, all six legal return routes, mixed outputs,
ambiguous targets, blocking findings, missing normal output, research rendering,
authenticated choices and re-asking after rewind, stale attempts, autonomous
policy, database reopen and saved-proof revalidation. It uses no model process,
native issue or installed provider executable.

The executable worker embeds all thirteen default definitions. The Node-only
[business application](../../packages/command-chain/business-application.ts)
freezes the original input, four separate native role agents, authenticated
principal, native project, clean repository commit, execution mode, and all four
source definitions. `business_contract` retains stage generations and immutable
accepted-conclusion fingerprints; `business_execution` pins each native attempt
to exactly one draft. Standalone business and delivery/requirement ownership
cannot coexist. End to End switches active ownership in its atomic handoff while
retaining the business record as immutable source history.

Configure through the human-only
`POST /api/issues/{id}/engineering/business-analysis` endpoint, or
`multica engineering configure-business <issue-id> --payload-file ./business.json`.
The payload needs `expected_revision: 0`, `repository_path`, `input`, `roles`
(`intent`, `business_design`, `specification`, `review`), `decision_mode`, and
`auto_continue`. Go resolves actual agent IDs, permissions, project resources and
execution modes; the client cannot supply the native project, human author or
execution-resource projection. Input replacement/reconciliation is not connected.

Runs use the existing `multica engineering start/status/command`, human
`inspect/answer/abandon`, repository binding and native queue. A structured return
creates a fresh generation for its responsibility target and supersedes all old
downstream generations. Earlier completed stages remain current. New drafts are
empty of old artifacts; retained human choices, their complete dependency graph
and exact answered question snapshots are included in the initial atomic draft
write. Nonhuman resolutions are reconsidered. Changing an inherited human choice
requires the ordinary reopen/question/answer protocol.

Every business task operation and runtime binding checks the actual current
native project supplied by Go, along with stage ownership, attempt and readonly
repository binding. Worktree settlement can recover a completed draft after its
runtime directory is removed only while the retained branch still names the
frozen commit. Accepted history recompiles against its frozen source and stored
fingerprint rather than trusting a `completed` label. Stage transitions use
version-checked root updates; a saved completed draft can settle after a process
restart. This is local checkpoint recovery, not global external-effect deduplication.

With `auto_continue`, the coordinator queues the first/new stage and fully
answered question batches using stable checkpoint task IDs. It rechecks native
membership, role invocation, lifecycle, project and resources; it waits for prior
runs and does not re-enqueue a terminal task. Interrupted editable drafts retain
manual Continue semantics.

`application-business.test.ts` covers the four-role workflow, all six return
transitions, historical supersession, authenticated choice inheritance, database
reopen, deleted worktree settlement, readonly/project checks, attempt reuse and
accepted-history mutation. Go tests cover configuration projection, machine
credential refusal, all four claim instructions, changed-project denial and
continuation admission. Shared API tests reject malformed confirmation/history.
The native `engineering-business.spec.ts` exercises actual Go/worker/CLI calls and
queue continuations with fixture credentials; it never launches an agent provider.
The controlled native scenario passed against the managed local Go service: human
choice and resumed task, intent return and preserved old drafts, inherited choice
in revision two, readonly and changed-project refusal, all four source roles,
exact approved specification publication and native Done refusal. The repository
remained clean at its original commit. This accepts the native in-place checkpoint
path. Exact standalone closure and its additional acceptance are described below;
real-model review quality and worktree-native acceptance remain unverified.

## Specification reading and versioned comments

The shared Business analysis panel configures the four frozen roles, displays
human decision options, current specification, readonly analysis versions and
comment progress. The same view is wired into Web and Desktop's issue panel.
A missing backend business capability hides configuration; older servers that
lack reading support remain readonly. Reading and feedback actions also require
an idle, open native issue and the exact current published specification.

`POST /api/issues/{id}/engineering/business-analysis/acknowledge` (CLI:
`multica engineering acknowledge-specification`) accepts `expected_version`,
`draft_id` and `specification_hash`. The authenticated human is supplied by Go.
The kernel recompiles the exact approved review, matches its fingerprint and
records the acknowledgement without overwriting earlier readings. A retried
identical reading is idempotent. Go rechecks the frozen project, unfinished runs
and actual native comment versions, then writes Done through the ordinary
synchronous completion boundary. This closes the analysis. `verified-binding`
still refuses to use a business specification as independent code verification.
A task credential cannot acknowledge reading or post human feedback.

`POST /api/issues/{id}/engineering/business-analysis/comments` (CLI:
`multica engineering comment-specification`) binds `request_id`, `draft_id`,
`specification_hash`, `content`, optional `anchor_type` / `quoted_text` /
`start_offset` / `end_offset`, and `intent` (`note`, `question`, `change_request`).
The current unread specification is the review target. A selection needs quoted
text. The native comment carries that quote and the human's text; protocol
history retains its source document/hash, anchor and intent.

Before writing the native comment, the kernel persists a stable publication
intent and blocks reading. Go publishes it as a native member comment under the
actual issue/project and acknowledges its body fingerprint. Only then does the
kernel create a new Spec generation and supersede old Spec/Review, preserving
Intent/Design and all old drafts. The new contracts expose exact comment IDs,
versions, quoted text and source references. Independent review approval marks
those frozen comments reviewed; the host resolves their native threads and
acknowledges that outcome. Current reading stays blocked until this completes.

Pending publication/resolution is reconciled by the native coordinator. A retry
reuses the same native comment ID and cannot replace the original request's
payload. The kernel and PostgreSQL do not share a transaction: durable intents,
scoped native lookups and idempotent acknowledgement support those specific retry
boundaries; they are not a universal exactly-once claim. Membership, project and
lifecycle are rechecked when publishing or resolving. No agent mention in this
artifact feedback starts an unrelated agent run.

Submitted specification feedback is immutable through native comment edit/delete
handlers. New feedback belongs to the current unread specification. Native
completion rechecks the actual comment author, text fingerprint, resolution and
absence of added attachments; a chat thread's resolution alone is not protocol
review. These are text/quote comments, matching the source document-comment
schema; attachment-based document feedback is not supplied here.

Local host tests cover exact reading, pending comment recovery after restart,
quoted feedback, idempotent publication, scoped Spec/Review revision, independent
review/resolution, old-version refusal and new reading. Go tests use real native
comments, project/identity/idle checks, guarded Done and immutable comment writes.
Shared API tests reject malformed reading/publication/comment state; component
tests cover configuration failure, unchanged-request retry and disabled reading.
The browser scenario now exercises configuration, authenticated choices, source
returns, quoted native feedback, revision two, old reading refusal and final
reading through the shared UI. It passed in 4.8 minutes against the managed local
Go service with controlled native task fixtures and no provider process. The
fixture repository stayed clean, and its owned records were removed on teardown.

Inspected UI evidence:

- [Four-role configuration](assets/business-analysis-configure.png)
- Quoted feedback: [wide](assets/business-specification-feedback-1280.png), [narrow](assets/business-specification-feedback-390.png)
- Confirmed current reading: [wide](assets/business-specification-read-1280.png), [narrow](assets/business-specification-read-390.png)

## Remaining pipeline boundaries

[End to End](end-to-end.md) hands the exact approved specification and its
provenance to requirement context using the initially authorized roles, without
an extra manual approval or a delivered-code claim. Its controlled native
acceptance is tracked separately from standalone specification closure.
Input replacement/reconciliation, real-model specification quality, native
worktree acceptance, packaged Desktop and historical-data cutover remain separate
acceptance boundaries. See the [coverage audit](migration-status.md).
