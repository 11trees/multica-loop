# Feedback protocol and durable batches

This increment provides the imported Feedback Triage and Feedback Verify
protocols and a Node-only SQLite store. Native comment capture, human controls,
queue dispatch, forward delivery, report correction and parent completion are
not connected to this store yet. The running worker still embeds seven
definitions. Adding these two profiles does not increase the number of
connected native workflows.

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

Before freezing or settling Verify, an injected authoritative work resolver must
obtain actual completed delivery or report evidence. Without that resolver the
store refuses verification. Report correction requires report evidence; other
forward groups require delivery evidence. All comments in one group bind the
same work snapshot. Changed work is rejected before results are applied. This
interface is not a production resolver and does not establish native ownership,
independence or readiness by itself.

Each comment has its own frozen verification draft and result. A reopened
comment does not resolve an unverified sibling; all comments in a group must
reach their own results before that group becomes terminal. Historical batch
and result records remain immutable. A reopened comment may then enter a new
batch with a new ID and draft, retaining its source version and the previous
failure's reason, observations and work binding as frozen context. A resolved
source version cannot be captured again; an edited source version is new input.

Result receipt, comment state, group state and batch version settle in one
SQLite transaction. Storage can reopen and retry an identical completed draft
without duplicating groups or results. This is not a cross-database or generic
exactly-once claim. Native issue writes/publication remain future integration.

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
fixtures; no native feedback run or provider/model is invoked by these tests.

The next integration must capture actual native comment versions under the
authenticated requirement, freeze invocable roles, bind real readonly runs,
and use the native queue. Forward groups must reach actual reproduction,
planning, accepted delivery or report correction before a production resolver
permits verification. Parent completion must account for pending/reopened
comments, current report generation and authenticated reading. These gates,
native UI/CLI controls, browser acceptance and real-provider acceptance remain
required before post-delivery feedback can be described as migrated.
