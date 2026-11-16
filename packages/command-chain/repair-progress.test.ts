// @vitest-environment node
import {readFile} from "node:fs/promises";
import {it,expect} from "vitest";
import {repairRecoveryProgressSchema,repairBusinessProgressSchema,repairBusinessProgressHash,repairNativeProgressHash} from "./repair-progress";
it("matches native UTF-8 progress witnesses and binds the result, event and current native claim",async()=>{
 const value=JSON.parse(await readFile(new URL("./test-helpers/repair-business-progress.json",import.meta.url),"utf8")),parsed=repairRecoveryProgressSchema.parse(value);expect(parsed).toEqual(value);
 expect(repairBusinessProgressHash(parsed.business)).toBe(parsed.business.hash);expect(repairNativeProgressHash(parsed.native)).toBe(parsed.native.hash);
 expect(()=>repairRecoveryProgressSchema.parse({...parsed,business:{...parsed.business,completion_event_hash:"5".repeat(64)}})).toThrow(/hash changed/);expect(()=>repairRecoveryProgressSchema.parse({...parsed,native:{...parsed.native,attempt_id:parsed.native.attempt_id+"1"}})).toThrow(/hash changed/);
});
it("requires a YAML draft fingerprint and keeps Direct's explicit result separate",async()=>{
 const value=repairRecoveryProgressSchema.parse(JSON.parse(await readFile(new URL("./test-helpers/repair-business-progress.json",import.meta.url),"utf8"))).business;
 for(const wrong of [{...value,draft_hash:null},{...value,draft_id:null}])expect(()=>repairBusinessProgressSchema.parse({...wrong,hash:repairBusinessProgressHash(wrong)})).toThrow(/draft differs/);
 const direct={...value,chain:"direct" as const,draft_id:null,draft_hash:null,sequence:0};expect(repairBusinessProgressSchema.parse({...direct,hash:repairBusinessProgressHash(direct)})).toMatchObject({chain:"direct",draft_id:null});
});

it("matches native continuation hashes while retaining its entry, current task and native failure",async()=>{
 const value=JSON.parse(await readFile(new URL("./test-helpers/repair-continuation-progress.json",import.meta.url),"utf8")),parsed=repairRecoveryProgressSchema.parse(value);expect(parsed.business.entry_task_id).not.toBe(parsed.business.task_id);expect(parsed.native.status).toBe("failed");
 for(const field of ["entry_task_id","execution_hint_hash"] as const){const changed={...parsed.business};delete changed[field];expect(()=>repairBusinessProgressSchema.parse({...changed,hash:repairBusinessProgressHash(changed)})).toThrow(/both entry/);}
});
