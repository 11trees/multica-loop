# Business analysis protocol and native checkpoints

The four authoring definitions are imported from the read-only LoopWork baseline
`17982f2b93100b42d65ed650869c9cc97ff92b5a`. YAML comments were removed; parsed
definitions, declared fields, instructions, phase order and rendering flags match
the source. The native API/CLI and coordinator execute these checkpoints;
standalone reading, document comments, End to End handoff and shared UI selection
remain incomplete.

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
to exactly one draft. Business and delivery/requirement ownership cannot coexist
on the same issue, including during initial publication.

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
path, not real-model review quality, worktree-native acceptance or final closure.

## Remaining pipeline boundaries

Business checkpoints currently stop at the approved specification. The native
Done guard rejects this workflow even after approval. `reading_enabled: false`
records that versioned specification reading is unavailable; there is no action
that treats the approval as delivered software. Shared Web/Desktop configuration
and business-specific artifact/history views are not connected yet.

The following remain required before calling this a migrated Business Analysis
or End to End pipeline:

- In standalone analysis, require authenticated reading of the exact current
  approved specification. Native specification comments must bind that version
  and automatically revise Spec/Review without replacing Intent/Design.
- In End to End, automatically hand the exact approved specification and its
  provenance to requirement context using the initially authorized roles. This
  must not introduce an extra manual approval or claim delivered code.
- Complete native current-comment/run checks, shared Web/Desktop controls and
  actual native browser acceptance of those final boundaries.

See the [coverage audit](migration-status.md) for the remaining migration scope.
