import { parse } from "yaml";
import { z } from "zod";
import type { CommandChainProfile } from "./definition";
import { applyDecisionCommand, decisionGraphErrors, decisionModeSchema, decisionResolutionErrors } from "./decisions";
import { draftSchema, PhaseValidationError, type BuiltinHandlers, type ChainDraft, type ChainCommand } from "./runtime";

const text=z.string().trim().min(1);
export const reproductionContractSchema=z.strictObject({binding:draftSchema.shape.binding,decisionMode:decisionModeSchema,contextRef:text,contextFingerprint:z.string().regex(/^[a-f0-9]{64}$/),contextContent:text,expectedBehavior:text});
export type ReproductionContract=z.infer<typeof reproductionContractSchema>;
export const reproductionProfile:CommandChainProfile={id:"reproduction",agent:"repro-agent",requiredBuiltins:["decision-proposal","decision-resolution","decision-answer-review","reproduction-finalize"],builtins:{"decision-proposal":{acceptsArtifacts:false},"decision-resolution":{acceptsArtifacts:false},"decision-answer-review":{acceptsArtifacts:true},"reproduction-finalize":{acceptsArtifacts:false}},metadataKeys:[],repositoryAdapters:[]};
const verdictSchema=z.object({status:z.enum(["reproduced","not_reproduced"]),expectedBehavior:text,actualBehavior:text,environment:text,stability:text,impactScope:text});
function rows<T>(draft:Readonly<ChainDraft>,block:string,schema:z.ZodType<T>){return draft.artifacts.filter(item=>item.ref === `reproduction.${block}`).map(item=>({key:item.key,...schema.parse(parse(item.content))}));}
export function reproductionState(draft:Readonly<ChainDraft>){return {
  verdict:rows(draft,"verdict",verdictSchema)[0],
  steps:rows(draft,"steps",z.object({action:text,expected:text,actual:text})),
  evidence:rows(draft,"evidence",z.object({kind:z.enum(["log","screenshot","command","observation"]),content:text,source:text})),
  hypotheses:rows(draft,"hypotheses",z.object({status:z.enum(["suspected","excluded"]),statement:text,evidence:text})),
  answerReview:draft.artifacts.find(item=>item.ref === "reproduction.answer-review")?.content ?? "",
};}
function inputErrors(draft:Readonly<ChainDraft>,contract:ReproductionContract){
  const errors=JSON.stringify(draft.binding) === JSON.stringify(contract.binding) ? [] : ["Frozen reproduction binding changed"];
  const verdict=reproductionState(draft).verdict;
  if(verdict && verdict.expectedBehavior !== contract.expectedBehavior)errors.push("Reproduction must preserve the exact frozen Existing Expected");
  return errors;
}
function completionErrors(draft:Readonly<ChainDraft>,contract:ReproductionContract){
  const value=reproductionState(draft),errors=[...inputErrors(draft,contract),...decisionResolutionErrors(draft)];
  if(value.verdict?.status !== "reproduced")errors.push("Only a reproduced conclusion can hand off to delivery planning");
  if(!value.steps.length || !value.evidence.length)errors.push("Reproduction requires steps and locatable observation evidence");
  if(!value.answerReview.trim())errors.push("Reproduction answer review is missing");
  if(draft.runtimeInputs.some(item=>item.active && !item.answer))errors.push("Reproduction facts remain unanswered");
  return errors;
}
export function createReproductionHandlers(input:ReproductionContract):BuiltinHandlers{
  const contract=reproductionContractSchema.parse(input);
  const decide=(allowed:string[])=>(draft:ChainDraft,command:ChainCommand)=>{
    if(!allowed.includes(command.type))throw new Error("Decision command is outside the reproduction phase");
    if(command.type === "decision.ask" && reproductionState(draft).verdict?.status !== "not_reproduced")throw new Error("Only not_reproduced can request missing reproduction facts");
    applyDecisionCommand(draft,command,contract.decisionMode);
  };
  return {
    "decision-proposal":Object.assign((draft:Readonly<ChainDraft>)=>({errors:decisionGraphErrors(draft.decisions ?? [])}),{command:decide(["decision.propose","decision.remove"]),rewind:(draft:ChainDraft,to:string)=>{
      if(to !== "investigation")return;
      const artifacts=draft.artifacts.filter(item=>item.ref.startsWith("reproduction."));
      (draft.reproduction ??= {history:[]}).history.push({sequence:draft.sequence,attemptId:draft.attemptId,artifacts:structuredClone(artifacts)});
      draft.artifacts=draft.artifacts.filter(item=>!item.ref.startsWith("reproduction."));
    }}),
    "decision-resolution":Object.assign((draft:Readonly<ChainDraft>)=>({errors:decisionResolutionErrors(draft)}),{runtimeInputs:true,command:decide(["decision.ask","decision.resolve","decision.reopen"]),beforePause:(draft:Readonly<ChainDraft>)=>{if(reproductionState(draft).verdict?.status !== "not_reproduced")throw new PhaseValidationError(["Only not_reproduced can wait for missing reproduction facts"]);}}),
    "decision-answer-review":(draft:Readonly<ChainDraft>)=>({errors:decisionResolutionErrors(draft)}),
    "reproduction-finalize":Object.assign((draft:Readonly<ChainDraft>)=>({errors:completionErrors(draft,contract)}),{beforeComplete:(draft:ChainDraft)=>{const errors=inputErrors(draft,contract);if(errors.length)throw new PhaseValidationError(errors);},finalize:(draft:Readonly<ChainDraft>)=>completionErrors(draft,contract)}),
  };
}
export function compileReproductionConclusion(draft:Readonly<ChainDraft>,input:ReproductionContract){
  const contract=reproductionContractSchema.parse(input),errors=completionErrors(draft,contract);
  if(draft.definition.id !== reproductionProfile.id || draft.definition.agent !== reproductionProfile.agent || draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(Object.keys(draft.definition.phases)))errors.push("Reproduction is not completed");
  if(errors.length)throw new PhaseValidationError(errors);
  const value=reproductionState(draft),history=structuredClone(draft.reproduction?.history ?? []),report=["# Reproduction evidence",...Object.entries(value.verdict!).filter(([key])=>key !== "key").map(([key,content])=>`## ${key}\n\n${content}`),"## Steps",...value.steps.map(item=>JSON.stringify(item)),"## Evidence",...value.evidence.map(item=>JSON.stringify(item)),"## Investigation hypotheses (not implementation obligations)",...value.hypotheses.map(item=>JSON.stringify(item)),"## Answer review",value.answerReview,...(history.length ? ["## Prior investigation observations",...history.map(item=>JSON.stringify(item))] : [])].join("\n\n");
  return {kind:"reproduction" as const,draftId:draft.id,attemptId:draft.attemptId,sequence:draft.sequence,binding:structuredClone(draft.binding),contextRef:contract.contextRef,contextFingerprint:contract.contextFingerprint,...value,history,decisions:structuredClone(draft.decisions ?? []),report};
}
