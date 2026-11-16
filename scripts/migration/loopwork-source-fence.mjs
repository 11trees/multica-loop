import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { copyDatabase, sourceFiles, verifyArchive } from "./loopwork-history-lib.mjs";

const prefix = "__multica_cutover_";
const marker = `${prefix}owner`;
const quote = name => `"${name.replaceAll('"', '""')}"`;
const json = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { sqlite_integer: String(item) } : item instanceof Uint8Array ? { sqlite_blob: Buffer.from(item).toString("base64") } : item);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => json(canonical(a)) === json(canonical(b));
export const cutoverDigest = value => createHash("sha256").update(json(value)).digest("hex");
export const sourceNamespace = manifest => cutoverDigest({ format: "loopwork-source-v1", repository: manifest.source.repository, data_root: manifest.source.data_root });

function catalog(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return schema.filter(row => !row.name.startsWith(prefix));
}
function content(db) {
  const schema = catalog(db), tables = schema.filter(row => row.type === "table");
  if (tables.some(row => /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ""))) throw new Error("Virtual source tables need explicit cutover support");
  const rows = tables.map(table => {
    const query = db.prepare(`SELECT * FROM ${quote(table.name)}`); query.setReadBigInts(true);
    // Sort row digests rather than rowids: WITHOUT ROWID tables and duplicate
    // records must retain the same logical identity after WAL checkpointing.
    const hashes = [...query.iterate()].map(row => cutoverDigest(row)).sort();
    return { table: table.name, rows: hashes.length, hash: cutoverDigest(hashes) };
  });
  return { schema_hash: cutoverDigest(schema), rows_hash: cutoverDigest(rows), tables: tables.map(row => row.name), rows: rows.reduce((n, row) => n + row.rows, 0) };
}
function guards(tables) {
  return tables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
    const name = `${prefix}${cutoverDigest(table).slice(0, 24)}_${operation.toLowerCase()}`;
    return { name, sql: `CREATE TRIGGER ${quote(name)} BEFORE ${operation} ON ${quote(table)} BEGIN SELECT RAISE(ABORT, 'LoopWork source is frozen for Multica cutover'); END` };
  }));
}
function state(db, scope, expected) {
  const actual = content(db);
  if (actual.schema_hash !== expected.schema_hash || actual.rows_hash !== expected.rows_hash) throw new Error("Original source schema or records changed; cutover remains blocked");
  const reserved = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name GLOB ? ORDER BY name").all(`${prefix}*`);
  if (!reserved.length) return "unfenced";
  if (reserved.filter(row => row.name === marker && row.type === "table").length !== 1) throw new Error("Source fence marker is missing or foreign");
  const saved = db.prepare(`SELECT payload FROM ${quote(marker)}`).all();
  if (saved.length !== 1 || !equal(JSON.parse(saved[0].payload), { scope, expected })) throw new Error("Source fence belongs to another cutover or preimage");
  const triggers = guards(actual.tables);
  if (reserved.length !== triggers.length + 1 || triggers.some(trigger => !reserved.some(row => row.type === "trigger" && row.name === trigger.name && row.sql === trigger.sql))) throw new Error("Source fence trigger inventory changed");
  return "frozen";
}

function requireLogicallyStopped(db, role) {
  const exists = table => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const reject = (table, condition) => {
    if (exists(table) && db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${condition} LIMIT 1`).get()) throw new Error(`Source ${role}/${table} is not stopped; drain it before cutover`);
  };
  if (role === "business") {
    if (!exists("loop_lifecycle_state")) throw new Error("Source lifecycle schema is unsupported");
    reject("loop_lifecycle_state", "desired_intent<>'stopped' OR actual_phase NOT IN ('stopped','crashed')");
    reject("loop_runs", "status NOT IN ('stopped','crashed')");
    reject("loop_managed_processes", "status<>'exited'");
    reject("execution_processes", "status<>'exited'");
    reject("execution_attempts", "status IN ('planned','running','output_received','verifying','applying')");
  }
  if (role === "management") {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'admin_*processes'").all()) reject(row.name, "status<>'exited'");
    // The known management store keeps durable run authority in this singleton.
    if (!exists("admin_control")) throw new Error("Source management intent schema is unsupported");
    reject("admin_control", "desired_intent<>'stopped'");
  }
}

async function copied(path, fn) {
  const root = await mkdtemp(join(tmpdir(), "multica-source-inspect-"));
  try {
    const target = join(root, "source.db");
    const captured = await copyDatabase(path, target);
    const db = new DatabaseSync(target, { readOnly: true });
    try { db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF"); return await fn(db, captured.source_files); }
    finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function sourceCohort(archive, expectedHash) {
  const manifest = await verifyArchive(archive);
  if (manifest.hash !== expectedHash) throw new Error("Cutover archive identity changed");
  const root = manifest.source.data_root;
  if (await realpath(root) !== root || await realpath(manifest.source.repository) !== manifest.source.repository) throw new Error("Source roots changed");
  const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", manifest.source.repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("rev-parse", "HEAD") !== manifest.source.commit || git("status", "--porcelain", "--untracked-files=no")) throw new Error("Pinned source checkout changed");
  if (manifest.application_inventory?.length !== 1 || manifest.application_inventory[0].source_name !== "loopwork.db") throw new Error("Unsupported application database cohort");
  const entries = [{ ...manifest.application_inventory[0], role: "application" }, ...manifest.databases];
  const inodes = new Set();
  for (const entry of entries) {
    if (!["loopwork.db", "loop-ui.db", "admin-management.db"].includes(entry.source_name)) throw new Error("Unsupported source database path");
    entry.path = join(root, entry.source_name);
    const stat = await lstat(entry.path), inode = `${stat.dev}:${stat.ino}`;
    if (!stat.isFile() || stat.isSymbolicLink() || inodes.has(inode) || await realpath(entry.path) !== entry.path) throw new Error("Source database identity changed");
    inodes.add(inode);
  }
  return { manifest, entries };
}

// This inspection only reads source bytes. SQLite opens private copies, because
// even readOnly:true may reconstruct shared-memory files beside a live source.
export async function prepareSourceFence(archive, expectedHash) {
  const { manifest, entries } = await sourceCohort(archive, expectedHash), preimages = [];
  for (const entry of entries) {
    preimages.push(await copied(entry.path, (db, files) => {
      if (!equal(files, entry.source_files)) throw new Error("Source changed since capture; take a fresh archive before cutover");
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB ?").get(`${prefix}*`)) throw new Error("Source already has a cutover fence");
      requireLogicallyStopped(db, entry.role);
      return { name: entry.source_name, role: entry.role, files, ...content(db) };
    }));
  }
  for (const entry of entries) if (!equal(await sourceFiles(entry.path), entry.source_files)) throw new Error("Source cohort changed during inspection");
  return { source_namespace: sourceNamespace(manifest), archive_hash: manifest.hash, preimages, physical_quiescence_confirmed: false, execution_authorized: false };
}

function fenceScope(record) {
  if (!/^[a-f0-9]{64}$/.test(record.archive_hash) || !/^[a-f0-9]{64}$/.test(record.source_namespace) || !/^[a-f0-9]{64}$/.test(record.scope_hash) || !/^[a-f0-9-]{36}$/.test(record.id)) throw new Error("Invalid native cutover identity");
  return { id: record.id, archive_hash: record.archive_hash, source_namespace: record.source_namespace, scope_hash: record.scope_hash };
}
export async function inspectSourceFence(archive, record) {
  const scope = fenceScope(record), { entries, manifest } = await sourceCohort(archive, record.archive_hash);
  if (sourceNamespace(manifest) !== scope.source_namespace || record.preimages.length !== entries.length) throw new Error("Source cohort correspondence changed");
  const databases = [];
  for (const entry of entries) {
    const expected = record.preimages.find(row => row.name === entry.source_name && row.role === entry.role);
    if (!expected) throw new Error("Source preimage is missing");
    databases.push({ name: entry.source_name, state: await copied(entry.path, db => state(db, scope, expected)) });
  }
  return { databases, state: databases.every(row => row.state === "frozen") ? "frozen" : databases.every(row => row.state === "unfenced") ? "unfenced" : "partial", physical_quiescence_confirmed: false, execution_authorized: false };
}

// Callers must retain the committed native barrier throughout both operations.
// Each SQLite transaction is durable separately; an interrupted cohort is held
// on the native side and retried with the same saved identity and preimages.
export async function changeSourceFence(archive, record, operation, requireNativeBarrier) {
  if (!["freeze", "restore"].includes(operation)) throw new Error("Unsupported source fence operation");
  const scope = fenceScope(record), { entries, manifest } = await sourceCohort(archive, record.archive_hash);
  if (sourceNamespace(manifest) !== scope.source_namespace || record.preimages.length !== entries.length) throw new Error("Source cohort correspondence changed");
  for (const entry of entries) {
    await requireNativeBarrier(record, operation);
    const expected = record.preimages.find(row => row.name === entry.source_name && row.role === entry.role);
    if (!expected) throw new Error("Source preimage is missing");
    const initial = await copied(entry.path, db => state(db, scope, expected));
    if (operation === "freeze" && initial === "unfenced" && !equal(await sourceFiles(entry.path), expected.files)) throw new Error("Unfenced source changed since preparation");
    if (operation === "freeze" && initial === "frozen" || operation === "restore" && initial === "unfenced") continue;
    const db = new DatabaseSync(entry.path);
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
      const current = state(db, scope, expected);
      if (operation === "freeze" && current === "unfenced") {
        requireLogicallyStopped(db, entry.role);
        db.exec(`CREATE TABLE ${quote(marker)}(payload TEXT NOT NULL)`);
        db.prepare(`INSERT INTO ${quote(marker)} VALUES(?)`).run(json({ scope, expected }));
        for (const trigger of guards(expected.tables)) db.exec(trigger.sql);
      } else if (operation === "restore" && current === "frozen") {
        for (const trigger of guards(expected.tables)) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
        db.exec(`DROP TABLE ${quote(marker)}`);
      }
      state(db, scope, expected);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }
  }
  return inspectSourceFence(archive, record);
}
