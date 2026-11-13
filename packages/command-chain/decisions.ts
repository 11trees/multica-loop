import { z } from "zod";
import type { ChainDraft, ChainCommand } from "./runtime";

export const decisionModeSchema=z.enum(["conservative","balanced","autonomous","fully_autonomous"]);
export type DecisionMode=z.infer<typeof decisionModeSchema>;

const text = z.string().trim().min(1);
export const decisionOptionSchema = z.strictObject({ id: text.max(100), label: text.max(240), consequence: text.max(1000) });
export const decisionAuthoritySchema = z.enum(["upstream", "user", "project_evidence", "agent_authority"]);
export const decisionProposalSchema = z.strictObject({
  key: text.max(240), type: z.enum(["business", "technical"]), title: text.max(500), question: text.max(4000), impact: text.max(4000),
  options: z.array(decisionOptionSchema).min(2).max(20),
  recommendation: z.strictObject({ option: text, reason: text.max(4000), authority: decisionAuthoritySchema }),
  dependencies: z.array(z.strictObject({ decision: text, option: text })).max(50).default([]),
}).superRefine((value,ctx) => {
  if(new Set(value.options.map(option=>option.id)).size !== value.options.length) ctx.addIssue({code:"custom",message:"Decision options must have unique IDs"});
  if(!value.options.some(option=>option.id === value.recommendation.option)) ctx.addIssue({code:"custom",message:"Recommended option is missing"});
});
export const decisionStateSchema = decisionProposalSchema.safeExtend({
  status: z.enum(["proposed","needs_user_input","resolved"]), humanRequested: z.boolean().default(false),
  resolution: z.strictObject({option:text,authority:decisionAuthoritySchema,decision:text.max(4000),rationale:text.max(4000),evidence:text.max(4000),userId:text.optional(),questionId:text.optional()}).optional(),
});
export type DecisionState = z.infer<typeof decisionStateSchema>;
export function decisionGraphErrors(decisions: readonly DecisionState[]):string[] {
  const errors:string[]=[];const byKey=new Map(decisions.map(node=>[node.key,node]));
  if(byKey.size !== decisions.length) errors.push("Decision keys must be unique");
  for(const node of decisions) for(const dependency of node.dependencies) {
    const parent=byKey.get(dependency.decision);
    if(!parent) errors.push(`Decision ${node.key} refers to missing dependency ${dependency.decision}`);
    else if(!parent.options.some(option=>option.id === dependency.option)) errors.push(`Decision ${node.key} refers to missing dependency option`);
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(key:string):boolean=>{
    if(visiting.has(key)) return true;if(visited.has(key))return false;visiting.add(key);
    const cyclic=Boolean(byKey.get(key)?.dependencies.some(item=>visit(item.decision)));visiting.delete(key);visited.add(key);return cyclic;
  };
  if(decisions.some(node=>visit(node.key)))errors.push("Decision graph must be acyclic");return errors;
}

export const decisionPolicies={
  conservative:"Do not use agent_authority. Use upstream commitments or decisive project evidence; otherwise ask the human.",
  balanced:"Use agent_authority only for reversible, equivalent, internal engineering decisions. Ask the human about other outcome branches.",
  autonomous:"Use agent_authority for technical choices within the existing business contract. Product choices still need the human.",
  fully_autonomous:"Inherit explicit upstream commitments and existing human answers, then resolve remaining nodes with agent_authority. Do not use decision.ask.",
};

export function decisionResolutionErrors(draft:Readonly<ChainDraft>){
  const errors=decisionGraphErrors(draft.decisions ?? []);
  for(const node of draft.decisions ?? []){
    if(node.status !== "resolved" || !node.resolution){errors.push(`Decision ${node.key} is not resolved`);continue;}
    if(node.resolution.authority === "user"){
      const question=draft.runtimeInputs.find(input=>input.id === node.resolution!.questionId && input.decisionKey === node.key);
      if(!question?.answer || question.answer.userId !== node.resolution.userId || question.answer.selectedOption !== node.resolution.option || question.question !== node.question || JSON.stringify(question.options) !== JSON.stringify(node.options))errors.push(`Decision ${node.key} no longer matches its authenticated human choice`);
    }
  }return errors;
}

export function applyDecisionCommand(draft:ChainDraft,command:ChainCommand,decisionMode:DecisionMode){
  const nodes=draft.decisions ??= [];
  if(command.type === "decision.propose"){
    const index=nodes.findIndex(node=>node.key === command.decision.key);
    if(index >= 0 && nodes[index]!.status !== "proposed")throw new Error("Reopen the decision before changing its proposal");
    const node={...command.decision,status:"proposed" as const,humanRequested:Boolean(nodes[index]?.humanRequested || draft.runtimeInputs.some(input=>input.decisionKey === command.decision.key))};
    if(index<0)nodes.push(node);else nodes[index]=node;return;
  }
  if(!("key" in command))throw new Error("Expected a decision command");
  const node=nodes.find(node=>node.key === command.key);if(!node)throw new Error("Decision is missing");
  if(command.type === "decision.remove") {
    if(node.status !== "proposed")throw new Error("Only a proposed decision can be removed");
    if(draft.runtimeInputs.some(input=>input.decisionKey === node.key && input.answer))throw new Error("Answered human decisions must be reopened and answered, not removed");
    draft.decisions=nodes.filter(item=>item !== node);for(const input of draft.runtimeInputs)if(input.decisionKey === node.key)input.active=false;return; }
  if(command.type === "decision.reopen") { node.status="proposed";delete node.resolution;for(const input of draft.runtimeInputs)if(input.decisionKey === node.key)input.active=false;return; }
  if(command.type === "decision.ask"){
    if(decisionMode === "fully_autonomous")throw new Error("Fully autonomous analysis cannot ask human decisions");
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
  } else if(command.authority === "agent_authority" && (decisionMode === "conservative" || node.type === "business" && decisionMode !== "fully_autonomous"))throw new Error("This decision exceeds the configured agent authority");
  node.status="resolved";node.resolution={option:command.option,authority:command.authority,decision:command.decision,rationale:command.rationale,evidence:command.evidence,...(command.authority === "user" ? {userId:answer!.userId,questionId:request!.id} : {})};
}
