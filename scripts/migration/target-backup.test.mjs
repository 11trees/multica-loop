import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {cutoverFixture} from './loopwork-cutover-fixture.mjs';
import {copyDatabase} from './loopwork-history-lib.mjs';
import {fileInventory,verifyTargetBackup,drillTargetBackup,main} from './target-backup.mjs';
const seal=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t){
 const f=await cutoverFixture(t);await mkdir(join(f.root,'backup/history'),{recursive:true});const root=await realpath(join(f.root,'backup'));await cp(f.archive,join(root,'history/primary'),{recursive:true});await mkdir(join(root,'sqlite'));
 const sqlite=[];for(const [kind,path] of [['business',join(f.dataRoot,'loop-ui.db')],['admin',join(f.dataRoot,'admin-management.db')]]){const file=`sqlite/${kind}.sqlite`,copy=await copyDatabase(path,join(root,file)),d=new DatabaseSync(join(root,file),{readOnly:true});try{sqlite.push({kind,file,source:path,...copy,summary:{version:d.prepare('PRAGMA user_version').get().user_version,tables:d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:d.prepare(`SELECT count(*) n FROM "${name}"`).get().n}))}});}finally{d.close();}}
 for(const file of ['schema.sql','postgres.dump'])await writeFile(join(root,file),'Controlled fixture, not a PostgreSQL restore verdict');
 const body={format:'multica-target-backup-v1',source:{database:'fixture',repository:f.sourceRoot},postgres:{tables:[],sequences:[],extensions:[],schema_sha256:createHash('sha256').update(await readFile(join(root,'schema.sql'))).digest('hex')},sqlite,uploads:{source:f.sourceRoot},configuration:[],history:{primary_hash:f.hash,supplement_hash:null},files:await fileInventory(root),execution_authorized:false},manifest={...body,hash:seal(body)};await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));return {...f,backup:root,manifest};
}

test('verifies exact backup files, pinned history, committed SQLite rows and rejects corrupt or extra payloads',async t=>{
 const f=await fixture(t);assert.equal((await verifyTargetBackup(f.backup,f.manifest.hash)).hash,f.manifest.hash);
 await assert.rejects(drillTargetBackup({env:{DATABASE_URL:'postgres://fixture@localhost/fixture?sslmode=disable',MULTICA_LOOPWORK_HISTORY_ARCHIVE:f.archive,MULTICA_LOOPWORK_HISTORY_HASH:f.hash},backup:f.backup,expectedHash:f.manifest.hash,output:join(f.sourceRoot,'unsafe-drill'),container:'a'.repeat(12)}),/disjoint/);
 const sqlite=f.manifest.sqlite.find(row=>row.kind==='business');assert.equal(sqlite.summary.tables.find(row=>row.name==='tasks').rows,3);
 await assert.rejects(verifyTargetBackup(f.backup,'0'.repeat(64)),/identity/);
 await writeFile(join(f.backup,'unlisted'),'outside inventory');await assert.rejects(verifyTargetBackup(f.backup,f.manifest.hash),/inventory/);await rm(join(f.backup,'unlisted'));
 const path=join(f.backup,'postgres.dump'),before=await readFile(path);await writeFile(path,'changed bytes');await assert.rejects(verifyTargetBackup(f.backup,f.manifest.hash),/inventory/);await writeFile(path,before);
 await rm(join(f.backup,'schema.sql'));await symlink(join(f.backup,'postgres.dump'),join(f.backup,'schema.sql'));await assert.rejects(verifyTargetBackup(f.backup,f.manifest.hash),/links or special/);
});

test('refuses incomplete scopes and unknown restore arguments without database access',async t=>{
 const f=await fixture(t),{hash,...body}=f.manifest;body.sqlite=[];const changed={...body,hash:seal(body)};await writeFile(join(f.backup,'manifest.json'),JSON.stringify(changed));await assert.rejects(verifyTargetBackup(f.backup,changed.hash),/incomplete/);
 await assert.rejects(main(['restore','--database','production']),/Use capture/);
 await assert.rejects(main(['drill','--backup','/backup','--expected-hash','0'.repeat(64),'--output','/tmp/new','--postgres-container','a'.repeat(12),'--database','production']),/Use capture/);
});
