# Command chain kernel

This package imports the LoopWork authoring format independently of a database,
runner, agent CLI, Multica API, or UI. The host supplies the chain identity,
available builtins, mandatory builtin order, metadata keys, and repository
adapters. YAML cannot define executable commands, validators, or transitions.

The loader validates syntax, references, writable block boundaries, and the
mandatory builtin sequence. `CommandChainEngine` adds phase execution and
durable drafts through an injected `DraftStore`. Business builtin implementations
and trusted Multica integration remain separate work.

The identifier grammar excludes numeric keys so YAML declaration order survives
JavaScript object enumeration. Only authoring format version 1 is accepted.

## Draft execution

- Creation pins the entire definition, issue/workspace, contract revision,
  code version, inputs, and run attempt. Editing source YAML does not silently
  change an existing draft.
- Agent commands can put/remove artifacts in the current phase, set inputs
  in a metadata phase, complete a phase, or rewind to an earlier phase with
  a reason. YAML objects reject undeclared fields, missing required fields,
  invalid enums, and invalid array cardinality. Singleton and keyed blocks
  retain their distinct cardinality.
- Completion checks required artifacts and phase inputs. Confirmation phases
  require an explicit recorded statement; this statement is an agent assertion,
  not human approval or proof of a Git commit.
- Builtins require host-supplied handlers. Missing handlers and failed validators
  stop completion without changing stored state. A handler can produce validated
  artifacts and freeze existing items. Handlers must be side-effect free:
  the store atomically commits their output and phase progression, but cannot
  roll back an external operation.
- Frozen items cannot be replaced or removed. New keys may be appended.
  Rewinding clears completion and freezes at/after the target, and removes
  artifact blocks whose first owning phase follows the target. Rewinding
  development to implementation therefore invalidates downstream review;
  rewinding verification to plan clears results and unfreezes scenarios.
- Every mutation checks both the run attempt and expected sequence. Host-only
  `resume` changes the attempt without losing the checkpoint. Atomic store
  compare-and-swap rejects competing writes. Completed drafts are immutable.

`@multica/command-chain/sqlite-store` exports a local `SqliteDraftStore` reference
adapter using Node's built-in `node:sqlite` (Node 22.13+). Create its parent
directory before opening a file and close it on shutdown. Each draft is one
atomic snapshot including its event history; this is intentionally an initial
local adapter, not the final evidence archive. No application imports it yet.
The main package entry has no Node or database imports. Other adapters must
honor the same atomic create/compare-and-swap contract.

The engine does **not** authenticate Multica runs, execute engineering builtins,
capture shell receipts, judge evidence truth, wait for human answers, or change
issue status. Callers must derive identity and version bindings from trusted
host state. A draft marked `completed` only means its configured handlers and
phase checks accepted it; no production delivery result or handoff is issued.

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
host-owned execution rules. Runtime tests exercise actual SQLite files in
temporary directories, reopen the store, supersede run attempts, race two
connections, and invalidate downstream output. Test builtin handlers are
deliberate stubs; they are not implementations of LoopWork engineering gates.
These fixtures are migration evidence, not live configuration. No agent
accounts or user databases are accessed by these tests.
