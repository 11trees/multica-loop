# Native role practice migration

The thirteen active legacy Agent Prompts in the
[configuration retention](configuration-migration.md) were reviewed against native
claim instructions and phase work packets. Most role-specific reasoning practice
was absent from the claim layer: Context/Planning/Analysis had only the generic
command bootstrap, and all four business roles shared one short readonly boundary.
The YAML phases and native gates supplied structure, but did not replace those
missing role responsibilities.

The host now embeds versioned role practice in
[`roleguidance`](../../server/internal/engineering/roleguidance/guidance.go).
After the existing authenticated kernel selection and native project/child checks,
[`buildClaimedTaskResponse`](../../server/internal/handler/daemon.go) composes it
into `Agent.Instructions`. Selection uses the current protocol chain, never a
mutable Agent/Team name. It applies equally to native Team and standalone
engineering claims, managed children, End to End handoffs, feedback continuations
and normal business successors after repair. Existing Agent-authored notes remain
intact. No stored Agent/Team definition or historical preparation is rewritten.

Each composed block states `Engineering role practice v1`, its role and a SHA-256
over the complete common/decision/role content. The claim carries the actual text
to the daemon; this version/hash describes that claim's host guidance, not a new
Team revision or a promise that an old task will always use the same binary.
Native task/code/artifact bindings, current phase commands, permission checks,
independent evidence and human gates retain their normal authority. The host does
not load legacy Prompt tables or an installed provider account while claiming.

## Reviewed source correspondence

Source is the pinned LoopWork commit
`17982f2b93100b42d65ed650869c9cc97ff92b5a` and configuration artifact
`2ee49133d2f1c135084f837e714210f436a6e76ed4ee5ef516572b095fd8a533`.
The table covers each source Prompt's goal, numbered principles, decision boundary
and completion conditions. Hash prefixes identify exact retained Prompt bytes;
the configuration artifact holds the full hashes and originals.

| Source Agent / Prompt hash prefix | Native chain and retained practice |
| --- | --- |
| `direct-agent` / `f5a9df7c1d45` | `direct`: exact authorized goal, actual work, no added stages/questions, private result files, native RUN/SUBMIT, honest failure/limitations and no independent-verification claim |
| `idea-context-agent` / `54ed75fdb214` | `idea-context`: why/for whom/success/constraints, factual discovery, actual external research and provenance, exhaustive intent Design Tree, active-path synthesis and no business-solution/code design |
| `business-design-agent` / `a0e2ab373ea3` | `business-design`: business scenarios/rules/states/permissions/failures, researched alternatives, separated proposals/resolution, unique active-path solution and sole-owner intent gaps without technical design |
| `requirement-spec-agent` / `85d4aaf2a1bd` | `requirement-spec`: all ten business sections, inherited decisions/research URLs, observable acceptance, holistic verification, expression fixes versus sole-owner upstream gaps, no invented semantics |
| `spec-review-agent` / `35be5e7be616` | `spec-review`: independent coverage/consistency/provenance inspection, deduplicated blockers with stable keys and exactly one responsibility owner, complete approved specification versus findings, no implementation review |
| `backlog-agent` / `ead895d3bc5e` | `context`: real AS-IS investigation, Actual/Existing Expected/TO-BE distinction, input-solution reconciliation, impact change/preserve/technical dispositions, bounded scope and first-class stable acceptance/oracles |
| `story-splitter-agent` / `11f87a98b987` | `planning`: independently valuable vertical units, conservative merge when independence is unproved, complete source coverage, real prerequisites/order, project-proven delivery span, stable keys and feedback-only forward scope |
| `analyst-agent` / `3442542cc0b7` | `analysis`: business then system-boundary Do It Twice, impact panorama, complete product/engineering Design Tree, evidence/authority-bound decisions, equivalent Dev outcomes and unique Test oracle, compact frozen contract without local code/test design |
| `repro-agent` / `355bbaf28d8d` | `reproduction`: reported versus observed/normative/inferred/unknown, conditional minimal sufficient evidence or incident chain, intermittent conditions/confidence, useful controls, honest non-reproduction and no business verdict/fix |
| `dev-agent` / `55fcdcb71be7` | `development`: explicit input priority, complete sufficient responsibility rather than tiny diff, existing-behavior/no-empty-commit path, code review/real receipt-bound checks, scope-only commits, repository/secrets/process integrity and independent Test boundary |
| `test-agent` / `58123e03a9ad` | `verification`: frozen business black-box oracles, per-acceptance frontend loops plus API supplement, immutable plans/failures, actual repeatable observations, recovery retest, responsibility classification, isolated data and honest blocked/risk boundaries |
| `review-agent` / `de5497d1159c` | `review`: original-goal-to-composed-result independent fact chain, effective forward lineage versus history, gaps versus risks, complete forward units or evidence-backed readable report, no new tests/approval and separate exact reading |
| `feedback-agent` / `58dc996da801` | `feedback-triage` and `feedback-verify`: batch exact-once grouping/types/responses/acceptance without rewriting old units; separately, independent single-comment actual evidence and resolved/reopened result, with host-owned forwarding and reading |

Common practice retains stable semantic identities, incremental recovery,
evidence/authority distinctions, source limits and host-owned routing/completion.
Only intent, business design, Context and Analysis receive the shared Design Tree
practice: complete ready-frontier batches; proposal/resolution separation;
resolution-packet-only policy; inherited human keys; exhaustive re-traversal after
all answer origins; explicit incremental returns; no silent assumptions, pending
fact branches or hidden product decisions. An empty tree or autonomous mode never
weakens that completion standard. These requirements are role practice, not an
assertion that a finite structural validator proves semantic exhaustiveness.

## Native adaptations and boundaries

- The old first `status`, bare `direct run/submit`, ad hoc result JSON and old
  terminal/routing syntax are not installed. The existing native bootstrap,
  `multica engineering command`, current available commands, sequences and host
  routing remain authoritative. The unresolved source `{{mode_instruction}}`
  placeholder becomes the current resolution packet's actual policy.
- Ordinary Review and report-expression correction are exclusive instruction
  variants. Correction receives its pinned cloned baseline and wording-only scope,
  no ordinary closure-gap/forward-unit instruction or new product decision role.
  Separate single-comment verification and fresh reading still follow it.
- The source's one Feedback Agent becomes two independent native roles; neither
  acquires the other's authority. A planning/reproduction feedback group also
  retains the existing host's scoped group instruction.
- Reproduction retains reported/observed distinctions, incident evidence and
  uncertainty; the existing native frozen Expected and reproduced-only handoff
  gates remain unchanged. Missing facts resume investigation through the native
  input path instead of copying legacy routing instructions.
- Verification practice carries the source Prompt's frontend loop for every
  acceptance. Both the pinned source validator and current native validator have
  the weaker structural minimum of full source coverage plus at least one
  acceptance covered through frontend. This change does not relabel that minimum
  as enforcement of per-acceptance frontend quality or actual evidence truth.
- Guidance is a host-owned instruction layer for an authenticated role. It is not
  automatic import of arbitrary source configurations, new custom Prompt editing,
  a runtime grant, a Team pack registry or authority to change a frozen contract.

## Controlled verification and pending acceptance

Pure tests cover distinct/hash-auditable bodies for all fourteen native chain
roles, unknown-role exclusion, shared decision scope and Review/correction
replacement. Native PostgreSQL claim tests cover all fourteen roles, correction
and an ordinary unconfigured issue with deliberately misleading editable Agent
names. They verify exact current-role text, one instruction layer, preserved
workspace notes, normal accepted-child/project checks and unchanged stored Agent
instructions. Existing full engineering handler checks retain their completion,
independence, feedback, source/cutover and human-reading gates. No test discovers
or launches a model executable.

This establishes a reviewed Prompt port and controlled native delivery of its
text. It does not prove a real model follows the reasoning practice, research
quality, scenario completeness, semantic evidence truth or recovery behavior.
Real-provider and packaged-client acceptance remain pending; the actual four
staged tasks and unbound Team roles are not started by this change.
