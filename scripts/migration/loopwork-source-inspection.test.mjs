import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { cutoverFixture } from "./loopwork-cutover-fixture.mjs";
import { stableDigest } from "./loopwork-cutover-lib.mjs";
import { changeSourceFence, prepareSourceFence } from "./loopwork-source-fence.mjs";
import { inspectNativeSource } from "./loopwork-source-inspection.mjs";

async function bytes(root){return Object.fromEntries(await Promise.all((await readdir(root)).map(async name=>[name,await readFile(join(root,name))])));}
test("native source inspection binds the frozen scope and leaves source/archive bytes unchanged",{skip:!["darwin","linux"].includes(process.platform)},async t=>{
 if(!await access(process.platform==="darwin"?"/usr/sbin/lsof":"/usr/bin/lsof").then(()=>true,()=>false)){t.skip("lsof is required");return;}
 const f=await cutoverFixture(t),source=await prepareSourceFence(f.archive,f.hash),payload={format:"loopwork-cutover-hold-v1",source,preparations:[]},record={id:randomUUID(),archive_hash:f.hash,source_namespace:source.source_namespace,scope_hash:stableDigest(payload),payload};
 await assert.rejects(inspectNativeSource(f.archive,{expected_hash:f.hash,record}),/entire source cohort frozen/);
 await changeSourceFence(f.archive,{...record,preimages:source.preimages},"freeze",async()=>{});
 for(const db of Object.values(f.dbs))db.close();
 const before=await bytes(f.dataRoot),archive=await bytes(f.archive),result=await inspectNativeSource(f.archive,{expected_hash:f.hash,record});
 assert.equal(result.source_frozen,true);assert.equal(result.registered_writers_quiesced,true);assert.equal(result.execution_authorized,false);assert.equal(result.physical_quiescence_confirmed,false);assert.equal(result.cutover_id,record.id);
 assert.deepEqual(await bytes(f.dataRoot),before);assert.deepEqual(await bytes(f.archive),archive);
 await assert.rejects(inspectNativeSource(f.archive,{expected_hash:f.hash,record:{...record,payload:{...payload,format:"changed"}}}),/scope changed/);
 await assert.rejects(inspectNativeSource(f.archive,{expected_hash:"0".repeat(64),record}),/scope changed/);
});
