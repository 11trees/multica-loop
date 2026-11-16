// @vitest-environment node
import {readFile} from "node:fs/promises";
import {expect,it} from "vitest";
import {repairExecutionHintSchema,repairExecutionHintHash} from "./repair-execution";
it("matches the native recovery context digest and rejects a substituted stage or authority",async()=>{
 const hint=repairExecutionHintSchema.parse(JSON.parse(await readFile(new URL("./test-helpers/repair-execution-hint.json",import.meta.url),"utf8")));expect(hint.hash).toBe(repairExecutionHintHash(hint));
 for(const changed of [{...hint,draft_id:"other-stage"},{...hint,sequence:hint.sequence+1},{...hint,user_id:hint.agent_id},{...hint,kind:"entry"}])expect(()=>repairExecutionHintSchema.parse(changed)).toThrow(/hash changed/);
});
