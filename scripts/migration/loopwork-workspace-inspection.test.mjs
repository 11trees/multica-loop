import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {cutoverFixture} from './loopwork-cutover-fixture.mjs';
import {stableDigest} from './loopwork-cutover-lib.mjs';
import {browseArchive} from './loopwork-history-lib.mjs';
import {changeSourceFence,prepareSourceFence} from './loopwork-source-fence.mjs';
import {captureWorkspace} from './loopwork-workspace.mjs';
import {inspectActivationWorkspaces} from './loopwork-workspace-inspection.mjs';

test('activation source reader recompiles current workspace against original packet and frozen cohort without authority or writes',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
 if(!await access(process.platform==='darwin'?'/usr/sbin/lsof':'/usr/bin/lsof').then(()=>true,()=>false)){t.skip('lsof required');return;}
 const f=await cutoverFixture(t,{workspaceRoot:true}),source=await prepareSourceFence(f.archive,f.hash),{packet}=await browseArchive(f.archive,f.hash,{action:'packet',task_id:'pending'});
 const project=randomUUID(),proposal={format:'loopwork-cutover-hold-v1',source,preparations:[{source_task_id:'pending',packet_hash:packet.hash,project_id:project}]};
 const record={id:randomUUID(),archive_hash:f.hash,scope_hash:stableDigest(proposal),source_namespace:source.source_namespace,payload:proposal};
 const payload={format:'loopwork-cutover-workspaces-v1',cutover_id:record.id,scope_hash:record.scope_hash,archive_hash:f.hash,source_namespace:record.source_namespace,workspaces:[{source_project_id:packet.source_project.id,project_id:project,content:await captureWorkspace(f.workspaceRoot)}],execution_authorized:false};
 const hash=stableDigest(payload),input={expected_hash:f.hash,expected_workspace_hash:hash,workspace_observation:{hash,payload},record};
 await changeSourceFence(f.archive,{...record,preimages:source.preimages},'freeze',async()=>{});
 for(const db of Object.values(f.dbs))db.close();
 const before=await readFile(join(f.workspaceRoot,'.git/index')),result=await inspectActivationWorkspaces(f.archive,input);
 assert.equal(result.matches_saved_baseline,true);assert.equal(result.workspace_hash,hash);assert.equal(result.workspaces[0].project_id,project);assert.equal(result.source_frozen,true);assert.equal(result.physical_quiescence_confirmed,false);assert.equal(result.execution_authorized,false);
 assert.deepEqual(await readFile(join(f.workspaceRoot,'.git/index')),before);
 await assert.rejects(inspectActivationWorkspaces(f.archive,{...input,expected_workspace_hash:'0'.repeat(64)}),/scope changed/);
 const foreign={...payload,workspaces:[{...payload.workspaces[0],content:{...payload.workspaces[0].content,root:f.sourceRoot}}]},foreignHash=stableDigest(foreign);
 await assert.rejects(inspectActivationWorkspaces(f.archive,{...input,expected_workspace_hash:foreignHash,workspace_observation:{hash:foreignHash,payload:foreign}}),/correspondence changed/);
 await writeFile(join(f.workspaceRoot,'new.md'),'Existing human changes\n');
 await assert.rejects(inspectActivationWorkspaces(f.archive,input),/differs from the acknowledged/);
});
