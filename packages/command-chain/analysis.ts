import { z } from "zod";
import { parse } from "yaml";
import { verificationContractSchema } from "./verification";
import { decisionGraphErrors, decisionResolutionErrors, applyDecisionCommand } from "./decisions";
import { draftSchema, PhaseValidationError, type BuiltinHandlers, type ChainDraft, type ChainCommand } from "./runtime";
import type { CommandChainProfile } from "./definition";

const text=z.string().trim().min(1);
export const deliveryUnitSchema=z.strictObject({key:text.max(120),title:text.max(200),actor:text.max(500),trigger:text.max(4000),observableOutcome:text.max(4000),acceptance:text.max(4000),
  sourceRefs:z.array(z.strictObject({key:text.max(240),kind:z.enum(["change","preserve","technical","acceptance"]),content:text.max(4000),sourceRef:text.max(500)})).min(1).max(200),
  dependsOn:z.array(text.max(120)).max(50).default([]),
});
export const analysisContractSchema=verificationContractSchema.safeExtend({unit:deliveryUnitSchema,
  decisionMode:z.enum(["conservative","balanced","autonomous","fully_autonomous"]).default("balanced"),
  dependencies:z.array(z.strictObject({key:text,issueId:z.uuid(),repositoryPath:text,binding:verificationContractSchema.shape.binding})).default([]),
});
export type AnalysisContract=z.infer<typeof analysisContractSchema>;
export const analysisProfile:CommandChainProfile={definitionVersions:[2],id:"delivery-analysis",agent:"analyst-agent",requiredBuiltins:["delivery-unit","decision-proposal","decision-resolution","decision-answer-review"],
  builtins:{"delivery-unit":{acceptsArtifacts:false},"decision-proposal":{acceptsArtifacts:false},"decision-resolution":{acceptsArtifacts:true},"decision-answer-review":{acceptsArtifacts:true}},metadataKeys:[],repositoryAdapters:[]};
function rows(draft:Readonly<ChainDraft>,block:string){return draft.artifacts.filter(item=>item.ref === `delivery-analysis.${block}`).map(item=>({key:item.key,value:parse(item.content) as Record<string,string>}));}
function impactErrors(draft:Readonly<ChainDraft>,closed=false){
  const errors:string[]=[];const impacts=rows(draft,"impacts"),nodes=draft.decisions ?? [];
  if(!impacts.length)errors.push("Register at least one actual impact");
  for(const impact of impacts){
    if(impact.value.disposition === "needs_decision" && !impact.value.decision)errors.push(`Impact ${impact.key} needs a decision key`);
    if(impact.value.decision && !nodes.some(node=>node.key === impact.value.decision))errors.push(`Impact ${impact.key} refers to a missing decision`);
    if(closed && impact.value.disposition === "needs_decision")errors.push(`Impact ${impact.key} is still needs_decision`);
  }return errors;
}
function closureErrors(draft:Readonly<ChainDraft>){return [...impactErrors(draft,true),...decisionResolutionErrors(draft)];}
function bindingErrors(draft:Readonly<ChainDraft>,contract:AnalysisContract){return Object.keys(contract.binding).some(key=>draft.binding[key as keyof typeof draft.binding] !== contract.binding[key as keyof typeof contract.binding]) ? ["Frozen analysis binding changed"] : [];}
export function createAnalysisHandlers(input:AnalysisContract):BuiltinHandlers{
  const contract=analysisContractSchema.parse(input);
  const unitErrors=(draft:Readonly<ChainDraft>)=>[...bindingErrors(draft,contract),...(new Set(contract.unit.dependsOn).size !== contract.unit.dependsOn.length ? ["Delivery unit dependency keys repeat"] : []),
    ...contract.unit.dependsOn.flatMap(key=>contract.dependencies.some(item=>item.key === key) ? [] : [`Dependency ${key} has no frozen verified binding`])];
  return {
    "delivery-unit":Object.assign((draft:Readonly<ChainDraft>)=>({errors:unitErrors(draft)}),{beforeComplete:(draft:ChainDraft)=>{const errors=unitErrors(draft);if(errors.length)throw new PhaseValidationError(errors);},finalize:(draft:Readonly<ChainDraft>)=>[...unitErrors(draft),...closureErrors(draft)]}),
    "decision-proposal":Object.assign((draft:Readonly<ChainDraft>)=>({errors:[...impactErrors(draft),...decisionGraphErrors(draft.decisions ?? [])]}),{command:(draft:ChainDraft,command:ChainCommand)=>{if(!["decision.propose","decision.remove"].includes(command.type))throw new Error("Only propose/remove are allowed here");applyDecisionCommand(draft,command,contract.decisionMode);},rewind:(draft:ChainDraft,to:string)=>{
      const phases=Object.entries(draft.definition.phases),proposal=phases.findIndex(([_,phase])=>phase.type === "builtin" && phase.builtin === "decision-proposal");
      if(phases.findIndex(([id])=>id === to)<=proposal)for(const node of draft.decisions ?? []){node.status="proposed";delete node.resolution;}
    }}),
    "decision-resolution":Object.assign((draft:Readonly<ChainDraft>)=>({errors:closureErrors(draft)}),{runtimeInputs:true,command:(draft:ChainDraft,command:ChainCommand)=>{if(!["decision.ask","decision.resolve","decision.reopen"].includes(command.type))throw new Error("Only ask/resolve/reopen are allowed here");applyDecisionCommand(draft,command,contract.decisionMode);}}),
    "decision-answer-review":(draft:Readonly<ChainDraft>)=>({errors:closureErrors(draft)}),
  };
}
export function compileAnalysisConclusion(draft:Readonly<ChainDraft>,input:AnalysisContract){
  const contract=analysisContractSchema.parse(input);const errors=[...bindingErrors(draft,contract),...closureErrors(draft)];
  if(draft.definition.id !== "delivery-analysis" || draft.definition.agent !== "analyst-agent" || draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(Object.keys(draft.definition.phases)))errors.push("Analysis is not completed");
  const value=(block:string)=>draft.artifacts.find(item=>item.ref === `delivery-analysis.${block}`)?.content;
  for(const block of ["summary","contract","answer-review"])if(!value(block))errors.push(`Analysis ${block} is missing`);
  if(errors.length)throw new PhaseValidationError(errors);
  return {kind:"analysis" as const,draftId:draft.id,attemptId:draft.attemptId,sequence:draft.sequence,binding:structuredClone(draft.binding),unit:structuredClone(contract.unit),
    acceptances:structuredClone(contract.sources.filter(source=>source.kind === "acceptance")),summary:value("summary")!,impacts:rows(draft,"impacts"),decisions:structuredClone(draft.decisions ?? []),answerReview:value("answer-review")!,
    handoff:{implementationGuidance:value("contract")!,guardrails:rows(draft,"guardrails"),verificationFocus:rows(draft,"verification-focus")}};
}

/** Host-only: retain authenticated choices, clear conclusions and implementation assumptions. */
export function createAnalysisRework(previous:Readonly<ChainDraft>,previousContract:AnalysisContract,contract:AnalysisContract,id:string,attemptId:string):ChainDraft {
  compileAnalysisConclusion(previous,previousContract);
  if(JSON.stringify({...previousContract,binding:contract.binding}) !== JSON.stringify(contract))throw new Error("Reanalysis cannot replace the frozen unit, policy, dependencies, or original sources");
  return draftSchema.parse({...structuredClone(previous),id,binding:contract.binding,attemptId,sequence:0,status:"editing",phase:Object.keys(previous.definition.phases)[0],
    artifacts:[],frozen:[],writeRules:[],completedPhases:[],
    decisions:(previous.decisions ?? []).map(node=>node.resolution?.authority === "user" ? node : {...node,status:"proposed",resolution:undefined}),
    runtimeInputs:previous.runtimeInputs.map(input=>({...input,active:false})),
    events:[{sequence:0,attemptId,command:"analysis.rework",phase:Object.keys(previous.definition.phases)[0],reason:`Reassess failed specification from analysis ${previous.id}`}],
  });
}
