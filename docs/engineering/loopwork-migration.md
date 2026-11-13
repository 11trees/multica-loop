# LoopWork migration

## Objective and baseline

Move LoopWork's development workflow into Multica. The confirmed deployment
target is a local single-user installation that opens the workspace without
an email or OAuth login, through the direct-loopback bootstrap described in
[local access](local-access.md).
Local identity must remain explicit so issues, runs, decisions, permissions,
and audit records retain their ownership.

The [coverage audit](migration-status.md) maps every source command chain and
user pipeline to current target evidence and remaining work.

The fork starts from Multica `v0.8.2`, commit
`b7f8efcaae6c5f3273c0038252b5d10c81b41068`. `origin` is
`11trees/multica-loop`; `upstream` is `multica-ai/multica`. Work begins on
`codex/loopwork-migration`. Keep upstream branding, license, and notices intact.
The legacy LoopWork source baseline is commit
`17982f2b93100b42d65ed650869c9cc97ff92b5a` on `develop`.

## Ownership

| Responsibility | Owner |
| --- | --- |
| Projects, issues, comments, human interaction, agent configuration | Multica |
| Runtime processes, run queue, concurrency, transcripts | Multica |
| Frozen contracts, chain phases, drafts, artifact rules, verification validity | Engineering protocol kernel |
| Run identity, snapshots, evidence capture, authorized handoff | Integration adapter |
| Phase progress, artifacts, decisions, actionable errors | Shared native Web/Desktop engineering controls |

A run ending normally is not proof of delivery. An authoritative chain result
must name the issue, chain instance and revision, run attempt, contract version,
and tested code version. Each requirement has exactly one active execution
owner during migration. Chain state and issue progress must not become two
competing sources of delivery truth.

Use a parent issue for the overall requirement and child issues where a
delivery unit needs independent tracking. Internal phases stay within the
chain. A project's workflow is shared by its issues, so parent and child paths
must be designed together rather than assuming a per-issue workflow choice.

## Platform constraints to resolve

- Plugin management is behind `plugins_v1`, defaulting off. Self-host setup
  needs explicit plugin enablement and the existing signing/content-origin
  configuration.
- Agent hooks expose tools; an agent chooses whether to invoke them. Event
  hooks are asynchronous and cannot veto a status transition.
- The plugin Action API currently patches issue title and description only.
  Status and assignee changes need a separately defined integration path.
- Strong delivery gates therefore need a synchronous host boundary, with an
  explicit decision for unavailable validators. Treat a hard gate as pending
  until every relevant transition path has been checked.
- Plugin backend endpoints are operated by us. Workspace plugin KV is bounded;
  decide durable draft/evidence storage separately before adding runtime state.
- The local no-login entry produces a real local identity/session, preserving
  task identity and membership checks. See [local access](local-access.md)
  for its direct-loopback scope and Web/Desktop/CLI bootstrap behavior.

## Milestones

1. **Fork and definitions.** Establish the pinned baseline and import the real
   development/verification YAML through a standalone definition loader. Exit:
   malformed definitions, missing required builtins, and invalid references
   are rejected without loading LoopWork's database or runner.
2. **Local access and platform integration.** Specify and implement local
   single-user bootstrap, shared native controls and CLI operations, trusted run
   binding, and the synchronous handoff boundary. Exit: the intended local
   installation opens its workspace without external account verification,
   and the integration capabilities are demonstrated against the host.
3. **One delivery unit.** Add draft persistence, builtin implementations,
   frozen inputs, development evidence, independent verification, and bounded
   rework. Exit: a real unit survives failure, interruption, and a human answer
   without duplicate delivery or testing the wrong commit.
4. **A complete requirement.** Add requirement context, planning, delivery
   analysis, dependencies, and final review. Exit: a multi-unit requirement
   reaches an auditable final result with only necessary human intervention.
5. **Additional paths.** Complete Bug Fix acceptance, feedback additions, business
   analysis, and end-to-end flows. Restore parallel analysis only after serial
   execution and resource ownership are verified.
6. **Cutover.** Default new work to Multica, drain old work on LoopWork, keep
   historical records queryable, and retire superseded infrastructure by role.

## Current implementation

The standalone kernel and imported delivery-analysis/development/verification YAML definitions are in
`packages/command-chain`. The loader validates authoring structure. The engine
supports scoped artifact and metadata edits, field validation, phase completion,
explicit confirmations, rewind invalidation, item freezing, and run-attempt
takeover. A local SQLite adapter persists each draft and event history atomically
and rejects stale writes. The definition and contract/code bindings are pinned
when the draft is created. Tests cover reopening storage and competing writers.

The four independent verification gates are migrated: they freeze host-supplied
sources, require source coverage and a frontend acceptance scenario, freeze
the plan, validate result correspondence and failure attribution, seal observed
results, and recheck evidence review before compiling a passed/failed conclusion.
New scenarios in execution are append-only. They reject stale
workspace/issue/revision/contract/code bindings. This preserves the current
LoopWork minimum of one frontend acceptance scenario, not frontend coverage of
every acceptance. Blocked observations remain at the execution checkpoint.
The kernel can suspend a question batch, persist authenticated human answers,
and resume the same phase on a new run attempt after all answers arrive. It
preserves questions superseded by rewind and does not convert answers into
passing evidence. Human authentication and answer/abandon APIs are connected;
[shared issue controls](human-controls.md) expose questions, answers, and manual
continuation. An authorized [coordinator](automatic-continuation.md) also queues
development handoff and fully answered question batches. Explicitly budgeted
[implementation rework](rework.md) preserves failed generations and rechecks the
frozen scenarios; specification failures return to an authorized analyst; stagnation/budget stops require human review.

Development gates now cover frozen scope, implementation claims, recovery
resolutions, code review, current captured command checks, and clean commits.
The same issue can hand the actual development commit and unchanged frozen
oracles to a different verification agent. Structured receipt capture currently
supports Codex. Native local-directory and pinned-worktree bindings are now
connected; other providers and remote clone mapping remain pending. See
[development handoff](development-handoff.md) for the exact provenance and limits.
[Delivery analysis](analysis.md) now covers frozen units/dependencies, impact scans,
structured decisions and authenticated human option choices, answer review, and
frozen-spec handoff to development. The original acceptances remain unchanged;
analysis-derived guardrail/focus sources are appended with draft provenance.
[Readonly bug reproduction](reproduction.md) now separates missing conditions from
reproduced observations and freezes its evidence before planning. Real-provider
Bug Fix acceptance remains pending.
[Requirement context and planning](requirements.md) now publish stable, versioned
acceptance entities and compile source-covered ordered units on the requirement
issue. They use native context/planner runs and authenticated human decisions.
Native child-issue publication now persists frozen identities/sources and uses
the native issue service with retryable acknowledgements. A separate human policy now freezes three delivery roles, per-unit rework budgets
and execution mode. The native coordinator runs children serially from acknowledged
predecessor commits, completes them through the synchronous Done gate, and records
exact verification bindings on the parent. In-place and worktree kernel coverage
and the native in-place requirement scenario validate the connected path. Requirement final review now freezes scoped independent evidence, appends closure
gap units without replanning, retains review generations, and gates native
completion on authenticated reading of the exact report hash. See
[requirement review](requirement-review.md). Managed recovery/reconciliation and
cross-parent repository ownership remain pending; see [requirements](requirements.md#authorized-serial-execution).
Other engineering builtin implementations are pending. The
engine rejects completion of a builtin without its host handler. Generic
runtime tests use explicit stubs; verification tests use its migrated gates.
Neither is evidence of a delivered real unit. The opt-in local application now
persists contracts and drafts in the managed environment's SQLite database.
Human configuration freezes sources and the actual clean Git HEAD; the service
checks the bound execution repository on every agent operation. The daemon
projects generated context by digest and pins worktrees to the selected commit;
see [repository binding](repository-binding.md). Active drafts must be
explicitly abandoned before their contract is replaced. Additional observation capture,
remote-daemon repository mapping, issue-deletion retention, and authoritative
result publication remain pending.

The fork also has an opt-in local single-user entry, shared Web/Desktop
automatic login, and managed development profile support. A task-token-only
run-context endpoint and kernel bridge now check the current issue/workspace,
agent role, host-resolved version binding, and claim identity. The bridge can
create, read, edit, and resume drafts using that identity. A live cross-service
fixture test covers pause, storage reopen, host-provided human answer, reclaimed
credentials, and continuation. See [run binding](run-binding.md) for its exact
trust and verification boundary.

The native `multica engineering` CLI and Go host endpoints now execute the
development and verification chains through a bundled Node worker. Claim assembly
injects instructions for the current configured role. A live native-CLI fixture
test covers frozen Git identity, phase commands, human answers, reclaimed
continuation, and refusal after repository edits. See
[engineering service](engineering-service.md) for setup and limits.

The first synchronous [issue completion boundary](issue-completion.md) now checks
ordinary/description/batch updates, PR automation, and workflow remaps against
the latest passed verification and current clean commit. It preserves the
existing non-atomic batch semantics and does not supply a cross-database handoff
transaction. System arbitration, verified feedback, remote repository mapping,
remaining chains, and real delivery acceptance are still pending. These local
fixture-based checks do not establish real-provider delivery acceptance or
finish the migration.

## Cutover and rollback

New tasks can opt into the new platform after their scenario is accepted.
Prefer completing in-flight tasks on their original owner. To transfer one,
first stop its execution, capture contracts and valid artifacts, reconcile the
repository commit, then explicitly establish the new continuation point.
Transfer execution ownership back using the same procedure if necessary.
Preserve historical databases read-only; do not import transient run statuses
as evidence that work has completed.
