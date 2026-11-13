# Business analysis protocol

The four authoring definitions are imported from the read-only LoopWork baseline
`17982f2b93100b42d65ed650869c9cc97ff92b5a`. YAML comments were removed; parsed
definitions, declared fields, instructions, phase order and rendering flags match
the source. This is a protocol implementation, not a connected native workflow.

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

The executable worker still embeds the existing nine delivery definitions.
Business definitions and handlers are available in the pure package but are not
yet selected by an API, CLI, UI, task claim or coordinator. The following must be
connected and accepted before calling this a migrated Business Analysis pipeline:

- Freeze native roles, original input, source definitions, principal and project;
  retain historical stage revisions and exactly one active owner.
- Bind readonly native attempts, supersede downstream revisions on structured
  returns, and retain authenticated upstream decisions with their original scope.
- Publish the independently reviewed specification. In standalone analysis,
  require authenticated reading of its exact current version; native specification
  comments must revise Spec/Review without replacing Intent/Design.
- In End to End, automatically hand the exact approved specification and its
  provenance to requirement context using the initially authorized roles. This
  must not introduce an extra manual approval or claim delivered code.
- Enforce native completion and current comment/run checks through Go, with
  shared Web/Desktop controls and actual native browser acceptance.

See the [coverage audit](migration-status.md) for the remaining migration scope.
