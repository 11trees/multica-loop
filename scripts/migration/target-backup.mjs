import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,copyFile,cp,lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {copyDatabase,sourceFiles,verifyArchive} from './loopwork-history-lib.mjs';
import {verifyHistorySupplement} from './loopwork-history-supplement.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const seal=value=>digest(JSON.stringify(value));
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const inside=(root,path)=>{const part=relative(root,path);return !part||!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
async function exists(path){return lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});}
async function fingerprint(path){const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink())throw new Error('Backup requires regular files');const data=await readFile(path),after=await lstat(path);if(['dev','ino','size','mtimeMs','ctimeMs'].some(key=>before[key]!==after[key]))throw new Error('Backup source changed');return {bytes:data.length,sha256:digest(data)};}
export async function fileInventory(root){
 if(await realpath(root)!==root||(await lstat(root)).isSymbolicLink())throw new Error('Backup roots must be canonical directories');
 const files=[];async function visit(path){for(const entry of (await readdir(join(root,path),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const next=path?`${path}/${entry.name}`:entry.name;if(entry.isDirectory())await visit(next);else if(entry.isFile())files.push({path:next,...await fingerprint(join(root,next))});else throw new Error('Backup trees cannot contain links or special files');}}await visit('');return files;
}
async function privateTree(root){await chmod(root,0o700);for(const item of await readdir(root,{withFileTypes:true})){if(item.isDirectory())await privateTree(join(root,item.name));else if(item.isFile())await chmod(join(root,item.name),0o600);else throw new Error('Unexpected backup object');}}
async function newDestination(path,forbidden){
 if(!isAbsolute(path))throw new Error('Use a new absolute backup destination');
 const parent=await realpath(dirname(path)),output=join(parent,relative(dirname(path),path));
 if(forbidden.some(root=>inside(root,output)||inside(output,root)))throw new Error('Backup destinations must be disjoint from every source');
 if(await exists(output))throw new Error('Never overwrite backup or drill destinations');return output;
}
function connection(env){const url=new URL(env.DATABASE_URL??'');if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.search)throw new Error('Use the managed local database without connection overrides');return {url,database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username)};}
function docker(container,command,args=[],input){if(!/^[a-f0-9]{12,64}$/.test(container))throw new Error('Use the exact PostgreSQL container ID');return execFileSync('docker',['exec',...(input?['-i']:[]),container,command,...args],{input,maxBuffer:512*1024*1024,stdio:['pipe','pipe','pipe']});}
async function serverIdentity(client,container,user,database){
 const expected=(await client.query("SELECT system_identifier::text id FROM pg_control_system()")).rows[0].id;
 const actual=docker(container,'psql',['-U',user,'-d',database,'-X','-qAt','-c','SELECT system_identifier::text FROM pg_control_system()']).toString().trim();
 if(actual!==expected)throw new Error('PostgreSQL container and managed server differ');return expected;
}
export async function postgresInventory(client){
 const tables=(await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename")).rows,result=[];
 for(const {schemaname,tablename} of tables){const rows=(await client.query(`SELECT to_jsonb(t)::text AS value FROM ${quote(schemaname)}.${quote(tablename)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map(row=>row.value);result.push({schema:schemaname,table:tablename,rows:rows.length,sha256:seal(rows)});}
 const sequences=[];for(const row of (await client.query("SELECT sequence_schema,sequence_name FROM information_schema.sequences ORDER BY sequence_schema,sequence_name")).rows){const value=(await client.query(`SELECT last_value::text,is_called FROM ${quote(row.sequence_schema)}.${quote(row.sequence_name)}`)).rows[0];sequences.push({...row,...value});}
 return {tables:result,sequences,extensions:(await client.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows};
}
function sqliteSummary(path){const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA query_only=ON;PRAGMA trusted_schema=OFF');if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok'))throw new Error('SQLite integrity check failed');return {version:db.prepare('PRAGMA user_version').get().user_version,tables:db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:db.prepare(`SELECT count(*) n FROM ${quote(name)}`).get().n}))};}finally{db.close();}}
export async function verifyTargetBackup(directory,expectedHash){
 directory=await realpath(directory);const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),{hash,...body}=manifest;
 if(!/^[a-f0-9]{64}$/.test(expectedHash??'')||hash!==expectedHash||hash!==seal(body)||body.format!=='multica-target-backup-v1'||body.execution_authorized!==false)throw new Error('Target backup identity changed');
 if(typeof body.source?.database!=='string'||!body.source.database||!Array.isArray(body.postgres?.tables)||!Array.isArray(body.postgres.sequences)||!Array.isArray(body.postgres.extensions)||!Array.isArray(body.files)||!Array.isArray(body.sqlite)||body.sqlite.length!==2||body.sqlite.some((row,index)=>row.kind!==['business','admin'][index]||row.file!==`sqlite/${row.kind}.sqlite`)||!body.files.some(row=>row.path==='postgres.dump')||!body.files.some(row=>row.path==='schema.sql'))throw new Error('Target backup scope is incomplete');
 const inventory=await fileInventory(directory),files=inventory.filter(row=>row.path!=='manifest.json');if(!equal(files,manifest.files))throw new Error('Target backup payload inventory changed');
 const primary=await verifyArchive(join(directory,'history/primary'));if(primary.hash!==manifest.history.primary_hash)throw new Error('Primary history identity changed');
 if(manifest.history.supplement_hash)await verifyHistorySupplement(join(directory,'history/supplement'),primary.hash,manifest.history.supplement_hash);
 for(const row of manifest.sqlite)if(!equal(await fingerprint(join(directory,row.file)),row.snapshot)||!equal(sqliteSummary(join(directory,row.file)),row.summary))throw new Error('SQLite inventory changed');
 return manifest;
}
export async function captureTargetBackup({env=process.env,output,container,repository=process.cwd()}){
 repository=await realpath(repository);const {database,user}=connection(env),client=new pg.Client({connectionString:env.DATABASE_URL});
 const sqlite=env.MULTICA_ENGINEERING_DATABASE,primaryRoot=await realpath(env.MULTICA_LOOPWORK_HISTORY_ARCHIVE),primary=await verifyArchive(primaryRoot);
 if(primary.hash!==env.MULTICA_LOOPWORK_HISTORY_HASH||!sqlite||!isAbsolute(sqlite)||env.S3_BUCKET)throw new Error('Backup requires the pinned local history and local stores');
 const supplementRoot=env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT?await realpath(env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT):null;
 if(supplementRoot)await verifyHistorySupplement(supplementRoot,primary.hash,env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT_HASH);
 const uploadRoot=await realpath(resolve(repository,'server',env.LOCAL_UPLOAD_DIR||'./data/uploads'));
 const profileRoot=resolve(env.MULTICA_DEV_PROFILES_HOME||join(homedir(),'.multica/profiles'),env.MULTICA_DEV_PROFILE??'');
 if(!env.MULTICA_DEV_PROFILE||!/^[-a-zA-Z0-9_]+$/.test(env.MULTICA_DEV_PROFILE))throw new Error('Use the managed native profile');
 output=await newDestination(output,[repository,primaryRoot,...(supplementRoot?[supplementRoot]:[]),dirname(sqlite),uploadRoot,profileRoot,...primary.databases.find(row=>row.role==='business').summary.projects.map(row=>resolve(row.workspace_root))]);
 const stage=join(dirname(output),`.target-backup-${randomUUID()}`);await mkdir(stage,{mode:0o700});
 try{
  await client.connect();
  if(Number((await client.query('SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n)!==0)throw new Error('Stop the managed services and other database clients before capture');
  const systemID=await serverIdentity(client,container,user,database),version=(await client.query("SELECT current_setting('server_version_num') n")).rows[0].n;
  const dumpVersion=docker(container,'pg_dump',['--version']).toString();if(!dumpVersion.includes(` ${Math.floor(Number(version)/10000)}.`))throw new Error('Use matching PostgreSQL tools');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const tables=(await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename")).rows;
  if(tables.length)await client.query('LOCK TABLE '+tables.map(row=>`${quote(row.schemaname)}.${quote(row.tablename)}`).join(',')+' IN SHARE MODE');
  const snapshot=(await client.query('SELECT pg_export_snapshot() id')).rows[0].id,key=randomUUID().replaceAll('-','');
  const pgArgs=['-U',user,'-d',database,'--no-owner','--no-privileges',`--snapshot=${snapshot}`],postgres=await postgresInventory(client);
  await writeFile(join(stage,'postgres.dump'),docker(container,'pg_dump',[...pgArgs,'--format=custom']),{mode:0o600,flag:'wx'});
  const schema=docker(container,'pg_dump',[...pgArgs,'--schema-only',`--restrict-key=${key}`]);await writeFile(join(stage,'schema.sql'),schema,{mode:0o600,flag:'wx'});
  const stores=[];await mkdir(join(stage,'sqlite'),{mode:0o700});
  for(const [kind,path] of [['business',sqlite],['admin',sqlite+'.admin.sqlite']]){const file=`sqlite/${kind}.sqlite`,copied=await copyDatabase(path,join(stage,file));stores.push({kind,file,source:path,...copied,summary:sqliteSummary(join(stage,file))});}
  await mkdir(join(stage,'history'),{mode:0o700});await cp(primaryRoot,join(stage,'history/primary'),{recursive:true});if(supplementRoot)await cp(supplementRoot,join(stage,'history/supplement'),{recursive:true});
  const uploads=await fileInventory(uploadRoot);await cp(uploadRoot,join(stage,'uploads'),{recursive:true});
  await mkdir(join(stage,'configuration'),{mode:0o700});const configuration=[];
  for(const [kind,path] of [['environment',join(repository,'.env')],['native_profile',join(profileRoot,'config.json')],['native_daemon_identity',join(profileRoot,'daemon.id')]]){if(!await exists(path)){configuration.push({kind,source:path,missing:true});continue;}const facts=await fingerprint(path),file=`configuration/${kind}`;await copyFile(path,join(stage,file));configuration.push({kind,source:path,file,...facts});}
  for(const store of stores)if(!equal(await sourceFiles(store.source),store.source_files))throw new Error('SQLite source cohort changed');
  if(!equal(uploads,await fileInventory(uploadRoot))||!equal(uploads,await fileInventory(join(stage,'uploads'))))throw new Error('Upload source changed');
  for(const config of configuration)if(!config.missing&&!equal(await fingerprint(config.source),{bytes:config.bytes,sha256:config.sha256}))throw new Error('Native configuration changed');
  if(Number((await client.query('SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n)!==0)throw new Error('Another database client connected during capture');
  await privateTree(stage);
  const body={format:'multica-target-backup-v1',captured_at:new Date().toISOString(),source:{repository,commit:execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),database,system_identifier:systemID},postgres:{...postgres,schema_sha256:digest(schema),schema_key:key},sqlite:stores,history:{primary_hash:primary.hash,supplement_hash:supplementRoot?env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT_HASH:null},uploads:{source:uploadRoot,files:uploads},configuration,files:await fileInventory(stage),execution_authorized:false,
   exclusions:['This is a local stopped-service data backup, not authority to execute restored work.','Source project repositories, source database write guards and installed provider accounts/CLIs are not restored.','PostgreSQL roles/ACLs and external services require separate setup. Native configuration is private bytes only; never source it in a drill. Restored ownership, runtime/process facts and queued intent need explicit reconciliation before any live restart.']};
  const manifest={...body,hash:seal(body)};await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});await verifyTargetBackup(stage,manifest.hash);await client.query('COMMIT');await rename(stage,output);
  return {backup:output,hash:manifest.hash,tables:postgres.tables.length,rows:postgres.tables.reduce((n,row)=>n+row.rows,0),files:manifest.files.length,execution_authorized:false};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});await rm(stage,{recursive:true,force:true});throw error;}finally{await client.end();}
}
export async function drillTargetBackup({env=process.env,backup,expectedHash,output,container}){
 backup=await realpath(backup);const manifest=await verifyTargetBackup(backup,expectedHash),{database:sourceDatabase,user,url}=connection(env);
 if(sourceDatabase!==manifest.source.database)throw new Error('Drill must use the original managed server identity');
 output=await newDestination(output,[backup,manifest.source.repository,...manifest.sqlite.map(row=>dirname(row.source)),manifest.uploads.source]);
 await mkdir(output,{mode:0o700});const admin=new pg.Client({connectionString:env.DATABASE_URL}),name='multica_restore_'+randomUUID().replaceAll('-','');let created=false,restored;
 try{
  await admin.connect();if(await serverIdentity(admin,container,user,sourceDatabase)!==manifest.source.system_identifier)throw new Error('Restore server changed');
  await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`);created=true;url.pathname='/'+name;url.search='';restored=new pg.Client({connectionString:url.href});
  docker(container,'pg_restore',['-U',user,'-d',name,'--no-owner','--no-privileges','--exit-on-error'],await readFile(join(backup,'postgres.dump')));
  await restored.connect();const inventory=await postgresInventory(restored),{schema_sha256,schema_key,...expected}=manifest.postgres;if(!equal(inventory,expected))throw new Error('Restored PostgreSQL rows/sequences/extensions differ');
  const schema=docker(container,'pg_dump',['-U',user,'-d',name,'--no-owner','--no-privileges','--schema-only',`--restrict-key=${schema_key}`]);if(digest(schema)!==schema_sha256)throw new Error('Restored PostgreSQL schema differs');
  for(const folder of ['sqlite','uploads','history','configuration'])await cp(join(backup,folder),join(output,folder),{recursive:true});await privateTree(output);
  const expectedFiles=manifest.files.filter(row=>['sqlite/','uploads/','history/','configuration/'].some(prefix=>row.path.startsWith(prefix)));if(!equal(await fileInventory(output),expectedFiles))throw new Error('Restored file bytes differ');
  for(const row of manifest.sqlite)if(!equal(sqliteSummary(join(output,row.file)),row.summary))throw new Error('Restored SQLite state differs');
  await verifyArchive(join(output,'history/primary'));if(manifest.history.supplement_hash)await verifyHistorySupplement(join(output,'history/supplement'),manifest.history.primary_hash,manifest.history.supplement_hash);
  await restored.end();restored=null;await admin.query(`DROP DATABASE ${quote(name)}`);created=false;
  const result={format:'multica-target-restore-drill-v1',checked_at:new Date().toISOString(),backup_hash:expectedHash,source_database:sourceDatabase,isolated_database:name,isolated_database_removed:true,postgres_tables:inventory.tables.length,postgres_rows:inventory.tables.reduce((sum,row)=>sum+row.rows,0),schema_equal:true,all_rows_equal:true,sequences_equal:true,sqlite_equal:true,history_equal:true,files_equal:true,restored_files:expectedFiles.length,configuration_executed:false,execution_authorized:false,live_restore_accepted:false};
  await writeFile(join(output,'receipt.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
 }finally{if(restored)await restored.end().catch(()=>{});if(created)await admin.query(`DROP DATABASE ${quote(name)}`).catch(()=>{});await admin.end();}
}
export async function main(args,env=process.env){const [action,...rest]=args,options={};for(let i=0;i<rest.length;i+=2){if(!rest[i]?.startsWith('--')||!rest[i+1]||Object.hasOwn(options,rest[i]))throw new Error('Invalid backup arguments');options[rest[i]]=rest[i+1];}const allowed=action==='capture'?['--output','--postgres-container']:action==='verify'?['--backup','--expected-hash']:action==='drill'?['--backup','--expected-hash','--output','--postgres-container']:[];if(!allowed.length||Object.keys(options).length!==allowed.length||allowed.some(key=>!options[key]))throw new Error('Use capture --output new-absolute-path --postgres-container exact-id | verify --backup absolute-path --expected-hash sha256 | drill --backup absolute-path --expected-hash sha256 --output new-absolute-path --postgres-container exact-id');if(action==='verify'){const m=await verifyTargetBackup(options['--backup'],options['--expected-hash']);return {hash:m.hash,files:m.files.length,execution_authorized:false};}return action==='capture'?captureTargetBackup({env,output:options['--output'],container:options['--postgres-container']}):drillTargetBackup({env,backup:options['--backup'],expectedHash:options['--expected-hash'],output:options['--output'],container:options['--postgres-container']});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{process.stderr.write('Target backup or isolated restore refused; inspect its saved identity and stopped-service prerequisites. No live database restore or provider start was requested.\n');process.exitCode=1;});
