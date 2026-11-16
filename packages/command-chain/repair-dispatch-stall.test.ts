// @vitest-environment node
import {readFile} from "node:fs/promises";
import {it,expect} from "vitest";
import {repairDispatchStallSchema,repairDispatchStallHash} from "./repair-dispatch-stall";
it("matches native dispatch reservations and requires a never-claimed task and continuous eligible interval",async()=>{
 const proof=repairDispatchStallSchema.parse(JSON.parse(await readFile(new URL("./test-helpers/repair-dispatch-stall.json",import.meta.url),"utf8")));expect(proof.hash).toBe(repairDispatchStallHash(proof));
 for(const changed of [{...proof,claimed_at:proof.reserved_at},{...proof,started_at:proof.reserved_at},{...proof,eligible_elapsed_ms:1199999},{...proof,status:"running"},{...proof,preparation:{...proof.preparation,source_attempt_id:"invented"}},{...proof,watch_hash:"a".repeat(64)}])expect(()=>repairDispatchStallSchema.parse(changed)).toThrow();
});

it("keeps the actual predecessor claim separate from its unclaimed linked continuation",async()=>{
 const proof=repairDispatchStallSchema.parse(JSON.parse(await readFile(new URL("./test-helpers/repair-bound-dispatch-stall.json",import.meta.url),"utf8")));expect(proof.hash).toBe(repairDispatchStallHash(proof));
 for(const [key,value] of Object.entries(proof.bound_source!)){const changed={...proof,bound_source:{...proof.bound_source!,[key]:String(value)+"changed"}};expect(()=>repairDispatchStallSchema.parse(changed)).toThrow();}
 const same={...proof,task_id:proof.bound_source!.task_id};expect(()=>repairDispatchStallSchema.parse({...same,hash:repairDispatchStallHash(same)})).toThrow(/identity changed/);
 const missing={...proof,bound_source:undefined};expect(()=>repairDispatchStallSchema.parse(missing)).toThrow();
 expect(()=>repairDispatchStallSchema.parse({...proof,claimed_at:proof.reserved_at})).toThrow();
});
