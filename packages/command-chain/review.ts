import { parse, stringify } from "yaml";
import { z } from "zod";
import type { CommandChainProfile } from "./definition";
import { draftSchema, PhaseValidationError, type BuiltinHandlers, type ChainDraft } from "./runtime";

const text=z.string().trim().min(1);
const subject=z.strictObject({key:text.max(240),kind:z.enum(["intent","target","expected","impact","acceptance","delivery_unit","feedback_acceptance"]),content:text,sourceRef:text.optional(),contractRef:text.optional(),storyIndex:text.optional(),requiredEvidenceRefs:z.array(text).min(1)});
const evidence=z.strictObject({ref:text.max(240),kind:text,status:text,revision:text,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),independentTest:z.boolean(),content:text});
export const reviewContractSchema=z.strictObject({binding:draftSchema.shape.binding,generation:z.number().int().positive(),subjects:z.array(subject).min(1),evidence:z.array(evidence).min(1)})
  .superRefine((value,ctx)=>{
    if(new Set(value.subjects.map(item=>item.key)).size !== value.subjects.length || new Set(value.evidence.map(item=>item.ref)).size !== value.evidence.length)ctx.addIssue({code:"custom",message:"Review subject and evidence identities must be unique"});
    for(const item of value.subjects)if(new Set(item.requiredEvidenceRefs).size !== item.requiredEvidenceRefs.length || item.requiredEvidenceRefs.some(ref=>!value.evidence.some(source=>source.ref === ref && source.independentTest && source.status === "passed")))ctx.addIssue({code:"custom",message:`Subject ${item.key} requires current independent passed verification references`});
  });
export type ReviewContract=z.infer<typeof reviewContractSchema>;
export const reviewProfile:CommandChainProfile={id:"review",agent:"review-agent",requiredBuiltins:["review-inputs","review-reconciliation","review-output","review-finalize"],builtins:{"review-inputs":{acceptsArtifacts:false},"review-reconciliation":{acceptsArtifacts:true},"review-output":{acceptsArtifacts:true},"review-finalize":{acceptsArtifacts:false}},metadataKeys:[],repositoryAdapters:[]};
const reconciliation=z.object({subjectRef:text,result:text,evidenceRefs:z.array(text).min(1)});
const gap=z.object({subjectRef:text,kind:z.enum(["missing_evidence","fact_conflict","unresolved_obligation"]),reason:text.max(4000),boundary:text.max(4000)});
const unit=z.object({title:text.max(200),actor:text.max(500),trigger:text.max(4000),observableOutcome:text.max(4000),acceptance:text.max(4000),gapKeys:z.array(text).min(1),dependsOn:z.array(text)});
function rows<T>(draft:Readonly<ChainDraft>,block:string,schema:z.ZodType<T>){return draft.artifacts.filter(item=>item.ref === `review.${block}`).map(item=>({key:item.key,...schema.parse(parse(item.content))}));}
function state(draft:Readonly<ChainDraft>){return {reconciliations:rows(draft,"reconciliations",reconciliation),gaps:rows(draft,"gaps",gap),units:rows(draft,"forward-units",unit),sections:rows(draft,"report-sections",z.object({kind:text,content:text})),assessment:rows(draft,"assessment",z.object({summary:text,evidenceBoundary:text,residualRisk:text.optional()}))[0]};}
function projections(contract:ReviewContract){return [
  ...contract.subjects.map(({key,requiredEvidenceRefs:_required,...value})=>({ref:"review.subjects",key,content:stringify(value).trim()})),
  ...contract.evidence.map(({content:_content,independentTest,...value})=>({ref:"review.evidence-sources",key:value.ref,content:stringify({...value,independentTest:independentTest ? "yes" : "no"}).trim()})),
  {ref:"review.meta",key:undefined,content:stringify({mode:"closure",totalStories:String(contract.evidence.filter(item=>item.independentTest).length),reviewRevision:String(contract.generation)}).trim()},
];}
function inputErrors(draft:Readonly<ChainDraft>,contract:ReviewContract){
  const errors=JSON.stringify(draft.binding) === JSON.stringify(contract.binding) ? [] : ["Frozen review binding changed"];
  const expected=projections(contract),actual=draft.artifacts.filter(item=>["review.subjects","review.evidence-sources","review.meta"].includes(item.ref));
  if(actual.length !== expected.length || expected.some(item=>actual.find(value=>value.ref === item.ref && value.key === (item.key ?? ""))?.content !== item.content))errors.push("Frozen review subjects, evidence or metadata changed");
  return errors;
}
function reconciliationErrors(draft:Readonly<ChainDraft>,contract:ReviewContract){
  const value=state(draft),errors=inputErrors(draft,contract),handled=new Map<string,number>();
  for(const row of [...value.reconciliations,...value.gaps]){
    if(!contract.subjects.some(item=>item.key === row.subjectRef))errors.push(`Unknown review subject ${row.subjectRef}`);
    handled.set(row.subjectRef,(handled.get(row.subjectRef) ?? 0)+1);
  }
  for(const item of contract.subjects)if(handled.get(item.key) !== 1)errors.push(`Subject ${item.key} requires exactly one reconciliation or gap`);
  for(const row of value.reconciliations){
    if(new Set(row.evidenceRefs).size !== row.evidenceRefs.length)errors.push(`Reconciliation ${row.key} repeats evidence references`);
    for(const ref of row.evidenceRefs)if(!contract.evidence.some(item=>item.ref === ref))errors.push(`Unknown frozen review evidence ${ref}`);
    const subject=contract.subjects.find(item=>item.key === row.subjectRef);
    if(subject?.requiredEvidenceRefs.some(ref=>!row.evidenceRefs.includes(ref)))errors.push(`Reconciliation ${row.key} omits independent verification for its subject scope`);
  }
  return errors;
}
function assessmentErrors(draft:Readonly<ChainDraft>){return state(draft).assessment ? [] : ["Requirement closure assessment and evidence boundary are required"];}
export function reviewGapSources(subjects:ReviewContract["subjects"],gaps:(z.infer<typeof gap> & {key:string})[],draftId:string){
  return gaps.flatMap(gap=>{
    const subject=subjects.find(item=>item.key === gap.subjectRef);if(!subject)throw new Error("Review gap subject is missing");
    const parts=Array.from({length:Math.ceil(subject.content.length/4000)},(_,index)=>({key:`gap:${gap.key}:subject:${index+1}`,kind:"change" as const,content:subject.content.slice(index*4000,(index+1)*4000),sourceRef:gap.subjectRef}));
    return [{key:`gap:${gap.key}:reason`,kind:"change" as const,content:gap.reason,sourceRef:gap.subjectRef},...parts,{key:`gap:${gap.key}:boundary`,kind:"acceptance" as const,content:gap.boundary,sourceRef:`REVIEW_GAP:${draftId}:${gap.key}`}];
  });
}
function outputErrors(draft:Readonly<ChainDraft>){
  const value=state(draft),errors:string[]=[];
  if(!value.gaps.length){
    if(value.units.length)errors.push("A report without closure gaps cannot add forward delivery units");
    const allowed=["outcome","scope","decisions","implementation","verification","deviations","risks","feedback"];
    for(const item of value.sections)if(item.key !== item.kind || !allowed.includes(item.kind))errors.push(`Report section ${item.key} must use its canonical kind`);
    for(const kind of ["outcome","scope","implementation","verification","risks"])if(!value.sections.some(item=>item.kind === kind))errors.push(`Required report section ${kind} is missing`);
  }else{
    if(value.sections.length)errors.push("Closure gaps and report sections are exclusive outputs");
    if(!value.units.length || value.units.length>50)errors.push("Closure gaps require 1 to 50 complete forward delivery units");
    const covered=value.units.flatMap(item=>item.gapKeys),keys=new Set(value.gaps.map(item=>item.key));
    for(const key of keys)if(covered.filter(item=>item === key).length !== 1)errors.push(`Closure gap ${key} must be covered exactly once`);
    if(covered.some(key=>!keys.has(key)))errors.push("Forward units reference an unknown closure gap");
    for(const item of value.units){
      if(new Set(item.dependsOn).size !== item.dependsOn.length || item.dependsOn.some(key=>key === item.key || !value.units.some(unit=>unit.key === key)))errors.push(`Forward unit ${item.key} has invalid dependencies`);
      const subjects=rows(draft,"subjects",subject.omit({key:true,requiredEvidenceRefs:true})).map(item=>({...item,requiredEvidenceRefs:["frozen"]}));
      if(reviewGapSources(subjects,value.gaps.filter(gap=>item.gapKeys.includes(gap.key)),draft.id).length>200)errors.push(`Forward unit ${item.key} exceeds the source limit; split its gap scope`);
    }
    const visiting=new Set<string>(),visited=new Set<string>();
    const visit=(key:string):boolean=>{if(visiting.has(key))return true;if(visited.has(key))return false;visiting.add(key);const cyclic=Boolean(value.units.find(item=>item.key === key)?.dependsOn.some(visit));visiting.delete(key);visited.add(key);return cyclic;};
    if(value.units.some(item=>visit(item.key)))errors.push("Forward delivery dependencies must be acyclic");
  }
  return errors;
}
function allErrors(draft:Readonly<ChainDraft>,contract:ReviewContract){return [...reconciliationErrors(draft,contract),...assessmentErrors(draft),...outputErrors(draft)];}
export function createReviewHandlers(input:ReviewContract):BuiltinHandlers{
  const contract=reviewContractSchema.parse(input);
  return {
    "review-inputs":draft=>({errors:draft.artifacts.some(item=>item.ref === "review.meta") ? inputErrors(draft,contract) : [],artifacts:projections(contract),freeze:["review.subjects","review.evidence-sources","review.meta"]}),
    "review-reconciliation":Object.assign((draft:Readonly<ChainDraft>)=>({errors:reconciliationErrors(draft,contract)}),{runtimeInputs:true}),
    "review-output":draft=>({errors:[...assessmentErrors(draft),...outputErrors(draft)]}),
    "review-finalize":Object.assign((draft:Readonly<ChainDraft>)=>({errors:allErrors(draft,contract)}),{finalize:(draft:Readonly<ChainDraft>)=>allErrors(draft,contract)}),
  };
}
export function compileReviewConclusion(draft:Readonly<ChainDraft>,input:ReviewContract){
  const contract=reviewContractSchema.parse(input),errors=allErrors(draft,contract);
  if(draft.definition.id !== reviewProfile.id || draft.definition.agent !== reviewProfile.agent || draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(Object.keys(draft.definition.phases)))errors.push("Requirement review is not completed");
  if(errors.length)throw new PhaseValidationError(errors);
  const value=state(draft),assessment=value.assessment!;
  const report=value.gaps.length ? null : ["# Requirement closure report",`Review ${contract.generation}`,assessment.summary,...value.sections.map(item=>`## ${item.kind}\n\n${item.content}`),`## Evidence boundary\n\n${assessment.evidenceBoundary}`,...(assessment.residualRisk ? [`## Residual risk\n\n${assessment.residualRisk}`] : [])].join("\n\n");
  return {kind:"requirement-review" as const,verdict:value.gaps.length ? "closure_gap" as const : "report_ready" as const,draftId:draft.id,sequence:draft.sequence,binding:structuredClone(draft.binding),generation:contract.generation,assessment,reconciliations:value.reconciliations,gaps:value.gaps,units:value.units,report};
}
