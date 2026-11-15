# Native engineering process ownership

LoopWork's repair takeover drains physical workspace writers before granting an
owned repair anchor (`repair-takeover.ts` and `execution-processes.ts`). Native
Multica task termination, cancellation and slot availability do not establish
that physical fact. This journal supplies the prerequisite for that takeover;
it does not grant repair write permission by itself.

## Connected lifecycle

Engineering Codex runs now use three synchronous SDK boundaries:

1. Before `cmd.Start`, reserve a unique physical allocation against the exact
   native task claim and its previously acknowledged repository binding.
2. After starting the owned process group, persist the real PID, group ID and
   birth marker before initialization or prompt delivery.
3. After the SDK reaps and confirms the whole group has exited, persist the exit
   fact before publishing the native result. A missing exit acknowledgement
   produces `cleanup_unconfirmed`; the daemon maps it to a blocked native result.

Each physical retry reserves a new allocation. The daemon uses its control-plane
credential for `/api/daemon/tasks/{taskId}/engineering-process`; a task token cannot
write these records. Go derives workspace, issue, agent, runtime and claim identity
from native records. Request bodies cannot supply a replacement runtime or actor.
The daemon captures the host's boot-session identity locally. Go keeps credentials
outside the private protocol worker.

Two business-side SQLite tables retain repository bindings and process allocations.
They are independent of Admin's investigation-process allocation. Bindings freeze
the actual directory, execution mode and project for a native claim. A PID/birth
identity cannot be replaced. Allocation IDs and exit receipts are immutable, and
an unconfirmed allocation blocks new provider starts for the same native issue,
including replacement claims. Other issues are not globally serialized by this
journal.

Protocol surrender blocks new reservations and PID binding, while permitting the
same runtime to record physical cleanup afterward. Cancellation can also report
cleanup after the native task becomes terminal, provided its claim remains current.
The completion and verified-binding checks reject pending physical allocations.
An unrecorded older run is not assigned invented process metadata.

## Verification and limits

Store tests cover binding and project identity, claim replacement, immutable birth
identity, unknown exit, idempotent cleanup, host/claim isolation and surrender.
Application tests exercise cleanup after Direct surrender without releasing its
original intervention. PostgreSQL-backed handler tests check control-plane identity,
stale claims, forged runtime fields and cleanup after native cancellation.

An isolated native daemon fixture runs a test-created Codex executable through the
real SDK and bundled worker. It verifies repository binding before reservation,
PID acknowledgement before initialization, normal exit receipts, rejected reservation
without prompt delivery and lost exit acknowledgement retaining a blocked allocation.
SDK fixtures independently check callback ordering, rejected pre-spawn reservation,
rejected PID binding and missing exit receipt. No installed provider or account is
resolved. macOS execution is verified; Linux process identity is compiled separately.

The complete kernel passed 257 tests across 24 files. All 43 PostgreSQL-backed
engineering handler tests passed with the race detector. Native daemon, SDK and
Admin regression fixtures passed, as did kernel typecheck/lint and Go vet.
The two browser scenarios passed in 50.5 seconds against the managed API: each
reserved a known no-spawn allocation, proved native task termination and an
unconfirmed cleanup could not grant Done, then recorded actual no-spawn cleanup
without weakening the original Admin intervention. Their process and binding
records were removed by scoped teardown. These browser allocations did not run
a provider; the actual SDK lifecycle is exercised by the separate native fixture.

The journal currently covers the Codex protocol path, not all provider families or
legacy unrecorded runs. Remote physical recovery, stale-claim cleanup after runtime
reassignment, project-wide admission fences, draining other writers, takeover
revocation and independent repair verification still require migration. A terminal
task or a journal with no known allocation cannot stand in for those missing proofs.
Admin workspace takeover remains unconnected until those ownership checks exist.
