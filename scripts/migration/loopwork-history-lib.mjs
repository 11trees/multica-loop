import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {taskPacket,sealTaskPacket} from "./loopwork-task-packet.mjs";

const format = "loopwork-history-archive-v1";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const json = (value, space) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { sqlite_integer: String(item) } : item instanceof Uint8Array ? { sqlite_blob: Buffer.from(item).toString("base64") } : item, space);
const digest = (value) => createHash("sha256").update(json(value)).digest("hex");
const within = (parent, child) => { const path = relative(parent, child); return !path || path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path); };
const absolute = (path) => { if (!isAbsolute(path)) throw new Error("Use absolute paths"); return resolve(path); };
async function file(path) {
  const stat = await lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Expected a regular file: ${path}`);
  return stat;
}
async function fingerprint(path) {
  const stat = await file(path); if (!stat) return null;
  const hash = createHash("sha256");
  if (stat.size) for await (const chunk of createReadStream(path, { start: 0, end: stat.size - 1 })) hash.update(chunk);
  const after = await file(path);
  if (!after || stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error("Source changed during fingerprint; retry a fresh snapshot");
  return { bytes: stat.size, sha256: hash.digest("hex") };
}
async function sourceFiles(path) {
  if (await file(`${path}-journal`)) throw new Error("Rollback journal present; finish the source transaction before capture");
  const database = await fingerprint(path); if (!database) throw new Error(`Source database is missing: ${path}`);
  return { database, wal: await fingerprint(`${path}-wal`) };
}

// Copy only bytes from the source. SQLite may reconstruct shared memory or
// checkpoint WAL only in our private staging directory, never in the source.
export async function copyDatabase(source, destination, afterCopy) {
  if (resolve(source) === resolve(destination)) throw new Error("Source and destination must differ");
  const before = await sourceFiles(source);
  await copyFile(source, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600);
  if (before.wal) { await copyFile(`${source}-wal`, `${destination}-wal`, constants.COPYFILE_EXCL); await chmod(`${destination}-wal`, 0o600); }
  const copied = { database: await fingerprint(destination), wal: await fingerprint(`${destination}-wal`) };
  if (afterCopy) await afterCopy();
  const after = await sourceFiles(source);
  if (json(before) !== json(copied) || json(before) !== json(after)) throw new Error("Source changed during capture; no archive was published");
  const db = new DatabaseSync(destination);
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const checked = db.prepare("PRAGMA quick_check").all();
    if (checked.length !== 1 || Object.values(checked[0])[0] !== "ok") throw new Error("Copied source failed SQLite integrity check");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint.busy) !== 0) throw new Error("Copied WAL could not be checkpointed");
    db.exec("PRAGMA journal_mode=DELETE");
  } finally { db.close(); }
  await rm(`${destination}-wal`, { force: true }); await rm(`${destination}-shm`, { force: true });
  return { source_files: before, snapshot: await fingerprint(destination) };
}

function tables(db) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => {
    if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "")) throw new Error("Virtual tables require explicit migration support");
    const columns = db.prepare(`PRAGMA table_info(${quote(row.name)})`).all();
    return { name: row.name, rows: Number(db.prepare(`SELECT count(*) AS n FROM ${quote(row.name)}`).get().n), primary_key: columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name), columns: columns.map((column) => column.name) };
  });
}
function inventory(path, role) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const catalog = tables(db), exists = (name, fields) => fields.every((column) => catalog.find((table) => table.name === name)?.columns.includes(column));
    const summary = { tables: catalog };
    if (role === "business") {
      for (const [table, fields] of [["projects", ["project_id", "workspace_root", "deleted_at"]], ["tasks", ["task_id", "project_id", "agile_status", "run_state", "closure_status", "workflow_engine"]]]) if (!exists(table, fields)) throw new Error(`Unsupported LoopWork history schema: ${table}`);
      summary.projects = db.prepare("SELECT project_id,workspace_root,deleted_at FROM projects ORDER BY project_id").all();
      summary.tasks = db.prepare("SELECT task_id,project_id,agile_status,run_state,closure_status,workflow_engine FROM tasks ORDER BY project_id,task_id").all();
      if (summary.tasks.some((task) => !summary.projects.some((project) => project.project_id === task.project_id))) throw new Error("A source task has no project owner");
      summary.unfinished_task_ids = summary.tasks.filter((task) => !["done", "cancelled"].includes(task.agile_status)).map((task) => task.task_id);
      summary.legacy_imports = exists("legacy_project_database_imports", ["source_db_path", "workspace_root", "project_id", "imported_at"]) ? db.prepare("SELECT source_db_path,workspace_root,project_id,imported_at FROM legacy_project_database_imports ORDER BY source_db_path").all() : [];
      summary.run_facts = {};
      for (const table of ["loop_runs", "execution_attempts", "loop_managed_processes"]) if (exists(table, ["status"])) summary.run_facts[table] = db.prepare(`SELECT status,count(*) AS count FROM ${quote(table)} GROUP BY status ORDER BY status`).all();
      if (exists("loop_lifecycle_state", ["desired_intent", "actual_phase"])) summary.lifecycle = db.prepare("SELECT desired_intent,actual_phase FROM loop_lifecycle_state").all();
    }
    if (role === "application") {
      summary.workspace_root = exists("app_settings", ["setting_key", "setting_value"]) ? db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='workspace_root'").get()?.setting_value ?? null : null;
    }
    return summary;
  } finally { db.close(); }
}

async function candidates(dataRoot) {
  const result = [];
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    const paths = entry.isDirectory() ? (await readdir(join(dataRoot, entry.name), { withFileTypes: true })).filter((child) => child.isFile() && /\.(db|sqlite)$/.test(child.name)).map((child) => join(entry.name, child.name)) : entry.isFile() && /\.(db|sqlite)$/.test(entry.name) ? [entry.name] : [];
    for (const path of paths) result.push({ path, bytes: (await lstat(join(dataRoot, path))).size });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function futurePath(path) {
  const suffix=[]; let current=path;
  while (!await lstat(current).catch((error)=>{if(error.code==="ENOENT")return null;throw error;})) {suffix.unshift(basename(current));current=dirname(current);}
  return join(await realpath(current),...suffix);
}

export async function createArchive({ sourceRoot, dataRoot, output }) {
  sourceRoot = await realpath(absolute(sourceRoot)); dataRoot = await realpath(absolute(dataRoot)); output = absolute(output);
  output=await futurePath(output);
  if (within(sourceRoot, output) || within(dataRoot, output)) throw new Error("Archive must be outside the read-only source repository and data root");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(output));
  if (await lstat(output).catch((error) => { if (error.code === "ENOENT") return null; throw error; })) throw new Error("Archive destination already exists; never overwrite a historical capture");
  const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", sourceRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const source = { repository: sourceRoot, data_root: dataRoot, commit: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain", "--untracked-files=no") };
  if (source.dirty) throw new Error("Pinned history capture requires a clean tracked source checkout");
  const stage = join(parent, `.history-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
  try {
    const databases = [], application = [];
    for (const [name, role, required] of [["loopwork.db", "application", true], ["loop-ui.db", "business", true], ["admin-management.db", "management", false]]) {
      const original = join(dataRoot, name); if (!await file(original)) { if (required) throw new Error(`Missing source: ${name}`); continue; }
      const destination = join(stage, name), captured = await copyDatabase(original, destination), summary = inventory(destination, role);
      if (role === "application") { application.push({ source_name: name, source_files: captured.source_files, summary, excluded_payload: "Application configuration and runtime credentials require explicit configuration migration" }); await rm(destination); }
      else databases.push({ role, source_name: name, file: name, ...captured, summary });
    }
    // Recheck the entire cohort, not only each database's individual copy window.
    for (const entry of [...application, ...databases]) if (json(await sourceFiles(join(dataRoot, entry.source_name))) !== json(entry.source_files)) throw new Error("Source database cohort changed before archive publication");
    if (git("rev-parse", "HEAD") !== source.commit || !!git("status", "--porcelain", "--untracked-files=no") !== source.dirty) throw new Error("Source checkout changed during capture");
    const business = databases.find((entry) => entry.role === "business"), imported = new Set(await Promise.all(business.summary.legacy_imports.map((entry) => realpath(entry.source_db_path).catch((error)=>{if(error.code==="ENOENT")return resolve(entry.source_db_path);throw error;}))));
    const otherDatabases = (await candidates(dataRoot)).filter((entry) => !["loop-ui.db", "loopwork.db", "admin-management.db"].includes(entry.path)).map((entry) => ({ ...entry, disposition: imported.has(resolve(dataRoot, entry.path)) ? "already_merged_source_not_reimported" : "unclassified_not_imported" }));
    const body = { format, captured_at: new Date().toISOString(), source, application_inventory: application, databases, other_databases: otherDatabases,
      ownership: { mode: "historical_archive_only", source_owner: "LoopWork", native_tasks_created: 0, unfinished_task_ids: business.summary.unfinished_task_ids },
      remaining: ["Explicit native issue and human/Team correspondence", "Drain or explicitly reconcile unfinished LoopWork tasks", "External run/evidence files and attachments", "Unclassified historical databases", "Application configuration migration", "UI history navigation and cutover/rollback acceptance"] };
    const manifest = { ...body, hash: digest(body) }; await writeFile(join(stage, "manifest.json"), `${json(manifest, 2)}\n`, { mode: 0o600, flag: "wx" });
    await verifyArchive(stage);
    await rename(stage, output); return { archive: output, hash: manifest.hash, projects: business.summary.projects.length, tasks: business.summary.tasks.length, unfinished_tasks: business.summary.unfinished_task_ids.length };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export async function verifyArchive(archive) {
  archive = await realpath(absolute(archive));
  const manifestPath = join(archive, "manifest.json"); if (!await file(manifestPath)) throw new Error("Archive manifest is missing");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")), { hash, ...body } = manifest;
  if (manifest.format !== format || hash !== digest(body) || !Array.isArray(manifest.databases) || manifest.databases.length < 1 || manifest.ownership?.mode !== "historical_archive_only") throw new Error("Archive manifest identity changed");
  for (const entry of manifest.databases) {
    if (!["loop-ui.db", "admin-management.db"].includes(entry.file) || entry.file !== entry.source_name || (entry.file === "loop-ui.db" ? entry.role !== "business" : entry.role !== "management")) throw new Error("Archive database path or role changed");
    const path = join(archive, entry.file);
    if (await file(`${path}-wal`) || await file(`${path}-journal`) || await file(`${path}-shm`)) throw new Error("Archive contains an unexpected database journal");
    if (json(await fingerprint(path)) !== json(entry.snapshot)) throw new Error("Archive database fingerprint changed");
    if (json(inventory(path, entry.role)) !== json(entry.summary)) throw new Error("Archive record inventory differs from its saved correspondence");
  }
  if (manifest.databases.filter((entry) => entry.role === "business").length !== 1) throw new Error("Archive needs exactly one current business owner");
  const business=manifest.databases.find((entry)=>entry.role==="business");
  if(manifest.ownership.source_owner!=="LoopWork" || manifest.ownership.native_tasks_created!==0 || json(manifest.ownership.unfinished_task_ids)!==json(business.summary.unfinished_task_ids)) throw new Error("Archive cannot transfer native execution ownership");
  return manifest;
}

const readable = new Map([
  ["tasks", "task_id"], ["documents", "document_id"], ["stories", "story_id"], ["agent_work_drafts", "draft_id"],
  ["command_chain_drafts", "draft_id"], ["business_analysis_drafts", "draft_id"], ["execution_attempts", "execution_id"],
  ["repair_cases", "case_id"], ["repair_observations", "observation_id"],
]);
export async function readArchiveRecord(archive, table, id) {
  const key = readable.get(table); if (!key || typeof id !== "string" || !id.length) throw new Error("Select a supported history table and exact original id");
  const manifest = await verifyArchive(archive), role=table.startsWith("repair_")?"management":"business", entry = manifest.databases.find((item) => item.role === role), schema = entry?.summary.tables.find((item) => item.name === table);
  if (!schema?.columns.includes(key)) throw new Error("Historical record table is not present in this source version");
  const columns = schema.columns.filter((column) => !/(?:token|credential|password|secret|api_key)/i.test(column)), db = new DatabaseSync(join(archive, entry.file), { readOnly: true });
  try { db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF"); const statement = db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} WHERE ${quote(key)}=?`); statement.setReadBigInts(true); return { archive_hash: manifest.hash, source_id: id, table, historical_only: true, record: statement.get(id) ?? null }; } finally { db.close(); }
}


export async function browseArchive(archive, expectedHash, input) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("History needs its explicitly pinned archive hash");
  const manifest=await verifyArchive(archive);
  if(manifest.hash!==expectedHash)throw new Error("Historical archive differs from its configured identity");
  const entry=manifest.databases.find(item=>item.role==="business"),db=new DatabaseSync(join(archive,entry.file),{readOnly:true});
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const source={hash:manifest.hash,commit:manifest.source.commit,captured_at:manifest.captured_at,name:"LoopWork"};
    if(input.action==="list") {
      const projects=db.prepare("SELECT p.project_id AS id,p.name,p.workspace_root,p.deleted_at,COUNT(t.task_id) AS task_count,SUM(CASE WHEN t.task_id IS NOT NULL AND t.agile_status NOT IN ('done','cancelled') THEN 1 ELSE 0 END) AS unfinished_count FROM projects p LEFT JOIN tasks t ON t.project_id=p.project_id GROUP BY p.project_id ORDER BY p.name,p.project_id").all();
      const filters=[],params=[];
      if(input.project_id){filters.push("project_id=?");params.push(input.project_id);}
      if(input.search){filters.push("(instr(lower(title),lower(?))>0 OR instr(lower(task_id),lower(?))>0)");params.push(input.search,input.search);}
      const where=filters.length?`WHERE ${filters.join(" AND ")}`:"",total=Number(db.prepare(`SELECT count(*) AS n FROM tasks ${where}`).get(...params).n);
      const offset=input.offset??0,limit=50;
      const tasks=db.prepare(`SELECT task_id AS id,project_id,title,item_type,agile_status AS status,run_state,closure_status,updated_at FROM tasks ${where} ORDER BY updated_at DESC,task_id LIMIT ? OFFSET ?`).all(...params,limit,offset);
      return {historical_only:true,source,projects,tasks,total,offset,limit};
    }
    if(input.action==="packet"||input.action==="preparation-source") return {historical_only:true,source,...(input.action==="preparation-source"?{namespace:digest({format:"loopwork-source-v1",repository:manifest.source.repository,data_root:manifest.source.data_root})}:{}),packet:sealTaskPacket(taskPacket(db,entry.summary.tables,input.task_id),source)};
    const task=db.prepare("SELECT task_id AS id,project_id,title,item_type,description,agile_status AS status,run_state,closure_status,current_subagent,next_step,blocked_reason,created_at,updated_at,completed_at FROM tasks WHERE task_id=?").get(input.task_id);
    if(!task)return input.action==="document"?{historical_only:true,source,document:null}:{historical_only:true,source,task:null,documents:[]};
    if(input.action==="task") {
      const documents=db.prepare("SELECT document_id AS id,title,kind,source_agent,revision,created_at,updated_at FROM documents WHERE task_id=? ORDER BY updated_at DESC,document_id").all(task.id);
      return {historical_only:true,source,task,documents};
    }
    if(input.action==="document") {
      const document=db.prepare("SELECT document_id AS id,task_id,title,kind,content,format,source_agent,revision,created_at,updated_at FROM documents WHERE document_id=? AND task_id=?").get(input.document_id,task.id)??null;
      return {historical_only:true,source,document};
    }
    throw new Error("Unsupported historical read");
  }finally{db.close();}
}
