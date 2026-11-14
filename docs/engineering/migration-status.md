# Migration coverage audit

This checklist preserves the full migration objective. A working Develop path
does not establish parity with every LoopWork pipeline. The authoritative source
inventory is `src/domain/command-chain-catalog.ts` and
`src/domain/pipeline-catalog.ts` in the read-only LoopWork baseline
`17982f2b93100b42d65ed650869c9cc97ff92b5a`. The target worker's actual embedded
definitions and host application are the implementation evidence.

## Default command chains

| LoopWork chain | Target status | Current evidence and boundary |
| --- | --- | --- |
| `idea-context` | Native checkpoint connected | Frozen original input, role/attempt/project ownership, authenticated choices and intent publication |
| `business-design` | Native checkpoint connected | Frozen upstream versions, solution publication and intent returns with historical supersession |
| `requirement-spec` | Native checkpoint connected | Draft/verification/final publication, single-target returns and version-bound native comment revisions |
| `spec-review` | Native checkpoint connected | Independent frozen native role, findings/verdict, approved specification, responsibility returns and exact human reading |
| `requirement-context` | Implemented for the delivery path | [Context gates](../../packages/command-chain/context.ts), permanent acceptance entities, authenticated choices and native context/planner handoff |
| `delivery-plan` | Implemented for the delivery path | [Planning gates](../../packages/command-chain/planning.ts), full source-key coverage, ordered dependencies and stable native child publication |
| `delivery-analysis` | Implemented for managed units | [Analysis gates](../../packages/command-chain/analysis.ts), scoped dependencies, decision authority and specification rework |
| `reproduction` | Connected through planning | [Reproduction gates](reproduction.md), frozen Existing Expected, readonly conditions/observations, authenticated facts, renewed investigation, history and native planner handoff |
| `development` | Implemented with provider limits | [Development gates](../../packages/command-chain/development.ts), actual commits and captured command receipts; trusted provider capture is currently the Codex adapter |
| `verification` | Implemented with evidence limits | [Verification gates](../../packages/command-chain/verification.ts), frozen coverage/results and failure attribution; semantic evidence truth is still declared |
| `review` | Normal closure implemented | [Review gates](../../packages/command-chain/review.ts), scoped fact reconciliation, forward units, history and authenticated report reading; report correction is connected; arbitration remains absent |
| `feedback-triage` | Native capture and forward delivery connected | [Feedback gates/store](feedback.md), frozen native comments, separate readonly triage/reproduction/planning roles, stable append publication and serial managed delivery; independent per-comment verification and fresh report reading are connected; report-expression correction and its independent candidate verification are connected |
| `feedback-verify` | Native delivery feedback connected | Authoritative accepted-work resolver, native independent single-comment tasks, separate sibling results, reopened recapture and new final Review/reading; corrected-report verification and new candidate reading are connected |

“Implemented” describes connected code and controlled fixture evidence. It does
not imply real-provider acceptance, packaged Desktop verification, or historical
data migration. The target [worker](../../packages/command-chain/worker.ts)
currently embeds all thirteen default definitions. Four business-analysis
roles now use native API/CLI checkpoints, readonly attempt/project bindings and
coordinator handoff, including responsibility returns and historical supersession.
Specification reading/comments and shared controls are connected; End to End
handoff and initially authorized delivery passed their controlled local native
scenario. See
[business analysis protocol](business-analysis.md) for its verified boundary.

## Complete user pipelines

| Source pipeline | Migration status | Required remaining work |
| --- | --- | --- |
| Direct | Controlled normal lifecycle connected | [Direct](direct.md): dedicated RUN/SUBMIT, first-result-wins persistence, native attempt/project fencing, Git/plain-directory binding, guarded automatic Done and Markdown UI; both controlled browser scenarios passed. Terminal intervention handoff is connected; independent Admin repair/arbitration, real-provider and packaged acceptance remain |
| Business Analysis | Standalone closure connected | Real-model review quality, native worktree and packaged acceptance before cutover |
| End to End | Controlled local path connected | Ten initial roles, exact source handoff, authenticated context, two native dependent deliveries, automatic publication/review, a third forward unit and exact report reading passed; real-provider and native worktree/packaged acceptance remain |
| Develop | Controlled local path connected | Real-provider acceptance, remaining recovery and resource-ownership boundaries before cutover |
| Bug Fix | Controlled reproduction-to-planning path connected | Real-provider diagnosis and complete Bug Fix delivery acceptance; shared downstream delivery is exercised separately |
| Post-delivery feedback | Partial | Capture, triage, forward delivery, independent per-comment verification and new report reading connected; report correction connected; original-contract revision and reconciliation remain incomplete |

The legacy OpenSpec pack supplies variants of six chains. Those repository
adapters, pack selection and variant-specific acceptance have not been migrated.
The generic loader is not evidence that the OpenSpec behavior is connected.

## Cross-cutting requirements

| Requirement | Current state | Evidence or next proof |
| --- | --- | --- |
| Confirmed local single-user no-login deployment | Implemented | [Local access](local-access.md): direct-loopback bootstrap, explicit local identity, fresh-browser entry and shared development CLI profile |
| Human questions, choices and current report reading | Connected for migrated chains | [Human controls](human-controls.md), [analysis](analysis.md), [final review](requirement-review.md); task credentials cannot answer or acknowledge reading |
| Terminal intervention and host arbitration | Terminal handoff connected; Admin repair remains incomplete | [Immutable handoff](intervention.md) retains the editable checkpoint, native attempt and original evidence; current agent faults route to independent Admin observations. The retired assistance loop does not establish current source parity |
| Independent Admin repair | Observation delivery and supervision connected; execution incomplete | [Independent management storage and bridge](admin.md) retain original runtime versions, cohort evidence and replay-safe acknowledgement; separate supervisor renewal is connected. Source `admin-command.ts`, `admin-management-store.ts` and `admin-controller.ts`: process/authority fencing, immutable original observations, investigation and diagnosis, controlled workspace takeover, repair workspaces/builds, separate verification, external dependency probes, verified business handoff and runtime updates require their own acceptance |
| Native queue/run identity and interruption recovery | Partial overall | Stable checkpoint task IDs, attempt fencing and saved-result settlement are covered; this is not a universal external-side-effect deduplication guarantee |
| Immutable contracts, scoped evidence and completion | Connected for migrated chains | Exact source/code bindings, synchronous Done guards and review/native child proofs; unported chains cannot inherit these claims automatically |
| Shared-repository ownership and parallel work | Incomplete | One requirement is serialized; cross-parent repository leases/admission, global arbitration and parallel analysis are not established |
| Published-plan changes and exhausted managed budget | Incomplete | Generic reconfiguration is refused; explicit reconciliation and managed recovery are still required |
| Editable/versioned command-chain configuration | Partial | Profiles and frozen source definitions exist; the legacy configuration store, authoring controls and pack selector are not migrated |
| Additional providers and remote repository mapping | Incomplete | Accept actual trusted command capture, host version binding and recovery for each supported configuration; do not infer parity from CLI discovery |
| Packaged Desktop and independent Mobile | Not accepted | Shared Web/Desktop views exist, but installed Desktop remains unverified; Mobile has its own interface |
| In-flight work and historical artifacts | Not migrated | Inventory actual owners, preserve contracts/evidence/history, establish cutover and rollback, then verify record-level correspondence |

The migration remains active until the relevant source pipelines, named gates,
artifacts and deployment requirements are accepted against current runtime state.
Neither this checklist nor a green subset of tests closes the objective.

## Business analysis acceptance and next handoff

The four business-analysis definitions, pure profiles, completion gates and
artifact compilers are present: `idea-context`, `business-design`,
`requirement-spec` and `spec-review`. Native role binding, historical publication,
all responsibility returns and coordinator handoff are connected. Specification
reading/comments and shared UI are connected; [End to End](end-to-end.md) adds
exact source handoff and the initial downstream execution policy.
A generic prompt or successful native task does not establish this migration.

Source inspection confirms these additional acceptance requirements in
`businessAnalysisCompleteErrors` / result compilation
(`src/application/command-chain-drafts.ts`), native return publication
(`src/application/agent-results.ts`), and
`src/application/business-analysis-pipeline.test.ts`:

| Stage | Required output or return gate |
| --- | --- |
| `idea-context` | Problem, actors, goals and success are required; decision questions use authenticated answers and retained research/source rendering |
| `business-design` | A complete solution needs summary, actors, scenarios, flows, rules, scope and success; an intent gap excludes solution output and returns to intent |
| `requirement-spec` | A normal result needs draft, verification and final specification; upstream gaps choose exactly one of intent or business design and exclude a final specification |
| `spec-review` | Findings and verdict precede approval; all blocking gaps have one responsibility target and at least one gap finding; gaps exclude approval |
| Business Analysis completion | The approved specification requires current-version reading; specification comments before reading revise Spec/Review while preserving Intent/Design and superseding old downstream revisions |
| End to End handoff | Approved specifications automatically enter requirement context; this does not count as delivered code or close the parent |

The [business protocol tests](../../packages/command-chain/business.test.ts)
execute all four imported definitions against the actual handlers in temporary
SQLite databases. All normal paths, six responsibility returns, conflicting
outputs, authenticated decision options and re-asking after rewind, stored-proof
revalidation and public source rendering are covered. Parsed YAML equality with
the frozen original definitions was checked; only source comments were removed.

The target has implemented these pure gates and native publication/return paths.
Local host tests cover four roles, all six responsibility returns, source and
accepted-result fingerprints, old-attempt fencing, inherited human choices and
readonly/project binding. Exact reading and versioned comment publication/resolve
are connected through native completion, with retained reading history. The
controlled native browser scenario passed in 4.8 minutes, including shared UI
configuration, quoted feedback, Spec/Review revision and exact new-version reading;
[wide and narrow screenshots](business-analysis.md#specification-reading-and-versioned-comments)
were inspected. No provider process ran.
The implementation retains old artifacts; it cannot substitute approval for
versioned reading or delivered software. Structural artifact presence and findings
are protocol evidence; semantic specification quality still needs independent review.

Feedback contract revision, published-scope reconciliation and abandoned-work
recovery retain their separate rows above. Real-provider and packaged acceptance,
other repository mappings, in-flight records and cutover also remain unfinished.
