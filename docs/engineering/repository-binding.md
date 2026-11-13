# Local runtime repository binding

The engineering contract registers a clean repository and freezes its commit.
The runtime must separately bind the directory it actually prepared. An issue's
project needs a native `local_directory` resource for its daemon, pointing into
that registered repository. Both `in_place` and `worktree` execution modes are
supported on the API host's local filesystem. A clone with similar contents is
not a mapping: the resolved Git common directory must match.

## Native execution

Claim assembly includes `engineering_repository` and `engineering_commit` for
the configured current role. A development continuation selects the latest
bound delivery branch's commit; a verifier always receives the exact frozen
development handoff commit. An engineering claim without a matching native
local-directory environment is rejected before provider execution.

For worktree mode, native preparation checks out that full commit into a fresh
task branch. It does not replay the user's dirty checkout or silently continue
an unrelated conversation branch. Existing source edits remain in the user's
directory. Native cleanup reclaims the prepared worktree after execution while
retaining its named branch, including an unchanged pinned snapshot. A subsequent
claim can continue the branch's current commit through a new prepared worktree.

Before provider execution, the daemon calls
`POST /api/daemon/tasks/{taskId}/engineering-repository` with its claim timestamp,
prepared `work_dir`, mode, and generated-file digests. The endpoint requires the
owning control-plane PAT/JWT and a currently running matching claim. Task tokens
and per-task Remote-MCP daemon tokens cannot register a mapping. Go derives the
workspace, issue, agent, and attempt; credentials never enter the Node worker.
An absent or malformed binding acknowledgement stops provider launch.

The worker stores a mapping per contract revision, agent, and run attempt.
Engineering reads/commands and captured receipts require that mapping. A
development checkout must descend from the frozen base; a verifier's checkout
must equal the handoff commit. Receipts from another worktree are rejected even
when it shares the same Git object database.

## Generated runtime files

Prepare writes a task marker and context/skill files, and the daemon injects a
runtime brief into the provider's instruction file. These are normally visible
to Git and would make an otherwise clean engineering checkout look dirty.

The daemon projects only its sidecar manifest plus the injected instruction
file. It sends paths and SHA-256 digests, never the contents of files that might
contain credentials. The worker checks those exact bytes, captures their
original committed content identity and executable bit, and uses that original
projection for clean checks and business-code fingerprints. This preserves
developer check validity when the same business changes are committed.

There is no global ignore for `.multica`, `AGENTS.md`, `CLAUDE.md`, or skill
directories. Unregistered changes still count. Altered generated files are
rejected, and committing generated context is refused. Runtime-owned files are
read-only during a bound attempt; editing a user-authored part of the same
instruction file currently requires leaving the active injected-context attempt.
Supporting simultaneous business edits in that file remains a limitation.

If the daemon refreshes a brief for the native fresh-session retry, it can
refresh injected digests on the same mapping. The directory, branch, mode, paths,
original content identities, and executable bits remain fixed. This does not
rewrite command receipts or refresh their observed business fingerprints.

## Handoff and completion

Development completion records the actual clean commit and durable branch.
Independent verification uses another agent and its own bound worktree, with the
same source/oracle contract and exact handoff commit. The registered user's HEAD
does not have to move to the development branch.

For a worktree delivery, the synchronous Done check requires the delivery branch
to still name the verified commit. It checks a still-present verification
worktree for cleanliness/version drift. After native reclamation, the completed
verification binding and retained delivery ref remain the durable references.
Moving or deleting the delivery branch prevents completion. In-place delivery
continues to require the registered checkout's current clean matching commit,
allowing only the recorded generated context while the runtime is active.

## Verification and limits

Package tests cover mapping ownership, unrelated clones, in-place path mismatch,
attempt identity, context digest refresh, exact normalization, changed runtime
files, business edits, accidental context commits, and cleanup restoration.
Native Go tests prepare an actual pinned worktree from a dirty source, export
the real sidecar/brief projection, round-trip the preparation JSON boundary,
and retain the unchanged branch after cleanup. A real `runTask` test uses an
isolated-home, test-created fake provider in both directory modes to prove that
binding happens after preparation/start and before launch, that the provider
uses the bound directory, and that missing acknowledgement prevents launch.
Daemon transport and Go API tests check current claims and credential boundaries.

The delivery E2E now runs both modes through the real native management CLI,
Go API, private worker, Git commits, and independent Chromium observation. Its
worktree case retains the user's base HEAD, reclaims both fixture worktrees,
then checks the retained delivery ref and rejects branch drift. Runtime identities
and injected-context contents are fixture supplied; native preparation/projection
is tested separately in Go. No installed agent CLI or model is executed.

Remote-daemon clones, cross-host filesystem access, submodules, Git filter/line-
ending conversion, and simultaneous edits to generated instruction files still
need acceptance work. The binding/fingerprint checks are observations, not an
atomic filesystem snapshot or a transaction across PostgreSQL and SQLite. This
does not finish requirement planning, final review, analysis/arbitration integration,
other chains, or real-provider delivery acceptance.
