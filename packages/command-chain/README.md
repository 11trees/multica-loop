# Command chain definitions

This package imports the LoopWork authoring format independently of a database,
runner, agent CLI, Multica API, or UI. The host supplies the chain identity,
available builtins, mandatory builtin order, metadata keys, and repository
adapters. YAML cannot define executable commands, validators, or transitions.

The loader validates syntax, references, writable block boundaries, and the
mandatory builtin sequence. Its output is an authoring definition and phase
order, **not an executable chain or evidence of completed work**. Builtin
implementation, draft persistence, artifact validation, resume, execution
identity, and Multica handoff authorization are subsequent migration steps.

The identifier grammar excludes numeric keys so YAML declaration order survives
JavaScript object enumeration. Only authoring format version 1 is accepted.

## Verification

```sh
pnpm --filter @multica/command-chain test
pnpm --filter @multica/command-chain typecheck
pnpm --filter @multica/command-chain lint
```

`fixtures/development.yaml` and `fixtures/verification.yaml` are unchanged
copies of LoopWork's `command-chains/default/dev-agent.yaml` and
`command-chains/default/test-agent.yaml` from commit
`17982f2b93100b42d65ed650869c9cc97ff92b5a`. Tests exercise both real definitions
and rejection of changes that would remove verification stages or inject
host-owned execution rules. These fixtures are migration evidence, not live
configuration. No agent accounts or user databases are accessed by these tests.
