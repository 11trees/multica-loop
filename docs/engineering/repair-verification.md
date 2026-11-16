# Independent repair verification

LoopWork's `independent-verification-preparation.ts` derives targets from original
failures. A repairer's command suggestions cannot define independent acceptance.
This migration connects submission, private host preparation, physical handoff,
separate independent Test allocation, fresh source authorization, frozen check
preparation and native check execution with physical receipts. Scoped
[repair writes and candidate capture](repair-workspace.md) are connected;
verified business handoff remains incomplete.

## Request and fresh candidate binding

A live investigator first reads status, obtains an owned native takeover and
records immutable repair evidence. Its `verification-requested` submission must
name the current host-observed `workspace-content-v1` version, every original
non-Admin observation in the Case and saved evidence keys from this attempt,
including the host-created `native-candidate/<key>` receipt from its write grant.
Missing/foreign/duplicate references, a draining fence and stale versions are
rejected. The first terminal submission remains immutable.

The private command runner persists the request, then invokes a host callback
before returning its success response. An unavailable callback accepts no request.
The callback rechecks the original native source and owned writer inventory,
reads actual registered-root content, revalidates authority and the same owned
cohort after the read, and prepares the input in separate management storage.
A changed candidate cannot be authorized by an earlier cached progress receipt.
A callback failure retains the submitted request as history; its exact retry can
succeed only if its original candidate and authority still match.

## Frozen input

Schema 5 added `admin_verification_input`; schema 6 adds the independent plan
store and includes never-launched waiting Tests in the single active-slot index.
Schema 7 adds ordered `admin_verification_check` records and immutable
`admin_verification_receipt` records for native execution.
Schema 8 requires native write/candidate receipts and pins the exact candidate
hash in the independent input envelope. Older settled prepared Cases requeue for
repair while their prior input and original history remain retained.
Upgrades retain original Cases, observations and stopped intent. The host freezes the repair attempt/generation,
intent and supervision identity, project/runtime and both repository paths, exact
native source/checkpoint and writer-inventory hash, expected content version,
complete original observations and derived target references.

Direct retains its full original input plus the full execution/failure snapshot.
YAML checkpoints retain every frozen source key/oracle, the entire original
contract/execution input and the original failure. Conflicting or missing target
identities are rejected. The repairer's proposed reproduction, version commands,
acceptance checks and replacement targets are stored only in its submission;
they are excluded from the independent input. No command is executed by this gate.

The input has a content hash, is revalidated on read and cannot be replaced.
Status exposes only its hash, expected version and target count. The private host
can read the complete retained input with management authority; this historical
read is not authorization to schedule or execute a Test invocation.

## Physical handoff

An unconfirmed repair process keeps the invocation and Case running. Only a
confirmed physical exit, a prepared input and unchanged original references and
cohort move the Case to `verifying`. Here that status means waiting for independent
verification. It is not a passing Test result. A missing/stale preparation requeues
the Case and retains its failed attempt and original request. New original facts
before settlement also require a fresh attempt. The original business intervention
and native repair fence remain held; nothing closes, resumes or completes business.

Controlled tests cover multiple original failures, full Direct/YAML targets,
repairer-proposal exclusion, immutable restart, stale content/cohort/authority,
damaged input and schema upgrades. The bundled worker and private native socket
test changes a real temporary repository after submission, proves rejection,
restores the submitted content and proves preparation plus physical handoff while
business remains blocked. Runner tests require the callback before replying.
They use test-created fixtures, not installed provider discovery or real models.

## Separate independent Test preparation

A waiting-verification Case allocates a new `verification` generation, session
and frozen explicit runtime, with a reference to the exact physically settled
repair input. It clones only the original takeover source and does not inherit
an owned receipt. Native reconciliation hands the original project fence to the
new generation only after predecessor exit, then rechecks the native source,
actual content version and exact writer inventory. The host repeats this gate
before launch and around preparation persistence.

A durable `waiting` state means no launch reservation exists. Host replacement
or stop can cancel that state without inventing process-exit evidence; unchanged
originals return to waiting verification, while changed originals return to
repair. `verification-launch` validates fresh ownership and reserves `launching`
before spawning. Unknown launching/running identities continue to hold their
physical barrier. No Test can use Admin status/evidence/submit commands.

The Test process receives original facts and plan-output paths in a new private
directory. It has no Admin command socket/token or business database authority. Its
verification context also prevents CLI fallback to human profile/token and
refuses human login, local configuration and management commands.
Its actual group/PID/birth identity is bound before prompt delivery. It authors
only reproduction and exact-target acceptance commands; version/reference/pass
fields are rejected. The host requires confirmed process-group exit, unchanged
original-facts bytes and actual source version, and full frozen-target coverage
before persisting the plan. Repairer-proposed checks remain excluded.

The complete generated directory is retained, including scripts, imports, data,
plan, original facts and empty directories. Two content scans record file modes,
paths and digests; links, special files and changed inputs are rejected. Capture
is bounded at 10000 entries and 256 MiB. The manifest is hashed and stored with
the host-bound input identity. Physical settlement moves a successful preparation
to `verification-prepared`, which is waiting for actual native checks, not a pass.
Failed preparations retain their original Case and history. New original facts
invalidate prepared readiness without deleting the old plan or artifacts.

Real SDK lifecycle tests use a test-created provider and a real temporary
repository. Complete plans are retained; omitted targets and source edits fail.
Artifact checks reject hard/symbolic links and detect permission/empty-directory
changes. The bundled PostgreSQL/private-socket test hands the fence to the new
Test generation and rejects a changed candidate before launch. These are controlled
fixtures, not real-model acceptance.

## Native execution and immutable receipts

A prepared Case allocates a new `verification-execution` generation bound to the
exact completed Test preparation, input hash and plan hash. It reacquires the
original native source/cohort and current content authorization; preparation does
not lend it an owned receipt. Before execution the host checks the complete
artifact manifest and compares the commands with the retained independent
`verification-plan.json` witness.

The host launches its own explicit executable as a credential-free native worker
in a separate process group. It binds the actual PID, group and birth marker
before sending commands over private stdin. Each step is durably started before
delivery; steps cannot be skipped, replayed or continued after failure. The order
is a host content-version read, original reproduction, every frozen acceptance
command, and another host content-version read. Version reads are host-owned;
the independent Test cannot supply them or a passing verdict.

The worker executes actual shell commands against the frozen registered root.
The host rechecks native source and artifacts around each step and records actual
stdout, stderr and exit code with worker identity, physical group quiescence,
source validity and artifact validity. Each output stream is bounded at 2 MiB;
truncation fails verification. Timeouts, missing exits, surviving children,
source/artifact changes and nonzero exits cannot pass. Logs remain outside both
the project and frozen artifacts under the host's `verification-runs` directory.

After stopping the owned worker group, the host freshly revalidates native source
authorization and compiles an immutable receipt from the ordered records and
physical exit facts. Final settlement recompiles and compares the entire saved
receipt. Only a complete passing result with confirmed physical exit moves the
Case to `verified`. New original facts return it to repair while retaining old
checks and receipts. Admin stop cancels the owned process group; uncertain exits
keep their barrier. This does not establish immediate cancellation from every
business UI action or control detached external processes.

Controlled Runner tests use a test-created SDK provider, real temporary Git
repositories and real shell/Node checks. They cover successful checks, assertion
failure, changed source/artifacts, plan metadata substitution, timeout, output
overflow, surviving children and Admin stop. Kernel tests reject reordered or
replayed checks, replaced receipts, incomplete evidence and a failed final native
scope gate. Separate PostgreSQL/private-socket tests cover source authorization
and predecessor fence handover; they do not establish one complete real-provider
production run. Linux cross-compilation is not Linux runtime acceptance.

Still required: verified business handoff and broader recovery. Running-service
identity, runtime repairs, isolated repair builds and shared-path
ownership retain their separate acceptance requirements. A `verified` repair
Case does not release the business fence, resume the interrupted task, replace
the Team's normal delivery verification or satisfy native Done. Real-provider
and packaged acceptance remain unverified.
