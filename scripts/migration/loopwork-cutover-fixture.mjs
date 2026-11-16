import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createArchive } from "./loopwork-history-lib.mjs";
import { taskPacket } from "./loopwork-task-packet.mjs";

export async function cutoverFixture(t, { workspaceRoot = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "multica-cutover-test-")), sourceRoot = join(root, "source"), dataRoot = join(sourceRoot, "data"), archive = join(root, "archive");
  await mkdir(dataRoot, { recursive: true });
  execFileSync("git", ["init", "-q", sourceRoot]);
  await writeFile(join(sourceRoot, "README.md"), "Isolated source baseline\n");
  execFileSync("git", ["-C", sourceRoot, "add", "README.md"]);
  execFileSync("git", ["-C", sourceRoot, "-c", "user.name=Cutover fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Baseline"]);
  if (workspaceRoot === true) {
    workspaceRoot = join(root, "work-repository");
    await mkdir(workspaceRoot);
    execFileSync("git", ["init", "-q", workspaceRoot]);
    await writeFile(join(workspaceRoot, "README.md"), "Existing work\n");
    execFileSync("git", ["-C", workspaceRoot, "add", "."]);
    execFileSync("git", ["-C", workspaceRoot, "-c", "user.name=Cutover fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Work baseline"]);
    workspaceRoot = await realpath(workspaceRoot);
  }
  const dbs = {};
  for (const name of ["loopwork.db", "loop-ui.db", "admin-management.db"]) {
    const db = new DatabaseSync(join(dataRoot, name));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    dbs[name] = db;
  }
  const app = dbs["loopwork.db"], business = dbs["loop-ui.db"], admin = dbs["admin-management.db"];
  app.exec("CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT); CREATE TABLE runtime(id TEXT PRIMARY KEY,api_key TEXT); INSERT INTO runtime VALUES('runtime','fixture-secret-must-not-export')");
  app.prepare("INSERT INTO app_settings VALUES('workspace_root',?)").run(sourceRoot);
  business.exec(`CREATE TABLE projects(project_id TEXT PRIMARY KEY,name TEXT,workspace_root TEXT,deleted_at TEXT);
    INSERT INTO projects VALUES('project','Original project','/isolated/repository',NULL),('deleted','Deleted project','/deleted','2026-09-09');
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT,agile_status TEXT,run_state TEXT,closure_status TEXT,workflow_engine TEXT,item_type TEXT,title TEXT);
    INSERT INTO tasks VALUES('pending','project','ready_to_close','waiting_for_answers','awaiting_read','legacy','feature','Original pending'),('closed','project','done','idle','read','legacy','feature','Closed'),('deleted-pending','deleted','blocked','blocked','open','legacy','feature','Deleted pending');
    CREATE TABLE documents(document_id TEXT PRIMARY KEY,task_id TEXT,content BLOB,revision INTEGER);
    INSERT INTO documents VALUES('original','pending',X'FF000102',9223372036854775807);
    CREATE TABLE loop_lifecycle_state(singleton INTEGER PRIMARY KEY,desired_intent TEXT,actual_phase TEXT);
    INSERT INTO loop_lifecycle_state VALUES(1,'stopped','stopped');
    CREATE TABLE loop_runs(run_id TEXT PRIMARY KEY,status TEXT,started_at TEXT); INSERT INTO loop_runs VALUES('run','stopped','2000-01-01T00:00:00.000Z');
    CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,status TEXT); INSERT INTO execution_attempts VALUES('attempt','applied');
    CREATE TABLE loop_managed_processes(process_id TEXT PRIMARY KEY,status TEXT,pid INTEGER,process_start_marker TEXT,registered_at TEXT); INSERT INTO loop_managed_processes VALUES('process','exited',424242,'Sat Jan 1 00:00:00 2000','2000-01-01 00:00:00');
    CREATE TABLE execution_processes(allocation_id TEXT PRIMARY KEY,pid INTEGER,process_start_marker TEXT,process_group_id INTEGER,created_at TEXT,status TEXT);`);
  if (workspaceRoot) business.prepare("UPDATE projects SET workspace_root=? WHERE project_id='project'").run(workspaceRoot);
  admin.exec("CREATE TABLE admin_control(singleton INTEGER PRIMARY KEY,desired_intent TEXT); INSERT INTO admin_control VALUES(1,'stopped'); CREATE TABLE repair_cases(case_id TEXT PRIMARY KEY,original_json TEXT); INSERT INTO repair_cases VALUES('case','Original failure provenance'); CREATE TABLE admin_runtime_cli_processes(allocation_id TEXT PRIMARY KEY,status TEXT)");
  admin.exec("CREATE TABLE repair_attempts(attempt_id TEXT PRIMARY KEY,pid INTEGER,start_marker TEXT,process_group_id INTEGER,started_at TEXT)");
  for (const table of ["admin_business_worker_processes", "admin_harness_build_processes", "admin_runtime_host_processes", "admin_runtime_ui_processes", "admin_runtime_cli_processes", "admin_runtime_update_processes"]) {
    if (table !== "admin_runtime_cli_processes") admin.exec(`CREATE TABLE "${table}"(allocation_id TEXT PRIMARY KEY,status TEXT)`);
    admin.exec(`ALTER TABLE "${table}" ADD COLUMN pid INTEGER; ALTER TABLE "${table}" ADD COLUMN marker TEXT; ALTER TABLE "${table}" ADD COLUMN group_id INTEGER`);
  }
  const catalog = business.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => {
    const columns = business.prepare(`PRAGMA table_info("${name}")`).all();
    return { name, columns: columns.map(row => row.name), primary_key: columns.filter(row => row.pk).map(row => row.name) };
  });
  for (const section of taskPacket(business, catalog, "pending").sections) {
    if (!catalog.some(row => row.name === section.table)) {
      business.exec(`CREATE TABLE "${section.table}"(${section.missing_columns.map((column, index) => `"${column}" TEXT${index ? "" : " PRIMARY KEY"}`).join(",")})`);
    } else for (const column of section.missing_columns) business.exec(`ALTER TABLE "${section.table}" ADD COLUMN "${column}" TEXT`);
  }
  t.after(async () => { for (const db of Object.values(dbs)) if(db.isOpen)db.close(); await rm(root, { recursive: true, force: true }); });
  const capture = await createArchive({ sourceRoot, dataRoot, output: archive });
  return { root, sourceRoot, dataRoot, archive, hash: capture.hash, dbs, business, app, admin, workspaceRoot };
}
