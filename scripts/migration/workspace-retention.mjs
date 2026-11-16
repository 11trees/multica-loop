import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,readlink,realpath,rename,symlink,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {captureWorkspace} from './loopwork-workspace.mjs';
import {fileInventory} from './target-backup.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const retentionHash=value=>sha(JSON.stringify(canonical(value)));
const equal=(a,b)=>retentionHash(a)===retentionHash(b);
const within=(root,path)=>{const part=relative(root,path);return !part||!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
const safePath=path=>typeof path==='string'&&path&&!isAbsolute(path)&&!path.includes('\0')&&!path.split('/').some(part=>['','.','..','.git'].includes(part.toLowerCase()));
function git(root,args,input){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_LFS_SKIP_SMUDGE:'1'});
 const supplied=input!==undefined&&input.length>0;
 return execFileSync('git',['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-C',root,...args],{env,input:supplied?input:undefined,maxBuffer:128*1024*1024,stdio:[supplied?'pipe':'ignore','pipe','pipe']});
}
const refs=root=>git(root,['for-each-ref','--format=%(refname) %(objectname) %(symref)']).toString('utf8').trimEnd().split('\n').filter(Boolean).map(line=>{const [name,oid,symref='']=line.split(' ');return {name,oid,symref};});
const branchOf=root=>{try{return git(root,['symbolic-ref','-q','HEAD']).toString().trim();}catch{return null;}};
async function optional(path){return lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});}
async function metadata(path){const stat=await optional(path);if(!stat)return null;if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Git retention metadata must be regular files');return readFile(path);}
export async function retentionDestination(path,protectedRoots){
 if(!isAbsolute(path))throw new Error('Retention requires an absolute new destination');
 const output=join(await realpath(dirname(path)),path.slice(dirname(path).length+1));
 for(const root of protectedRoots){const original=await realpath(root).catch(error=>{if(error.code==='ENOENT')return resolve(root);throw error;});if(within(original,output)||within(output,original))throw new Error('Retention destinations must be disjoint from all source roots');}
 if(await optional(output))throw new Error('Never overwrite a retention or restore directory');return output;
}
function validateSnapshot(snapshot){
 if(snapshot?.format!=='loopwork-workspace-content-v1'||snapshot.execution_authorized!==false||!isAbsolute(snapshot.root)||!Array.isArray(snapshot.files)||!Array.isArray(snapshot.index))throw new Error('Invalid retained workspace snapshot');
 const paths=new Set();for(const file of snapshot.files){if(!safePath(file.path)||paths.has(file.path)||!['file','symlink','deleted'].includes(file.kind))throw new Error('Unsafe retained workspace path');paths.add(file.path);}
 for(const path of paths){const parts=path.split('/');while(parts.length>1){parts.pop();if(paths.has(parts.join('/')))throw new Error('Retained workspace has conflicting parent paths');}}
 for(const row of snapshot.index)if(!safePath(row.path)||!['100644','100755','120000'].includes(row.mode)||!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(row.oid))throw new Error('Invalid retained staging identity');
}
async function storeBlob(directory,data){const hash=sha(data),path=`blobs/${hash}`;if(!await optional(join(directory,path)))await writeFile(join(directory,path),data,{mode:0o600,flag:'wx'});return path;}
export async function retainRepository(root,directory,expected){
 validateSnapshot(expected);if(root!==expected.root||!equal(await captureWorkspace(root),expected))throw new Error('Workspace differs from the acknowledged content');
 await mkdir(join(directory,'blobs'),{recursive:true,mode:0o700});
 const indexPath=resolve(root,git(root,['rev-parse','--git-path','index']).toString().trim()),indexBefore=await readFile(indexPath),beforeRefs=refs(root);
 const branch=branchOf(root),shallowPath=resolve(root,git(root,['rev-parse','--git-path','shallow']).toString().trim()),shallowBytes=await metadata(shallowPath),shallow=shallowBytes?shallowBytes.toString().trim().split('\n').filter(Boolean):[];
 const pack='objects.pack',tips=[...new Set([expected.head,...beforeRefs.map(row=>row.oid)])];
 await writeFile(join(directory,pack),git(root,['pack-objects','--stdout','--revs'],Buffer.from(tips.join('\n')+'\n')),{mode:0o600,flag:'wx'});
 const staged=[];for(const oid of [...new Set(expected.index.map(row=>row.oid))]){const data=git(root,['cat-file','blob',oid]);staged.push({oid,file:await storeBlob(directory,data)});}
 const working=[];let bytes=0;
 for(const file of expected.files){if(file.kind==='deleted')continue;const path=join(root,file.path),stat=await lstat(path);if(file.kind==='file'&&!stat.isFile()||file.kind==='symlink'&&!stat.isSymbolicLink())throw new Error('Workspace file kind changed');const data=file.kind==='symlink'?await readlink(path,{encoding:'buffer'}):await readFile(path);if(sha(data)!==file.hash||data.length!==file.size)throw new Error('Workspace file changed during retention');bytes+=data.length;if(bytes>1024*1024*1024)throw new Error('Workspace retention exceeds 1 GiB of current content');working.push({path:file.path,file:await storeBlob(directory,data)});}
 const excludePath=resolve(root,git(root,['rev-parse','--git-path','info/exclude']).toString().trim()),excludeBytes=await metadata(excludePath),exclude=excludeBytes?await storeBlob(directory,excludeBytes):null;
 if(!equal(shallowBytes?.toString('base64')??null,(await metadata(shallowPath))?.toString('base64')??null)||!equal(excludeBytes?.toString('base64')??null,(await metadata(excludePath))?.toString('base64')??null)||branchOf(root)!==branch||!indexBefore.equals(await readFile(indexPath))||!equal(refs(root),beforeRefs)||!equal(await captureWorkspace(root),expected))throw new Error('Workspace or Git staging changed during retention');
 return {snapshot:expected,snapshot_hash:retentionHash(expected),refs:beforeRefs,head_branch:branch,source_index_sha256:sha(indexBefore),pack,shallow,staged,working,exclude,current_bytes:bytes};
}
export async function verifyWorkspaceRetention(directory,expectedHash){
 directory=await realpath(directory);const saved=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),{hash,...body}=saved;
 if(!/^[a-f0-9]{64}$/.test(expectedHash??'')||hash!==expectedHash||retentionHash(body)!==hash||body.format!=='loopwork-workspace-retention-v1'||body.execution_authorized!==false||!Array.isArray(body.repositories)||!body.repositories.length)throw new Error('Workspace retention identity changed');
 const observation={format:'loopwork-cutover-workspaces-v1',cutover_id:body.cutover_id,scope_hash:body.scope_hash,archive_hash:body.archive_hash,source_namespace:body.source_namespace,workspaces:body.repositories.map(row=>({source_project_id:row.source_project_id,project_id:row.project_id,content:row.snapshot})),execution_authorized:false};
 if(retentionHash(observation)!==body.workspace_hash||new Set(body.repositories.map(row=>row.directory)).size!==body.repositories.length||new Set(body.repositories.map(row=>row.project_id)).size!==body.repositories.length)throw new Error('Retained workspace cohort differs from the acknowledged observation');
 const inventory=(await fileInventory(directory)).filter(row=>row.path!=='manifest.json');if(!equal(inventory,body.files))throw new Error('Workspace retention payload changed');
 for(const repo of body.repositories){validateSnapshot(repo.snapshot);if(repo.snapshot_hash!==retentionHash(repo.snapshot)||!/^repositories\/\d+$/.test(repo.directory)||repo.pack!=='objects.pack'||!Array.isArray(repo.shallow)||repo.shallow.some(oid=>!new RegExp('^[a-f0-9]{'+repo.snapshot.head.length+'}$').test(oid)))throw new Error('Workspace retention correspondence changed');const root=join(directory,repo.directory),files=new Map(repo.snapshot.files.map(row=>[row.path,row]));
  const blob=async path=>{if(!/^blobs\/[a-f0-9]{64}$/.test(path))throw new Error('Invalid retention blob');const data=await readFile(join(root,path));if(sha(data)!==path.slice(6))throw new Error('Retention blob changed');return data;};
  if(repo.working.length!==repo.snapshot.files.filter(row=>row.kind!=='deleted').length||new Set(repo.working.map(row=>row.path)).size!==repo.working.length)throw new Error('Retained working content incomplete');
  for(const item of repo.working){const source=files.get(item.path),data=await blob(item.file);if(!source||source.kind==='deleted'||data.length!==source.size||sha(data)!==source.hash)throw new Error('Retained working content differs');}
  const expected=new Set(repo.snapshot.index.map(row=>row.oid));if(repo.staged.length!==expected.size||new Set(repo.staged.map(row=>row.oid)).size!==expected.size)throw new Error('Retained staging content incomplete');
  for(const item of repo.staged){if(!expected.has(item.oid))throw new Error('Unexpected staging blob');const data=await blob(item.file),digest=createHash(item.oid.length===40?'sha1':'sha256').update(`blob ${data.length}\0`).update(data).digest('hex');if(digest!==item.oid)throw new Error('Retained staging object differs');}
  if(repo.exclude)await blob(repo.exclude);
 }
 return saved;
}
export async function publishWorkspaceRetention(stage,output,body){
 const contents={format:'loopwork-workspace-retention-v1',captured_at:new Date().toISOString(),...body,files:await fileInventory(stage),execution_authorized:false,exclusions:['Ignored files outside HEAD/index, reflogs, hooks, credentials/configuration outside the captured project, source Git configuration and external LFS/submodule data are excluded.','The restored index preserves staged entries and bytes, not source stat caches or index flags. Symlinks retain link bytes only.','Retention and isolated restoration grant no live repository, process, source-release or verification authority.']};
 const manifest={...contents,hash:retentionHash(contents)};await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});await verifyWorkspaceRetention(stage,manifest.hash);await rename(stage,output);return manifest;
}
export async function drillWorkspaceRetention({backup,expectedHash,output}){
 backup=await realpath(backup);const manifest=await verifyWorkspaceRetention(backup,expectedHash);output=await retentionDestination(output,[backup,...manifest.protected_roots,...manifest.repositories.map(row=>row.snapshot.root)]);await mkdir(output,{mode:0o700});const results=[];
 for(const repo of manifest.repositories){const root=join(output,repo.directory),stored=join(backup,repo.directory);await mkdir(root,{recursive:true,mode:0o700});
  git(root,['init','-q','--template=','--object-format='+ (repo.snapshot.head.length===40?'sha1':'sha256')]);
  git(root,['index-pack','--stdin'],await readFile(join(stored,repo.pack)));
  if(repo.shallow.length)await writeFile(join(root,'.git/shallow'),repo.shallow.join('\n')+'\n',{mode:0o600,flag:'wx'});
  const direct=repo.refs.filter(row=>!row.symref).map(row=>`create ${row.name} ${row.oid}\n`).join('');if(direct)git(root,['update-ref','--stdin'],Buffer.from(direct));
  for(const ref of repo.refs)if(ref.symref)git(root,['symbolic-ref',ref.name,ref.symref]);
  if(repo.head_branch)git(root,['symbolic-ref','HEAD',repo.head_branch]);else git(root,['update-ref','--no-deref','HEAD',repo.snapshot.head]);
  for(const item of repo.staged){const oid=git(root,['hash-object','-w','--no-filters',join(stored,item.file)]).toString().trim();if(oid!==item.oid)throw new Error('Restored staging blob differs');}
  const index=Buffer.from(repo.snapshot.index.map(row=>`${row.mode} ${row.oid}\t${row.path}\0`).join(''));git(root,['update-index','-z','--index-info'],index);
  if(repo.exclude){await mkdir(join(root,'.git/info'),{recursive:true,mode:0o700});await writeFile(join(root,'.git/info/exclude'),await readFile(join(stored,repo.exclude)),{mode:0o600});}
  for(const item of repo.working){const file=repo.snapshot.files.find(row=>row.path===item.path),target=join(root,item.path);await mkdir(dirname(target),{recursive:true,mode:0o700});const data=await readFile(join(stored,item.file));if(file.kind==='symlink')await symlink(data,target);else{await writeFile(target,data,{mode:0o600,flag:'wx'});await chmod(target,file.mode);}}
  git(root,['fsck','--full','--no-reflogs']);const observed=await captureWorkspace(root);if(!equal({...observed,root:repo.snapshot.root},repo.snapshot)||!equal(refs(root),repo.refs))throw new Error('Restored workspace or Git references differ');
  results.push({source_root:repo.snapshot.root,restored_root:root,head:observed.head,files:observed.files.length,untracked_files:observed.untracked_count,deleted_files:observed.deleted_count,staged_entries:observed.index.length,git_refs:repo.refs.length,content_and_staging_equal:true,git_history_checked:true,shallow_boundaries:repo.shallow.length});
 }
 const receipt={format:'loopwork-workspace-restore-drill-v1',checked_at:new Date().toISOString(),backup_hash:expectedHash,workspace_hash:manifest.workspace_hash,cutover_id:manifest.cutover_id,repositories:results,execution_authorized:false,live_restore_accepted:false};await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});return receipt;
}
