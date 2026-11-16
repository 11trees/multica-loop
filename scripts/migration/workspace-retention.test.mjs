import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {captureWorkspace} from './loopwork-workspace.mjs';
import {main} from './loopwork-retain.mjs';
import {retainRepository,publishWorkspaceRetention,verifyWorkspaceRetention,drillWorkspaceRetention,retentionHash} from './workspace-retention.mjs';
function context(repository,source){
 const repo={...repository,source_project_id:'project',project_id:'00000000-0000-4000-8000-000000000001',directory:'repositories/0'},body={cutover_id:'00000000-0000-4000-8000-000000000002',scope_hash:'a'.repeat(64),archive_hash:'b'.repeat(64),source_namespace:'c'.repeat(64),protected_roots:[source],repositories:[repo]};
 const payload={format:'loopwork-cutover-workspaces-v1',cutover_id:body.cutover_id,scope_hash:body.scope_hash,archive_hash:body.archive_hash,source_namespace:body.source_namespace,workspaces:[{source_project_id:repo.source_project_id,project_id:repo.project_id,content:repo.snapshot}],execution_authorized:false};return {...body,workspace_hash:retentionHash(payload)};
}
async function fixture(t,{shallow=false,detached=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'multica-retention-test-'))),source=join(root,'source');await mkdir(source);t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',source,...args],{stdio:['ignore','pipe','pipe']});git('init','-q');await writeFile(join(source,'tracked'),'Original\n');await writeFile(join(source,'deleted'),'Tracked deletion\n');await writeFile(join(source,'empty'),'');await writeFile(join(source,'.gitignore'),'.env\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Original');
 if(shallow){const parent=git('rev-parse','HEAD').toString().trim();git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Shallow tip');const head=git('rev-parse','HEAD').toString().trim();await writeFile(join(source,'.git/shallow'),head+'\n');await rm(join(source,'.git/objects',parent.slice(0,2),parent.slice(2)));}
 git('tag','retained-tag');git('branch','other-branch');git('symbolic-ref','refs/remotes/fixture/HEAD','refs/heads/other-branch');
 if(detached){git('checkout','--detach','-q','HEAD');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Detached tip');}
 await writeFile(join(source,'tracked'),'Staged\n');git('add','tracked');await writeFile(join(source,'tracked'),'Working after staging\n');await chmod(join(source,'tracked'),0o755);await rm(join(source,'deleted'));await mkdir(join(source,'.tmp'));await writeFile(join(source,'.tmp/new\nfile'),Buffer.from([0,255,1,2]));await writeFile(join(source,'.env'),'ignored-secret-not-retained');await symlink('/missing-external-target',join(source,'link'));
 const snapshot=await captureWorkspace(source),stage=join(root,'stage');await mkdir(join(stage,'repositories/0'),{recursive:true,mode:0o700});const before=await readFile(join(source,'.git/index')),repository=await retainRepository(source,join(stage,'repositories/0'),snapshot),output=join(root,'backup');
 const manifest=await publishWorkspaceRetention(stage,output,context(repository,source));return {root,source,output,snapshot,manifest,before};
}

test('restores staged, unstaged, executable, deleted, untracked binary and symlink content plus Git refs without changing the source',async t=>{
 const f=await fixture(t);assert.deepEqual(await readFile(join(f.source,'.git/index')),f.before);assert.deepEqual(await captureWorkspace(f.source),f.snapshot);
 const result=await drillWorkspaceRetention({backup:f.output,expectedHash:f.manifest.hash,output:join(f.root,'drill')});assert.equal(result.execution_authorized,false);assert.equal(result.repositories[0].content_and_staging_equal,true);assert.equal(result.repositories[0].untracked_files,2);assert.equal(result.repositories[0].deleted_files,1);
 assert.deepEqual(await captureWorkspace(f.source),f.snapshot);assert.deepEqual(await readFile(join(f.source,'.git/index')),f.before);assert.equal((await verifyWorkspaceRetention(f.output,f.manifest.hash)).hash,f.manifest.hash);
 await assert.rejects(readFile(join(f.root,'drill/repositories/0/.env')),/ENOENT/);
});

test('rejects altered payloads, wrong pins, existing outputs and source-root restore destinations',async t=>{
 const f=await fixture(t);await assert.rejects(verifyWorkspaceRetention(f.output,'0'.repeat(64)),/identity/);
 await assert.rejects(drillWorkspaceRetention({backup:f.output,expectedHash:f.manifest.hash,output:join(f.source,'unsafe')}),/disjoint/);
 await assert.rejects(drillWorkspaceRetention({backup:f.output,expectedHash:f.manifest.hash,output:f.output}),/disjoint|overwrite/);
 const altered=JSON.parse(JSON.stringify(f.manifest));delete altered.hash;altered.repositories[0].project_id='foreign-project';altered.hash=retentionHash(altered);await writeFile(join(f.output,'manifest.json'),JSON.stringify(altered));await assert.rejects(verifyWorkspaceRetention(f.output,altered.hash),/acknowledged observation/);await writeFile(join(f.output,'manifest.json'),JSON.stringify(f.manifest));
 const file=f.manifest.files.find(row=>row.path.includes('/blobs/'));await writeFile(join(f.output,file.path),'Changed');await assert.rejects(verifyWorkspaceRetention(f.output,f.manifest.hash),/payload/);
});

test('retains a shallow boundary and restores available history without fetching a missing parent',async t=>{
 const f=await fixture(t,{shallow:true});assert.equal(f.manifest.repositories[0].shallow.length,1);const receipt=await drillWorkspaceRetention({backup:f.output,expectedHash:f.manifest.hash,output:join(f.root,'shallow-drill')});assert.equal(receipt.repositories[0].shallow_boundaries,1);assert.equal(receipt.repositories[0].content_and_staging_equal,true);const root=receipt.repositories[0].restored_root;assert.equal(execFileSync('git',['-C',root,'rev-parse','--is-shallow-repository'],{encoding:'utf8'}).trim(),'true');assert.equal(execFileSync('git',['-C',root,'rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'1');assert.deepEqual(await captureWorkspace(f.source),f.snapshot);
});

test('retains an unreferenced detached HEAD and refuses a changed acknowledged workspace',async t=>{
 const f=await fixture(t,{detached:true});assert.equal(f.manifest.repositories[0].head_branch,null);const receipt=await drillWorkspaceRetention({backup:f.output,expectedHash:f.manifest.hash,output:join(f.root,'detached-drill')});assert.equal(execFileSync('git',['-C',receipt.repositories[0].restored_root,'rev-parse','--abbrev-ref','HEAD'],{encoding:'utf8'}).trim(),'HEAD');await writeFile(join(f.source,'tracked'),'Later user work');await assert.rejects(retainRepository(f.source,join(f.root,'changed'),f.snapshot),/acknowledged/);
});

test('restores an empty staging index while preserving remaining working files',async t=>{
 const f=await fixture(t);execFileSync('git',['-C',f.source,'rm','--cached','-f','-r','.'],{stdio:['ignore','pipe','pipe']});const snapshot=await captureWorkspace(f.source);assert.equal(snapshot.index.length,0);const stage=join(f.root,'empty-stage');await mkdir(join(stage,'repositories/0'),{recursive:true,mode:0o700});const repo=await retainRepository(f.source,join(stage,'repositories/0'),snapshot),backup=join(f.root,'empty-backup'),manifest=await publishWorkspaceRetention(stage,backup,context(repo,f.source));const receipt=await drillWorkspaceRetention({backup,expectedHash:manifest.hash,output:join(f.root,'empty-drill')});assert.equal(receipt.repositories[0].staged_entries,0);assert.equal(receipt.repositories[0].content_and_staging_equal,true);assert.deepEqual(await captureWorkspace(f.source),snapshot);
});

test('capture accepts native cutover identity rather than caller-selected source paths',async()=>{
 await assert.rejects(main(['capture','--id','00000000-0000-4000-8000-000000000001','--expected-workspace','a'.repeat(64),'--output','/tmp/new','--source','/caller/source'],{}),/Use capture/);
});
