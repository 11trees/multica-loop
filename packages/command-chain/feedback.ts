import { parse, stringify } from "yaml";
import { z } from "zod";
import type { CommandChainProfile } from "./definition";
import { applyDecisionCommand, decisionGraphErrors, decisionModeSchema, decisionResolutionErrors, decisionStateSchema } from "./decisions";
import { draftSchema, PhaseValidationError, type ChainDraft, type ChainCommand, type BuiltinHandlers } from "./runtime";

const text=z.string().trim().min(1);
export const feedbackCommentSchema=z.strictObject({id:text.max(240),version:text,content:text,sourceRef:text,authorId:text});
export const feedbackContextSchema=z.strictObject({ref:text,version:text,content:text});
const unitSchema=z.strictObject({index:z.number().int().positive(),key:text,version:text,content:text});
export const feedbackWorkTypeSchema=z.enum(["reply","historical_correction","report_correction","bug","behavior_change","scope_addition","technical_change","learning_only"]);
const indexSchema=z.union([z.number(),z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive());
export const feedbackGroupSchema=z.strictObject({key:text.max(120),workType:feedbackWorkTypeSchema,title:z.string().trim().default(""),reason:text,response:z.string().trim().default(""),commentIds:z.array(text).min(1).max(100),affectedDeliveryUnits:z.array(indexSchema),acceptance:z.array(text)});
export type FeedbackGroup=z.infer<typeof feedbackGroupSchema>;
export const feedbackTriageContractSchema=z.strictObject({binding:draftSchema.shape.binding,batchId:text,decisionMode:decisionModeSchema,comments:z.array(feedbackCommentSchema).min(1).max(100),context:feedbackContextSchema,units:z.array(unitSchema),previousFeedback:z.array(feedbackContextSchema).default([])})
  .superRefine((value,ctx)=>{
    if(new Set(value.comments.map(item=>item.id)).size !== value.comments.length)ctx.addIssue({code:"custom",message:"Frozen feedback comments must be unique"});
    if(new Set(value.units.map(item=>item.key)).size !== value.units.length || value.units.some((item,index)=>item.index !== index+1))ctx.addIssue({code:"custom",message:"Frozen delivery units need unique keys and contiguous source indexes"});
  });
export type FeedbackTriageContract=z.infer<typeof feedbackTriageContractSchema>;
export const feedbackWorkEvidenceSchema=z.strictObject({kind:z.enum(["delivery","report"]),ref:text,version:text,codeVersion:text,content:text});
export const feedbackVerifyContractSchema=z.strictObject({binding:draftSchema.shape.binding,batchId:text,groupId:text,group:feedbackGroupSchema,comment:feedbackCommentSchema,context:feedbackContextSchema,work:feedbackWorkEvidenceSchema})
  .superRefine((value,ctx)=>{
    if(!value.group.commentIds.includes(value.comment.id))ctx.addIssue({code:"custom",message:"Verification comment is outside the frozen group"});
    if(value.work.codeVersion !== value.binding.codeVersion)ctx.addIssue({code:"custom",message:"Feedback verification must bind the actual forward work code version"});
  });
export type FeedbackVerifyContract=z.infer<typeof feedbackVerifyContractSchema>;
const resultIdentity={binding:draftSchema.shape.binding,draftId:text,sequence:z.number().int().nonnegative(),attemptId:text,batchId:text};
export const feedbackTriageConclusionSchema=z.strictObject({kind:z.literal("feedback-triage"),...resultIdentity,summary:text,groups:z.array(feedbackGroupSchema).min(1),decisions:z.array(decisionStateSchema)});
export const feedbackVerifyConclusionSchema=z.strictObject({kind:z.literal("feedback-verify"),...resultIdentity,groupId:text,commentId:text,summary:text,evidence:z.array(z.strictObject({key:text,content:text})).min(1),conclusion:z.strictObject({verdict:z.enum(["resolved","reopened"]),reason:text}),work:feedbackWorkEvidenceSchema});
export const feedbackTriageProfile:CommandChainProfile={id:"feedback-triage",agent:"feedback-agent",requiredBuiltins:["feedback-triage-inputs","decision-proposal","decision-resolution","decision-answer-review","feedback-triage-finalize"],builtins:{"feedback-triage-inputs":{acceptsArtifacts:false},"decision-proposal":{acceptsArtifacts:false},"decision-resolution":{acceptsArtifacts:false},"decision-answer-review":{acceptsArtifacts:true},"feedback-triage-finalize":{acceptsArtifacts:false}},metadataKeys:[],repositoryAdapters:[]};
export const feedbackVerifyProfile:CommandChainProfile={id:"feedback-verify",agent:"feedback-agent",requiredBuiltins:["feedback-verify-inputs","feedback-verify-finalize"],builtins:{"feedback-verify-inputs":{acceptsArtifacts:false},"feedback-verify-finalize":{acceptsArtifacts:false}},metadataKeys:[],repositoryAdapters:[]};
const one=(draft:Readonly<ChainDraft>,ref:string)=>draft.artifacts.find(item=>item.ref === `feedback.${ref}`)?.content ?? "";
const groups=(draft:Readonly<ChainDraft>)=>draft.artifacts.filter(item=>item.ref === "feedback.groups").map(item=>feedbackGroupSchema.parse({key:item.key,...parse(item.content)}));
function bindingErrors(draft:Readonly<ChainDraft>,contract:{binding:ChainDraft["binding"]}){return JSON.stringify(draft.binding) === JSON.stringify(contract.binding) ? [] : ["Frozen feedback binding changed"];}
function projections(contract:FeedbackTriageContract){return [...contract.comments.map((comment,index)=>({ref:"feedback.inputs",key:`comment-${index+1}`,content:stringify({commentId:comment.id}).trim()})),{ref:"feedback.meta",key:undefined,content:stringify({batchId:contract.batchId,totalStories:String(contract.units.length)}).trim()}];}
function triageInputErrors(draft:Readonly<ChainDraft>,contract:FeedbackTriageContract){
  const actual=draft.artifacts.filter(item=>["feedback.inputs","feedback.meta"].includes(item.ref)).map(({ref,key,content})=>({ref,key,content}));
  return [...bindingErrors(draft,contract),...(JSON.stringify(actual) === JSON.stringify(projections(contract).map(item=>({...item,key:item.key ?? ""}))) ? [] : ["Frozen feedback batch, comments or delivery-unit count changed"])];
}
function triageErrors(draft:Readonly<ChainDraft>,contract:FeedbackTriageContract){
  const errors=[...triageInputErrors(draft,contract),...decisionResolutionErrors(draft)],values=groups(draft),seen=new Set<string>();
  if(!one(draft,"summary").trim() || !one(draft,"answer-review").trim())errors.push("Feedback summary and answer review are required");
  if(!values.length)errors.push("Feedback triage requires at least one group");
  if(new Set(values.map(item=>item.key)).size !== values.length)errors.push("Feedback group keys must be unique");
  for(const group of values){
    for(const id of group.commentIds){if(!contract.comments.some(item=>item.id === id))errors.push(`Group ${group.key} refers to an unknown frozen comment`);if(seen.has(id))errors.push(`Comment ${id} is grouped more than once`);seen.add(id);}
    if(["report_correction","bug","behavior_change","scope_addition","technical_change"].includes(group.workType) && (!group.title || !group.acceptance.length))errors.push(`Forward work group ${group.key} requires a title and verifiable acceptance`);
    if(["reply","historical_correction"].includes(group.workType) && !group.response)errors.push(`Group ${group.key} requires an explicit response`);
    if(new Set(group.affectedDeliveryUnits).size !== group.affectedDeliveryUnits.length || group.affectedDeliveryUnits.some(index=>index>contract.units.length))errors.push(`Group ${group.key} refers to invalid or duplicate delivery-unit indexes`);
  }
  for(const comment of contract.comments)if(!seen.has(comment.id))errors.push(`Frozen feedback comment ${comment.id} is uncovered`);
  if(draft.runtimeInputs.some(item=>item.active && !item.answer))errors.push("Feedback clarification remains unanswered");
  return errors;
}
export function createFeedbackTriageHandlers(input:FeedbackTriageContract):BuiltinHandlers{
  const contract=feedbackTriageContractSchema.parse(input),decide=(allowed:string[])=>(draft:ChainDraft,command:ChainCommand)=>{if(!allowed.includes(command.type))throw new Error("Decision command is outside the feedback phase");applyDecisionCommand(draft,command,contract.decisionMode);};
  return {
    "feedback-triage-inputs":draft=>({errors:draft.artifacts.some(item=>item.ref === "feedback.meta") ? triageInputErrors(draft,contract) : bindingErrors(draft,contract),artifacts:projections(contract),freeze:["feedback.inputs","feedback.meta"]}),
    "decision-proposal":Object.assign((draft:Readonly<ChainDraft>)=>({errors:decisionGraphErrors(draft.decisions ?? [])}),{command:decide(["decision.propose","decision.remove"]),rewind:(draft:ChainDraft,to:string)=>{if(["inputs","clarification_proposal"].includes(to))for(const node of draft.decisions ?? []){node.status="proposed";delete node.resolution;}}}),
    "decision-resolution":Object.assign((draft:Readonly<ChainDraft>)=>({errors:decisionResolutionErrors(draft)}),{runtimeInputs:true,command:decide(["decision.ask","decision.resolve","decision.reopen"])}),
    "decision-answer-review":(draft:Readonly<ChainDraft>)=>({errors:decisionResolutionErrors(draft)}),
    "feedback-triage-finalize":Object.assign((draft:Readonly<ChainDraft>)=>({errors:triageErrors(draft,contract)}),{beforeComplete:(draft:ChainDraft)=>{const errors=bindingErrors(draft,contract);if(errors.length)throw new PhaseValidationError(errors);},finalize:(draft:Readonly<ChainDraft>)=>triageErrors(draft,contract)}),
  };
}
function completeErrors(draft:Readonly<ChainDraft>,profile:CommandChainProfile){return draft.definition.id === profile.id && draft.definition.agent === profile.agent && draft.status === "completed" && draft.phase === null && JSON.stringify(draft.completedPhases) === JSON.stringify(Object.keys(draft.definition.phases)) ? [] : ["Feedback command chain is not completed"];}
export function compileFeedbackTriageConclusion(draft:Readonly<ChainDraft>,input:FeedbackTriageContract){
  const contract=feedbackTriageContractSchema.parse(input),errors=[...triageErrors(draft,contract),...completeErrors(draft,feedbackTriageProfile)];if(errors.length)throw new PhaseValidationError(errors);
  return feedbackTriageConclusionSchema.parse({kind:"feedback-triage",batchId:contract.batchId,binding:structuredClone(draft.binding),draftId:draft.id,sequence:draft.sequence,attemptId:draft.attemptId,summary:one(draft,"summary"),groups:groups(draft),decisions:structuredClone(draft.decisions ?? [])});
}
function verifyInputErrors(draft:Readonly<ChainDraft>,contract:FeedbackVerifyContract){return [...bindingErrors(draft,contract),...(one(draft,"target") === stringify({commentId:contract.comment.id,groupId:contract.groupId}).trim() ? [] : ["Frozen feedback verification target changed"])];}
function verification(draft:Readonly<ChainDraft>){return {summary:one(draft,"summary"),evidence:draft.artifacts.filter(item=>item.ref === "feedback.evidence").map(item=>({key:item.key,content:item.content})),conclusion:z.object({verdict:z.enum(["resolved","reopened"]),reason:text}).parse(parse(one(draft,"conclusion")))};}
function verifyErrors(draft:Readonly<ChainDraft>,contract:FeedbackVerifyContract){
  const errors=verifyInputErrors(draft,contract),value=verification(draft);
  if(!value.summary.trim() || !value.evidence.length || value.evidence.some(item=>!item.content.trim()))errors.push("Feedback verification requires a summary and locatable independent evidence");
  if(draft.runtimeInputs.length || draft.decisions?.length)errors.push("Feedback Verify cannot request questions or runtime input");
  return errors;
}
export function createFeedbackVerifyHandlers(input:FeedbackVerifyContract):BuiltinHandlers{
  const contract=feedbackVerifyContractSchema.parse(input);
  return {
    "feedback-verify-inputs":draft=>({errors:draft.artifacts.some(item=>item.ref === "feedback.target") ? verifyInputErrors(draft,contract) : bindingErrors(draft,contract),artifacts:[{ref:"feedback.target",content:stringify({commentId:contract.comment.id,groupId:contract.groupId}).trim()}],freeze:["feedback.target"]}),
    "feedback-verify-finalize":Object.assign((draft:Readonly<ChainDraft>)=>({errors:verifyErrors(draft,contract)}),{beforeComplete:(draft:ChainDraft)=>{const errors=bindingErrors(draft,contract);if(errors.length)throw new PhaseValidationError(errors);},finalize:(draft:Readonly<ChainDraft>)=>verifyErrors(draft,contract)}),
  };
}
export function compileFeedbackVerifyConclusion(draft:Readonly<ChainDraft>,input:FeedbackVerifyContract){
  const contract=feedbackVerifyContractSchema.parse(input),errors=[...verifyErrors(draft,contract),...completeErrors(draft,feedbackVerifyProfile)];if(errors.length)throw new PhaseValidationError(errors);
  return feedbackVerifyConclusionSchema.parse({kind:"feedback-verify",batchId:contract.batchId,groupId:contract.groupId,commentId:contract.comment.id,binding:structuredClone(draft.binding),draftId:draft.id,sequence:draft.sequence,attemptId:draft.attemptId,...verification(draft),work:structuredClone(contract.work)});
}
