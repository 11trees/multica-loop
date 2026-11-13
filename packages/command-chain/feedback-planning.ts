import {feedbackWorkScopeSchema,type FeedbackTriageContract,type FeedbackGroup} from "./feedback";
import {planningSourceSchema} from "./planning";

export function feedbackPlanningInputs(contract:FeedbackTriageContract,groupId:string,group:FeedbackGroup){
 if(!["bug","behavior_change","scope_addition","technical_change"].includes(group.workType))throw new Error("This feedback group does not produce delivery planning");
 const comments=group.commentIds.map(id=>{const comment=contract.comments.find(item=>item.id === id);if(!comment)throw new Error("Feedback planning comment is outside its frozen batch");return comment;});
 const units=group.affectedDeliveryUnits.map(index=>{const unit=contract.units.find(item=>item.index === index);if(!unit)throw new Error("Feedback planning unit is outside its frozen batch");return unit;});
 const scope=feedbackWorkScopeSchema.parse({batchId:contract.batchId,groupId,group,comments,context:contract.context,units});
 const ref=`FEEDBACK_GROUP:${groupId}`;
 const sources=[{key:"feedback:change",kind:"change" as const,content:`${group.title}: ${group.reason}`,sourceRef:ref},...group.acceptance.map((content,index)=>({key:`feedback:acceptance:${index+1}`,kind:"acceptance" as const,content,oracle:content,sourceRef:`${ref}:acceptance:${index+1}`}))].map(value=>planningSourceSchema.parse(value));
 return {scope,sources};
}
