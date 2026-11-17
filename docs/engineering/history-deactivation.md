# Reversing an unused native activation

Native activation transfers migration ownership and registers reviewed project
resources, but leaves its tasks in Backlog without starting them. The local human
can now reverse that unused ownership before any execution or workflow binding
has been recorded. This is a data-preserving deactivation followed by the existing
source rollback, not a schema downgrade or a reset of repository files.

```sh
make env-exec ARGS="-- node scripts/migration/loopwork-cutover.mjs deactivate --id SAVED_CUTOVER_UUID --expected-workspace ORIGINAL_WORKSPACE_SHA256"
make env-exec ARGS="-- node scripts/migration/loopwork-cutover.mjs status --id SAVED_CUTOVER_UUID"
make env-exec ARGS="-- node scripts/migration/loopwork-cutover.mjs rollback --id SAVED_CUTOVER_UUID"
```

The native route is
`POST /api/engineering/history/cutovers/{id}/deactivate`, accepting only
`expected_scope_hash` and `expected_workspace_hash`. The CLI derives the existing
scope from its environment-pinned cutover; callers cannot submit a path, Team,
runtime or replacement task. It uses the existing local human authentication and
reserved workspace owner/admin boundary. It does not discover or launch a model,
require an online provider to withdraw, or act on the actual staged cohort during
startup or tests.

## Unused ownership prerequisites

The native transaction locks the cutover and all owned project rows. It then
requires:

- the original activated receipt, scope, reviewed workspace hash and human;
- the complete exact adoption cohort, with no missing or additional native tasks;
- every imported task still in Backlog at exactly its original staged snapshot
  plus the activation's one owned description/revision change;
- no native queue history, even terminal runs, project chats, controllers, repair
  fences or handoffs;
- no configured business workflow or frozen task Team binding, including a binding
  retained after an interrupted start that never enqueued a task;
- a fresh readonly source/workspace inspection matching the acknowledged baseline,
  original database guards and scoped registered-writer proof;
- exactly the unchanged local-directory resources allocated by activation, with
  their original IDs, project/workspace, type, reference, creator, null label and
  initial position. Modified or additional resources require reconciliation.

Task snapshots retain all semantic fields, original creation identity and exact
revision. Only the activation-owned description/revision delta and activity
timestamps are normalized. Tasks and their existing related history remain native
records; none is deleted. The held task row prevents an accepted-status update
from passing while withdrawal is being checked. The ordinary Team start path
requires an open accepted task, so a changed status/version is not an unused
Backlog cohort. The project update locks serialize native execution/resource
admission. These checks do not establish a global filesystem lease or ownership
of unregistered external writers.

## Atomic native transition and replay

After all checks, the same PostgreSQL transaction removes only the exact original
activation resources, stores an immutable `loopwork-native-deactivation-v1`
receipt, changes the cutover to `deactivated`, withdraws every adoption and cancels
its native Backlog issue. The receipt retains the entire original activation,
fresh source inspection, exact pre-withdrawal task snapshots and removed resource
identities. The original activation is never erased or changed. Any failure rolls
back all resource, task and ownership changes.

`deactivated` reacquires the native project hold. Withdrawn cancelled tasks retain
their permanent queue/status barriers, including after source rollback. A saved
deactivation cannot reactivate the old cohort, and migration 684 refuses downgrade
while such receipts exist. Direct phase edits cannot replace the required receipt
or bypass the unused-execution/resource barrier.

Lost/concurrent acknowledgements replay the same deactivation before mutable
source readiness, task state or runtime configuration. The original workspace
hash must still match the committed request. Replay also works after a subsequent
`rollback_pending`/`cancelled` transition and never restores removed resources or
creates another issue/run.

## Source restoration remains a separate durable step

`deactivate` leaves all original source SQLite guards installed. Only the explicit
`rollback` command can return the frozen source stores to their prior unguarded
state. It refuses a still-activated cohort, retains the native hold through
`rollback_pending`, and rechecks the saved deactivation/activation relationship
and exact retained workspace before intent, before each source restoration and
before final native release. The workspace-only reader remains usable after an
interrupted restoration has already unfenced part of the source cohort; it does
not falsely require those restored files to be frozen again.

Changed workspace files are preserved and require reconciliation; the tool never
resets, checks out, cleans, commits or restores file bytes over user work. An
interrupted source or native acknowledgement resumes the same identity. The final
`cancelled` cutover retains both receipts and its previous workspace/process
observations. Native imported tasks stay cancelled and cannot resume. As with
pre-activation rollback, later migration needs a fresh source capture because
source file preimages changed.

## Evidence and remaining acceptance

Native PostgreSQL handler tests cover successful atomic cancellation/resource
removal, original activation and goal/material retention, permanent status barriers,
immutable receipt/replay before changed source readiness and after cancellation,
wrong-hash refusal, task/workspace/writer/resource changes, terminal queue history,
retained Team bindings, unavailable workers and concurrent task acceptance blocked
by the exact task lock. These use controlled source/worker fixtures and do not
launch an Agent.

Separate isolated PostgreSQL/SQLite/Git operator tests cover real source guards,
both pre-adoption and deactivated-receipt rollback, preservation of dirty included
work, post-deactivation workspace-change refusal, partial/lost acknowledgements,
retained observations and permanent withdrawn-task guards. Their activation and
deactivation records are controlled fixtures; they are not an acceptance run on
the actual migration cohort. Normal source rollback and safe empty-history
up/down migrations remain covered; downgrade with a deactivation receipt is
explicitly refused.

The actual four local tasks remain staged under their original source freeze and
Team revision, with no activation, deactivation, project resource or model run.
Rollback after any recorded execution, workflow binding, changed native scope or
workspace still needs explicit result/side-effect reconciliation. Live physical
drain, native work export/reconciliation, actual cutover/rollback and real-provider
acceptance remain incomplete. A terminal status or absence of a currently running
process does not authorize this unused-cohort path.
