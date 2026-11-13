# Engineering verification service

The local fork can run independent verification, optionally following development,
through the native Multica CLI. Go authenticates each request, projects the human/run identity, and
invokes a bundled Node worker over private stdin/stdout. The worker owns frozen
contracts and drafts in a local SQLite database. It receives no bearer credential,
JWT signing key, or PostgreSQL credential. There is no additional HTTP listener.

## Start and configure

Set `MULTICA_ENGINEERING_ENABLED=true` in the checkout's ignored environment file.
Restart through `make down` and `make up C=api,web`. The managed environment builds
`packages/command-chain/dist/worker.mjs` and assigns its own
`<environment-state-directory>/engineering.sqlite`. `make down` preserves that
database. Node 22.13+ and Git are required on the API host.

For an independently launched backend, build with
`pnpm --filter @multica/command-chain build` and explicitly set
`MULTICA_ENGINEERING_WORKER` and `MULTICA_ENGINEERING_DATABASE` to absolute paths.
Do not share the same engineering database between server processes; the initial
local adapter serializes application operations inside one Go host.

Build the CLI from this fork; the daemon's task-local CLI must include the new
`engineering` command. An older installed CLI cannot execute these commands.

```sh
go -C server build -o bin/multica ./cmd/multica
server/bin/multica engineering configure <issue-id> --payload-file ./verification.json
```

The human's JSON payload contains:

```json
{
  "expected_revision": 0,
  "agent_id": "<verifier agent UUID in this workspace>",
  "repository_path": "<absolute path to the repository on the API host>",
  "sources": [
    {
      "key": "ac1",
      "kind": "acceptance",
      "description": "The required observable behavior",
      "oracle": "How the result will be judged",
      "sourceRef": "The frozen requirement or acceptance reference"
    }
  ]
}
```

All sources need stable keys and references, and at least one must be an
acceptance. Other kinds are `focus`, `guardrail`, and `recovery`. The server
checks the agent's workspace and the human's issue visibility. The worker resolves
the real Git root, rejects tracked/untracked changes, reads HEAD itself, and hashes
the frozen source/revision content. Code and contract versions are never supplied
by the agent. Keep test artifacts in ignored locations or outside the checked
repository. Repository paths currently refer to the API host, so remote-daemon
checkout mapping is not supported yet.

To run development first, also supply a different `developer_agent_id` and
nonempty `implementation_guidance`. See [development handoff](development-handoff.md)
for captured check requirements and supported runtimes. The CLI selects the
current role from the task identity and transfers the committed snapshot to
the verifier after development finalization.

One contract revision owns one draft. Repeated `start` calls on the same run
return its checkpoint. Replacement requires the expected current revision and
a completed or explicitly abandoned draft; old contract revisions remain stored.

## Agent and human commands

At claim assembly, the configured verifier receives instructions to use the
native CLI. Other agents/issues receive no engineering instruction. An enabled
but unavailable role lookup fails the claim instead of silently omitting the
protocol. Commands use the run's existing `MULTICA_TOKEN` and server/workspace
environment. The caller cannot choose an issue, role, or attempt in these commands.

```sh
multica engineering start
multica engineering status
multica engineering command --payload '{"expected_sequence":0,"command":{"type":"phase.complete"}}'
```

The response includes the frozen contract, draft/sequence/phase, schemas,
instructions, questions, artifacts, and final conclusion when ready. Every agent
operation rechecks the repository binding. Development can resume its partial
uncommitted edits; review/check evidence remains tied to the actual tree, and
final handoff requires a clean commit. Verification requires its pinned clean
commit. A changed frozen version needs an explicit new revision, not a rewritten
oracle.

Runtime-input commands persist questions; `phase.complete` then suspends the
unfinished phase. The agent must return control when `waiting_for_answers`.
Only an authenticated human can inspect/answer/abandon through the issue API:

```sh
multica engineering inspect <issue-id>
multica engineering answer <issue-id> --payload-file ./answer.json
multica engineering abandon <issue-id> --payload-file ./abandon.json
```

An answer payload has `expected_sequence`, `request_id`, and `answer`.
An abandon payload has `expected_sequence` and `reason`. The answering/abandoning
user is derived from the session/PAT, never a JSON field. A new run of the same
verifier uses `start` to resume after all answers arrive. Answers do not make
blocked observations pass. The [shared issue controls](human-controls.md) expose
configuration, answers, progress, and explicit Run/Continue actions. Starting a
new run is manual unless the contract enables `auto_continue`. With that policy,
the [host coordinator](automatic-continuation.md) queues the verifier after
development handoff and resumes fully answered question batches. Existing
contracts and CLI payloads that omit the field remain manual.

## Verification and limits

Package tests cover actual Git repositories, dirty/changed commits, pinned
contracts, one-draft start, role restrictions, question recovery, abandonment,
and the distributable worker bundle. Backend tests cover actor projection and
claim instruction assembly. A live fixture check uses the built native CLI,
running Go API, actual worker/database, human answer API, and a clean temporary
Git repository:

```sh
go -C server build -o bin/multica-engineering-test ./cmd/multica
MULTICA_ENGINEERING_CLI="$PWD/server/bin/multica-engineering-test" \
  make env-exec ARGS="-- pnpm exec playwright test engineering-service.spec.ts"
```

The check passed without starting an agent CLI or model. It exercises fixture
observations, not a real delivered business change. Its fixture helper removes
its own PostgreSQL/SQLite records. Normal issue-deletion retention/cleanup for
engineering history remains an application integration task.

The service now [checks issue completion synchronously](issue-completion.md),
including human/agent updates, batches, PR automation, and workflow remaps. A
passed current independent verification is required for a registered issue's
done-category write. Native execution now requires a project local-directory
resource and a runtime-owned [repository binding](repository-binding.md); both
in-place and pinned-worktree modes are supported on the API host. The other
chains, additional provider receipt adapters, automated failure/rework,
remote clone mapping, and cross-database handoff
acceptance remain required for cutover. Successful process exit is not evidence
of engineering delivery.
