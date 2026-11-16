import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {constants,createReadStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {copyDatabase,sourceFiles,verifyArchive} from './loopwork-history-lib.mjs';

const format='loopwork-history-supplement-v1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const within=(root,path)=>{const part=relative(root,path);return !part||!isAbsolute(part)&&part!=='..'&&!part.startsWith(`..${sep}`);};
const safeRelative=path=>typeof path==='string'&&!!path&&!isAbsolute(path)&&!path.split(/[\\/]/).some(part=>['','.','..'].includes(part));
function assertSourceCheckout(source){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'});
 const git=(...args)=>execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',source.repository,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 if(git('rev-parse','HEAD')!==source.commit||git('status','--porcelain','--untracked-files=no'))throw new Error('Pinned source checkout changed');
}
async function existing(path){return lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});}
async function destination(path){
 if(!isAbsolute(path))throw new Error('Supplement output requires an absolute path');
 const suffix=[];let parent=resolve(path);
 while(!await existing(parent)){suffix.unshift(basename(parent));parent=dirname(parent);}
 return join(await realpath(parent),...suffix);
}
async function regular(root,path){
 if(!safeRelative(path))throw new Error('Invalid relative material path');
 const absolute=join(root,path),stat=await existing(absolute);
 if(!stat)return null;
 let parent=root;
 for(const part of relative(root,dirname(absolute)).split(sep).filter(Boolean)){
  parent=join(parent,part);const directory=await lstat(parent);
  if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('Historical material parent must be a regular directory');
 }
 if(!stat.isFile()||stat.isSymbolicLink()||!within(root,await realpath(absolute)))throw new Error('Material must be a regular file inside its original root');
 return stat;
}
async function fingerprint(root,path){
 const before=await regular(root,path);if(!before)return null;
 const digest=createHash('sha256');for await(const chunk of createReadStream(join(root,path)))digest.update(chunk);
 const after=await regular(root,path);
 if(!after||['dev','ino','size','mode','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw new Error('Historical material changed while reading');
 return {bytes:before.size,sha256:digest.digest('hex')};
}
function inventory(path,knownTasks){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF');
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{
   if(/^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql??''))throw new Error('Unsupported virtual historical database');
   return {name:row.name,columns:db.prepare(`PRAGMA table_info(${quote(row.name)})`).all().map(c=>c.name),rows:Number(db.prepare(`SELECT count(*) AS n FROM ${quote(row.name)}`).get().n)};
  });
  const columns=name=>tables.find(t=>t.name===name)?.columns??[];
  const tasks=columns('tasks').includes('task_id')?db.prepare('SELECT task_id FROM tasks ORDER BY task_id').all().map(row=>row.task_id):[];
  const application=tables.some(t=>['app_settings','global_runtime_configurations','runtime_configurations','global_runtime_configuration_versions'].includes(t.name));
  const business=columns('tasks').includes('task_id')&&columns('documents').includes('document_id');
  return {kind:application?'application_configuration_excluded':business?'historical_business_database':tables.length?'unsupported_database_excluded':'empty_sqlite_database',tables,task_ids:tasks,task_ids_in_primary_archive:tasks.filter(id=>knownTasks.has(id)),task_ids_outside_primary_archive:tasks.filter(id=>!knownTasks.has(id))};
 }finally{db.close();}
}
function primaryScope(archive,manifest){
 const entry=manifest.databases.find(d=>d.role==='business'),db=new DatabaseSync(join(archive,entry.file),{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF');
  const has=(table,column)=>entry.summary.tables.some(t=>t.name===table&&t.columns.includes(column));
  return {tasks:new Set(entry.summary.tasks.map(t=>t.task_id)),runs:has('loop_runs','run_id')?db.prepare('SELECT run_id FROM loop_runs ORDER BY run_id').all().map(r=>r.run_id):[],profiles:has('project_agent_states','project_id')&&has('project_agent_states','agent_id')?db.prepare('SELECT project_id,agent_id FROM project_agent_states ORDER BY project_id,agent_id').all():[]};
 }finally{db.close();}
}
async function sourceMaterials(root,scope){
 const files=[];
 const add=async(path,category,origin)=>{if(await existing(join(root,path)))files.push({path,category,origin});};
 for(const id of scope.runs){
  if(!safeRelative(id)||id.includes('/'))throw new Error('Unsupported source run identity');
  for(const leaf of ['runner.pid','runner.start-gate'])await add(`runs/${id}/${leaf}`,'run_process_history',{run_id:id});
  await add(`run-diagnostics/${id}/runner.stderr.log`,'run_diagnostics',{run_id:id});
 }
 await add('admin/host.log','management_host_log',{});
 await add('agent-runtime/manifest.json','generated_profile_inventory',{});
 for(const {project_id,agent_id} of scope.profiles){
  if(!safeRelative(project_id)||project_id.includes('/')||!safeRelative(agent_id)||agent_id.includes('/'))throw new Error('Unsupported source profile identity');
  const directory=`agent-runtime/projects/${project_id}/agents/${agent_id}`;
  for(const leaf of ['PROMPT.md','MEMORY.md'])await add(`${directory}/${leaf}`,'generated_prompt_memory_history',{project_id,agent_id});
  const memory=`${directory}/memory`,stat=await existing(join(root,memory));
  if(stat){
   if(!stat.isDirectory()||stat.isSymbolicLink()||!within(root,await realpath(join(root,memory))))throw new Error('Historical memory directory changed');
   for(const leaf of (await readdir(join(root,memory))).sort())if(/^\d{4}-\d{2}-\d{2}\.md$/.test(leaf))await add(`${memory}/${leaf}`,'generated_prompt_memory_history',{project_id,agent_id});
  }
 }
 return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
async function storeBlob(stage,sourceRoot,path,expected){
 const key=`blobs/${expected.sha256}`,target=join(stage,key);
 if(!await existing(target)){await copyFile(join(sourceRoot,path),target,constants.COPYFILE_EXCL);await chmod(target,0o600);}
 if(!equal(await fingerprint(stage,key),expected)||!equal(await fingerprint(sourceRoot,path),expected))throw new Error('Material changed during capture');
 return key;
}

export async function captureHistorySupplement({archive,expectedHash,output}){
 archive=await realpath(archive);const primary=await verifyArchive(archive);
 if(primary.hash!==expectedHash)throw new Error('Supplement requires the pinned primary archive');
 if(await realpath(primary.source.repository)!==primary.source.repository)throw new Error('Pinned source checkout root changed');
 assertSourceCheckout(primary.source);
 const root=primary.source.data_root;if(await realpath(root)!==root)throw new Error('Source data root changed');
 output=await destination(output);
 const forbidden=await Promise.all([archive,primary.source.repository,root,...primary.databases.find(d=>d.role==='business').summary.projects.map(p=>p.workspace_root)].map(path=>realpath(path).catch(error=>{if(error.code==='ENOENT')return resolve(path);throw error;})));
 if(forbidden.some(path=>within(resolve(path),output)))throw new Error('Supplement must stay outside every original project, source and archive root');
 if(await existing(output))throw new Error('Never overwrite an existing supplement');
 await mkdir(dirname(output),{recursive:true,mode:0o700});
 const stage=join(dirname(output),`.history-supplement-${randomUUID()}`);await mkdir(join(stage,'blobs'),{recursive:true,mode:0o700});await mkdir(join(stage,'databases'),{mode:0o700});
 try{
  const scope=primaryScope(archive,primary),databases=[],materials=[];
  for(const [index,candidate] of primary.other_databases.entries()){
   if(!safeRelative(candidate.path))throw new Error('Invalid original database path');
   const stat=await regular(root,candidate.path);
   const row={source_path:candidate.path,original_disposition:candidate.disposition,primary_observed_bytes:candidate.bytes,observed_bytes:stat?.size??null};
   if(!stat){databases.push({...row,kind:'missing_since_primary_capture',payload_excluded:true});continue;}
   const before=await sourceFiles(join(root,candidate.path));
   if(stat.size===0&&!before.wal){databases.push({...row,kind:'empty_file',source_files:before,payload_excluded:true,tables:[],task_ids:[]});continue;}
   const path=`databases/${index}.db`,copied=await copyDatabase(join(root,candidate.path),join(stage,path));
   if(!equal(before,copied.source_files))throw new Error('Historical source changed before its private copy');
   const details=inventory(join(stage,path),scope.tasks),retain=['historical_business_database','empty_sqlite_database'].includes(details.kind)&&basename(candidate.path)!=='loopwork.db';
   databases.push({...row,...details,...copied,...(retain?{file:path}:{payload_excluded:true})});
   if(!retain)await rm(join(stage,path));
  }
  const selected=await sourceMaterials(root,scope);let bytes=0;
  for(const item of selected){
   const facts=await fingerprint(root,item.path);if(!facts)throw new Error('Selected historical material disappeared');bytes+=facts.bytes;
   if(selected.length>10000||bytes>256*1024*1024)throw new Error('Historical materials exceed bounded capture capacity');
   materials.push({...item,...facts,file:await storeBlob(stage,root,item.path,facts)});
  }
  // Both the selected file set and every database/WAL preimage must remain
  // current through publication. This never opens an original SQLite file.
  if(!equal(await sourceMaterials(root,scope),selected))throw new Error('Historical file inventory changed during capture');
  for(const item of materials)if(!equal(await fingerprint(root,item.path),{bytes:item.bytes,sha256:item.sha256}))throw new Error('Historical material changed before publication');
  for(const db of databases){if(db.source_files&&!equal(await sourceFiles(join(root,db.source_path)),db.source_files)||db.kind==='missing_since_primary_capture'&&await existing(join(root,db.source_path)))throw new Error('Historical database cohort changed before publication');}
  if((await verifyArchive(archive)).hash!==expectedHash)throw new Error('Primary archive changed');
  assertSourceCheckout(primary.source);
  const body={format,archive_hash:expectedHash,captured_at:new Date().toISOString(),source:{repository:primary.source.repository,data_root:root,commit:primary.source.commit},databases,materials,
   historical_only:true,execution_authorized:false,native_tasks_created:0,
   exclusions:['Application/configuration database payloads and unsupported database schemas are excluded.','Generated Prompt/Memory files, PID/gate files and private logs are historical blobs only; they are not installed as configuration, process ownership, credentials or execution authority.','Task/document file and image references, repository evidence trees, unregistered run/profile directories and remote resources require separate materialization.','Task IDs in secondary databases remain namespaced by their original database; matching IDs alone do not establish identical records or native task correspondence.']};
  const manifest={...body,hash:hash(body)};await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  await verifyHistorySupplement(stage,expectedHash,manifest.hash);await rename(stage,output);
  return {supplement:output,hash:manifest.hash,archive_hash:expectedHash,databases:databases.length,classifications:Object.fromEntries([...new Set(databases.map(d=>d.kind))].map(kind=>[kind,databases.filter(d=>d.kind===kind).length])),retained_databases:databases.filter(d=>d.file).length,materials:materials.length,material_bytes:bytes,historical_only:true,execution_authorized:false};
 }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}

export async function verifyHistorySupplement(directory,expectedArchiveHash,expectedHash){
 directory=await realpath(directory);await regular(directory,'manifest.json');
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),{hash:saved,...body}=manifest;
 if(!/^[a-f0-9]{64}$/.test(expectedArchiveHash??'')||!/^[a-f0-9]{64}$/.test(expectedHash??'')||manifest.format!==format||saved!==hash(body)||saved!==expectedHash||manifest.archive_hash!==expectedArchiveHash||manifest.historical_only!==true||manifest.execution_authorized!==false||manifest.native_tasks_created!==0||!Array.isArray(manifest.databases)||!Array.isArray(manifest.materials))throw new Error('Supplement identity or historical scope changed');
 const databaseNames=new Set(),paths=new Set();
 for(const db of manifest.databases){
  if(!safeRelative(db.source_path)||databaseNames.has(db.source_path))throw new Error('Supplement database correspondence changed');databaseNames.add(db.source_path);
  if(db.file){if(!/^databases\/\d+\.db$/.test(db.file)||!['historical_business_database','empty_sqlite_database'].includes(db.kind)||basename(db.source_path)==='loopwork.db'||!equal(await fingerprint(directory,db.file),db.snapshot))throw new Error('Supplement database fingerprint or scope changed');
   for(const suffix of ['-wal','-shm','-journal'])if(await existing(join(directory,db.file+suffix)))throw new Error('Supplement database has unexpected sidecars');
   const actual=inventory(join(directory,db.file),new Set(db.task_ids_in_primary_archive));
   if(!equal(actual.tables,db.tables)||actual.kind!==db.kind||!equal(actual.task_ids,db.task_ids))throw new Error('Supplement record inventory changed');
  }else if(db.payload_excluded!==true)throw new Error('Unclassified payload disposition');
 }
 for(const item of manifest.materials){
  if(!safeRelative(item.path)||paths.has(item.path)||item.file!==`blobs/${item.sha256}`||!/^[a-f0-9]{64}$/.test(item.sha256)||!equal(await fingerprint(directory,item.file),{bytes:item.bytes,sha256:item.sha256}))throw new Error('Supplement material fingerprint or path changed');paths.add(item.path);
 }
 const expectedFiles=new Set(['manifest.json',...manifest.databases.filter(row=>row.file).map(row=>row.file),...manifest.materials.map(row=>row.file)]);
 const actualFiles=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory()&&['databases','blobs'].includes(entry.name)){
   for(const child of await readdir(join(directory,entry.name),{withFileTypes:true})){if(!child.isFile())throw new Error('Unexpected supplement object');actualFiles.push(`${entry.name}/${child.name}`);}
  }else if(entry.isFile()&&entry.name==='manifest.json')actualFiles.push(entry.name);
  else throw new Error('Unexpected supplement object');
 }
 if(actualFiles.length!==expectedFiles.size||actualFiles.some(path=>!expectedFiles.has(path)))throw new Error('Unexpected supplement payload');
 return manifest;
}

export async function readSupplementRecord(directory,archiveHash,supplementHash,databasePath,table,id){
 if(!['tasks','documents'].includes(table)||typeof id!=='string'||!id)throw new Error('Choose an exact original task/document ID');
 const manifest=await verifyHistorySupplement(directory,archiveHash,supplementHash),entry=manifest.databases.find(db=>db.source_path===databasePath&&db.kind==='historical_business_database'&&db.file);
 if(!entry)throw new Error('Historical database payload is not available');
 const key=table==='tasks'?'task_id':'document_id',schema=entry.tables.find(t=>t.name===table);
 if(!schema?.columns.includes(key))throw new Error('Historical record schema is unavailable');
 const db=new DatabaseSync(join(directory,entry.file),{readOnly:true});
 try{db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF');const columns=schema.columns.filter(c=>!/(token|credential|password|secret|api_key)/i.test(c));const query=db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} WHERE ${quote(key)}=?`);query.setReadBigInts(true);return {historical_only:true,execution_authorized:false,archive_hash:archiveHash,supplement_hash:manifest.hash,source_database:entry.source_path,table,source_id:id,record:query.get(id)??null};}finally{db.close();}
}
