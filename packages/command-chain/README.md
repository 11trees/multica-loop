# Command chain kernel

This package imports the LoopWork authoring format independently of a database,
runner, agent CLI, Multica API, or UI. The host supplies the chain identity,
available builtins, mandatory builtin order, metadata keys, and repository
adapters. YAML cannot define executable commands, validators, or transitions.

The loader validates syntax, references, writable block boundaries, and the
mandatory builtin sequence. `CommandChainEngine` adds phase execution and
durable drafts through an injected `DraftStore`. Requirement context, planning,
bug reproduction, delivery analysis, development, independent verification and
normal requirement review have host-owned handlers. Four business-analysis chains
also have pure profiles, gates and conclusion compilers; their native orchestration
is not connected yet. The remaining source chains and pipelines are
tracked in the [migration coverage audit](../../docs/engineering/migration-status.md).

The identifier grammar excludes numeric keys so YAML declaration order survives
JavaScript object enumeration. Profiles select supported definition versions;
most imported definitions use version 1, while delivery analysis uses version 2.

## Draft execution

- Creation pins the entire definition, issue/workspace, contract revision,
  code version, inputs, and run attempt. Editing source YAML does not silently
  change an existing draft.
- Agent commands can put/remove artifacts in the current phase, set inputs
  in a metadata phase, complete a phase, or rewind to an earlier phase with
  a reason. YAML objects reject undeclared fields, missing required fields,
  invalid enums, and invalid array cardinality. Singleton and keyed blocks
  retain their distinct cardinality.
- Completion checks required artifacts and phase inputs. Confirmation phases
  require an explicit recorded statement; this statement is an agent assertion,
  not human approval or proof of a Git commit.
- Builtins require host-supplied handlers. Missing handlers and failed validators
  stop completion without changing stored state. A handler can produce validated
  artifacts, freeze existing items, require append-only writes, or seal an
  entire block. Handlers must be side-effect free:
  the store atomically commits their output and phase progression, but cannot
  roll back an external operation.
- Frozen items cannot be replaced or removed. Append-only blocks allow new
  keys but preserve all existing items; sealed blocks reject all edits.
  Rewinding clears completion, freezes, and write rules at/after the target, and removes
  artifact blocks whose first owning phase follows the target. Rewinding
  development to implementation therefore invalidates downstream review;
  rewinding verification to plan clears results and unfreezes scenarios.
- Every mutation checks both the run attempt and expected sequence. Host-only
  `resume` changes the attempt without losing the checkpoint. Atomic store
  compare-and-swap rejects competing writes. Completed drafts are immutable.

`@multica/command-chain/sqlite-store` exports a local `SqliteDraftStore` reference
adapter using Node's built-in `node:sqlite` (Node 22.13+). Create its parent
directory before opening a file and close it on shutdown. Each draft is one
atomic snapshot including its event history; this is intentionally an initial
local adapter, not the final evidence archive. The Node-only host applications
use it alongside their frozen contract and integration records.
The main package entry has no Node or database imports. Other adapters must
honor the same atomic create/compare-and-swap contract.

The engine does **not** authenticate Multica runs, capture shell receipts, judge
evidence truth, or change issue status. Callers must
derive identity and version bindings from trusted host state. A draft marked
`completed` only means its configured handlers and phase checks accepted it;
no production delivery result or handoff is issued.

`MulticaRunClient` and `MulticaChainBridge` add authenticated host run lookup
and scoped access to the engine. They check fresh server identity, the configured
agent/chain role, and the host-resolved version binding before every operation.
See [run binding](../../docs/engineering/run-binding.md) for the endpoint,
required host ports, integration evidence, and remaining handoff boundary.

## Runtime input and human answers

Builtin handlers explicitly opt into runtime inputs; YAML cannot grant this
capability. Verification planning and execution support `runtime-input.put`
and `runtime-input.remove`. Questions include a stable key, title, question,
reason, and recommendation. Completing a phase with an unanswered active
question persists `waiting_for_answers` without advancing or validating the
unfinished phase. Agent mutations stop while the draft is waiting.

Host-only `answerRuntimeInput` requires the draft sequence, request ID, answer,
and authenticated human user ID. Answers are immutable and recorded with their
author and sequence. This method is not an agent command; the integration must
authenticate a human before invoking it. Partial answers keep the whole batch
waiting. Once every active question is answered, host-only `resume` assigns a
new run attempt and returns to the same phase, preserving the contract, artifacts,
and frozen plan. The old run cannot continue, even if it learns the new sequence.

An answer does not turn blocked observations into passing results. Verification
must run again and update its observations before completion. Answered questions
cannot be rewritten or silently asked again under the same active key. Rewind
supersedes questions at/after the target while preserving their answers for
inspection; a new question receives a new request ID so a stale answer cannot
close it. Removed unanswered questions are retained as inactive records too.
Multica's shared human controls and native continuation scheduler are connected;
see [human controls](../../docs/engineering/human-controls.md) and
[automatic continuation](../../docs/engineering/automatic-continuation.md).

## Independent verification builtins

`createVerificationHandlers` implements the four verification gates against a
host-supplied `VerificationContract`. Inputs are generated from its frozen
sources, not development notes or agent-provided replacements. Every gate
checks workspace, issue, revision, contract version, code version, and the
frozen source contents against that contract. The caller must resolve the
contract from current trusted host state; comparing supplied versions alone
does not establish that the worktree actually matches them.

Planning requires coverage of every frozen source, unique known coverage
references, and at least one frontend acceptance scenario. This preserves
the current LoopWork policy; it does not require frontend coverage for every
acceptance. Observed results cannot precede the plan. Completing the plan
freezes its existing scenarios.
New scenarios added during execution are append-only too. Execution completion
seals both scenarios and results; finalization seals the evidence review.
Changing observations after review requires rewinding execution, while changing
an existing expected result requires rewinding the plan.

Execution requires one observed result per scenario and no orphan result keys.
Passed results cannot have a failure kind. Failed results require implementation
or specification attribution; blocked results require environment or
inconclusive attribution and prevent completion. After evidence review, final
validation rechecks the same contract, plan, observations, and review summary.
Declared extension fields remain in artifacts while builtins validate their
mandatory semantic fields independently of YAML's `required` settings.

`compileVerificationConclusion` derives a passed/failed conclusion only from
a completed draft that still passes these checks. A failed verification can
have a completed chain: completion means the report is ready, not that the
implementation passed. The conclusion includes draft sequence, run attempt,
and version bindings. Failure routing preserves specification precedence:
specification findings point to analysis; implementation-only failures point
to development. The pure conclusion supplies routing hints; the host application
applies the authorized bounded rework/reanalysis transitions.
The conclusion is not a signed host receipt or proof that supplied
evidence describes an independently observed event. The host supplies captured
command receipts, repository checks and guarded handoffs; these do not prove the
semantic truth of a verifier's narrative. Blocked observations stay at
the execution checkpoint and can suspend for human input; after an answer,
they still cannot produce a conclusion until observations are updated.

## Verification

```sh
pnpm --filter @multica/command-chain test
pnpm --filter @multica/command-chain typecheck
pnpm --filter @multica/command-chain lint
```

`definitions/development.yaml` and `definitions/verification.yaml` are unchanged
copies of LoopWork's `command-chains/default/dev-agent.yaml` and
`command-chains/default/test-agent.yaml` from commit
`17982f2b93100b42d65ed650869c9cc97ff92b5a`. Tests exercise both real definitions
and rejection of changes that would remove verification stages or inject
host-owned execution rules. Runtime tests exercise actual SQLite files in
temporary directories, reopen the store, supersede run attempts, race two
connections, and invalidate downstream output. Generic runtime tests use
deliberate stub handlers. `verification.test.ts` exercises the actual migrated
verification handlers, including coverage, attribution, stale contract/code
bindings, blocked observations, and passed/failed conclusion compilation.
Both unchanged development and verification definitions are embedded in the
executable application worker. Development checks reference structured runtime
receipts and the observed repository snapshot; see
[development handoff](../../docs/engineering/development-handoff.md). Package tests
use temporary repositories/databases and do not access agent accounts or user
databases. See [the engineering service](../../docs/engineering/engineering-service.md)
for its authenticated host API, native CLI, durable contracts, actual Git checks,
and integration evidence.

## Requirement final review

`createReviewHandlers` preserves the imported review phase order and its exclusive
report/closure-gap branches. Subjects, exact evidence-source fingerprints and
metadata are host-owned. Each subject requires one reconciliation or gap;
reconciliations require every frozen independent verification reference for that
scope. Missing or conflicting composed evidence must remain an explicit gap.

`compileReviewConclusion` derives `report_ready` or `closure_gap`, never native
issue completion. The Node host appends stable gap units, retains their original
oracles and review lineage, schedules fresh review generations, and records an
explicit authenticated reading acknowledgement. Go rechecks native children and
unfinished runs before writing Done. See [requirement review](../../docs/engineering/requirement-review.md)
for exact runtime evidence, recovery and remaining migration boundaries.

## Bug reproduction

The imported `reproduction.yaml` and `reproduction.ts` gates sit between bug
context and planning. The host freezes reliable Existing Expected, context
fingerprints and readonly code bindings. Missing facts pause for authenticated
answers; renewed investigation archives earlier observations. Only reproduced
conclusions append source-covered planning facts. The standalone profile is
platform independent; native orchestration stays in the requirement host. See
[reproduction](../../docs/engineering/reproduction.md) for actual acceptance and
provider/semantic boundaries.

## Feedback foundation

`feedback.ts` supplies the imported triage and verification profiles. The main
entry exports only their platform-independent schemas, handlers and compilers.
The Node-only `@multica/command-chain/feedback-store` subpath persists frozen
batches, work groups and per-comment verification receipts with SQLite CAS.
An authoritative host resolver is required before verification can be frozen
or settled. It is not wired into the private worker or native feedback controls.
See [feedback boundaries](../../docs/engineering/feedback.md) before integrating
these components with issue comments, roles, forward delivery and completion.
