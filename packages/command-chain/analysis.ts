import { z } from "zod";
import { parse } from "yaml";
import { verificationContractSchema } from "./verification";
import { decisionGraphErrors } from "./decisions";
import { PhaseValidationError, type BuiltinHandlers, type ChainDraft, type ChainCommand } from "./runtime";
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
export const analysisPolicies={
  conservative:"Do not use agent_authority. Use upstream commitments or decisive project evidence; otherwise ask the human.",
  balanced:"Use agent_authority only for reversible, equivalent, internal engineering decisions. Ask the human about other outcome branches.",
  autonomous:"Use agent_authority for technical choices within the existing business contract. Product choices still need the human.",
  fully_autonomous:"Inherit explicit upstream commitments and existing human answers, then resolve remaining nodes with agent_authority. Do not use decision.ask.",
};
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
function closureErrors(draft:Readonly<ChainDraft>){
  const errors=[...impactErrors(draft,true),...decisionGraphErrors(draft.decisions ?? [])];
  for(const node of draft.decisions ?? []){
    if(node.status !== "resolved" || !node.resolution){errors.push(`Decision ${node.key} is not resolved`);continue;}
    if(node.resolution.authority === "user"){
      const question=draft.runtimeInputs.find(input=>input.id === node.resolution!.questionId && input.decisionKey === node.key);
      if(!question?.answer || question.answer.userId !== node.resolution.userId || question.answer.selectedOption !== node.resolution.option || question.question !== node.question || JSON.stringify(question.options) !== JSON.stringify(node.options))errors.push(`Decision ${node.key} no longer matches its authenticated human choice`);
    }
  }return errors;
}
function bindingErrors(draft:Readonly<ChainDraft>,contract:AnalysisContract){return Object.keys(contract.binding).some(key=>draft.binding[key as keyof typeof draft.binding] !== contract.binding[key as keyof typeof contract.binding]) ? ["Frozen analysis binding changed"] : [];}
function resolve(draft:ChainDraft,command:ChainCommand,contract:AnalysisContract){
  const nodes=draft.decisions ??= [];
  if(command.type === "decision.propose"){
    const index=nodes.findIndex(node=>node.key === command.decision.key);
    const node={...command.decision,status:"proposed" as const,humanRequested:Boolean(nodes[index]?.humanRequested || draft.runtimeInputs.some(input=>input.decisionKey === command.decision.key))};
    if(index<0)nodes.push(node);else nodes[index]=node;return;
  }
  if(!("key" in command))throw new Error("Expected a decision command");
  const node=nodes.find(node=>node.key === command.key);if(!node)throw new Error("Decision is missing");
  if(command.type === "decision.remove") { draft.decisions=nodes.filter(item=>item !== node);for(const input of draft.runtimeInputs)if(input.decisionKey === node.key)input.active=false;return; }
  if(command.type === "decision.reopen") { node.status="proposed";delete node.resolution;for(const input of draft.runtimeInputs)if(input.decisionKey === node.key)input.active=false;return; }
  if(command.type === "decision.ask"){
    if(contract.decisionMode === "fully_autonomous")throw new Error("Fully autonomous analysis cannot ask human decisions");
    if(node.status !== "proposed")throw new Error("Only a proposed decision can be requested");
    node.status="needs_user_input";node.humanRequested=true;
    const option=node.options.find(option=>option.id === node.recommendation.option)!;
    draft.runtimeInputs.push({id:`${draft.id}:decision:${draft.sequence+1}:${node.key}`,key:`decision:${draft.sequence+1}`,title:node.title,question:node.question,why:node.impact,
      recommendation:node.recommendation.reason,recommendationOption:option.id,options:structuredClone(node.options),decisionKey:node.key,phase:draft.phase!,attemptId:draft.attemptId,active:true,answer:null});return;
  }
  if(command.type !== "decision.resolve")throw new Error("Expected a resolution command");
  if(!node.options.some(option=>option.id === command.option))throw new Error("Selected decision option is missing");
  const request=draft.runtimeInputs.find(input=>input.decisionKey === node.key && input.active);const answer=request?.answer;
  if(node.humanRequested || command.authority === "user"){
    if(command.authority !== "user" || !answer || answer.selectedOption !== command.option)throw new Error("Human authority requires the authenticated matching option selection");
  } else if(command.authority === "agent_authority" && (contract.decisionMode === "conservative" || node.type === "business" && contract.decisionMode !== "fully_autonomous"))throw new Error("This decision exceeds the configured agent authority");
  node.status="resolved";node.resolution={option:command.option,authority:command.authority,decision:command.decision,rationale:command.rationale,evidence:command.evidence,...(command.authority === "user" ? {userId:answer!.userId,questionId:request!.id} : {})};
}
export function createAnalysisHandlers(input:AnalysisContract):BuiltinHandlers{
  const contract=analysisContractSchema.parse(input);
  const unitErrors=(draft:Readonly<ChainDraft>)=>[...bindingErrors(draft,contract),...(new Set(contract.unit.dependsOn).size !== contract.unit.dependsOn.length ? ["Delivery unit dependency keys repeat"] : []),
    ...contract.unit.dependsOn.flatMap(key=>contract.dependencies.some(item=>item.key === key) ? [] : [`Dependency ${key} has no frozen verified binding`])];
  return {
    "delivery-unit":Object.assign((draft:Readonly<ChainDraft>)=>({errors:unitErrors(draft)}),{beforeComplete:(draft:ChainDraft)=>{const errors=unitErrors(draft);if(errors.length)throw new PhaseValidationError(errors);},finalize:(draft:Readonly<ChainDraft>)=>[...unitErrors(draft),...closureErrors(draft)]}),
    "decision-proposal":Object.assign((draft:Readonly<ChainDraft>)=>({errors:[...impactErrors(draft),...decisionGraphErrors(draft.decisions ?? [])]}),{command:(draft:ChainDraft,command:ChainCommand)=>{if(!["decision.propose","decision.remove"].includes(command.type))throw new Error("Only propose/remove are allowed here");resolve(draft,command,contract);},rewind:(draft:ChainDraft,to:string)=>{
      const phases=Object.entries(draft.definition.phases),proposal=phases.findIndex(([_,phase])=>phase.type === "builtin" && phase.builtin === "decision-proposal");
      if(phases.findIndex(([id])=>id === to)<=proposal)for(const node of draft.decisions ?? []){node.status="proposed";delete node.resolution;}
    }}),
    "decision-resolution":Object.assign((draft:Readonly<ChainDraft>)=>({errors:closureErrors(draft)}),{runtimeInputs:true,command:(draft:ChainDraft,command:ChainCommand)=>{if(!["decision.ask","decision.resolve","decision.reopen"].includes(command.type))throw new Error("Only ask/resolve/reopen are allowed here");resolve(draft,command,contract);}}),
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
