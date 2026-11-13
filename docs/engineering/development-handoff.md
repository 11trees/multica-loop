# Development, captured checks, and verification handoff

The local engineering application supports the development chain followed by
independent verification for one issue/delivery unit. Human configuration uses
the existing `configure` endpoint and adds `developer_agent_id` and
`implementation_guidance`. `agent_id` remains the independent verifier. The
two agent IDs must differ. The application freezes the clean base commit,
guidance, sources, oracles, and revision before development starts.

The initial implementation uses the same API-host repository path for both
roles. Use a local in-place checkout matching the registered path. Native
disposable worktrees and remote-daemon checkout mapping still need an explicit
host mapping; they must not silently be treated as the registered checkout.

## Developer commands and gates

The native CLI selects the role from the authenticated task, not a command flag.
`start` enters the development draft until handoff; the verifier cannot start
early. Development can change files and advance HEAD along the frozen base's
history. Its business contract remains immutable.

- `delivery_spec` presents frozen acceptance oracles and implementation guidance.
- `implement` accepts `acceptance.assess` with a frozen acceptance `key` and
  nonempty `evidence`. These are implementation claims, not independent passes.
  Every acceptance needs a claim; every recovery source needs its keyed
  `development.recovery-resolutions` artifact. Runtime inputs can suspend work.
- `review` requires the existing code-review summary/evidence artifact.
  Completing it binds that assertion to the observed code fingerprint; later
  repository changes require a fresh review before subsequent phases complete.
- `developer_verify` accepts `check.record` (`key`, `receipt_id`, `summary`) and
  `check.remove` (`key`). At least one selected captured command must explicitly
  succeed. The receipt must belong to the current run and current observed
  repository snapshot. A later execution of the same command supersedes it,
  including failed, declined, and unknown outcomes. Agents cannot submit an
  exit code in `check.record`.
- `commit` and `finalize` require explicit statements and an actually clean Git
  checkout. Finalization rechecks implementation claims and captured checks;
  committing unchanged file contents does not invalidate the content fingerprint.

Rewinding to/before developer verification clears selected checks. Rewinding
implementation invalidates downstream review. Rewinding before implementation
also clears implementation claims. A new run needs fresh selected checks before
finalization; resume does not turn earlier facts into observations by the new run.

## Runtime provenance

The Codex adapter copies `command`, `cwd`, terminal `status`, and optional
`exitCode` from native `commandExecution` completion items, following the
[official App Server event structure](https://developers.openai.com/codex/app-server).
It does not infer success from output text. Missing exit status remains unknown.
The common runtime message has an optional structured command result; other
providers currently emit no eligible receipts until their adapters are added.

Only a development claim advertises `engineering_chain: development`. The daemon
then reports native outcomes with its claim generation and scoped tool-call ID
to `/api/daemon/tasks/{taskId}/engineering-receipts`. The endpoint requires an
owning control-plane PAT/JWT and validates the running task/claim. Agent task
tokens and per-task Remote-MCP daemon tokens cannot attest command results.
Task/agent/workspace identity is projected by Go; bearer credentials are never
sent to the kernel worker. Command text is redacted before transport/storage.

The worker checks the command's repository mapping and stores an immutable
receipt with a fingerprint observed at ingestion. Replaying an identical receipt
keeps the original fingerprint; it cannot refresh evidence for changed code.
Fingerprints include tracked and nonignored untracked file bytes, executable
bits, and symlink targets. Ignored files/environment and submodule content are
outside this implementation; unsupported repository entries fail explicitly.
The ingestion fingerprint is not an atomic snapshot of the process's entire
execution. Workspace ownership and concurrent-edit acceptance remain necessary
before claiming that guarantee. No exactly-once external-effects claim is made.

## Handoff and independence

After successful finalization, the application stores the development conclusion
and actual clean HEAD, then enables the configured verifier with that exact
commit and the original frozen source/oracle projection. The development report
is available to human inspection. The verifier's engineering response excludes
development claims/checks and implementation guidance. Multica's wider native
issue/conversation context projection still needs acceptance review.

Claim instructions now select the verifier role; the next verifier run is still
started manually through Multica. This handoff does not itself update the issue
status or enqueue an agent. A crash between draft completion and handoff can
re-enter handoff from the completed draft; the commit and checks are revalidated.
It is not a single transaction with Multica's issue/task database.

Issue completion now uses a separate [synchronous host check](issue-completion.md):
the latest verification must pass against the current clean commit before a
human, agent, PR merge, or workflow remap can write a done-category status.

## Evidence

Package tests cover missing/forged receipts, later failures, changed repository
content, replay without fingerprint refresh, rewind invalidation, scoped commit
requirements, role separation, and transfer of frozen oracles. Backend fixtures
cover native Codex event parsing, daemon transport, control-plane credential
boundaries, and stale claims. No installed agent CLI or model is run by these tests.

`e2e/engineering-delivery.spec.ts` uses two fixture task identities, the real
native CLI/Go API/worker, a temporary Git repository, a real Node assertion and
Git commit, and an independent Chromium observation of the committed HTML page.
It passed with a recorded screenshot. Its runtime report is supplied by the
fixture control plane; actual provider/model execution remains unverified.

Development plus verification is not the full migration: requirement context,
planning/analysis, final review, other workflow paths, automatic continuation,
question UI, workspace mapping, final-review integration, and cross-database
handoff acceptance remain.
