// @vitest-environment node
import {readFile} from "node:fs/promises";
import {expect,it} from "vitest";
import {repairRecoveryFaultHash,repairRecoveryFaultSchema} from "./repair-recovery-fault";

it("matches the native UTF-8 fault witness and binds the Case, checkpoint, claim and native failure",async()=>{
 const raw=JSON.parse(await readFile(new URL("./test-helpers/repair-recovery-fault.json",import.meta.url),"utf8")),proof=repairRecoveryFaultSchema.parse(raw);expect(proof.hash).toBe(repairRecoveryFaultHash(proof));
 for(const changed of [{...proof,case_id:"another-case"},{...proof,checkpoint_hash:"c".repeat(64)},{...proof,attempt_id:`${proof.task_id}:1`},{...proof,status:"completed"},{...proof,failure_reason:"changed"},{...proof,execution_hint_hash:null}])expect(()=>repairRecoveryFaultSchema.parse(changed)).toThrow(/identity changed/);
 const invalid={...proof,attempt_id:`${proof.entry_task_id}:1`};expect(()=>repairRecoveryFaultSchema.parse({...invalid,hash:repairRecoveryFaultHash(invalid)})).toThrow(/identity changed/);
});

it("binds unbound preparation provenance without manufacturing its execution binding",async()=>{
 const proof=repairRecoveryFaultSchema.parse(JSON.parse(await readFile(new URL("./test-helpers/repair-prebind-fault.json",import.meta.url),"utf8")));expect(proof.hash).toBe(repairRecoveryFaultHash(proof));
 for(const [key,value]of Object.entries(proof.preparation!)){const changed={...proof,preparation:{...proof.preparation!,[key]:value+"changed"}};expect(()=>repairRecoveryFaultSchema.parse(changed)).toThrow();}
 expect(()=>repairRecoveryFaultSchema.parse({...proof,preparation:undefined})).toThrow(/identity changed/);
});
