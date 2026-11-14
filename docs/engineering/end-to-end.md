# End to End: approved specifications into delivery

End to End starts from the original idea, runs the four business-analysis roles,
and hands the independently approved specification directly into requirement
context. It does not stop for specification reading. The source pipeline is
LoopWork's `end-to-end` definition and `spec-review-agent` result application at
baseline `17982f2b93100b42d65ed650869c9cc97ff92b5a`.

## Initial authorization

Choose **End to End** on an unconfigured issue. Freeze the original idea, clean
repository, decision authority, ten distinct native agents and a per-unit rework
budget of 0–10. Every agent must be invocable and map to the same registered
project repository and execution mode. Automatic continuation is required.

The existing human business configuration endpoint and management CLI accept an
additional `delivery` policy:

```json
{
  "expected_revision": 0,
  "repository_path": "/absolute/local/repository",
  "input": "Original idea and its sources",
  "roles": {
    "intent": "<intent agent UUID>",
    "business_design": "<business design UUID>",
    "specification": "<specification writer UUID>",
    "review": "<independent specification reviewer UUID>"
  },
  "delivery": {
    "roles": {
      "context": "<requirement context UUID>",
      "planner": "<delivery planner UUID>",
      "analyst": "<unit analyst UUID>",
      "developer": "<developer UUID>",
      "verifier": "<independent verifier UUID>",
      "reviewer": "<final report reviewer UUID>"
    },
    "max_reworks": 2
  },
  "decision_mode": "balanced",
  "auto_continue": true
}
```

Use `POST /api/issues/{id}/engineering/business-analysis`, or
`multica engineering configure-business <issue-id> --payload-file ./workflow.json`.
Go supplies the authenticated principal, actual project and native resource
mappings; clients cannot supply those host projections. Omitting `delivery`
retains standalone [Business Analysis](business-analysis.md), including its
specification reading and versioned feedback boundary.

This initial authorization owns downstream publication, serial implementation
and independent final review. Separate **Publish units**, **Start deliveries**
and initial **Start final review** authorizations are not required. Ordinary
[Develop requirements](requirements.md) retain their separate human controls.

## Exact handoff and retained provenance

The business record freezes its four definitions and the context, planning and
final-review definitions at initial authorization. Every stage retains immutable
accepted conclusions and their original question/decision evidence. Once review
approves and the native run finishes, the coordinator checks native membership,
project visibility, all six downstream roles, resource mappings and idle runs.

The host then imports the requirement and marks the business handoff in one
SQLite transaction. Failed destination creation or source update rolls both
back. A retry of an acknowledged handoff reuses the same context/plan identities.
Handoff and context task admission may occur on separate coordinator ticks; a
successful import is not itself native task admission.
No parent or child native issue is created by this handoff. The original business
record, superseded drafts and comments/readings remain stored; its active task
ownership ends when the requirement ownership begins.

Requirement context receives the unchanged original idea and a separate frozen
`businessSource`: actual project, approved review draft/hash, exact approved
specification, and all four current accepted stage draft IDs, hashes, bindings
and complete serialized conclusions. The host recompiles the retained business
conclusions against their frozen definitions when accessing that requirement or
its managed children. Neither a `completed` flag nor copied Markdown establishes
this provenance.

Context still investigates actual code, closes new questions and creates
permanent requirement acceptance entities. Its compiled conclusion retains the
business source. Planning additionally receives immutable, ordered chunks of the
approved specification, each with an exact review/hash/part reference. Those
sources require explicit plan coverage alongside the context impacts and original
acceptance oracles. Planning's per-source size bounds remain unchanged; the
complete approved document remains in the source snapshot.

## Automatic delivery and final reading

After a valid plan and terminal parent runs, the coordinator applies the initial
authorization to the existing native unit publication service. Durable publication
intents and native origin checks retain their existing retry semantics. The frozen
delivery policy runs units serially through analysis, development and independent
verification from their accepted predecessor commits.

After every child has guarded native completion and acknowledged verification,
the initially authorized final reviewer is configured against the exact native
child set. Its obligations include the approved business specification as well as
context, acceptances, independent evidence and delivery facts. Closure gaps use
the ordinary forward-unit/review loop. The final report still requires explicit
human reading of its exact current hash before the parent can enter native Done.
Specification approval alone cannot authorize delivered-code completion.

Go rechecks frozen project scope on task admission, run controls and completion;
managed child scope carries the same original project. Permission or resource
changes block subsequent automatic boundaries. They do not stop OS processes that
are already running or roll back external effects. Manual root replacement and
changing the initially frozen reviewer require explicit reconciliation.

## Verification boundary

Host tests use real temporary Git repositories and SQLite databases. They cover
initial ten-role authorization, exact source fingerprints, native project fences,
reading refusal at specification approval, stale handoff, dirty repositories,
transaction rollback, retry after reopen, retained business-proof mutation and
competing workflow refusal. Go tests cover the actual native role/resource
projection and refusal for unfinished runs, changed project or revoked roles.
All six downstream claim roles recheck the original project before native launch,
including when parent and children are moved together. Runtime command receipts
also receive their actual project from Go. Shared API checks reject missing or
inconsistent source versions; component tests
cover ten-role configuration and the initial budget.

The native browser scenario passed in 13.2 minutes against the managed local
service: initial ten-role UI configuration, all four business definitions, exact
source handoff, an authenticated context option, two dependent native units,
automatic publication/delivery/final review, a review gap and third forward unit,
then the new report and exact reading into native Done. It observes actual Ready
and Continued browser behavior, captures host command receipts and commits actual
fixture changes. The fixture repository remained clean at its final accepted
commit; owned native/kernel records were removed on teardown.

The scenario uses controlled native task claims and management CLI commands. It
does not launch a provider or establish real-model review quality. Native claim
preparation and original-project rejection are checked separately in Go. Shared
views keep polling across automatic transitions and hide unsupported root
replacement; the latter guard is covered by a component regression.

Inspected UI evidence:

- [Initial ten-role authorization](assets/end-to-end-configure.png)
- [Approved source in requirement context, narrow](assets/end-to-end-source-390.png)
- Final report: [wide](assets/end-to-end-report-1280.png), [narrow reading action](assets/end-to-end-report-390.png)

Packaged Desktop, native multi-unit worktree execution, historical migration and cutover remain
separate acceptance boundaries in the [migration audit](migration-status.md).
