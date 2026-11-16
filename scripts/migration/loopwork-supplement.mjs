import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureHistorySupplement,captureReferenceSupplement,readSupplementRecord,verifyHistorySupplement} from './loopwork-history-supplement.mjs';

export async function main(args,env=process.env){
 const [action,...rest]=args,options={};
 for(let i=0;i<rest.length;i+=2){if(!rest[i]?.startsWith('--')||!rest[i+1]||Object.hasOwn(options,rest[i]))throw new Error('Invalid supplement arguments');options[rest[i]]=rest[i+1];}
 const allowed=action==='capture'?['--output']:action==='references'?['--supplement','--expected-hash','--output']:action==='verify'?['--supplement','--expected-hash']:action==='record'?['--supplement','--expected-hash','--database','--table','--id']:null;
 if(!allowed||Object.keys(options).length!==allowed.length||allowed.some(key=>!options[key]))throw new Error('Use capture --output absolute-path | references --supplement absolute-path --expected-hash sha256 --output new-absolute-path | verify --supplement absolute-path --expected-hash sha256 | record --supplement absolute-path --expected-hash sha256 --database original-relative-database --table tasks|documents --id original-id');
 const archive=env.MULTICA_LOOPWORK_HISTORY_ARCHIVE,hash=env.MULTICA_LOOPWORK_HISTORY_HASH;
 if(!archive||!/^[a-f0-9]{64}$/.test(hash??''))throw new Error('Use the managed environment with its pinned primary archive');
 if(action==='capture')return captureHistorySupplement({archive,expectedHash:hash,output:options['--output']});
 if(!/^[a-f0-9]{64}$/.test(options['--expected-hash']))throw new Error('A pinned supplement hash is required');
 if(action==='references')return captureReferenceSupplement({archive,expectedHash:hash,supplement:options['--supplement'],expectedSupplementHash:options['--expected-hash'],output:options['--output']});
 if(action==='record')return readSupplementRecord(options['--supplement'],hash,options['--expected-hash'],options['--database'],options['--table'],options['--id']);
 const manifest=await verifyHistorySupplement(options['--supplement'],hash,options['--expected-hash']);return {hash:manifest.hash,archive_hash:manifest.archive_hash,databases:manifest.databases.length,materials:manifest.materials.length,historical_only:true,execution_authorized:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?{sqlite_integer:String(value)}:value instanceof Uint8Array?{sqlite_blob:Buffer.from(value).toString('base64')}:value)+'\n')).catch(()=>{process.stderr.write('Historical supplement refused; no native execution or source ownership was changed.\n');process.exitCode=1;});
