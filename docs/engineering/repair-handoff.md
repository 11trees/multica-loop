# Verified business handoff preparation

The independent host now prepares a successor after native repair verification.
This stage records an intent and a proposed checkpoint. It does not activate the
checkpoint, enqueue a native task, release the project fence or close the Case.

## Verified management context

Schema 9 adds `admin_handoff_preparation`. The host reads `handoff-pending` only
under current running intent and obtains `handoff-context` with management
authority. Agent commands expose neither action. A display status alone is
insufficient: context recompiles the entire ordered native receipt, compares its
saved bytes, checks the recorded worker identity, physically settled repair/Test
preparation/native execution, exact original coverage, immutable candidate and
owned source/cohort. Changed originals or stopped intent refuse preparation.

The target pins Case and verification identity, original repair and Test
preparation, receipt/input/plan/candidate hashes, source observation and receipt,
repository/resource binding and exact expected content version. Its identity is
independent of the current supervisor so a successor host can retry the same
target, but every operation requires fresh supervision and running intent. The
saved source generation and current management authorization remain distinct.

## Private native preparation

The independent host uses the API-owned private control socket's
`prepare-handoff` action. The API reads the verified context itself; its caller
cannot provide a directory, passing verdict, successor Agent or fence release.
The API revalidates the native source and exact owned fence, reconciles the same
physical writer inventory, and calls the business worker's host-only
`repair-handoff-prepare`. Preparation rechecks the actual repository version and
current source. Readonly roles and worktree execution also require a clean
registered repository. In-place Direct and development can retain uncommitted
work; the exact content version still has to match and preparation discards none
of those changes.

`engineering_repair_handoff` is the first durable handoff intent. It retains the
exact old root payload/hash, target, frozen task Team snapshot, original human,
and a deterministic new native task ID. YAML preparation stores a copied draft
with a new ID, explicit repair-derived binding and incremented sequence. It
retains the current phase, artifacts, decisions, human answers and events as a
proposal; it does not create a row in `chain_drafts`. Direct preparation records
its next version without editing its attempts or result. Each native workflow
owner still validates its exact original editable checkpoint.

The API rechecks frozen Team/native origin, human membership/project access,
Agent permissions/resources, actual content, management intent and native fence
after asynchronous preparation. Only then does it acknowledge the exact proposal
hash in management storage. A crash between the two store writes replays the
same proposal and successor identity. Acknowledgement cannot replace a previously
recorded proposal. The Case stays `verified`, its original intervention remains
pending and the fence remains held. A recorded preparation is historical evidence,
not a live execution permission.

## Activation still required

Before activation, reconcile code-bound inputs, Dev checks and Test observations
in the proposed copy. A repaired commit must not inherit passing observations
from the old binding. Keep those old facts in the surrendered draft and history,
and preserve human decisions, original obligations and bounded budgets.

Activation needs a durable native reservation for the exact intent before the
business hold is removed. Apply the new root/draft with source payload/sequence
checks and retire old attempt authority; stale root writers and old draft writers
must stay rejected after recovery. Keep the project fence through this step.
Then publish the stable native task and release the matching fence in one native
transaction after validating the applied business receipt. A crash after business
activation must leave native admission blocked until that final transaction can
replay. Do not expose a claimable task before its business checkpoint is ready.

Observe a new ordinary result application before closing the management Case.
Preparing or activating recovery cannot satisfy a Team phase or native Done.
Business activation, native reservation/queue handoff, progress observation and
closure remain unimplemented. Broader revocation, runtime/service identity and
shared-path recovery retain their separate migration requirements.

## Controlled evidence

Management tests recompile receipts, retain preparation across restart and
supervisor replacement, refuse stopped/new-original/corrupt-proof states, and
test schema upgrades. Business-store tests use synthetic host proof identities
with real temporary Git content: Direct, YAML, every business stage and requirement
context/planning/reproduction prepare a successor while old checkpoints remain
held. Team profile edits preserve the task's frozen executor. PostgreSQL/private
socket tests isolate the native boundary with management/business ports: changed
versions, sources, writers, intent, human identity and proposal hashes fail;
interrupted acknowledgement replays without releasing the fence or creating work.
Separate SDK tests use a test-created provider, actual source repair and native
shell checks before obtaining verified handoff eligibility. These are distinct
test layers, not one real-provider or packaged recovery acceptance run.
