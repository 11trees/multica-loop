# Legacy configuration retention and Team correspondence

The primary history archive deliberately excludes application database payloads.
The separate configuration capture now retains the four known Agent
configuration tables without retaining runtime/provider/account tables or
installing anything into Multica. Tasks continue to select one of the five
native Teams; this tool adds no pack selector or nested configuration registry.

```sh
node scripts/migration/loopwork-configurations.mjs capture \
  --archive /absolute/primary-history \
  --expected-hash primary-history-sha256 \
  --output /absolute/new-configuration-retention
node scripts/migration/loopwork-configurations.mjs verify \
  --archive /absolute/configuration-retention \
  --expected-hash configuration-retention-sha256
```

Capture derives the application database and source checkout from the pinned
primary history archive. The tracked source must still match that commit. It
uses a byte-checked private copy of the database/WAL, queries only the known
columns of `agent_configuration_sets`, `agent_configuration_documents`,
`agent_configuration_prompt_candidates` and
`agent_configuration_canary_receipts`, then removes the copied database before
publication. The original database is never opened by SQLite. Source bytes and
the tracked checkout are rechecked before publication. Unknown configuration
schemas, inconsistent ownership/hashes, changing sources, linked bundle files,
existing outputs and outputs overlapping source/history are refused.

Only one private `manifest.json` is published, in a `0700` directory with a
`0600` file. It preserves active and inactive configuration IDs, original Agent
IDs, Prompt text/hashes/revisions/source/reason/template versions, YAML and its
version/managed flag, unpromoted candidates, their evidence and canary outcomes.
Prompt and evidence text can contain private project information; exclusion of
runtime tables is not a claim that arbitrary authored text has been redacted.

The capture also retains the pinned default/OpenSpec bundle bytes and a derived
correspondence to Direct, Business Analysis, End to End, Develop and Bug Fix
roles. It distinguishes stored YAML from the source's effective system-managed
bundle: the old application refreshes managed documents from its current bundled
file. Both hashes remain visible, rather than calling an old cache a custom
document or discarding its original bytes. Non-managed YAML matching its bundle
is identified separately; different or unsupported YAML requires explicit porting.
Missing legacy role settings remain an explicit default-fallback review item.

Delivery context is compared across its six roles. All-OpenSpec maps to a
potential Team OpenSpec setting, none to default; mixed per-role adapters require
a decision because the target setting belongs to the whole Team. The original
single Feedback Agent maps to separate triage and independent verification roles;
its identity cannot satisfy both native roles. Pending Prompt candidates stay
unpromoted. Every plan has `installation_authorized: false` and
`native_tasks_changed: 0`.

## Actual local capture and remaining work

The local artifact is
`~/.multica/migrations/loopwork/20261117-configurations-01`, content identity
`2ee49133d2f1c135084f837e714210f436a6e76ed4ee5ef516572b095fd8a533`.
It is a later, explicitly separate observation of the pinned application's
configuration, not a replacement for the original history snapshot.

- 20 configuration sets, 13 active; 20 YAML documents, no Prompt candidates or
  canary receipts.
- All 13 active sets select default and label their Prompt source `system`.
  Their 13 effective YAML documents use the pinned system bundle.
- Six OpenSpec configurations are inactive. One further inactive test
  configuration has non-managed YAML that exactly matches its default bundle.
  None of the 20 observed documents requires custom-YAML porting.
- The three delivery Teams map to default repository context. Capture does not
  enable OpenSpec, revise a Team or change the four staged native tasks.

An independent private comparison receipt beside the artifact matches every
selected source row and the source database/WAL bytes after capture. It also
compares each legacy role Prompt with the current stored instructions of all 28
native preset role Agents. None is literally equal; every role remains unbound
to a runtime. This comparison covers stored Agent text, not the dynamic native
work packet. Native launch/continuation commands and phase instructions are
provided separately by the engineering service and kernel.

The original Prompts contain legacy CLI commands and must not be copied blindly
into native Agent instructions. A [reviewed native role-practice port](role-guidance.md)
now carries their role responsibilities, full decision-tree practice and evidence
boundaries through authenticated claims, with native bootstrap syntax and an
exclusive report-correction variant. It preserves stored Agent/Team settings and
does not read this archive during launch. No absence of custom YAML or literal
comparison proves behavioral parity: real-model semantic quality remains
unaccepted. Future custom-definition authoring/version controls, independent
Feedback setup, real-provider and packaged-client acceptance remain.
Capture/verification has no install or provider-launch action.

Controlled tests cover custom versus system-managed YAML, stale cached bundle
bytes, mixed adapters, inactive settings, unpromoted candidates/canary failures,
account-table exclusion, exact source preservation, schema/hash/ownership
refusal, changed sources, private output, identity checks and output boundaries.
