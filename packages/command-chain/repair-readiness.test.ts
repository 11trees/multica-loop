// @vitest-environment node
import {readFile} from "node:fs/promises";
import {it,expect} from "vitest";
import {repairReadinessObservationHash,repairReadinessObservationSchema} from "./repair-readiness";
it("matches native UTF-8 readiness witnesses and requires actual task identity for a runnable sample",async()=>{
 const proof=repairReadinessObservationSchema.parse(JSON.parse(await readFile(new URL("./test-helpers/repair-readiness.json",import.meta.url),"utf8")));expect(proof.hash).toBe(repairReadinessObservationHash(proof));expect(()=>repairReadinessObservationSchema.parse({...proof,reason:"changed"})).toThrow(/identity changed/);
 const noTask={...proof,task_id:null};expect(()=>repairReadinessObservationSchema.parse({...noTask,hash:repairReadinessObservationHash(noTask)})).toThrow(/identity changed/);
});
