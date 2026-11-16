import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,realpath,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {cutoverFixture} from './loopwork-cutover-fixture.mjs';
import {createArchive,verifyArchive} from './loopwork-history-lib.mjs';
import {browseHistorySupplement,captureHistorySupplement,captureReferenceSupplement,verifyHistorySupplement} from './loopwork-history-supplement.mjs';
import {main} from './loopwork-supplement.mjs';

async function fixture(t){
 const f=await cutoverFixture(t,{workspaceRoot:true});await mkdir(join(f.workspaceRoot,'.tmp'));
 const image=Buffer.from([0,255,1,2,3,0]),text='Exact current proof\n';
 await writeFile(join(f.workspaceRoot,'.tmp/image (1).png'),image);await writeFile(join(f.workspaceRoot,'.tmp/proof.txt'),text);
 await writeFile(join(f.workspaceRoot,'.env'),'not-exported');await writeFile(join(f.workspaceRoot,'.npmrc'),'not-exported');await writeFile(join(f.workspaceRoot,'private.db'),'not-exported');await writeFile(join(f.root,'outside.txt'),'not-exported');await symlink(join(f.root,'outside.txt'),join(f.workspaceRoot,'.tmp/link.txt'));
 f.business.prepare('UPDATE documents SET content=? WHERE document_id=?').run('![image](<.tmp/image%20(1).png>) [.tmp/proof.txt](.tmp/proof.txt#L1) [again](.tmp/proof.txt) [line](.tmp/proof.txt:3) [remote](https://example.invalid/proof) [escape](../outside.txt) [secret](.env) [registry](.npmrc) [database](private.db) [link](.tmp/link.txt) [missing](missing.txt) [tree](.tmp/) [glob](.tmp/*.png) [anchor](#local)','original');
 f.business.prepare('UPDATE tasks SET description=? WHERE task_id=?').run(JSON.stringify({paths:['.tmp/proof.txt:3-7']}),'pending');
 const archive=join(f.root,'reference-primary'),captured=await createArchive({sourceRoot:f.sourceRoot,dataRoot:f.dataRoot,output:archive});
 const supplement=join(f.root,'supplement'),saved=await captureHistorySupplement({archive,expectedHash:captured.hash,output:supplement});
 return {...f,archive,hash:captured.hash,supplement,supplementHash:saved.hash,image,text,output:join(f.root,'references')};
}
async function inventory(root){const result={};async function visit(path){for(const item of await readdir(join(root,path),{withFileTypes:true})){const next=path?`${path}/${item.name}`:item.name;if(item.isDirectory())await visit(next);else if(!item.isSymbolicLink())result[next]=createHash('sha256').update(await readFile(join(root,next))).digest('hex');}}await visit('');return result;}

test('extends a pinned supplement with current file bytes and source-qualified reference dispositions while preserving both inputs',async t=>{
 const f=await fixture(t),before=await inventory(f.workspaceRoot),primary=await inventory(f.archive),previous=await inventory(f.supplement);
 const result=await captureReferenceSupplement({archive:f.archive,expectedHash:f.hash,supplement:f.supplement,expectedSupplementHash:f.supplementHash,output:f.output});
 assert.equal(result.captured_files,2);assert.equal(result.execution_authorized,false);
 const manifest=await verifyHistorySupplement(f.output,f.hash,result.hash),reportEntry=manifest.materials.find(row=>row.category==='reference_inventory'),report=JSON.parse(await readFile(join(f.output,reportEntry.file),'utf8'));
 assert.equal(report.parent_supplement_hash,f.supplementHash);assert.equal(manifest.reference_capture.inventory_sha256,reportEntry.sha256);
 const refs=report.references.filter(row=>row.table==='documents'&&row.syntax==='markdown'),disposition=target=>refs.find(row=>row.target===target)?.disposition;
 for(const [target,status] of [['https://example.invalid/proof','remote_not_fetched'],['../outside.txt','outside_project'],['.env','configuration_or_database_excluded'],['.npmrc','configuration_or_database_excluded'],['private.db','configuration_or_database_excluded'],['.tmp/link.txt','symbolic_path_excluded'],['missing.txt','missing'],['.tmp/','directory_not_captured'],['.tmp/*.png','unsupported_path'],['#local','document_anchor']])assert.equal(disposition(target),status,target);
 assert.ok(report.references.some(row=>row.table==='tasks'&&row.field==='description'&&row.pointer==='/paths/0'&&row.task_id==='pending'&&row.disposition==='captured_current_bytes'));
 const file=manifest.materials.find(row=>row.origin.source_path==='.tmp/image (1).png');assert.deepEqual(await readFile(join(f.output,file.file)),f.image);
 const scope={expected_archive_hash:f.hash,expected_hash:result.hash},catalog=await browseHistorySupplement(f.output,{...scope,action:'catalog'}),header=catalog.files.find(row=>row.path===file.path);
 const download=await browseHistorySupplement(f.output,{...scope,action:'file',file_id:header.id,length:1048576});assert.deepEqual(Buffer.from(download.data_base64,'base64'),f.image);
 assert.equal(JSON.stringify(manifest).includes('not-exported'),false);
 assert.deepEqual(await inventory(f.workspaceRoot),before);assert.deepEqual(await inventory(f.archive),primary);assert.deepEqual(await inventory(f.supplement),previous);assert.equal((await verifyArchive(f.archive)).hash,f.hash);
 const verified=await main(['verify','--supplement',f.output,'--expected-hash',result.hash],{MULTICA_LOOPWORK_HISTORY_ARCHIVE:f.archive,MULTICA_LOOPWORK_HISTORY_HASH:f.hash});assert.equal(verified.hash,result.hash);
 await assert.rejects(captureReferenceSupplement({archive:f.archive,expectedHash:f.hash,supplement:f.supplement,expectedSupplementHash:f.supplementHash,output:f.output}),/Never overwrite/);
});

test('refuses wrong identities and output under original project roots, retaining the previous supplement',async t=>{
 const f=await fixture(t),args={archive:f.archive,expectedHash:f.hash,supplement:f.supplement,expectedSupplementHash:f.supplementHash,output:f.output};
 await assert.rejects(captureReferenceSupplement({...args,expectedSupplementHash:'0'.repeat(64)}),/identity/);
 await assert.rejects(captureReferenceSupplement({...args,output:join(f.workspaceRoot,'capture')}),/outside/);
 await writeFile(join(f.sourceRoot,'README.md'),'Changed checkout');await assert.rejects(captureReferenceSupplement(args),/Pinned source checkout changed/);
 assert.equal((await verifyHistorySupplement(f.supplement,f.hash,f.supplementHash)).hash,f.supplementHash);
 assert.equal((await readdir(f.root)).some(name=>name.startsWith('.history-supplement-')),false);
});

test('keeps secondary references scoped to the original database and requires exact project/root correspondence',async t=>{
 const f=await fixture(t);
 for(const [directory,root] of [['matched',f.workspaceRoot],['foreign',f.root]]){
  await mkdir(join(f.dataRoot,directory));const db=new DatabaseSync(join(f.dataRoot,directory,'loop-ui.db'));
  db.exec('CREATE TABLE projects(project_id TEXT,workspace_root TEXT);CREATE TABLE tasks(task_id TEXT,project_id TEXT,description TEXT);CREATE TABLE documents(document_id TEXT,task_id TEXT,content TEXT)');
  db.prepare('INSERT INTO projects VALUES(?,?)').run('project',root);db.prepare('INSERT INTO tasks VALUES(?,?,?)').run('pending','project','[proof](.tmp/proof.txt)');db.prepare('INSERT INTO documents VALUES(?,?,?)').run('original','pending','[image](<.tmp/image%20(1).png>)');db.close();
 }
 const archive=join(f.root,'secondary-primary'),primary=await createArchive({sourceRoot:f.sourceRoot,dataRoot:f.dataRoot,output:archive}),supplement=join(f.root,'secondary-supplement'),base=await captureHistorySupplement({archive,expectedHash:primary.hash,output:supplement});
 const captured=await captureReferenceSupplement({archive,expectedHash:primary.hash,supplement,expectedSupplementHash:base.hash,output:f.output}),manifest=await verifyHistorySupplement(f.output,primary.hash,captured.hash),entry=manifest.materials.find(row=>row.category==='reference_inventory'),report=JSON.parse(await readFile(join(f.output,entry.file),'utf8'));
 const matched=report.references.filter(row=>row.database==='matched/loop-ui.db'),foreign=report.references.filter(row=>row.database==='foreign/loop-ui.db');
 assert.equal(matched.filter(row=>row.disposition==='captured_current_bytes').length,2);assert.equal(foreign.length,2);assert.ok(foreign.every(row=>row.disposition==='unresolved_project'&&row.workspace_root===null));
 assert.ok(matched.some(row=>row.table==='documents'&&row.row==='original'&&row.task_id==='pending'));
 await assert.rejects(captureReferenceSupplement({archive,expectedHash:primary.hash,supplement:f.output,expectedSupplementHash:captured.hash,output:join(f.root,'again')}),/original supplement/);
});

test('uses exact archived import provenance for pre-project databases and refuses backups, owner conflicts and root contradictions',async t=>{
 const f=await fixture(t);
 f.business.exec('CREATE TABLE legacy_project_database_imports(source_db_path TEXT PRIMARY KEY,workspace_root TEXT,project_id TEXT,imported_at TEXT)');
 for(const directory of ['imported','rewritten-project','same-folder-backup','wrong-owner','contradictory-root']){
  await mkdir(join(f.dataRoot,directory));const path=join(f.dataRoot,directory,'loop-ui.db'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE tasks(task_id TEXT,description TEXT);CREATE TABLE documents(document_id TEXT,task_id TEXT,content TEXT)');
  const task=directory==='wrong-owner'?'deleted-pending':'pending';db.prepare('INSERT INTO tasks VALUES(?,?)').run(task,'[proof](.tmp/proof.txt)');db.prepare('INSERT INTO documents VALUES(?,?,?)').run('original',task,'[image](<.tmp/image%20(1).png>)');
  if(directory==='contradictory-root'){db.exec('CREATE TABLE projects(project_id TEXT,workspace_root TEXT)');db.prepare('INSERT INTO projects VALUES(?,?)').run('foreign',f.root);}
  if(directory==='rewritten-project'){db.exec("ALTER TABLE tasks ADD COLUMN project_id TEXT;UPDATE tasks SET project_id='old-project';CREATE TABLE projects(project_id TEXT,workspace_root TEXT)");db.prepare('INSERT INTO projects VALUES(?,?)').run('old-project',f.workspaceRoot);}
  db.close();
  if(directory!=='same-folder-backup')f.business.prepare('INSERT INTO legacy_project_database_imports VALUES(?,?,?,?)').run(await realpath(path),f.workspaceRoot,'project','2026-01-01');
 }
 const archive=join(f.root,'import-primary'),primary=await createArchive({sourceRoot:f.sourceRoot,dataRoot:f.dataRoot,output:archive}),supplement=join(f.root,'import-supplement'),base=await captureHistorySupplement({archive,expectedHash:primary.hash,output:supplement});
 const captured=await captureReferenceSupplement({archive,expectedHash:primary.hash,supplement,expectedSupplementHash:base.hash,output:f.output}),manifest=await verifyHistorySupplement(f.output,primary.hash,captured.hash),entry=manifest.materials.find(row=>row.category==='reference_inventory'),report=JSON.parse(await readFile(join(f.output,entry.file),'utf8'));
 const importedPath=await realpath(join(f.dataRoot,'imported/loop-ui.db')),imported=report.references.filter(row=>row.database==='imported/loop-ui.db');assert.equal(imported.length,2);assert.ok(imported.every(row=>row.disposition==='captured_current_bytes'&&row.project_correspondence.kind==='recorded_legacy_import'&&row.project_correspondence.source_db_path===importedPath&&row.project_correspondence.project_id==='project'));
 const rewritten=report.references.filter(row=>row.database==='rewritten-project/loop-ui.db');assert.equal(rewritten.length,2);assert.ok(rewritten.every(row=>row.disposition==='captured_current_bytes'&&row.project_correspondence.source_project_id==='old-project'&&row.project_id==='project'));
 for(const name of ['same-folder-backup','wrong-owner','contradictory-root']){const refs=report.references.filter(row=>row.database===`${name}/loop-ui.db`);assert.equal(refs.length,2);assert.ok(refs.every(row=>row.disposition==='unresolved_project'&&row.workspace_root===null));}
 assert.equal((await verifyHistorySupplement(supplement,primary.hash,base.hash)).hash,base.hash);assert.equal((await verifyArchive(archive)).hash,primary.hash);assert.equal(captured.captured_files,2);assert.equal(captured.execution_authorized,false);
});
