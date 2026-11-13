# Synchronous issue completion checks

With `MULTICA_ENGINEERING_ENABLED=true`, an issue with a registered engineering
contract can enter a built-in or custom `done` category only after the latest
revision's independent verification has completed with a passed verdict. A
development-enabled contract also requires its committed handoff. The current
delivery must still name the verified commit, and an active verification
checkout must remain clean after its recorded runtime projection. A newer pending
or abandoned revision cannot reuse an older pass.

The [runtime repository binding](repository-binding.md) distinguishes an active
execution checkout from the registered repository. In-place checks account for
exact generated runtime files. Worktree deliveries use the retained delivery
branch after native reclamation and reject a changed delivery ref.

This applies to human and agent writes alike. The Go host projects workspace and
issue identity into a private worker `completion` call; the agent cannot submit
its own authorization. Incomplete, failed, dirty, or changed-code states return
409. An unavailable worker or malformed permission response returns 503. No
status, content, workflow handoff, or wakeup side effect is published by a
rejected single-issue write.

## Covered writers

| Writer | Enforcement |
| --- | --- |
| Ordinary issue update, CLI status update, and move | Check the final workflow-resolved target before writing, including the description/attachment transaction path. |
| Batch issue update | Preflight explicitly requested completion for every visible item before any writes, then recheck each resolved target in the common write helpers. |
| Linked PR merge automation | Refuse its conditional completion write when the engineering check fails; keep the issue open and log the reason. |
| Workflow edit or project workflow switch | Check every remapped issue inside the existing PostgreSQL transaction; reject and roll back the workflow change and all remaps together. |

The service's remaining direct issue-status writers reset failed work to Todo or
advance Qoder work to In Progress/In Review; they do not grant completion. New
completion writers must call this boundary. This is an application boundary,
not a database trigger covering direct SQL or future code.

Unregistered issues keep normal Multica behavior after a successful lookup.
Started/unstarted statuses and cancellation retain their lifecycle semantics.
Reopen a done/cancelled issue before registering a new engineering contract.
Keep engineering mode enabled for migrated work; disabling the feature disables
its application checks.

## Transaction and acceptance limits

The check is synchronous with the status request. It does not create a distributed
transaction across PostgreSQL, engineering SQLite, and the filesystem. A batch
retains Multica's non-atomic semantics: preflight catches an already blocked
completion before writes, but a later changed condition can reject a remaining
item after previous items have committed. No global concurrent-edit or
cross-database atomicity guarantee is claimed.

This first boundary enforces the migrated development/verification protocol.
Requirement planning, analysis, final review, automatic scheduling, remote clone
mapping, and real-provider acceptance still need migration. A process exit or a
merged PR alone cannot replace the current independent verification verdict.

## Verification

Application tests exercise pending, abandoned, failed, passed, dirty, changed-code,
and superseded-contract states and reject task-owned authorization. Go DB-backed
tests cover human and task-token writes, ordinary/description/batch paths, custom
done statuses, cancellation, unavailable/malformed worker responses, PR automation,
and workflow remap rollback. The live delivery fixture now tries Done before
handoff, before verification, after a pass, and after repository edits. It uses
the real CLI/API/worker and Chromium with fixture runtime identities; no model
or installed agent CLI is executed.
