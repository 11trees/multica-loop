// @vitest-environment node
import {expect,it} from "vitest";
import {feedbackPlanningInputs} from "./feedback-planning";
import {feedbackTriageContractSchema,feedbackGroupSchema} from "./feedback";
const binding={workspaceId:"workspace",issueId:"parent",revision:1,codeVersion:"commit",contractVersion:"contract"};
const contract=feedbackTriageContractSchema.parse({binding,batchId:"batch",decisionMode:"balanced",comments:[{id:"one",version:"v1",content:"Add a reader action",sourceRef:"COMMENT:one:r1",authorId:"human"},{id:"two",version:"v2",content:"Other group",sourceRef:"COMMENT:two:r2",authorId:"human"}],context:{ref:"REPORT:one",version:"hash",content:"Original obligations"},units:[{index:1,key:"original",version:"unit-v1",content:"Frozen original unit"}]});
const group=feedbackGroupSchema.parse({key:"addition",workType:"scope_addition",title:"Another reader action",reason:"New scope",commentIds:["one"],affectedDeliveryUnits:[1],acceptance:["Action visible","Action activates"]});
it("freezes only the group's comments, affected unit versions and all explicit acceptances",()=>{
 const result=feedbackPlanningInputs(contract,"group",group);
 expect(result.scope).toMatchObject({batchId:"batch",groupId:"group",comments:[{id:"one",version:"v1"}],units:[{key:"original",version:"unit-v1"}],context:contract.context});expect(result.scope.comments).toHaveLength(1);
 expect(result.sources).toEqual([{key:"feedback:change",kind:"change",content:"Another reader action: New scope",sourceRef:"FEEDBACK_GROUP:group"},...group.acceptance.map((content,index)=>({key:`feedback:acceptance:${index+1}`,kind:"acceptance",content,oracle:content,sourceRef:`FEEDBACK_GROUP:group:acceptance:${index+1}`}))]);
 expect(contract.comments).toHaveLength(2);expect(contract.units[0]!.version).toBe("unit-v1");
});
it("rejects immediate/report groups and references outside the captured batch",()=>{
 for(const workType of ["reply","historical_correction","learning_only","report_correction"] as const)expect(()=>feedbackPlanningInputs(contract,"group",{...group,workType})).toThrow(/does not produce/);
 expect(()=>feedbackPlanningInputs(contract,"group",{...group,commentIds:["foreign"]})).toThrow(/comment is outside/);expect(()=>feedbackPlanningInputs(contract,"group",{...group,affectedDeliveryUnits:[2]})).toThrow(/unit is outside/);
});
