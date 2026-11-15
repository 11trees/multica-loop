# Independent Admin observation, supervision and investigation

The current LoopWork baseline routes role-requested `agent-fault` interventions to
independent Admin management. The source implementation is
`repair-observation-bridge.ts`, `admin-management-store.ts` and
`admin-controller.ts`; the old assistance loop excludes these faults.

## Implemented boundary

The target now has an independent management database at
`<engineering-database>.admin.sqlite`, an Admin-only worker mode and a separate
Go worker client/mutex. Management RPC does not initialize the business database;
each database rejects the other's schema. The Admin database has its own version,
WAL storage and full SQLite synchronization.

A new terminal request freezes the SHA-256 of the actual bundled protocol worker
and the running API executable. These are original runtime facts, rather than the
current checkout HEAD. The immutable original checkpoint and receipt remain in
business storage. Older receipts without these facts are not silently assigned
a newer runtime version and cannot enter this bridge until explicitly reconciled.

The Go bridge reads pending immutable observations, validates their native
workspace/issue/task/agent identity, and sends the original evidence and runtime
versions to management. The native source claim remains in the evidence; a later
claim timestamp does not rewrite the original failure. Closed/Done native issues
are not newly admitted by this increment.

Management persists an observation and its Case in one transaction. A stable
observation ID cannot be reused with changed evidence. Work-item cohort identity
uses the native workspace, issue and chain, retaining different signatures as
separate observations inside one Case. Original summary/version remain unchanged.
An Admin-origin fault must reference an existing Case in the same workspace;
it cannot recursively create an Admin for itself.

Only after management returns the exact Case/cohort does Go acknowledge delivery
against the original business observation ID and checkpoint fingerprint. A separate
business delivery record preserves the terminal receipt unchanged. A crash between
the two stores replays the same observation and reuses the same Case. A second
acknowledgement cannot rebind it. Delivery acknowledgement never resumes the
surrendered issue, spends a rework budget or grants Done.

## Supervision

Managed engineering startup launches `multica engineering admin-host` as a separate
process, outside the API and ordinary native agent slots. `make up`, `make status`
and `make down` own it as the `admin` component. The API only reads issue-scoped
management projections. The host acquires a 30-second owner/token lease and renews
every 10 seconds. Observation discovery and execution polling run independently,
so a blocked business read cannot starve either supervision or investigation.
A concurrent host cannot acquire an unexpired foreign lease. Expired ownership
advances the token; stale commands cannot modify the new owner's state.

The initial intent remains `stopped`, with no provider configured. Starting the
host does not discover executables, inspect model accounts or start a provider.
Investigation requires an explicit absolute executable, a runtime revision and a
durable start intent. Only the Codex protocol has the pre-prompt process binding
needed by this increment; macOS and Linux process identities are implemented.
Only the macOS fixture path has been executed in this checkout.

## Local operator commands

Run these from the checkout through its managed environment. They use local OS
access to the management worker, without a network management endpoint or a human
API token. `--provider-path` must name the executable chosen by the operator;
configuration alone does not execute it.

```sh
make env-exec ARGS="-- server/bin/multica engineering admin-control status"
make env-exec ARGS="-- server/bin/multica engineering admin-control configure --expected-revision 0 --provider-path /absolute/path/chosen-by-operator"
make env-exec ARGS="-- server/bin/multica engineering admin-control start --request-id operator-start-1"
make env-exec ARGS="-- server/bin/multica engineering admin-control stop --request-id operator-stop-1"
```

The example path is deliberately not a discovered/default provider. Do not start
a real model during migration acceptance without explicit authorization. Runtime
configuration can change only while stopped and after the previous allocation has
confirmed physical exit. Each new start/stop request increments the intent
revision; retrying the exact request ID reuses its receipt. A stop receipt confirms
the desired intent, not physical cleanup: read `status` until `active` is empty.
A native task or an investigation invocation cannot use these management commands.

## Investigation and physical ownership

The management database schema is version 2. It freezes one invocation generation,
session identity, runtime revision and recovery method per allocation. A durable
fair queue rotates Cases, with at most one live investigation process globally.
There is no fallback executable discovery or unconfigured alternate runtime.
Failures continue repair; an attempt count alone never creates a human question.

The SDK binds the actual PID, process group and birth marker before initialization
or prompt delivery. Rejected bindings stop the owned process tree. Stop, lost
supervision or changed intent cancels the invocation; the host retains an uncertain
allocation until physical exit is confirmed. A successor checks the saved process
identity before signalling it. A missing identity is held for reconciliation,
rather than interpreted as a stopped process. Only the same live owner can retire
a launch it knows never spawned or whose owned process exited before binding.
Shutdown does not explicitly release supervision when exit remains unconfirmed.

Each invocation gets a private working directory, log and Unix command socket.
Go retains the opaque command credential and projects the exact Case, generation,
session and supervision identity into the worker. The provider does not inherit
business database or Multica API credentials. This is a local trusted-operator
boundary, not an OS sandbox for a hostile same-user process.

The investigation commands are `engineering admin status`, `history`, `evidence`
and `submit`. Status must be read before evidence or submission. Bounded previews
include row hashes and lengths; history reads pin an exact row hash. Evidence keys
and terminal submissions are immutable. JSON files must be UTF-8 inside the
invocation's private `TMPDIR`; ordinary final text or a successful process exit
cannot substitute for a structured submission.

This increment accepts `deferred` investigation results and retains the failed
attempt and original observations while requeueing the Case. Verification and
diagnosis requests require scoped workspace takeover, and external waits require
independent diagnosis; these are explicitly rejected while their prerequisites
remain unconnected. No investigation receipt closes the Case or resumes business.

## Native visibility

The existing authenticated engineering overview looks up repair status only for
its native workspace/issue. The shared Web/Desktop panel shows the recorded Case,
retained-observation count and waiting-for-setup state. Management unavailability
leaves the original intervention readable and reports repair status as unavailable.
No task credential receives management supervision authority or a management RPC
endpoint. Runtime configuration and start/stop currently use the local CLI; shared
Web/Desktop execution controls are not yet connected. Original investigation evidence remains available on the issue.

## Verification boundary

Store tests cover separate-database rejection, immutable ID replay, cohort retention,
restart, workspace isolation, Admin self-fault linkage and expired supervisor tokens.
The two-store fixture interrupts delivery before acknowledgement and proves replay
without duplicate Case creation or business advancement. A bundled-worker fixture
checks management-only initialization and rejects reversing database roles.
Schema-upgrade checks retain existing observations and keep execution stopped.

Fake-provider integration runs the real SDK process lifecycle and bundled worker,
asserting PID binding before the first command, private status/evidence/submit,
retained deferred results, cooperative user stop and confirmed group exit. Separate
checks refuse a wrong birth marker and unknown allocation identity; CLI checks
keep human credentials out of the invocation protocol. Race-enabled checks passed. The complete protocol kernel passed 254 tests across
23 files; the PostgreSQL-backed engineering handler checks, kernel typecheck/lint,
Go vet and environment registry checks also passed. Linux cross-compilation passed;
no Linux process was executed.

Go tests cover native source validation, interrupted acknowledgement, exact runtime
version projection, unavailable management reads and heartbeat progress while
business discovery is blocked. All investigator processes in these checks are test-created fixtures with isolated homes. No installed model executable or account is resolved.

Both controlled native browser scenarios passed against the independent host in 37.6 seconds. Direct and
verification requests reached one acknowledged management Case with exact worker
and API executable fingerprints. The shared UI displayed the retained Case at
1280 and 390 pixels, while ordinary continuation and Done stayed blocked. These
runs used fixture-native tasks and no provider process.

![Direct repair Case](assets/admin-case-direct-1280.png)

![Direct repair Case at 390 pixels](assets/admin-case-direct-390.png)

![Verification repair Case](assets/admin-case-verification-1280.png)

![Verification repair Case at 390 pixels](assets/admin-case-verification-390.png)

Scoped workspace takeover, repair workspace/build actions, independent diagnosis,
repair verification, external dependency probes, verified business handoff and
runtime updates remain unconnected. Real-provider, Linux runtime and packaged
acceptance remain unverified. The complete migration stays active.
