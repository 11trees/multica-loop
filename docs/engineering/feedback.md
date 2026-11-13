# Feedback protocol and durable batches

The native requirement page and management CLI capture comments and queue a
frozen Feedback Triage role. Immediate dispositions can retain the original
report; forward work remains pending and blocks requirement completion. The
worker embeds nine definitions, including Feedback Verify. Frozen feedback
reproduction/planning appends managed deliveries. The native verifier independently
settles each comment against authoritative accepted work; completed feedback then
requires a new final review and exact human reading after delivery changes.
Report-expression correction uses the same native reviewer under a pinned
baseline, independent single-comment report verification and a new reading.
This is a partial feedback migration.

## Native capture and human controls

`Process feedback` is available against a valid final requirement report,
including a requirement already in Done. The human selects native comments and
two distinct invocable roles, both separate from the three delivery roles. The
feedback verifier must also be separate from the report reviewer. Go
loads actual comments from the same workspace and parent; clients submit IDs,
not comment bodies or authors. Capture freezes full text, source revision,
author, version hash, original context/report, delivery-unit snapshots, actual
definition sources, repository mapping and execution mode. Attachment IDs,
filenames, content types and sizes are references only: file bytes and signed
download URLs are not captured or interpreted.

Admission reopens Done to Todo, preserving assignment and project. Triage uses
the native task queue, attempt ownership, readonly repository binding and
authenticated human-answer flow. The shared Web/Desktop panel shows batch
dispositions and source versions. It does not mark native discussion threads
resolved or rewrite requirement acceptances and historical artifacts.

The CLI exposes `engineering start-feedback` and `engineering cancel-feedback`;
use each command's help for the JSON payload. Cancellation records the reason
and preserves unresolved comments, which continue to block Done. Once idle,
those comments can be captured in another batch. Captures retry under their
original request ID; changed source versions require new input.

```sh
multica engineering start-feedback <requirement-id> --payload-file feedback.json
multica engineering cancel-feedback <requirement-id> --payload-file cancellation.json
```

`feedback.json` supplies `request_id` (a new UUID), `expected_revision`,
`expected_sequence` (the report checkpoint), `expected_batch_number` (the latest
batch number, initially zero), `agent_id`, `verifier_id` and `comment_ids`.
`cancellation.json` supplies `batch_id`, `expected_version` and `reason`.
The issue overview exposes those checkpoints. Native identities, source
snapshots and repository resources are derived by the host.

When every comment receives only `reply`, `historical_correction` or
`learning_only`, the previous report remains valid. A previously Done parent
can return to Done only after the ordinary completion gate rechecks current
native children, accepted evidence and the exact human reading acknowledgement.
An unacknowledged report still requires reading. SQLite settlement and native
PostgreSQL lifecycle writes are separate: a durable restoration marker lets the
coordinator retry the native write and acknowledgement. This is not one
cross-database transaction.

Forward groups initially retain `waiting_for_repro`, `waiting_for_plan` or
`waiting_for_report`. Their completed triage cannot close the parent. The panel
keeps the prior report under `Previous report` and hides its closing action
while unresolved comments remain, including after cancellation.

## Forward reproduction, planning and delivery

After triage, **Authorize feedback deliveries** freezes an invocable planner and,
for defect groups, a separate reproducer. Both must be separate from the frozen
delivery roles and feedback verifier, and use the same registered repository and
execution mode. Existing analysis/development/verification roles and per-unit
rework budget remain the delivery policy. The CLI exposes
`engineering start-feedback-deliveries <requirement-id> --payload-file work.json`;
the payload contains `batch_id`, `expected_version`, `planner_agent_id` and, for
defects, `reproduction_agent_id`.

Each group's planning freezes only its comments, explicit acceptances, affected
unit versions and original report context. Defects first bind readonly
reproduction to original accepted oracles from their affected units (all frozen
units when no subset is declared). Missing facts use authenticated questions and
renewed observation. Only reproduced can hand off its retained observation report
to planning. New-scope, behavior and technical groups enter planning directly.

All delivery groups plan against the same frozen reviewed commit before any new
unit becomes executable. Each forward runtime attempt binds one exact group
draft; it cannot start or rebind the next group's checkpoint. The last completed
plan atomically appends every group's
stable unit intent, permanent feedback acceptances and origin references in
SQLite. Local keys are namespaced by group; dependencies remain within their
frozen plan. Original units and acceptances are retained, and each new unit records
its batch, group, planning draft and corrected-unit IDs. Saved terminal plans can
settle after reopening storage without appending twice.

Native task worktrees are disposable. Forward bindings retain their exact named
branch as well as draft identity; a completed plan can settle after its worktree
is reclaimed only while that retained ref still names the frozen commit. Branch
drift is rejected. This does not establish native worktree acceptance for the
entire requirement/review path or substitute for a fresh active-run binding.

The native coordinator publishes the intents with the existing stable-ID child
service. New units then use serial analysis → development → independent Test
from acknowledged predecessor commits, including guarded native Done and host
acceptance. Group delivery acceptance still leaves comments unresolved and the
parent open in `waiting_for_verify`; the native coordinator then freezes each single-comment
verification and queues the separate verifier. Delivery acceptance itself does
not count as Feedback Verify or a new closure report. A frozen append intent requires explicit reconciliation
before cancellation; the batch cancel action cannot discard native delivery scope.

Revising an original oracle when a behavior change contradicts it requires
explicit contract reconciliation;
appending a new acceptance does not retire or silently weaken the original one.

## Independent verification and new closure

After all batch-generated units reach guarded native acceptance, the coordinator
uses the already frozen verifier and human principal. It validates current native
scope and permissions, freezes exactly one pending comment, then queues a stable
native checkpoint task. Verification is readonly and binds the accepted composed
commit. Its native attempt cannot move to a sibling comment. A saved completed
draft settles after reopening storage; editable interrupted runs use the existing
human continuation control rather than automatic recreation of a terminal task.

The shared panel retains each comment's separate conclusion, reason and evidence.
Reopened comments block closure and can be captured in a new batch with retained
failure context; an unverified sibling stays pending. Previously resolved siblings
keep their own results.

When all comments are resolved, forward delivery requires a fresh normal final
Review under the frozen reviewer. The review pins completed feedback batch IDs,
retains historical failed results and reconciles each latest resolved comment
against its own Feedback Verify and independently tested delivery units. Feedback
proofs do not inflate the delivery-unit count. Historical reviews retain their
original evidence scope, even after later batches append work.

The old report remains under Previous report while the new review is pending.
The new report gets its own generation and hash without an inherited reading
acknowledgement. Only authenticated reading of that exact current hash can close
the native parent. Original-oracle revision still requires separate migration
work.

## Report-expression correction

A `report_correction` group queues the frozen report reviewer only after every
non-report group has its own terminal verification results. Reopened results
remain unresolved and visible as failure history; they cannot count as passed
closure evidence. Report groups run serially, retaining earlier report results,
including failed ones, before the next group freezes its baseline.

The candidate contract pins the batch/group, comments, exact previous report
hash and body, all report sections and assessment, accepted unit bindings and
current independent evidence. The review-input gate seeds the existing sections,
evidence boundary and residual risk. They remain editable expression under the
frozen correction boundary; semantic preservation remains the reviewer's and
independent verifier's judgment. The normal review's independent Test requirements
remain in force. Only the exact correction subject may cite its report baseline
without pretending that report is an independent Test.

Correction mode cannot finalize closure gaps, forward delivery units or questions.
Changed delivery meaning requires explicit triage/contract reconciliation. The
native role instructions and readonly attempt binding keep report authoring
separate from the frozen feedback verifier. A completed candidate preserves the
old generation and receives a new hash without inheriting reading confirmation.
Saved terminal candidates settle through the coordinator. Attempt-to-checkpoint
and retained worktree-ref checks also apply to candidate authoring.

The report-work resolver recompiles the actual saved candidate and checks its
baseline and content hash. Each comment then binds that exact candidate in a
separate Feedback Verify draft. The shared panel labels an unfinished candidate,
keeps prior report history accessible and withholds reading/closure. A generated
candidate cannot be cancelled as if it introduced no scope; cancellation and
abandoned-candidate recovery need explicit reconciliation.

Report-only batches leave the accepted code and native unit count unchanged.
After all report comments resolve, their current candidate requires its own
exact human reading. Closure recompiles each saved independent verification and
compares its work snapshot against the actual candidate. Mixed batches that
appended deliveries still require a fresh normal final Review after all feedback
settles; the candidate cannot bypass that review. Reopened report comments can
enter another batch with the failed candidate version, reasons and observations
retained. Old report hashes never acknowledge the current candidate.

Historical evidence is reused only within a single fact-validation call to avoid
repeating identical compiled delivery/report checks. No result persists across
requests; later drift remains observable and subject to the existing version,
source and completion guards.

## Protocol gates

The definitions import the source `feedback-agent.triage.yaml` and
`feedback-agent.verify.yaml`; comments are translated, while artifacts,
instructions and phase order remain unchanged.

Triage freezes a batch ID, ordered comment IDs and delivery-unit count. Its
contract also carries full comment versions/content/source references, parent
context and unit snapshots. Every comment must appear in exactly one stable
group. Unknown, omitted or repeated comments, invalid unit indexes, and missing
work-type-specific fields prevent finalization.

| Work type | Required routing facts | Durable initial state |
| --- | --- | --- |
| `reply` | Reason and explicit response | Completed without code work |
| `historical_correction` | Reason and explicit correction response | Completed without rewriting historical artifacts |
| `learning_only` | Reason | Completed as learning only |
| `bug` | Title, reason and verifiable acceptance | Waiting for reproduction |
| `behavior_change` | Title, reason and verifiable acceptance | Waiting for planning |
| `scope_addition` | Title, reason and verifiable acceptance | Waiting for planning |
| `technical_change` | Title, reason and verifiable acceptance | Waiting for planning |
| `report_correction` | Title, reason and verifiable acceptance | Waiting for a revised report |

The immediate dispositions follow the source behavior. Their classification is
an agent judgment, not deterministic proof that a comment needs no code change.
Clarification uses the existing decision policy and authenticated answer
snapshots; requesting a human choice prevents later substitution of another
option or agent authority. The answer review and completed phase order are
required before compiling triage.

Verify freezes exactly one comment, its group and the authoritative forward
work version. It requires a summary, independent evidence and a reason for
`resolved` or `reopened`. It cannot ask questions or runtime inputs, verify a
different comment or silently accept another code binding. Evidence text does
not itself prove an observation happened or is semantically sufficient.

## Store responsibilities and recovery

`FeedbackStore` is an internal host dependency, not an authenticated API. Its
caller owns native actor lookup, permissions, issue lifecycle, clean repository
binding and source-version validation. The store never receives bearer tokens.
The main package entry stays platform independent; import storage through the
explicit `@multica/command-chain/feedback-store` subpath.

Capture pins both actual definition sources and full feedback snapshots. A
stable request ID retries the same capture; changing its input rejects reuse.
One active batch per issue is permitted. A different workspace is independent.
Batch numbers and SQLite versions reject competing captures and stale writes.
The store reads completed drafts from its trusted `SqliteDraftStore` and
recompiles them; callers cannot submit a claimed triage or verification result.

Triage settlement creates stable group IDs and preserves each forward routing
state. An immediate disposition resolves only its own comments. No pending
delivery/report group becomes complete because an agent process exited or a
triage draft completed.

Before freezing or settling Verify, the injected authoritative work resolver must
obtain actual completed delivery or report evidence. Without that resolver the
store refuses verification. Report correction requires report evidence; other
forward groups require delivery evidence. All comments in one group bind the
same work snapshot. Changed work is rejected before results are applied. The
production delivery resolver reads the actual compiled planning, analysis
and independent Test results, matching each accepted binding and group origin.
It freezes all original and batch-generated units at the last accepted composed
commit and checks commit ancestry. A group sees only its own delivered content
plus the composition bindings. Later batches and review-gap units do not rewrite
that historical work version. Go separately requires current native child origin,
Done status, idle runs, human project visibility, invocable frozen verifier and
registered repository resources before freezing and claiming the task.

Each comment has its own frozen verification draft and result. A reopened
comment does not resolve an unverified sibling; all comments in a group must
reach their own results before that group becomes terminal. Historical batch
and result records remain immutable. A reopened comment may then enter a new
batch with a new ID and draft, retaining its source version and the previous
failure's reason, observations and work binding as frozen context. Native
recapture may use the actual accepted
forward commit while retaining the older report as history; its frozen basis
includes the failed result and accepted delivery snapshot. It cannot inherit
the older report's Done restoration. A resolved
source version cannot be captured again; an edited source version is new input.

Result receipt, comment state, group state and batch version settle in one
SQLite transaction. Storage can reopen and retry an identical completed draft
without duplicating groups or results. This is not a cross-database or generic
exactly-once claim. Native publication and SQLite acknowledgements are separate
retryable operations, not a cross-database commit.

An explicit host-authorized cancellation records actor, reason and time, leaves
completed facts intact, and returns unfinished comments to pending input.
Cancellation cannot count as feedback resolution. A work lookup that returns
after cancellation cannot revive the old batch.

## Evidence and remaining integration

Protocol and real SQLite tests cover all eight routing types, exact comment
coverage, scope/version rejection, human option authority, evidence requirements,
storage reopen, competing captures, per-comment outcomes, failed-evidence
retention, work-version drift, transactional write failure and cancellation
during an asynchronous work lookup. Work resolver results are controlled test
fixtures; no provider/model is invoked by these tests. Host tests cover in-place
and worktree bindings, frozen role separation, saved triage recovery, guarded
restoration and cancellation that leaves completion blocked. Native handler
tests cover actual comment lookup, spoofed/foreign input rejection, queue claim
and preserving parent fields. Shared UI/API tests cover native comment/role
selection, stable retry input, malformed responses and pending feedback.

Forward host tests cover reproduced-only defect handoff, group-scoped sources,
multiple groups sharing a planner/local key, all-plan publication barriers,
terminal-plan recovery, stable origin/acceptance IDs, immutable work policy,
attempt-to-draft fencing, reclaimed worktrees and retained-ref drift. Additional
checks cover separate sibling results, authoritative composed work, saved Verify
settlement, reopened recapture from accepted forward work, a second delivery
generation and a fresh review without inherited reading. They run
actual SQLite/Git and controlled delivery protocol commands in both directory
modes; they do not prove native provider execution or semantic evidence truth.

The controlled native requirement browser scenario runs the actual UI,
management CLI, Go scheduler and private worker. After actual Git changes,
independent Chromium observations, review-gap delivery and human report reading,
it captures native comments from Done. Reply/historical dispositions restore
guarded Done; a second scope-addition batch remains open and rejects direct Done.
That batch then authorizes a planner, freezes scoped planning, publishes a fourth
native child and serially delivers an actual Bookmark action. Chromium observes
Saved while Ready and Continue still work. After guarded native child acceptance,
the parent still rejects Done and displays pending Feedback Verify. The verifier
then independently observes the same Bookmark behavior through Chromium, records
a single-comment result, and hands off to a fresh normal final Review. The old
report hash is rejected; reading the new report closes native Done. The ledger
is checked on desktop and a 390px viewport. Classifications
and protocol commands are fixture-supplied, not model-generated. The fixture
removes only its owned native records and SQLite batches after acceptance.

The native scenario then captures a report-only wording correction, freezes the
previous report, retains its sections and packaged-deployment limitation, writes
the local-environment clarification and displays a candidate on desktop/390px.
A separate verifier reads the exact candidate hash/body. The native unit count
stays four, the old report hash is rejected, and only reading the independently
verified current candidate closes Done.

Shared views pass Web and Desktop main/renderer typechecks; this does not establish
packaged Desktop runtime acceptance.

Host regressions additionally exercise mixed delivery/report batches in both
repository modes, separate report siblings, multiple report groups, report
reopening/recapture, subsequent delivery generations, saved terminal verification
settlement and changed saved proof rejection. These use actual SQLite/Git with
fixture-supplied protocol judgments. They do not prove model judgment quality.

A separate browser layout regression uses a fixed pending-defect overview and a
mocked authorization response. Real role selectors and pointer submission check
long names, distinct roles, popup bounds and reachable controls at desktop/390px
widths. This UI test does not establish native work authorization by itself.

Both delivery and report resolvers and native single-comment paths are connected.
Original-oracle and published-scope reconciliation, abandoned-work recovery,
real-provider acceptance and packaged Desktop acceptance remain required
before post-delivery feedback can be described as fully migrated.

![Select native comments and separate feedback roles](assets/feedback-configure-1.png)

![Native Done restored after immediate dispositions, retaining the original report](assets/feedback-immediate-completed.png)

![Forward scope remains pending under the original requirement](assets/feedback-forward-pending.png)

![Pending feedback on a narrow viewport](assets/feedback-forward-pending-narrow.png)

![Feedback role authorization layout with a fixed defect response](assets/feedback-work-dialog-1280.png)

![Feedback role authorization on a narrow viewport](assets/feedback-work-dialog-390.png)

![Native forward delivery accepted while feedback remains unresolved](assets/feedback-delivery-awaiting-verification.png)

![Accepted forward unit and pending feedback verification on a narrow viewport](assets/feedback-delivery-awaiting-verification-narrow.png)

![New report and its own reading acknowledgement after independent Feedback Verify](assets/feedback-new-report-1280.png)

![Current feedback report reading on a narrow viewport](assets/feedback-new-report-390.png)

![Pinned report candidate retaining the previous sections and corrected local-environment wording](assets/feedback-report-candidate-1280.png)

![Report correction candidate on a narrow viewport](assets/feedback-report-candidate-390.png)

![Independently verified corrected report awaiting its own exact reading](assets/feedback-corrected-report-1280.png)

![Corrected report reading control on a narrow viewport](assets/feedback-corrected-report-390.png)
