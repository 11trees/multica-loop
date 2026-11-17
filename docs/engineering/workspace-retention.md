# Retaining acknowledged source workspaces

The native [target backup](target-backup.md) preserves application data separately
from the source repositories. A workspace observation stores hashes; it cannot
recover uncommitted code or an untracked screenshot. Workspace retention saves
the actual content of the current acknowledged observation in a separate private
archive and verifies reconstruction in a new directory.

The capture operator takes the saved cutover UUID and explicit latest workspace
hash. It accepts a local native database and pinned primary history archive,
requires the cutover to remain `source_frozen` without activation, and derives
all roots from the saved workspace observation. It rechecks the original packets,
frozen source cohort, registered-writer observation and actual workspace content
before and after capture. A caller cannot replace a source root.

```sh
make env-exec ARGS="-- node scripts/migration/loopwork-retain.mjs capture --id saved_cutover_uuid --expected-workspace saved_workspace_sha256 --output /absolute/new-retention"
make env-exec ARGS="-- node scripts/migration/loopwork-retain.mjs verify --backup /absolute/new-retention --expected-hash retained_sha256"
make env-exec ARGS="-- node scripts/migration/loopwork-retain.mjs drill --backup /absolute/new-retention --expected-hash retained_sha256 --output /absolute/new-drill"
```

The parent destination must exist. Capture and drill refuse existing outputs,
source roots, protected archives and overlapping ancestors. The archive uses
private directories and mode-0600 files. Its manifest reconstructs the original
workspace observation from every project/root/snapshot and checks the exact
saved hash, then verifies the complete payload inventory. Working content and
staged content are separate: a staged version and later working edits to the
same file are both retained.

Retention includes HEAD, its tree, the logical index, available history reachable
from the saved refs and HEAD, current file/link bytes, modes, untracked `.tmp`
files and deleted-path markers. A self-contained Git object pack preserves the
available graph. Shallow repositories retain their original boundary; capture
and restore do not fetch missing upstream history. Staged blobs are retained
even when they are not reachable from a commit. Source index bytes, refs,
branch identity, shallow metadata and content are rechecked before publication.

The drill initializes a new repository with an empty template, imports the object
pack, restores refs and HEAD, reconstructs index entries and writes current
content without running checkout hooks. It uses regular archived files to import
staged blobs, including empty files. It restores symbolic links as links and never
reads their targets. Git integrity checking and a fresh workspace observation
must match every saved content/staging field, allowing only the new physical root.
The receipt records original and restored roots; neither becomes a native project
resource through this operation.

Hooks, fsmonitor, lazy object fetching and network transports are disabled.
Source Git configuration, remotes' connection settings, reflogs, index stat
caches/flags, ignored files outside HEAD/index, external link targets and
uncaptured LFS/submodule data remain excluded. Incompatible repository state or
changed content is refused. Restored files/scripts are not executed, and no API,
provider or source-write permission is started or inherited.

## Actual local exercise

The saved active-project workspace was retained and restored with:

- HEAD `d869849b5ebaa744eac6fa2444c4522dc2e62d99`;
- 297 paths, including 73 untracked paths and one deletion;
- 224 staged index entries, five Git refs and one shallow boundary;
- 36,441,750 bytes of current file/link content.

Its original workspace observation remains
`8db6d16dbecc9eb2f1668de987734237f253335fe1e46e3f283ac869ae40cecb`.
The retained archive identity is
`ad98ea4e4b8a38d8ddc9ef255137a60a4fd244aec8f7682f9cb0fc5d009bccad`.
Private artifacts are `20261117-workspace-retention-01` and
`20261117-workspace-drill-02` in the migration directory. The restore receipt
confirms matching content, staging and Git integrity. An independent source
check confirms the original content, raw index bytes, refs and shallow boundary
unchanged. The source working directory was never reset, cleaned or committed.

This accepts reconstruction of that acknowledged scope. Ignored/external data,
other source repositories, live restoration and code/business verification need
separate acceptance. The restore drill itself does not change native task ownership or activity.

## Local environment retention

The actual `multica-loop` environment now uses `TTL_HOURS=0`, disabling collection
based on elapsed time while its checkout is retained. Later startup can use
`make up C=api,web`; an existing environment keeps its lifecycle settings. To
explicitly set indefinite retention, use `make up C=api,web ARGS="--ttl 0"`.
Keep the checkout and the private backups: explicit destruction or removal of
the checkout remains outside time-based retention.

Controlled tests cover staged/working divergence, empty staging and empty files,
binary/untracked/newline paths, modes, deletions, symbolic links, refs, detached
HEAD, a shallow history with a missing parent, changed scope/content, altered
payloads and protected destinations. They use local fixtures and never discover
or launch installed provider CLIs.

## Separately authorized execution checkout

The Development rollout reverified the acknowledged source content and restored
a fresh checkout from the retained archive. All 296 present working files match
the source, with its 73 previously untracked paths and one deletion preserved.
The restored index and history were verified before creating an execution-only
branch and baseline commit. The original source files, index bytes and Git refs
stayed unchanged. The live native project resource was then explicitly pointed
at this clean checkout before any workflow contract or Agent run was created.

The restore receipt still grants no execution authority. The separate human
request, native history activation, role/runtime bindings and normal task start
authorize the selected task. Its code version is the new checkout's commit, not
the old source HEAD. Subsequent implementation and verification must pass their
ordinary independent evidence and exact report-reading gates.
