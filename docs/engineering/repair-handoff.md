# Verified business handoff preparation and reservation

The independent host prepares a successor and reserves its native task identity
after repair verification. These stages retain an intent, proposed checkpoint and
durable native reservation. They do not activate the checkpoint, enqueue a native
task, release the project fence or close the Case.

## Verified management context

Management schema 10 retains `admin_handoff_preparation` and adds a separate
`admin_handoff_reservation` ledger. The host reads `handoff-pending` only
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

Business SQLite's `engineering_repair_handoff` is the first durable handoff
intent. It retains the
exact old root payload/hash, target, frozen task Team snapshot, original human,
and a deterministic new native task ID. YAML preparation stores a reconciled
successor draft with a new ID, repair-derived binding and incremented sequence.
All thirteen native definitions restart their current stage at its first phase,
without inheriting completed phases, sealed blocks or derived conclusions.
Verification retains source/scenario definitions, but removes results and evidence
review. Development removes implementation claims, captured-check selections and
code-review fingerprints. Other stage artifacts and reproduction observations are
rebuilt from the frozen contract. The surrendered draft retains the old facts
and events. The successor preserves metadata, acceptance definitions,
authenticated human decisions and their exact answered question snapshots;
non-human resolutions reopen for assessment and historical questions become
inactive. It does not create a row in `chain_drafts`. Direct preparation records
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

## Durable native reservation

Independent discovery now follows preparation with the private `reserve-handoff`
action. Reservation requires the acknowledged preparation and independently
repeats source, physical cohort, frozen Team, human, role-resource and actual
content checks. It compares the complete prepared successor with the saved
acknowledgement; a new passing flag or a task ID from the caller cannot reserve
work.

PostgreSQL migration 667 adds its own `engineering_repair_handoff` table. Under
the project admission lock and exact owned-fence lock, the API checks the writer
inventory, absence of active tasks, fresh management intent and content, and
absence of the proposed successor in the native task queue. It persists the
target, project, stable task ID and full immutable reservation receipt with
`phase='reserved'`. A project can have one outstanding reservation; another
target, changed payload or preexisting successor fails without replacement.
This record creates no `agent_task_queue` row.

The receipt pins proposal/proof hashes, candidate content version, continuation
identity/checkpoint, original source and the precise fence generation/cohort.
Native and kernel implementations hash length-prefixed UTF-8 fields so Unicode
paths and JSON escaping cannot change receipt identity. Management rechecks the
receipt against the current verified context before acknowledging it in schema
10. A crash after the PostgreSQL commit replays the same reservation after fresh
authorization, including under a successor supervisor or a new running-intent
revision. The original fence identity remains historical; current authorization
is checked separately. Stopped intent or new original observations refuse reuse.

Reserved records participate in the database admission and project/resource
mutation guards. Even if a fence is absent, an outstanding reservation prevents
controller/task admission and resource changes until publication is implemented.
The normal reservation path retains its exact owned fence and business hold.

## Successor evidence and retired authority

Preparation parses original and derived contracts through each native owner's
schema and requires the original draft/contract binding to agree. Review and
Feedback Verify refuse a changed accepted-work commit: a repair receipt cannot
relabel old independent evidence as verification of new delivered work. Normal
independent verification and evidence reconciliation remain required in that
case. The unchanged-commit path still rebuilds the stage's observations.

Surrender history independently revokes the exact old task and daemon attempt,
even if an active issue hold is later removed. Old credentials can read their
frozen end-execution receipt and replay the same immutable intervention; they
cannot bind a repository, reserve/bind another process or advance the current
workflow. Physical exit recording remains available. Draft saves also reject the
surrendered draft ID independently of the supplied workspace/issue binding.
These guards do not implement business activation or release any current hold.

## Activation still required

Apply the reconciled proposal through its workflow owner, preserving original
contracts, source history, human decisions and bounded budgets. Revalidate
code-bound upstream references before using the proposal as an active checkpoint.

The durable native reservation is now available before any business hold is
removed. Apply the new root/draft with source payload/sequence
checks and retire old attempt authority; stale root writers and old draft writers
must stay rejected after recovery. Keep the project fence through this step.
Then publish the stable native task and release the matching fence in one native
transaction after validating the applied business receipt. A crash after business
activation must leave native admission blocked until that final transaction can
replay. Do not expose a claimable task before its business checkpoint is ready.

Observe a new ordinary result application before closing the management Case.
Preparing or activating recovery cannot satisfy a Team phase or native Done.
Business activation, native queue publication, progress observation and
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

Successor tests parse all thirteen native contract shapes, retain exact human
answers, reopen non-human decisions and refuse changed accepted-work bindings.
The normal verification engine resumes a proposed successor and refuses to
finish execution without new observations. Development gates require new claims,
review and captured commands. A separate test simulates absence of the active
hold lookup while keeping surrender history, to verify permanent attempt
revocation; this is not a business-release or native-queue acceptance run.

Native reservation tests use PostgreSQL and the actual private control socket
with isolated management/business ports. They retain the fence and prove no task
was created, replay after interrupted acknowledgement, and refuse changed
proposal/content/intent, late historical writers, preexisting task IDs and
conflicting/corrupt reservations. A simulated missing-fence condition retains
native admission and resource-mutation barriers. Management tests retain the
receipt across restart/supervisor replacement, check rehashed but mismatched
source fields, and preserve proposals during the schema-nine upgrade. A shared
Unicode receipt witness is checked independently by Go and Node. These tests do
not establish business activation or a complete real-provider recovery.
An admission-wait test confirms a changed authorization cannot commit a native
reservation after waiting for another transaction's project lock.
