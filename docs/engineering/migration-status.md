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
| `idea-context` | Not migrated | No target definition or business-analysis host transition |
| `business-design` | Not migrated | No target definition or business-design conclusion/publication |
| `requirement-spec` | Not migrated | No target specification publication or source-bound spec lifecycle |
| `spec-review` | Not migrated | No target independent spec review or structured return path |
| `requirement-context` | Implemented for the delivery path | [Context gates](../../packages/command-chain/context.ts), permanent acceptance entities, authenticated choices and native context/planner handoff |
| `delivery-plan` | Implemented for the delivery path | [Planning gates](../../packages/command-chain/planning.ts), full source-key coverage, ordered dependencies and stable native child publication |
| `delivery-analysis` | Implemented for managed units | [Analysis gates](../../packages/command-chain/analysis.ts), scoped dependencies, decision authority and specification rework |
| `reproduction` | Connected through planning | [Reproduction gates](reproduction.md), frozen Existing Expected, readonly conditions/observations, authenticated facts, renewed investigation, history and native planner handoff |
| `development` | Implemented with provider limits | [Development gates](../../packages/command-chain/development.ts), actual commits and captured command receipts; trusted provider capture is currently the Codex adapter |
| `verification` | Implemented with evidence limits | [Verification gates](../../packages/command-chain/verification.ts), frozen coverage/results and failure attribution; semantic evidence truth is still declared |
| `review` | Normal closure implemented | [Review gates](../../packages/command-chain/review.ts), scoped fact reconciliation, forward units, history and authenticated report reading; report correction and arbitration remain absent |
| `feedback-triage` | Native capture and forward delivery connected | [Feedback gates/store](feedback.md), frozen native comments, separate readonly triage/reproduction/planning roles, stable append publication and serial managed delivery; independent per-comment verification and fresh report reading are connected; report correction remains pending |
| `feedback-verify` | Native delivery feedback connected | Authoritative accepted-work resolver, native independent single-comment tasks, separate sibling results, reopened recapture and new final Review/reading; corrected-report verification remains absent |

“Implemented” describes connected code and controlled fixture evidence. It does
not imply real-provider acceptance, packaged Desktop verification, or historical
data migration. The target [worker](../../packages/command-chain/worker.ts)
currently embeds nine definitions, all with native entry points for the connected
delivery paths. Feedback report correction remains incomplete. The four business-analysis chains remain absent and are
not supplied by a generic prompt or a successful native process exit.

## Complete user pipelines

| Source pipeline | Migration status | Required remaining work |
| --- | --- | --- |
| Direct | Native foundation only | Map and accept LoopWork's explicit result submission and completion semantics; an ordinary Multica run is insufficient evidence of that mapping |
| Business Analysis | Not connected | Four business-analysis chains, reviewed specification publication, return paths and reading acknowledgement |
| End to End | Partial | Connect approved business specifications into the delivered requirement path without losing source versions and authority |
| Develop | Controlled local path connected | Real-provider acceptance, remaining recovery and resource-ownership boundaries before cutover |
| Bug Fix | Controlled reproduction-to-planning path connected | Real-provider diagnosis and complete Bug Fix delivery acceptance; shared downstream delivery is exercised separately |
| Post-delivery feedback | Partial | Capture, triage, forward delivery, independent per-comment verification and new report reading connected; report correction and original-contract revision remain incomplete |

The legacy OpenSpec pack supplies variants of six chains. Those repository
adapters, pack selection and variant-specific acceptance have not been migrated.
The generic loader is not evidence that the OpenSpec behavior is connected.

## Cross-cutting requirements

| Requirement | Current state | Evidence or next proof |
| --- | --- | --- |
| Confirmed local single-user no-login deployment | Implemented | [Local access](local-access.md): direct-loopback bootstrap, explicit local identity, fresh-browser entry and shared development CLI profile |
| Human questions, choices and current report reading | Connected for migrated chains | [Human controls](human-controls.md), [analysis](analysis.md), [final review](requirement-review.md); task credentials cannot answer or acknowledge reading |
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

## Next increment: feedback report correction

Report correction remains unimplemented. Its source boundaries are
`src/application/work-item-feedback.ts` (`attachFeedbackBatchBarriersInDb`),
`src/application/command-chain-drafts.ts` (`reviewCorrectionSubjects`,
`assertReviewExecutionCurrent`, report-baseline cloning and correction-mode
validation), and `src/application/review-report-publication.ts` in the baseline
named above.

The next change will freeze the correction group, comments, exact prior report
hash and accepted delivery facts. In a mixed batch it must wait for every
non-report group's independent Feedback Verify. The reviewer will amend a
candidate from that retained report under the correction boundary, preserving
limitations and accepted facts. A report-expression correction cannot add a
closure gap, create delivery units or change an original oracle; a changed work
meaning must return to explicit triage/reconciliation.

Candidate publication will retain the old report, pin source/checkpoint ownership
and clear reading acknowledgement. The report-work resolver must expose the exact
candidate hash/content to a separate single-comment verifier. Pending or reopened
comments still prevent Done. The closure path must then use the current verified
report and exact human reading, while retaining forward-delivery final review
where the batch also changed implementation. This candidate/verification cycle
must not publish an unverified candidate as ordinary closed-delivery evidence.

Original-contract revision, business-analysis chains, recovery, other providers
and cutover retain their separate rows above. A passed delivery alone does not
resolve a comment or acknowledge a new final report.
