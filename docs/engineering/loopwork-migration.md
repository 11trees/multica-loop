# LoopWork migration

## Objective and baseline

Move LoopWork's development workflow into Multica and provide a single-user,
self-hosted mode that opens the workspace without an email or OAuth login.
Local identity must remain explicit so issues, runs, decisions, permissions,
and audit records retain their ownership.

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
| Phase progress, artifacts, decisions, actionable errors | Plugin surface |

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
- A local no-login entry must produce a real local identity/session. It must
  not disable task identity or impersonate an existing account through headers.
  The existing authenticated mode remains available; deployment/network scope
  and frontend/desktop bootstrap behavior must be specified before activation.

## Milestones

1. **Fork and definitions.** Establish the pinned baseline and import the real
   development/verification YAML through a standalone definition loader. Exit:
   malformed definitions, missing required builtins, and invalid references
   are rejected without loading LoopWork's database or runner.
2. **Local access and platform integration.** Specify and implement local
   single-user bootstrap, plugin deployment, tool invocation, trusted run
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
5. **Additional paths.** Migrate reproduction, feedback additions, business
   analysis, and end-to-end flows. Restore parallel analysis only after serial
   execution and resource ownership are verified.
6. **Cutover.** Default new work to Multica, drain old work on LoopWork, keep
   historical records queryable, and retire superseded infrastructure by role.

## Current implementation

The first increment contains only the definition loader and two original YAML
fixtures in `packages/command-chain`. It validates authoring structure; it does
not execute chains, validate observed evidence, persist drafts, alter issue
status, start agents, enable plugins, or change login behavior.

## Cutover and rollback

New tasks can opt into the new platform after their scenario is accepted.
Prefer completing in-flight tasks on their original owner. To transfer one,
first stop its execution, capture contracts and valid artifacts, reconcile the
repository commit, then explicitly establish the new continuation point.
Transfer execution ownership back using the same procedure if necessary.
Preserve historical databases read-only; do not import transient run statuses
as evidence that work has completed.
