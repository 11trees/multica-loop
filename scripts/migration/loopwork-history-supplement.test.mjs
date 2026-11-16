import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {cutoverFixture} from './loopwork-cutover-fixture.mjs';
import {createArchive,verifyArchive} from './loopwork-history-lib.mjs';
import {captureHistorySupplement,readSupplementRecord,verifyHistorySupplement} from './loopwork-history-supplement.mjs';
import {main} from './loopwork-supplement.mjs';

async function fixture(t){
 const f=await cutoverFixture(t),secondary=join(f.dataRoot,'old');await mkdir(secondary);
 const business=new DatabaseSync(join(secondary,'loop-ui.db'));business.exec(`PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;
 CREATE TABLE tasks(task_id TEXT PRIMARY KEY,title TEXT,command_token_hash TEXT,revision INTEGER);CREATE TABLE documents(document_id TEXT PRIMARY KEY,task_id TEXT,content TEXT);
 INSERT INTO tasks VALUES('pending','Original pending backup','never-project-this-token',9223372036854775807),('backup-only','Distinct historical task',NULL,2);
 INSERT INTO documents VALUES('original-doc','backup-only','Retain this exact historical body');`);
 t.after(()=>business.close());
 const app=new DatabaseSync(join(secondary,'loopwork.db'));app.exec("CREATE TABLE app_settings(name TEXT,value TEXT);INSERT INTO app_settings VALUES('api_key','application-secret-must-not-export')");app.close();
 await writeFile(join(f.dataRoot,'empty.db'),'');
 const unknown=new DatabaseSync(join(f.dataRoot,'unknown.db'));unknown.exec('CREATE TABLE unknown_settings(name TEXT,value TEXT)');unknown.close();
 f.business.exec("CREATE TABLE project_agent_states(project_id TEXT,agent_id TEXT);INSERT INTO project_agent_states VALUES('project','developer')");
 for(const directory of ['runs/run','run-diagnostics/run','admin','agent-runtime/projects/project/agents/developer/memory'])await mkdir(join(f.dataRoot,directory),{recursive:true});
 for(const [path,text] of [['runs/run/runner.pid','12345'],['run-diagnostics/run/runner.stderr.log','Original private stderr'],['admin/host.log','Original management log'],['agent-runtime/manifest.json','{"formatVersion":4}'],['agent-runtime/projects/project/agents/developer/PROMPT.md','Historical prompt'],['agent-runtime/projects/project/agents/developer/MEMORY.md','Historical memory'],['agent-runtime/projects/project/agents/developer/memory/2026-01-01.md','Daily historical memory']])await writeFile(join(f.dataRoot,path),text);
 const archive=join(f.root,'primary-with-secondary'),captured=await createArchive({sourceRoot:f.sourceRoot,dataRoot:f.dataRoot,output:archive});
 return {...f,archive,hash:captured.hash,output:join(f.root,'supplement'),secondaryBusiness:business};
}
async function bytes(root){const result={};async function visit(path){for(const item of await readdir(join(root,path),{withFileTypes:true})){const next=path?`${path}/${item.name}`:item.name;if(item.isDirectory())await visit(next);else result[next]=await readFile(join(root,next));}}await visit('');return result;}

test('preserves secondary WAL business history and named external files without native authority or application credentials',async t=>{
 const f=await fixture(t),before=await bytes(f.dataRoot),original=await readFile(join(f.archive,'manifest.json'));
 const result=await captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:f.output}),manifest=await verifyHistorySupplement(f.output,f.hash,result.hash);
 assert.deepEqual(await bytes(f.dataRoot),before);assert.deepEqual(await readFile(join(f.archive,'manifest.json')),original);assert.equal((await verifyArchive(f.archive)).hash,f.hash);
 assert.equal(result.databases,4);assert.equal(result.retained_databases,1);assert.equal(result.materials,7);assert.equal(result.execution_authorized,false);
 assert.equal(manifest.databases.find(d=>d.source_path==='old/loopwork.db').payload_excluded,true);
 const saved=manifest.databases.find(d=>d.source_path==='old/loop-ui.db');assert.ok(saved.source_files.wal);assert.deepEqual(saved.task_ids_in_primary_archive,['pending']);assert.deepEqual(saved.task_ids_outside_primary_archive,['backup-only']);
 const record=await readSupplementRecord(f.output,f.hash,result.hash,'old/loop-ui.db','tasks','pending');assert.equal(record.record.revision,9223372036854775807n);assert.equal(record.record.command_token_hash,undefined);assert.equal(record.execution_authorized,false);
 assert.equal((await readSupplementRecord(f.output,f.hash,result.hash,'old/loop-ui.db','documents','original-doc')).record.content,'Retain this exact historical body');
 assert.equal((await readSupplementRecord(f.output,f.hash,result.hash,'old/loop-ui.db','tasks',"pending' OR 1=1 --")).record,null);
 await assert.rejects(readSupplementRecord(f.output,f.hash,result.hash,'old/loopwork.db','tasks','pending'),/not available/);
 assert.equal(JSON.stringify(manifest).includes('application-secret-must-not-export'),false);
 assert.deepEqual((await readdir(join(f.output,'databases'))).sort(),[saved.file.split('/')[1]]);
 for(const item of manifest.materials)assert.equal((await readFile(join(f.output,item.file))).length,item.bytes);
 const env={MULTICA_LOOPWORK_HISTORY_ARCHIVE:f.archive,MULTICA_LOOPWORK_HISTORY_HASH:f.hash};assert.equal((await main(['verify','--supplement',f.output,'--expected-hash',result.hash],env)).hash,result.hash);
 await assert.rejects(captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:f.output}),/Never overwrite/);
});

test('refuses altered blobs, database bytes, unexpected payloads and the wrong pinned identity',async t=>{
 const f=await fixture(t),result=await captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:f.output}),manifest=await verifyHistorySupplement(f.output,f.hash,result.hash);
 await assert.rejects(verifyHistorySupplement(f.output,f.hash,'0'.repeat(64)),/identity/);
 await writeFile(join(f.output,'unreferenced-private-data'),'not in manifest');await assert.rejects(verifyHistorySupplement(f.output,f.hash,result.hash),/Unexpected supplement/);await rm(join(f.output,'unreferenced-private-data'));
 const material=manifest.materials[0],old=await readFile(join(f.output,material.file));await writeFile(join(f.output,material.file),'changed bytes');await assert.rejects(verifyHistorySupplement(f.output,f.hash,result.hash),/fingerprint/);await writeFile(join(f.output,material.file),old);
 const saved=manifest.databases.find(d=>d.file);await writeFile(join(f.output,saved.file),'damaged DB');await assert.rejects(verifyHistorySupplement(f.output,f.hash,result.hash),/fingerprint/);
});

test('rejects source links and unsafe output paths without publishing a partial supplement',async t=>{
 const f=await fixture(t);
 await assert.rejects(captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:join(f.sourceRoot,'unsafe-output')}),/outside/);
 await rm(join(f.dataRoot,'admin/host.log'));await symlink(join(f.sourceRoot,'README.md'),join(f.dataRoot,'admin/host.log'));
 await assert.rejects(captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:f.output}),/regular file/);
 await rm(join(f.dataRoot,'admin/host.log'));await writeFile(join(f.dataRoot,'admin/host.log'),'Restored original log');
 await rename(join(f.dataRoot,'run-diagnostics/run'),join(f.dataRoot,'run-diagnostics/run-real'));
 await symlink('run-real',join(f.dataRoot,'run-diagnostics/run'));
 await assert.rejects(captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:f.output}),/regular directory/);
 assert.equal((await readdir(f.root)).some(name=>name.startsWith('.history-supplement-')),false);
 await writeFile(join(f.sourceRoot,'README.md'),'Changed source checkout');
 await assert.rejects(captureHistorySupplement({archive:f.archive,expectedHash:f.hash,output:f.output}),/Pinned source checkout changed/);
 await assert.rejects(main(['capture','--output',f.output,'--source','/caller/path']),/Use capture/);
});
