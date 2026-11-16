import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdir,realpath,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyArchive} from './loopwork-history-lib.mjs';
import {inspectActivationWorkspaces} from './loopwork-workspace-inspection.mjs';
import {retentionDestination,retainRepository,publishWorkspaceRetention,retentionHash,verifyWorkspaceRetention,drillWorkspaceRetention} from './workspace-retention.mjs';

export async function captureRetainedWorkspaces({env=process.env,id,expectedWorkspaceHash,output}){
 const url=new URL(env.DATABASE_URL??'');if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||[...url.searchParams].some(([key,value])=>key!=='sslmode'||value!=='disable')||!/^[a-f0-9-]{36}$/.test(id)||!/^[a-f0-9]{64}$/.test(expectedWorkspaceHash)||!env.MULTICA_LOOPWORK_HISTORY_ARCHIVE)throw new Error('Use the pinned local cutover and exact workspace identity');
 const archive=await realpath(env.MULTICA_LOOPWORK_HISTORY_ARCHIVE),primary=await verifyArchive(archive);if(primary.hash!==env.MULTICA_LOOPWORK_HISTORY_HASH)throw new Error('Primary archive pin changed');
 const client=new pg.Client({connectionString:env.DATABASE_URL});let stage;
 try{
  await client.connect();const row=(await client.query('SELECT * FROM engineering_history_cutover WHERE id=$1',[id])).rows[0],saved=row?.receipt?.workspace_observations?.at(-1);
  if(!row||row.phase!=='source_frozen'||row.activation!==null||row.archive_hash!==primary.hash||saved?.hash!==expectedWorkspaceHash)throw new Error('Retention requires the exact current pre-activation workspace');
  const inspect=record=>inspectActivationWorkspaces(archive,{expected_hash:primary.hash,expected_workspace_hash:expectedWorkspaceHash,workspace_observation:saved,record});
  const before=await inspect(row),protectedRoots=[process.cwd(),archive,primary.source.repository,primary.source.data_root,...primary.databases.find(entry=>entry.role==='business').summary.projects.map(entry=>entry.workspace_root),...(env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT?[env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT]:[])].map(root=>resolve(root));
  output=await retentionDestination(output,protectedRoots);stage=join(dirname(output),`.workspace-retention-${randomUUID()}`);await mkdir(join(stage,'repositories'),{recursive:true,mode:0o700});
  const repositories=[];
  for(const [index,workspace] of saved.payload.workspaces.entries()){const directory=`repositories/${index}`;await mkdir(join(stage,directory),{mode:0o700});repositories.push({...await retainRepository(workspace.content.root,join(stage,directory),workspace.content),directory,source_project_id:workspace.source_project_id,project_id:workspace.project_id});}
  const current=(await client.query('SELECT * FROM engineering_history_cutover WHERE id=$1',[id])).rows[0];if(retentionHash(current)!==retentionHash(row))throw new Error('Native cutover changed during retention');
  const after=await inspect(current);if(after.workspace_hash!==before.workspace_hash)throw new Error('Workspace/source proof changed during retention');
  const manifest=await publishWorkspaceRetention(stage,output,{cutover_id:id,workspace_hash:expectedWorkspaceHash,scope_hash:row.scope_hash,archive_hash:primary.hash,source_namespace:row.source_namespace,protected_roots:protectedRoots,repositories});stage=null;
  return {backup:output,hash:manifest.hash,workspace_hash:expectedWorkspaceHash,repositories:repositories.map(row=>({source_project_id:row.source_project_id,root:row.snapshot.root,head:row.snapshot.head,files:row.snapshot.files.length,untracked_files:row.snapshot.untracked_count,deleted_files:row.snapshot.deleted_count,current_bytes:row.current_bytes,refs:row.refs.length})),source_unchanged:true,execution_authorized:false};
 }finally{if(stage)await rm(stage,{recursive:true,force:true});await client.end();}
}
export async function main(args,env=process.env){
 const [action,...rest]=args,options={};for(let i=0;i<rest.length;i+=2){if(!rest[i]?.startsWith('--')||!rest[i+1]||Object.hasOwn(options,rest[i]))throw new Error('Invalid retention arguments');options[rest[i]]=rest[i+1];}
 const allowed=action==='capture'?['--id','--expected-workspace','--output']:action==='verify'?['--backup','--expected-hash']:action==='drill'?['--backup','--expected-hash','--output']:[];
 if(!allowed.length||Object.keys(options).length!==allowed.length||allowed.some(key=>!options[key]))throw new Error('Use capture --id cutover-uuid --expected-workspace sha256 --output new-absolute-path | verify --backup absolute-path --expected-hash sha256 | drill --backup absolute-path --expected-hash sha256 --output new-absolute-path');
 if(action==='capture')return captureRetainedWorkspaces({env,id:options['--id'],expectedWorkspaceHash:options['--expected-workspace'],output:options['--output']});
 if(action==='drill')return drillWorkspaceRetention({backup:options['--backup'],expectedHash:options['--expected-hash'],output:options['--output']});
 const manifest=await verifyWorkspaceRetention(options['--backup'],options['--expected-hash']);return {hash:manifest.hash,repositories:manifest.repositories.length,execution_authorized:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(()=>{process.stderr.write('Workspace retention or isolated restore refused. Source files, index and native ownership were not intentionally changed.\n');process.exitCode=1;});
