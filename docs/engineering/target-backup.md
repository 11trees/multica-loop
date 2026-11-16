# Local target backup and restore drill

The target migration has state in PostgreSQL, the business and independent Admin
SQLite stores, local uploads, native environment/profile configuration and the
selected primary/supplemental history archives. Saving a single database does
not preserve that cohort.

`scripts/migration/target-backup.mjs` provides an offline local backup and a fresh
isolated restore drill. It has no live-database restore command. Stop the managed
API, Web, Admin, daemon and Desktop with `make down` first, after checking that
there are no active task/process owners. Other clients on the same native
database must also be disconnected. Other databases on the shared server remain
untouched.

Choose the exact PostgreSQL container serving the configured local database.
The operator compares its physical server identity to the managed connection
and checks the matching PostgreSQL client major version; the container's local
socket must permit the configured database user. Passwords are not put into
command arguments or printed.

```sh
make env-exec ARGS="-- node scripts/migration/target-backup.mjs capture --output /absolute/new-backup --postgres-container exact_container_id"
make env-exec ARGS="-- node scripts/migration/target-backup.mjs verify --backup /absolute/new-backup --expected-hash saved_sha256"
make env-exec ARGS="-- node scripts/migration/target-backup.mjs drill --backup /absolute/new-backup --expected-hash saved_sha256 --output /absolute/new-drill --postgres-container exact_container_id"
```

The parent destination directory must exist. Neither backup nor drill may
replace an existing directory or overlap its source roots. Paths and the
selected history hashes come from the managed environment. Cloud object storage
is not supported by this operator; local uploads resolve against the API's
`server/` working directory.

Capture holds write-blocking locks on all native user tables in one repeatable
read transaction and exports its snapshot to `pg_dump`. It records deterministic
hashes of every user-table row, schema, sequence value and extension version.
SQLite sources are copied as database/WAL bytes and checkpointed only in private
copies; original preimages are rechecked before publication. Upload and native
configuration bytes are also rechecked. The full payload inventory and both
history identities are pinned by the returned manifest hash. An incomplete or
changed inventory is refused. File verification alone does not prove restoration.

The drill creates a random `multica_restore_...` database on the same local server
using `template0`. It restores with matching native PostgreSQL tools, compares
the complete saved row/sequence/extension inventory and canonical schema, and copies
the SQLite, upload, history and configuration files into the new private drill
directory. Every retained file is compared to the backup. It never loads the
saved environment or profile, launches an API/Agent or changes a source write
guard. Schema comparison replays the complete saved DDL in another fresh empty
database and compares both PostgreSQL-generated schema exports. This accounts
for PostgreSQL flattening associative expressions during parsing while retaining
every constraint, function and other dumped definition in the comparison. The
original schema text/hash stays retained; no named constraint is omitted. After
successful comparison, both newly created databases are dropped and a
receipt is saved. Failure cleanup can drop only those newly created databases;
partial drill files remain isolated and cannot authorize a live restart.

Backup/drill directories use mode 0700 and files 0600. Native environment and
profile files can contain credentials: keep them private. This is not encryption,
and the manifest contains no authentication material directly. PostgreSQL roles
and ACLs, external services, installed provider credentials/CLIs, application
binaries and source project repositories require their own retention/setup.
The repository commit is recorded; rebuild that version separately.

Restored cutover holds, queued intent, runtime mappings, process identities and
source guard references are historical state. A successful isolated drill does
not prove those owners are current or authorize execution. Live disaster recovery
requires explicit reconciliation, compatible host/runtime setup and a separate
reviewed restart; post-activation migration rollback remains a separate protocol.

Default tests cover pinned file/history/SQLite verification, changed or extra
payloads, symlinks, incomplete cohorts and refusal of caller-selected live
restore arguments. They do not start PostgreSQL, application services or providers.

## Local stopped-service exercise

The actual target was backed up with its API, Web, independent Admin and daemon
stopped, no other clients on that native database and no active engineering
controller/process owners. The saved cohort contains:

- 196 PostgreSQL tables and 63,773 rows, all compared after restoration;
- the business SQLite's 30 tables and independent Admin SQLite's 22 tables;
- the selected primary history and supplemental history, including all 225
  supplemental materials and their existing source identity;
- native environment/profile bytes, the explicitly absent native daemon identity
  file, and an empty local upload directory;
- 155 payload files in total, with 153 non-dump/schema files restored exactly.

Backup identity:
`2c6ee3923df60c29b957a52a447626bb968c490026d59ce4cb23e0e61ee7f297`.
Private retained artifacts are under the migration directory as
`20261117-target-backup-01` and `20261117-target-drill-04`; the drill receipt and
separate source-validation report record the exact checks. No backup contents
or credentials are committed to the repository.

The isolated restore passed full row, canonical schema, sequence/extension,
SQLite, history and file comparisons. Both drill databases were removed. A
separate check found no remaining drill database and confirmed the source
PostgreSQL inventory and both native SQLite/WAL preimages unchanged. The saved
source cutover remains `source_frozen`, without activation. No restored service,
configuration or provider ran. This accepts this local isolated data-restore
exercise; live recovery, host portability, source repository retention and
post-activation rollback remain unaccepted.
