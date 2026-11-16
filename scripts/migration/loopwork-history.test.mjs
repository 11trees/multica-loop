import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { copyDatabase, createArchive, readArchiveRecord, verifyArchive } from "./loopwork-history.mjs";

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"loopwork-history-test-")),sourceRoot=join(root,"source"),dataRoot=join(sourceRoot,"data"),output=join(root,"archive");
  await mkdir(dataRoot,{recursive:true});execFileSync("git",["init","-q",sourceRoot]);execFileSync("git",["-C",sourceRoot,"config","user.name","History fixture"]);execFileSync("git",["-C",sourceRoot,"config","user.email","history@example.invalid"]);
  await writeFile(join(sourceRoot,"README.md"),"Source baseline\n");execFileSync("git",["-C",sourceRoot,"add","README.md"]);execFileSync("git",["-C",sourceRoot,"commit","-qm","Baseline"]);
  const app=new DatabaseSync(join(dataRoot,"loopwork.db"));app.exec("CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT); CREATE TABLE global_runtime_configurations(id TEXT PRIMARY KEY,api_key TEXT)");app.prepare("INSERT INTO app_settings VALUES('workspace_root',?)").run(sourceRoot);app.exec("INSERT INTO global_runtime_configurations VALUES('runtime','must-not-export-application-secret')");app.close();
  const business=new DatabaseSync(join(dataRoot,"loop-ui.db"));business.exec(`PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;
   CREATE TABLE projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT);
   CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT,agile_status TEXT,run_state TEXT,closure_status TEXT,workflow_engine TEXT,title TEXT);
   CREATE TABLE documents(document_id TEXT PRIMARY KEY,task_id TEXT,content TEXT);
   CREATE TABLE command_chain_drafts(draft_id TEXT PRIMARY KEY,workflow_phase TEXT);
   CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,status TEXT,task_id TEXT,command_token_hash TEXT,attempt INTEGER);
   CREATE TABLE legacy_project_database_imports(source_db_path TEXT PRIMARY KEY,workspace_root TEXT,project_id TEXT,imported_at TEXT);
   CREATE TABLE loop_runs(run_id TEXT PRIMARY KEY,status TEXT);
   CREATE TABLE loop_managed_processes(process_id TEXT PRIMARY KEY,status TEXT);
   CREATE TABLE loop_lifecycle_state(singleton INTEGER PRIMARY KEY,desired_intent TEXT,actual_phase TEXT);
   INSERT INTO projects VALUES('原项目','/original/project',NULL);
   INSERT INTO tasks VALUES('旧任务-1','原项目','done','idle','acknowledged','legacy','Original done');
   INSERT INTO tasks VALUES('旧任务-2','原项目','ready_to_close','waiting_for_answers','awaiting_read','legacy','Original pending');
   INSERT INTO documents VALUES('报告-1','旧任务-1','Exact original report and evidence');
   INSERT INTO command_chain_drafts VALUES('原草稿','finalize');
   INSERT INTO execution_attempts VALUES('execution-1','applied','旧任务-1','old-command-token-must-not-project',9223372036854775807);
   INSERT INTO loop_runs VALUES('old-run','stopped');INSERT INTO loop_managed_processes VALUES('old-process','exited');INSERT INTO loop_lifecycle_state VALUES(1,'stopped','stopped');`);
  business.exec(`ALTER TABLE projects ADD COLUMN name TEXT;UPDATE projects SET name='Original project';
   ALTER TABLE tasks ADD COLUMN item_type TEXT DEFAULT 'requirement';ALTER TABLE tasks ADD COLUMN updated_at TEXT DEFAULT '2026-01-01';ALTER TABLE tasks ADD COLUMN description TEXT;ALTER TABLE tasks ADD COLUMN current_subagent TEXT;ALTER TABLE tasks ADD COLUMN next_step TEXT;ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;ALTER TABLE tasks ADD COLUMN created_at TEXT;ALTER TABLE tasks ADD COLUMN completed_at TEXT;
   ALTER TABLE documents ADD COLUMN title TEXT DEFAULT 'Original report';ALTER TABLE documents ADD COLUMN kind TEXT DEFAULT 'review';ALTER TABLE documents ADD COLUMN source_agent TEXT;ALTER TABLE documents ADD COLUMN revision INTEGER DEFAULT 1;ALTER TABLE documents ADD COLUMN created_at TEXT;ALTER TABLE documents ADD COLUMN updated_at TEXT;ALTER TABLE documents ADD COLUMN format TEXT DEFAULT 'markdown';`);
  await mkdir(join(dataRoot,"old"));await writeFile(join(dataRoot,"old","loop-ui.db"),"Old already merged copy");await writeFile(join(dataRoot,"unknown.db"),"Unclassified source");business.prepare("INSERT INTO legacy_project_database_imports VALUES(?,?,?,?)").run(join(dataRoot,"old","loop-ui.db"),"/original/project","原项目","2026-01-01");
  const management=new DatabaseSync(join(dataRoot,"admin-management.db"));management.exec("CREATE TABLE repair_cases(case_id TEXT PRIMARY KEY,original_json TEXT); INSERT INTO repair_cases VALUES('original-case','Original failure provenance')");management.close();
  t.after(async()=>{business.close();await rm(root,{recursive:true,force:true});});return {root,sourceRoot,dataRoot,output,business};
}

async function bytes(root) { const out={};for(const name of ["loopwork.db","loop-ui.db","loop-ui.db-wal","loop-ui.db-shm","admin-management.db"]){out[name]=await readFile(join(root,name)).catch((error)=>{if(error.code==="ENOENT")return null;throw error;});}return out; }

test("captures committed WAL and exact source IDs while preserving source bytes and ownership",async(t)=>{
 const h=await fixture(t),before=await bytes(h.dataRoot),result=await createArchive(h),manifest=await verifyArchive(h.output);
 assert.deepEqual(await bytes(h.dataRoot),before);assert.equal(result.projects,1);assert.equal(result.tasks,2);assert.equal(result.unfinished_tasks,1);assert.deepEqual(manifest.ownership.unfinished_task_ids,["旧任务-2"]);assert.equal(manifest.ownership.native_tasks_created,0);
 assert.equal(manifest.databases.length,2);assert.deepEqual(manifest.other_databases.map((item)=>item.disposition),["already_merged_source_not_reimported","unclassified_not_imported"]);
 assert.equal((await lstat(h.output)).mode&0o777,0o700);for(const name of await readdir(h.output))assert.equal((await lstat(join(h.output,name))).mode&0o777,0o600);
 assert.equal((await readArchiveRecord(h.output,"repair_cases","original-case")).record.original_json,"Original failure provenance");
 assert.equal((await readArchiveRecord(h.output,"documents","报告-1")).record.content,"Exact original report and evidence");assert.equal((await readArchiveRecord(h.output,"tasks","旧任务-2")).record.agile_status,"ready_to_close");
 const execution=await readArchiveRecord(h.output,"execution_attempts","execution-1");assert.equal(execution.record.command_token_hash,undefined);assert.equal(execution.record.attempt,9223372036854775807n);assert.equal(execution.historical_only,true);
 assert.equal((await readArchiveRecord(h.output,"tasks","missing")).record,null);assert.equal((await readArchiveRecord(h.output,"tasks","旧任务-1' OR 1=1 --")).record,null);
 const text=await readFile(join(h.output,"manifest.json"),"utf8");assert.ok(!text.includes("must-not-export-application-secret"));assert.ok(!(await readdir(h.output)).includes("loopwork.db"));
 await assert.rejects(createArchive(h),/already exists/);await assert.rejects(readArchiveRecord(h.output,"global_runtime_configurations","runtime"),/supported history/);
});

test("rejects a source write during copy and never treats a partial capture as an archive",async(t)=>{
 const h=await fixture(t),destination=join(h.root,"copy.db");await assert.rejects(copyDatabase(join(h.dataRoot,"loop-ui.db"),destination,()=>h.business.exec("INSERT INTO documents(document_id,task_id,content) VALUES('late','旧任务-1','Late source change')")),/Source changed/);
 await assert.rejects(verifyArchive(h.root),/manifest is missing/);assert.equal(h.business.prepare("SELECT count(*) AS n FROM documents").get().n,2);
});

for(const mode of ["inside-source","source-symlink","source-journal","missing-db","foreign-task","corrupt-db","dirty-source"]){
 test(`fails capture safely: ${mode}`,async(t)=>{
  const h=await fixture(t);let options=h;
  if(mode==="inside-source")options={...h,output:join(h.sourceRoot,"new","archive")};
  if(mode==="source-symlink"){await symlink(h.sourceRoot,join(h.root,"redirect"));options={...h,output:join(h.root,"redirect","new","archive")};}
  if(mode==="source-journal")await writeFile(join(h.dataRoot,"loop-ui.db-journal"),"Unsettled transaction");
  if(mode==="missing-db")await rm(join(h.dataRoot,"loopwork.db"));
  if(mode==="dirty-source")await writeFile(join(h.sourceRoot,"README.md"),"Uncommitted source changes");
  if(mode==="foreign-task")h.business.exec("UPDATE tasks SET project_id='unowned' WHERE task_id='旧任务-2'");
  if(mode==="corrupt-db"){await rm(join(h.dataRoot,"admin-management.db"));await writeFile(join(h.dataRoot,"admin-management.db"),"Broken SQLite");}
  await assert.rejects(createArchive(options));assert.equal(await lstat(options.output).catch(()=>null),null);assert.equal(await lstat(join(h.sourceRoot,"new")).catch(()=>null),null);assert.deepEqual((await readdir(h.root)).filter((name)=>name.startsWith(".history-")),[]);
 });
}

for(const mode of ["manifest","database","symlink","journal"]){
 test(`refuses altered archive before querying: ${mode}`,async(t)=>{
  const h=await fixture(t);await createArchive(h);
  if(mode==="manifest"){const path=join(h.output,"manifest.json"),value=JSON.parse(await readFile(path,"utf8"));value.ownership.native_tasks_created=1;await writeFile(path,JSON.stringify(value));}
  if(mode==="database"){const db=new DatabaseSync(join(h.output,"loop-ui.db"));db.exec("UPDATE documents SET content='Rewritten evidence'");db.close();}
  if(mode==="symlink"){await rm(join(h.output,"loop-ui.db"));await symlink(join(h.dataRoot,"loop-ui.db"),join(h.output,"loop-ui.db"));}
  if(mode==="journal")await writeFile(join(h.output,"loop-ui.db-wal"),"Unexpected future writes");
  await assert.rejects(readArchiveRecord(h.output,"documents","报告-1"));
 });
}

test("CLI captures, verifies and queries original IDs without reading an application credential",async(t)=>{
 const h=await fixture(t),script=new URL("./loopwork-history.mjs",import.meta.url).pathname,call=(...args)=>JSON.parse(execFileSync(process.execPath,[script,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
 const capture=call("capture","--source-root",h.sourceRoot,"--data-root",h.dataRoot,"--output",h.output);assert.equal(capture.tasks,2);assert.equal(call("verify","--archive",h.output).verified,true);
 const record=call("record","--archive",h.output,"--table","execution_attempts","--id","execution-1");assert.equal(record.record.command_token_hash,undefined);assert.deepEqual(record.record.attempt,{sqlite_integer:"9223372036854775807"});
 assert.throws(()=>call("record","--archive",h.output,"--table","tasks","--table","documents","--id","报告-1"));
});

test("native browsing pins the archive, scopes documents to their original task and never changes history",async(t)=>{
 const {browseArchive}=await import('./loopwork-history-lib.mjs'),h=await fixture(t);await createArchive(h);const m=await verifyArchive(h.output),before=await readFile(join(h.output,'loop-ui.db'));
 const list=await browseArchive(h.output,m.hash,{action:'list'});assert.equal(list.total,2);assert.equal(list.projects[0].name,'Original project');assert.equal(list.historical_only,true);
 assert.equal((await browseArchive(h.output,m.hash,{action:'list',project_id:'foreign'})).total,0);
 assert.equal((await browseArchive(h.output,m.hash,{action:'list',search:"' OR 1=1 --"})).total,0);
 const filtered=await browseArchive(h.output,m.hash,{action:'list',search:'pending'});assert.equal(filtered.total,1);assert.equal(filtered.tasks[0].id,'旧任务-2');
 assert.equal((await browseArchive(h.output,m.hash,{action:'task',task_id:'旧任务-1'})).documents[0].id,'报告-1');
 assert.equal((await browseArchive(h.output,m.hash,{action:'document',task_id:'旧任务-1',document_id:'报告-1'})).document.content,'Exact original report and evidence');
 assert.equal((await browseArchive(h.output,m.hash,{action:'document',task_id:'旧任务-2',document_id:'报告-1'})).document,null);
 assert.equal((await browseArchive(h.output,m.hash,{action:'document',task_id:'missing',document_id:'报告-1'})).document,null);
 await assert.rejects(browseArchive(h.output,'0'.repeat(64),{action:'list'}),/configured identity/);assert.deepEqual(await readFile(join(h.output,'loop-ui.db')),before);
});
