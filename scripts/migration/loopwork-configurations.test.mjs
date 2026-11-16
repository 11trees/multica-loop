import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import {createArchive,sourceFiles} from "./loopwork-history-lib.mjs";
import {captureConfigurations,configurationPlan,main,verifyConfigurations} from "./loopwork-configurations.mjs";
const sha=value=>createHash("sha256").update(value).digest("hex");
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),"multica-configurations-"))),sourceRoot=join(root,"source"),dataRoot=join(sourceRoot,"data"),output=join(root,"history");await mkdir(dataRoot,{recursive:true});t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync("git",["-C",sourceRoot,...args],{stdio:["ignore","pipe","pipe"]});git("init","-q");await writeFile(join(sourceRoot,".gitignore"),"data/\n");
 for(const pack of ["default","openspec"]){await mkdir(join(sourceRoot,"command-chains",pack),{recursive:true});for(const name of ["backlog-agent.yaml","dev-agent.yaml","test-agent.yaml"])await writeFile(join(sourceRoot,"command-chains",pack,name),`version: ${pack}\n`);}
 git("add",".");git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","Source configuration baseline");
 const db=new DatabaseSync(join(dataRoot,"loopwork.db"));db.exec(`
  CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT);
  CREATE TABLE global_runtime_configurations(id TEXT PRIMARY KEY,api_key TEXT);INSERT INTO global_runtime_configurations VALUES('runtime','excluded-account-secret');
  CREATE TABLE agent_configuration_sets(configuration_id TEXT PRIMARY KEY,agent_id TEXT,name TEXT,is_active INTEGER,created_at TEXT,updated_at TEXT,prompt_content TEXT,prompt_hash TEXT,prompt_revision INTEGER,prompt_source TEXT,prompt_reason TEXT,prompt_template_version INTEGER,builtin_key TEXT,context_adapter TEXT);
  CREATE TABLE agent_configuration_documents(configuration_id TEXT,command_chain_id TEXT,yaml_content TEXT,content_hash TEXT,revision INTEGER,updated_at TEXT,system_managed INTEGER,PRIMARY KEY(configuration_id,command_chain_id));
  CREATE TABLE agent_configuration_prompt_candidates(candidate_id TEXT PRIMARY KEY,configuration_id TEXT,agent_id TEXT,revision INTEGER,base_prompt_revision INTEGER,content TEXT,content_hash TEXT,reason TEXT,evidence_json TEXT,remaining_runs INTEGER,created_at TEXT,updated_at TEXT);
  CREATE TABLE agent_configuration_canary_receipts(candidate_id TEXT,execution_id TEXT,outcome TEXT,updated_at TEXT,PRIMARY KEY(candidate_id,execution_id));`);
 for(const [id,agent,pack,promptSource,adapter] of [["context","backlog-agent","openspec","system","openspec"],["dev","dev-agent",null,"human",null],["test","test-agent","default","system",null],["inactive","dev-agent","default","evolution",null]]){const prompt=`Original ${id} prompt`;db.prepare("INSERT INTO agent_configuration_sets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,agent,id,id==="inactive"?0:1,"created","updated",prompt,sha(prompt),3,promptSource,"Original reason",14,pack,adapter);}
 for(const [id,chain,content,managed] of [["context","requirement-context","old cached bundle\n",1],["dev","development","custom: true\n",0],["test","verification","version: default\n",0]])db.prepare("INSERT INTO agent_configuration_documents VALUES(?,?,?,?,?,?,?)").run(id,chain,content,sha(content),2,"updated",managed);
 const candidate="Original unpromoted proposal";db.prepare("INSERT INTO agent_configuration_prompt_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("candidate","dev","dev-agent",4,3,candidate,sha(candidate),"Original candidate reason",'{"ref":"old-evidence"}',2,"created","updated");db.exec("INSERT INTO agent_configuration_canary_receipts VALUES('candidate','old-run','failed','updated')");db.close();
 const business=new DatabaseSync(join(dataRoot,"loop-ui.db"));business.exec("CREATE TABLE projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT);CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT,agile_status TEXT,run_state TEXT,closure_status TEXT,workflow_engine TEXT);INSERT INTO projects VALUES('project','/historical/root',NULL);INSERT INTO tasks VALUES('task','project','backlog','idle','open','command-chain')");business.close();
 const primary=await createArchive({sourceRoot,dataRoot,output});return {root,sourceRoot,dataRoot,archive:output,expectedHash:primary.hash,output:join(root,"configurations")};
}

test("retains exact permitted configuration versions and produces five Team correspondences without account data or source writes",async t=>{
 const f=await fixture(t),before=await sourceFiles(join(f.dataRoot,"loopwork.db")),result=await captureConfigurations(f),manifest=await verifyConfigurations(f.output,result.hash);
 assert.deepEqual(await sourceFiles(join(f.dataRoot,"loopwork.db")),before);assert.deepEqual(await readdir(f.output),["manifest.json"]);assert.equal((await lstat(f.output)).mode&0o777,0o700);assert.equal((await lstat(join(f.output,"manifest.json"))).mode&0o777,0o600);
 const retained=await readFile(join(f.output,"manifest.json"),"utf8");assert(!retained.includes("excluded-account-secret"));assert(retained.includes("Original unpromoted proposal"));assert.equal(manifest.selection.agent_configuration_canary_receipts[0].outcome,"failed");assert.equal(manifest.selection.agent_configuration_sets.find(row=>row.configuration_id==="inactive").is_active,0);
 assert.deepEqual(result.plan.teams.map(team=>team.workflow),["direct","business_analysis","end_to_end","develop","bug_fix"]);assert.equal(result.plan.installation_authorized,false);assert.equal(result.plan.native_tasks_changed,0);
 assert.equal(result.plan.teams.find(team=>team.workflow==="develop").repository_context,"mixed_role_context_requires_decision");assert.equal(result.plan.documents.find(doc=>doc.configuration_id==="context").effective_hash,sha("version: openspec\n"));assert.equal(result.plan.documents.find(doc=>doc.configuration_id==="context").disposition,"pinned_system_bundle");assert.equal(result.plan.documents.find(doc=>doc.configuration_id==="dev").disposition,"custom_yaml_requires_port");assert.equal(result.plan.documents.find(doc=>doc.configuration_id==="test").disposition,"stored_matches_bundle");assert.deepEqual(result.plan.pending_prompt_candidates,["candidate"]);
 assert.equal(manifest.selection.agent_configuration_documents.find(row=>row.configuration_id==="context").yaml_content,"old cached bundle\n");
});

test("rejects unknown configuration columns, bad ownership/hashes and changing source without publishing partial retention",async t=>{
 const f=await fixture(t),app=join(f.dataRoot,"loopwork.db"),db=new DatabaseSync(app);db.exec("ALTER TABLE agent_configuration_sets ADD COLUMN credential TEXT");db.close();await assert.rejects(captureConfigurations(f),/Unsupported configuration schema/);assert.deepEqual((await readdir(f.root)).sort(),["history","source"]);
 const clean=await fixture(t),result=await captureConfigurations(clean),manifest=await verifyConfigurations(clean.output,result.hash);const changed=structuredClone(manifest.selection);changed.agent_configuration_documents[0].configuration_id="missing";assert.throws(()=>configurationPlan(changed,manifest.bundles),/ownership/);changed.agent_configuration_documents[0].configuration_id=manifest.selection.agent_configuration_documents[0].configuration_id;changed.agent_configuration_sets[0].prompt_content="altered";assert.throws(()=>configurationPlan(changed,manifest.bundles),/prompt hash/);
 await assert.rejects(captureConfigurations({...clean,output:join(clean.root,"changing"),afterCopy:()=>{const writer=new DatabaseSync(join(clean.dataRoot,"loopwork.db"));writer.exec("UPDATE agent_configuration_sets SET updated_at='later'");writer.close();}}),/Source changed/);assert(!((await readdir(clean.root)).some(name=>name.startsWith(".configurations-"))));
});

test("refuses changed pins, unexpected payload files, existing/source outputs and unsupported options",async t=>{
 const f=await fixture(t);await assert.rejects(captureConfigurations({...f,expectedHash:"0".repeat(64)}),/identity/);await assert.rejects(captureConfigurations({...f,output:join(f.sourceRoot,"unsafe/deeper")}),/disjoint/);assert(!(await readdir(f.sourceRoot)).includes("unsafe"));const result=await captureConfigurations(f);await assert.rejects(captureConfigurations(f),/overwrite/);await assert.rejects(verifyConfigurations(f.output,"0".repeat(64)),/identity/);
 await writeFile(join(f.output,"source.sqlite"),"Unexpected retained database");await assert.rejects(verifyConfigurations(f.output,result.hash),/unexpected payload/);await rm(join(f.output,"source.sqlite"));const manifest=JSON.parse(await readFile(join(f.output,"manifest.json"),"utf8"));manifest.plan.native_tasks_changed=1;await writeFile(join(f.output,"manifest.json"),JSON.stringify(manifest));await assert.rejects(verifyConfigurations(f.output,result.hash),/identity/);await assert.rejects(main(["capture","--source","/arbitrary"]),/Use capture/);
});
