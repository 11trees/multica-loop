# Multica run binding

`GET /api/engineering/run` resolves the current engineering caller from a
normal Multica `mat_` bearer credential. It runs behind the existing auth and
workspace membership middleware. Human sessions/PATs, expired credentials,
non-running tasks, and tasks without an issue/runtime are rejected. Client
task, agent, issue, and attempt selectors do not determine the returned identity.
The owning agent and issue must belong to the credential's workspace, and the
issue must be visible to its owner.

The response has `api_version: 1`, workspace/issue/task/agent/runtime IDs,
the task's attempt counter, a `claim_id`, and an `attempt_id`. The claim ID is
the dispatch timestamp in Unix microseconds; the attempt ID combines task ID
and claim ID. Reclaiming a dispatched task refreshes that timestamp without
necessarily incrementing the attempt counter, so the counter alone is not a
sufficient identity. A token created before the current dispatch timestamp is
rejected at this endpoint, even if it has not expired. Responses are not cached.

## Kernel bridge

`MulticaRunClient` accepts the API origin and the run's injected task bearer
token, rejects redirects, and validates the complete response before exposing
camelCase context. It does not send client-supplied identity headers.
`MulticaChainBridge` receives host-owned role configuration, a loaded chain,
an engine, and a `resolveBinding` port. For every create/read/edit/resume it
resolves fresh run context, checks the configured agent and chain role, and
checks the workspace/issue/revision/contract/code binding. Mutation and resume
use the host-returned attempt ID; there is no agent-supplied attempt argument.

The integration must implement `resolveBinding` from authoritative frozen
contracts and checked repository state. The bridge rejects a changed binding;
it cannot establish that a callback returning a static code label describes
the actual checkout. Definition changes do not rewrite an existing draft's
pinned phase snapshot. Establish a new delivery revision when its binding changes.

Human answers remain a host-only engine operation. The task-token bridge does
not expose it. A human-facing integration must authenticate a real member and
derive their user ID before answering; local single-user login supplies that
identity through the normal session. The [engineering service](engineering-service.md)
now exposes authenticated human answer APIs and uses an actual Git-backed binding.
The [shared issue controls](human-controls.md) now show questions and support both manual and authorized
[automatic continuation](automatic-continuation.md).

## Verification and remaining boundary

Backend tests use the real auth/workspace middleware and a real managed test
database, covering credential identity, workspace selection, wrong agents,
terminal task states, expiry, forged human headers, and reclaimed credentials.
Kernel tests cover malformed context, current host binding checks, role checks,
stale contract/code versions, and old-claim writes after takeover.

Run the cross-service fixture check against the running managed environment:

```sh
make env-exec ARGS="-- pnpm exec playwright test engineering-run.spec.ts"
```

It requires local single-user mode and the managed database. `TestApiClient`
creates an issue and owned fixture runtime/agent/task/token rows, without
starting an agent CLI or model. The bridge calls the running Go HTTP endpoint,
persists verification state to a temporary SQLite file, reopens it, records a
host-provided human answer, simulates a reclaimed claim, rejects its old token,
resumes the same frozen plan, and compiles the fixture conclusion. Cleanup
removes only its own issue/runtime/agent/task/token rows and temporary storage.
This check has passed; it does not prove daemon dispatch, model execution,
human UI authentication, real observation capture, or a tested repository commit.

This is a current-run lookup and kernel bridge, not a synchronous delivery gate.
An HTTP context read and kernel write are separate operations. Other Multica
endpoints retain their existing task-token policy; this endpoint does not
globally revoke old credentials. The local application adds native CLI execution,
durable contracts, claim instructions, and a separate synchronous
[issue completion check](issue-completion.md). Specification-failure reanalysis/arbitration and cross-database handoff acceptance remain required before cutover.
