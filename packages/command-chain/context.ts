import { parse, stringify } from "yaml";
import { z } from "zod";
import { applyDecisionCommand, decisionGraphErrors, decisionModeSchema, decisionResolutionErrors } from "./decisions";
import { PhaseValidationError, draftSchema, type BuiltinHandlers, type ChainDraft, type ChainCommand } from "./runtime";
import type { CommandChainProfile } from "./definition";

import { businessSourceSchema } from "./end-to-end";

const text=z.string().trim().min(1);
export const contextContractSchema=z.strictObject({binding:draftSchema.shape.binding,input:text.max(40000),kind:z.enum(["requirement","bug"]),businessSource:businessSourceSchema.optional(),decisionMode:decisionModeSchema});
export type ContextContract=z.infer<typeof contextContractSchema>;
export const contextProfile:CommandChainProfile={id:"requirement-context",agent:"backlog-agent",requiredBuiltins:["decision-proposal","decision-resolution","decision-answer-review","acceptance-definition","requirement-context-finalize"],
  builtins:{"decision-proposal":{acceptsArtifacts:false},"decision-resolution":{acceptsArtifacts:false},"decision-answer-review":{acceptsArtifacts:true},"acceptance-definition":{acceptsArtifacts:true,allowsReadonlyArtifacts:true},"requirement-context-finalize":{acceptsArtifacts:false}},metadataKeys:[],repositoryAdapters:[]};
const assertion=z.object({perspective:z.enum(["actual","expected","target"]),statement:text,evidence:z.enum(["observed","reported","inferred","decided","conflicted"]),source:text,decision:text.optional()});
const impact=z.object({statement:text.max(4000),disposition:z.enum(["change","preserve","technical","needs_decision"]),rationale:text,source:text,decision:text.optional()});
function rows<T>(draft:Readonly<ChainDraft>,block:string,schema:z.ZodType<T>){return draft.artifacts.filter(item=>item.ref === `requirement-context.${block}`).map(item=>({key:item.key,...schema.parse(parse(item.content))}));}
function one(draft:Readonly<ChainDraft>,block:string){return draft.artifacts.find(item=>item.ref === `requirement-context.${block}`)?.content ?? "";}
function contextState(draft:Readonly<ChainDraft>){return {
  intent:one(draft,"intent"),assertions:rows(draft,"assertions",assertion),changeSummary:one(draft,"change-summary"),impacts:rows(draft,"impacts",impact),
  scope:rows(draft,"scope",z.object({direction:z.enum(["included","excluded"]),content:text})),constraints:rows(draft,"constraints",z.object({content:text})),acceptances:draft.acceptances ?? [],answerReview:one(draft,"answer-review"),
};}
function bindingErrors(draft:Readonly<ChainDraft>,contract:ContextContract){return JSON.stringify(draft.binding) === JSON.stringify(contract.binding) ? [] : ["Frozen requirement context binding changed"];}
function contextErrors(draft:Readonly<ChainDraft>,contract:ContextContract){
  const state=contextState(draft),errors=[...bindingErrors(draft,contract),...decisionResolutionErrors(draft)];
  const reliable=state.assertions.filter(item=>!["inferred","conflicted"].includes(item.evidence));
  if(!state.intent)errors.push("Business intent is missing");
  if(!reliable.some(item=>item.perspective === "actual"))errors.push("Reliable AS-IS Actual is missing");
  if(contract.kind === "bug" && !reliable.some(item=>item.perspective === "expected"))errors.push("Bug requires reliable Existing Expected");
  if(!reliable.some(item=>item.perspective === "target"))errors.push("Reliable TO-BE Target is missing");
  if(state.assertions.some(item=>item.evidence === "conflicted"))errors.push("Conflicting assertions remain unresolved");
  if(!state.changeSummary)errors.push("Change summary is missing");
  if(!state.impacts.length)errors.push("At least one business impact is required");
  if(state.impacts.some(item=>item.disposition === "needs_decision"))errors.push("Unresolved needs_decision impacts remain");
  if(!state.scope.some(item=>item.direction === "included"))errors.push("At least one included scope is required");
  if(!state.acceptances.length)errors.push("At least one requirement acceptance is required");
  for(const item of [...state.assertions,...state.impacts])if(item.decision && !draft.decisions?.some(node=>node.key === item.decision))errors.push(`${item.key} refers to a missing decision`);
  if(!state.answerReview)errors.push("Answer review is missing");
  const projected=draft.artifacts.filter(item=>item.ref === "requirement-context.acceptance");
  if(projected.length !== state.acceptances.length || state.acceptances.some(({key,...value})=>projected.find(item=>item.key === key)?.content !== stringify(value).trim()))errors.push("Acceptance projection differs from its entities");
  return errors;
}
export function createContextHandlers(input:ContextContract):BuiltinHandlers{
  const contract=contextContractSchema.parse(input);
  const decide=(allowed:string[])=>(draft:ChainDraft,command:ChainCommand)=>{if(!allowed.includes(command.type))throw new Error("Decision command is outside the current phase");applyDecisionCommand(draft,command,contract.decisionMode);};
  return {
    "decision-proposal":Object.assign((draft:Readonly<ChainDraft>)=>({errors:decisionGraphErrors(draft.decisions ?? [])}),{command:decide(["decision.propose","decision.remove"]),rewind:(draft:ChainDraft,to:string)=>{
      const order=Object.keys(draft.definition.phases);if(order.indexOf(to)<=order.indexOf("decision_proposal"))for(const node of draft.decisions ?? []){node.status="proposed";delete node.resolution;}
    }}),
    "decision-resolution":Object.assign((draft:Readonly<ChainDraft>)=>({errors:decisionResolutionErrors(draft)}),{runtimeInputs:true,command:decide(["decision.ask","decision.resolve","decision.reopen"])}),
    "decision-answer-review":(draft:Readonly<ChainDraft>)=>({errors:decisionResolutionErrors(draft)}),
    "acceptance-definition":Object.assign((draft:Readonly<ChainDraft>)=>({errors:draft.acceptances?.length ? [] : ["At least one requirement acceptance is required"],
      artifacts:(draft.acceptances ?? []).map(({key,...value})=>({ref:"requirement-context.acceptance",key,content:stringify(value).trim()})),freeze:["requirement-context.acceptance"]}),{
      command:(draft:ChainDraft,command:ChainCommand)=>{
        const values=draft.acceptances ??= [];
        if(command.type === "acceptance.put"){const index=values.findIndex(item=>item.key === command.acceptance.key);if(index<0)values.push(command.acceptance);else values[index]=command.acceptance;}
        else if(command.type === "acceptance.remove"){if(!values.some(item=>item.key === command.key))throw new Error("Acceptance is missing");draft.acceptances=values.filter(item=>item.key !== command.key);}
        else throw new Error("Only acceptance put/remove are allowed here");
        draft.artifacts=draft.artifacts.filter(item=>item.ref !== "requirement-context.acceptance");
      },rewind:(draft:ChainDraft,to:string)=>{const order=Object.keys(draft.definition.phases);if(order.indexOf(to)<=order.indexOf("acceptance"))draft.artifacts=draft.artifacts.filter(item=>item.ref !== "requirement-context.acceptance");if(order.indexOf(to)<order.indexOf("acceptance"))draft.acceptances=[];},
    }),
    "requirement-context-finalize":Object.assign((draft:Readonly<ChainDraft>)=>({errors:contextErrors(draft,contract)}),{beforeComplete:(draft:ChainDraft)=>{const errors=bindingErrors(draft,contract);if(errors.length)throw new PhaseValidationError(errors);},finalize:(draft:Readonly<ChainDraft>)=>contextErrors(draft,contract)}),
  };
}
export function compileContextConclusion(draft:Readonly<ChainDraft>,input:ContextContract){
  const contract=contextContractSchema.parse(input),errors=contextErrors(draft,contract);
  if(draft.definition.id !== contextProfile.id || draft.definition.agent !== contextProfile.agent || draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(Object.keys(draft.definition.phases)))errors.push("Requirement context is not completed");
  if(errors.length)throw new PhaseValidationError(errors);
  return {kind:"requirement-context" as const,draftId:draft.id,attemptId:draft.attemptId,sequence:draft.sequence,binding:structuredClone(draft.binding),...(contract.businessSource ? {businessSource:structuredClone(contract.businessSource)} : {}),...contextState(draft),decisions:structuredClone(draft.decisions ?? [])};
}
