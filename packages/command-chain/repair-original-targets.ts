import { z } from "zod";
import { businessContractSchema, businessProfiles } from "./business";
import { planningContractSchema } from "./planning";
import { contextContractSchema } from "./context";
import { reproductionContractSchema } from "./reproduction";
import { reviewContractSchema } from "./review";
import { feedbackTriageContractSchema,feedbackVerifyContractSchema } from "./feedback";

const text=z.string().trim().min(1);
/** Explicit native contracts define obligations; never accept an unknown shape
 * as generic input or inherit a repairer's replacement acceptance. */
export function checkpointRepairTargets(chain:string,raw:Record<string,unknown>):{key:string;original:unknown}[]{
  if(chain==="direct")return [{key:"original-input",original:z.object({direct:z.object({input:text})}).parse(raw).direct.input}];
  const source=z.object({contract:z.unknown()}).parse(raw);
  if(["analysis","development","verification"].includes(chain)){
    const contract=z.object({sources:z.array(z.object({key:text,oracle:text}).passthrough()).min(1)}).parse(source.contract);
    return contract.sources.map(item=>({key:`source:${item.key}`,original:item}));
  }
  if(chain==="planning"){
    const contract=planningContractSchema.parse(source.contract);
    return [...contract.sources.map(original=>({key:`source:${original.key}`,original})),
      ...(contract.reproduction?[{key:"reproduction-conclusion",original:contract.reproduction}]:[]),
      ...(contract.feedback?[{key:"feedback-group",original:contract.feedback.group},{key:"feedback-context",original:contract.feedback.context},...contract.feedback.comments.map(original=>({key:`feedback-comment:${original.id}`,original})),...contract.feedback.units.map(original=>({key:`feedback-unit:${original.key}`,original}))]:[])];
  }
  const stage=Object.entries(businessProfiles).find(([,profile])=>profile.id===chain)?.[0];
  if(stage){
    const contract=businessContractSchema.parse(source.contract);
    const business=z.object({business:z.object({originalInput:text,stage:text,upstream:z.array(z.record(z.string(),z.unknown())),previous:z.unknown(),returnReason:z.unknown(),comments:z.array(z.record(z.string(),z.unknown()))})}).parse(raw).business;
    if(contract.stage!==stage||business.stage!==stage)throw new Error("Original business stage identity changed");
    return [{key:"original-input",original:business.originalInput},
      ...business.upstream.map((original,index)=>({key:`upstream:${index}`,original})),
      ...(business.previous?[{key:"previous-stage",original:business.previous}]:[]),
      ...(business.returnReason?[{key:"return-reason",original:business.returnReason}]:[]),
      ...business.comments.map((original,index)=>({key:`specification-comment:${index}`,original}))];
  }
  if(chain==="context"){
    const contract=contextContractSchema.parse(source.contract);
    return [{key:"original-input",original:contract.input},...(contract.businessSource?[{key:"approved-business-source",original:contract.businessSource}]:[])];
  }
  if(chain==="reproduction"){
    const contract=reproductionContractSchema.parse(source.contract);
    return [{key:"existing-expected",original:contract.expectedBehavior},{key:"frozen-context",original:{ref:contract.contextRef,fingerprint:contract.contextFingerprint,content:contract.contextContent}}];
  }
  if(chain==="review"){
    const contract=reviewContractSchema.parse(source.contract);
    return [...contract.subjects.map(original=>({key:`subject:${original.key}`,original})),
      ...contract.evidence.map(original=>({key:`evidence:${original.ref}`,original})),
      ...(contract.correction?[{key:"report-correction",original:contract.correction}]:[])];
  }
  if(chain==="feedback-triage"){
    const contract=feedbackTriageContractSchema.parse(source.contract);
    return [{key:"frozen-context",original:contract.context},
      ...contract.comments.map(original=>({key:`comment:${original.id}`,original})),
      ...contract.units.map(original=>({key:`delivery-unit:${original.key}`,original})),
      ...contract.previousFeedback.map((original,index)=>({key:`previous-feedback:${index}`,original}))];
  }
  if(chain==="feedback-verify"){
    const contract=feedbackVerifyContractSchema.parse(source.contract);
    return [{key:`comment:${contract.comment.id}`,original:contract.comment},
      {key:"accepted-work",original:contract.work},{key:"frozen-context",original:contract.context},
      ...contract.group.acceptance.map((original,index)=>({key:`feedback-acceptance:${index}`,original}))];
  }
  throw new Error("Original repair checkpoint uses an unsupported native contract");
}
