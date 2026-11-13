import { parse, stringify } from "yaml";
import { z } from "zod";
import { draftSchema, PhaseValidationError, type ChainDraft, type BuiltinHandlers } from "./runtime";
import type { CommandChainProfile } from "./definition";
import {feedbackWorkScopeSchema} from "./feedback";

const text=z.string().trim().min(1);
export const planningSourceSchema=z.strictObject({key:text.max(240),kind:z.enum(["change","preserve","technical","acceptance"]),content:text.max(4000),sourceRef:text.max(500),oracle:text.max(4000).optional()});
export const planningContractSchema=z.strictObject({binding:draftSchema.shape.binding,sources:z.array(planningSourceSchema).min(1),existingKeys:z.array(text).default([]),feedback:feedbackWorkScopeSchema.optional(),reproduction:z.strictObject({draftId:text,sequence:z.number().int().nonnegative(),codeVersion:text,report:text}).optional()})
  .refine(value=>new Set(value.sources.map(item=>item.key)).size === value.sources.length,"Planning source keys must be unique");
export type PlanningContract=z.infer<typeof planningContractSchema>;
export const planningProfile:CommandChainProfile={id:"delivery-plan",agent:"story-splitter-agent",requiredBuiltins:["delivery-plan-inputs","delivery-plan-finalize"],builtins:{"delivery-plan-inputs":{acceptsArtifacts:false},"delivery-plan-finalize":{acceptsArtifacts:false}},metadataKeys:[],repositoryAdapters:[]};
const unitSchema=z.object({title:text.max(200),actor:text.max(500),trigger:text.max(4000),observableOutcome:text.max(4000),acceptance:text.max(4000),sourceRefs:z.array(text.max(240)).min(1).max(200),dependsOn:z.array(text.max(120)).max(50).default([])});
function units(draft:Readonly<ChainDraft>){return draft.artifacts.filter(item=>item.ref === "delivery-plan.units").map(item=>({key:item.key,...unitSchema.parse(parse(item.content))}));}
function one(draft:Readonly<ChainDraft>,block:string){return draft.artifacts.find(item=>item.ref === `delivery-plan.${block}`)?.content ?? "";}
function inputErrors(draft:Readonly<ChainDraft>,contract:PlanningContract){
  const errors=JSON.stringify(draft.binding) === JSON.stringify(contract.binding) ? [] : ["Frozen planning binding changed"];
  const projected=draft.artifacts.filter(item=>item.ref === "delivery-plan.sources");
  if(projected.length !== contract.sources.length || contract.sources.some(({key,oracle:_oracle,...value})=>projected.find(item=>item.key === key)?.content !== stringify(value).trim()))errors.push("Frozen planning sources differ from the contract");
  return errors;
}
function planErrors(draft:Readonly<ChainDraft>,contract:PlanningContract){
  const values=units(draft),errors=inputErrors(draft,contract),byKey=new Map(values.map(item=>[item.key,item]));
  if(!one(draft,"rationale"))errors.push("Planning rationale is missing");
  if(!one(draft,"coverage"))errors.push("Overall coverage explanation is missing");
  if(!values.length || values.length>50)errors.push("Plan requires 1 to 50 delivery units");
  if(values.length>1 && !one(draft,"ordering"))errors.push("Multiple units require ordering and dependency rationale");
  if(new Set(values.map(item=>item.title)).size !== values.length)errors.push("Delivery unit titles must be unique");
  for(const [index,item] of values.entries()){
    if(item.key.length>120 || contract.existingKeys.includes(item.key))errors.push(`Delivery unit ${item.key} is invalid or already exists`);
    if(new Set(item.sourceRefs).size !== item.sourceRefs.length || new Set(item.dependsOn).size !== item.dependsOn.length)errors.push(`Delivery unit ${item.key} repeats source/dependency keys`);
    for(const key of item.sourceRefs)if(!contract.sources.some(source=>source.key === key))errors.push(`Delivery unit ${item.key} refers to unknown source ${key}`);
    if(!item.sourceRefs.some(key=>contract.sources.some(source=>source.key === key && ["change","acceptance"].includes(source.kind))))errors.push(`Delivery unit ${item.key} needs a change or acceptance`);
    for(const dependency of item.dependsOn){const parent=values.findIndex(value=>value.key === dependency);if(parent<0 || parent>=index)errors.push(`Dependency ${dependency} must exist and precede ${item.key}`);}
  }
  for(const source of contract.sources)if(!values.some(item=>item.sourceRefs.includes(source.key)))errors.push(`Planning source ${source.key} is uncovered`);
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(key:string):boolean=>{if(visiting.has(key))return true;if(visited.has(key))return false;visiting.add(key);const cycle=Boolean(byKey.get(key)?.dependsOn.some(visit));visiting.delete(key);visited.add(key);return cycle;};
  if(values.some(item=>visit(item.key)))errors.push("Delivery dependencies must be acyclic");
  return errors;
}
export function createPlanningHandlers(input:PlanningContract):BuiltinHandlers{
  const contract=planningContractSchema.parse(input);
  return {
    "delivery-plan-inputs":draft=>({errors:draft.artifacts.some(item=>item.ref === "delivery-plan.sources") ? inputErrors(draft,contract) : [],
      artifacts:contract.sources.map(({key,oracle:_oracle,...value})=>({ref:"delivery-plan.sources",key,content:stringify(value).trim()})),freeze:["delivery-plan.sources"]}),
    "delivery-plan-finalize":Object.assign((draft:Readonly<ChainDraft>)=>({errors:planErrors(draft,contract)}),{finalize:(draft:Readonly<ChainDraft>)=>planErrors(draft,contract)}),
  };
}
export function compilePlanningConclusion(draft:Readonly<ChainDraft>,input:PlanningContract){
  const contract=planningContractSchema.parse(input),errors=planErrors(draft,contract);
  if(draft.definition.id !== planningProfile.id || draft.definition.agent !== planningProfile.agent || draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(Object.keys(draft.definition.phases)))errors.push("Delivery planning is not completed");
  if(errors.length)throw new PhaseValidationError(errors);
  return {kind:"delivery-plan" as const,draftId:draft.id,attemptId:draft.attemptId,sequence:draft.sequence,binding:structuredClone(draft.binding),rationale:one(draft,"rationale"),coverage:one(draft,"coverage"),ordering:one(draft,"ordering"),units:units(draft).map(item=>({...item,sourceRefs:item.sourceRefs.map(key=>{const {oracle:_oracle,...source}=contract.sources.find(source=>source.key === key)!;return source;})}))};
}
