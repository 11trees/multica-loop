# Native engineering execution ownership

LoopWork's repair takeover drains workspace writers before granting an owned
repair anchor (`repair-takeover.ts` and `execution-processes.ts`). Native task
termination, cancellation and slot availability do not establish that fact. The
native ownership journal and project admission guards supply prerequisites;
Admin takeover and independent repair verification remain unconnected.

## Task preparation and cleanup

An engineering-enabled local runtime receives `engineering_ownership` for tasks
whose native issue or chat belongs to a project. The daemon registers an execution
controller before preparing a workdir, with its actual daemon PID, birth marker,
host boot identity and exact native runtime/dispatch claim. PostgreSQL freezes the
project and original issue or chat scope. A unique live scope prevents replacement
claims from preparing another workspace until the old controller is quiesced.
Independent issues and chats can still run concurrently.

Once preparation finishes, the controller binds the actual directory and execution
mode before native StartTask. Its final receipt runs after worktree finalization,
environment cleanup and path-lock release. A provider exit receipt alone cannot
close that controller. Missing cleanup acknowledgements produce a blocked native
result with `cleanup_unconfirmed`.

Protocol admission is checked through a readonly host operation before preparation
or reservation and after persisting a real PID. Original terminal interventions
continue to block new starts while cleanup receipts remain writable.

The daemon uses its control-plane credential for
`/api/daemon/tasks/{taskId}/engineering-controller`; a task token cannot write these
records. Go projects native task, runtime, workspace and claim identity, rechecking
the native claim under a transaction lock. Bodies cannot supply replacement
runtime or actor identities. Credentials stay outside the private protocol worker.

## Codex process facts

Each physical Codex launch uses synchronous SDK boundaries:

1. Reserve a unique allocation before `cmd.Start`.
2. Persist the actual PID, group ID and birth marker before initialization or
   prompt delivery.
3. Confirm whole-group exit and persist the exit receipt before native settlement.

PostgreSQL retains controllers and their allocations in `engineering_run_guard`
and `engineering_run_process`. A rejected bind still saves the actual PID when
cancellation, protocol surrender or a repair fence won the launch race, then denies the acknowledgement
so the SDK stops the child. Exit and final cleanup receipts remain writable after
native cancellation or project fencing, while the same native claim remains valid.
A new claim cannot rewrite old process identities or cleanup facts.

No-spawn cleanup is explicit and cannot contradict a recorded PID. An unknown
allocation or unsupported invoked provider remains unconfirmed. Native idle gates
include these controllers even after the corresponding task becomes terminal;
configured engineering completion also checks this boundary.

The existing `/engineering-process` API and its business SQLite records remain
available at the public API boundary. Updated native daemons write lifecycle facts
only through the PostgreSQL controller API. Business SQLite still owns repository
bindings and original protocol/intervention state; this is not a dual-write or
fallback execution path. Completion checks both the protocol and native ownership.

## Project admission fences

`engineering_repair_fence` stores a project-scoped management owner, original
observation/source references, generation and phase. Admission obtains a key-share
lock on the native project row before reading the fence. A trusted acquirer must
lock that row for update, insert the fence and commit **before** cancelling tasks
or draining controllers. Waiting admissions then read the committed fence.

Database guards reject dispatched/running admission, new execution controllers,
project changes, project-resource changes and issue/chat project reassignment while
a fence exists. Logical task cancellation and physical cleanup can still finish.
The private Admin action now acquires a draining fence and cancels native tasks.
It does not yet establish physical ownership or release the fence. Its presence or a quiesced controller cannot authorize
repair writes or business completion.

## Verification and remaining work

PostgreSQL-backed handler fixtures cover control-plane identity, strict native
claim binding, project chats, replacement claims, immutable PID/cleanup facts,
no-spawn receipts, missing physical exit, completion after final controller cleanup,
and project mutation guards. A concurrency fixture observes the actual PostgreSQL
lock wait and proves admission rejects a fence committed while it waited.

The native daemon fixture runs a test-created Codex executable through the real SDK
and bundled worker. It checks controller admission, actual-workspace binding,
pre-prompt PID acknowledgement, rejected reservations/bindings and lost exit/final
cleanup acknowledgements. SDK fixtures separately test process-group shutdown and
callback ordering. No installed provider or account is resolved by these fixtures.
The existing browser intervention scenarios exercise the retained public process
API with known no-spawn allocations; they do not run a provider or prove Admin
workspace takeover.

Independent Admin requests and native source inspection are connected. An API-owned private Unix bridge cancels project issue/chat tasks through the native service only behind a committed matching repair fence, retaining cleanup barriers. Original checkpoint revision/receipt and native claim validation, draining-fence acquisition and same-source predecessor handover are connected. Physical draining of every writer, owned repair access, takeover revocation/release and separate repair verification still require migration. Shared paths attached to different projects,
remote physical recovery, stale-claim cleanup after runtime reassignment, other
provider lifecycle adapters and legacy unrecorded executions need their own proofs.
A terminal task or an empty set of known allocations cannot replace missing facts.

### Original repair source

The private business worker's host-only `repair-source` action takes the original
`observation_id`, acknowledged `case_id`, and `snapshot_hash`. It verifies the
immutable receipt, exact delivery acknowledgement and current surrendered
checkpoint. Direct requires the same active attempt and unfinished contract;
YAML requires the original role, revision and exact saved draft. Both require the
original daemon repository binding. Callers cannot provide replacement paths.
The result distinguishes registered repository from actual execution directory,
and retains the original code, kernel and API versions and receipt hash.

This is a read-only source description, not a takeover receipt. It reads saved
bindings even if cleanup removed the directory; it neither recreates the path
nor proves it still exists. The Go takeover coordinator must additionally verify
the native task dispatch claim, project/resource mapping, source-version
authority and current management lease before acquiring a fence, and revalidate
after draining. The independent host now inspects durable Admin requests against the native dispatch claim and project/runtime directory mapping. The private API now acquires and commits the draining fence before native cancellation. Physical draining and owned repair access remain incomplete. Observation delivery still
preserves historical faults even when their native claim is no longer current;
historical evidence alone cannot authorize a new repair.
