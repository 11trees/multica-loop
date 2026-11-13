# Requirement context and delivery planning

The fork imports LoopWork's `backlog-agent.yaml` and
`story-splitter-agent.yaml` as `definitions/context.yaml` and
`definitions/planning.yaml` in `packages/command-chain`. These retain the
original phase order and builtin gates. The context definition explicitly
declares the host-owned acceptance projection's fields for the new loader.

## Configure and run

Choose **Plan requirement** in an unconfigured issue's engineering panel.
Freeze the original input, clean local repository, requirement/bug type,
decision policy, context agent, separate planner, and continuation policy.
Both roles use the existing native queue, claim identity and daemon-owned
repository binding. Their operations require the frozen clean commit; neither
role may use investigation as a route to changing business code.

The CLI uses the existing human configuration endpoint:

```json
{
  "kind": "requirement",
  "expected_revision": 0,
  "agent_id": "<context agent UUID>",
  "planner_agent_id": "<planner UUID>",
  "repository_path": "/absolute/local/repository",
  "input": "Original requirement and its sources",
  "item_kind": "requirement",
  "decision_mode": "balanced",
  "auto_continue": true
}
```

Initial execution requires **Start run**. With automatic continuation, a fully
answered context question batch resumes that same context draft/phase, and a
completed context queues the frozen planner after all native issue runs finish.
The native task row and deterministic checkpoint ID retain the existing
[dispatch guarantees and limits](automatic-continuation.md). Manual continuation
uses the same revision/sequence and repository preflight.

A single issue owns either a requirement workflow or an independently configured
delivery workflow. A caller cannot silently replace one with the other. Freeze a
new requirement revision only after its current draft is completed or explicitly
abandoned. Previous requirement/acceptance revisions remain stored.

![Requirement input and role configuration](assets/requirement-configure.png)

## Context gates and acceptances

The context chain follows AS-IS, decision proposal, decision resolution, answer
review, TO-BE, impact scan, scope, acceptance definition, and finalization.
It requires intent, a reliable Actual, a reliable Target, a change summary,
resolved impacts, an included scope, and at least one acceptance. A bug also
requires reliable Existing Expected. Inferred statements cannot stand in for
those required reliable statements; conflicted assertions block completion.
Decision references must exist, every node must close, and a human resolution
must match the authenticated option snapshot. The authority modes and human
answer protections are shared with [delivery analysis](analysis.md).

Reliability labels, source relevance, product completeness, and consistency of
natural-language statements remain declared judgments. The host enforces their
structure and provenance; it does not prove their business semantics.

In the acceptance phase, use:

```json
{"type":"acceptance.put","acceptance":{"key":"reader-ready","statement":"The reader sees Ready","oracle":"A browser observes the exact Ready heading","source":"Original requirement"}}
```

`acceptance.remove` takes a `key`. Keys are stable, limited to 120 characters,
and use lowercase letters, digits, dots, underscores, colons or hyphens. `unit:`
is reserved for host-owned delivery acceptances. IDs, scope, publication state
and revision are assigned by the host; callers cannot supply them. The projected
`requirement-context.acceptance` artifacts are read-only. Rewinding before the
acceptance phase clears its draft entities; revisiting the acceptance phase
rebuilds its projection from the edited entities.

Publication gives each requirement acceptance a permanent UUID derived from its
workspace/issue/key. Its unchanged active meaning keeps the same revision.
Changes or reactivation increment the revision; removal retires the previous
entity in a new stored revision. Retirement does not erase history. Publishing
these entities, freezing planning inputs, and marking context handoff share one
SQLite transaction. A saved terminal context checkpoint can settle after a
restart without treating a native process exit as its conclusion.

## Planning gates

Planning inputs contain every resolved context impact and active requirement
acceptance. Impact references name the actual context draft/key. Acceptance
references name the permanent UUID and exact revision. The contract retains the
original acceptance oracle; the readonly planning projection follows the
original YAML's kind/content/sourceRef fields. Agents cannot replace these
frozen sources.

The planner registers a rationale, 1–50 keyed delivery units, overall coverage,
and ordering/dependency rationale when there is more than one unit. Each unit
has actor, trigger, observable outcome, acceptance meaning, source references,
and prerequisite keys. All source references must exist, all frozen sources
must be covered, and every unit must link a change or acceptance. Repeated
references, repeated dependency keys and duplicate unit titles are rejected.
Dependencies must exist, precede the dependent unit in the declared order, and
form an acyclic graph. The compiled plan expands references from the actual
frozen sources rather than trusting embedded source text from the planner.

Coverage is checked per source key. The host does not prove that a unit covers
every semantic clause inside a source or that units are independently useful.

## Verification and remaining integration

Kernel tests use real SQLite and temporary Git repositories to cover human
answer/resume, role handoff, reliable evidence requirements, frozen planning
inputs, invalid plans, acceptance revisions/retirement, and competing workflow
refusal. API/component checks cover wire mapping, malformed parent controls and
the distinction between a finished plan and delivered work. Go tests cover
context/planner claim instructions and planner visibility before worker access.

`e2e/engineering-requirement.spec.ts` configures the parent workflow through the
actual UI, observes the repository in Chromium, supplies a human option answer,
resumes through the native scheduler/CLI/worker, publishes acceptance identities,
and plans two dependent units. Its task claims are owned fixture metadata; it
does not launch an installed provider or call a model.

Native child-issue publication, scheduling units from their verified prerequisite
versions, and requirement-level final review are the next integration steps.
They are not implemented by compiling a plan. The completion gate rejects a
requirement issue until actual delivery and final review are connected and
passed. The current UI shows planned units and acceptance revisions without
offering another run for a terminal plan. Web/Desktop share these controls;
packaged Desktop and real-provider acceptance remain unverified. Mobile retains
its independent interface.

![Compiled dependency plan and permanent acceptances](assets/requirement-plan.png)

![Narrow requirement-plan layout](assets/requirement-plan-narrow.png)

SQLite publication, PostgreSQL task admission and filesystem observations are
separate boundaries. No cross-database transaction or global exactly-once
execution is established by these checks.
