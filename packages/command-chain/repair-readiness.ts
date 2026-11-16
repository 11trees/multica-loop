import {z} from "zod";
import {repairReadinessSchema} from "./repair-watch";
import {repairProgressHash} from "./repair-progress";

const hash=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().min(1);
const fields=z.strictObject({hash,case_id:text,verification_attempt_id:text,target_hash:hash,publication_hash:hash,workspace_id:z.uuid(),issue_id:z.uuid(),project_id:z.uuid(),runtime_id:z.uuid(),task_id:z.uuid().nullable(),business_hash:hash,source_key:hash,readiness:repairReadinessSchema,reason:text,observed_at:z.number().int().nonnegative()});
export type RepairReadinessObservation=z.infer<typeof fields>;
export function repairReadinessObservationHash(p:Omit<RepairReadinessObservation,"hash">){return repairProgressHash(["multica:repair-readiness:1",p.case_id,p.verification_attempt_id,p.target_hash,p.publication_hash,p.workspace_id,p.issue_id,p.project_id,p.runtime_id,p.task_id??"",p.business_hash,p.source_key,p.readiness,p.reason,String(p.observed_at)]);}
export const repairReadinessObservationSchema=fields.superRefine((p,ctx)=>{if(repairReadinessObservationHash(p)!==p.hash||p.readiness==="runnable"&&p.task_id===null)ctx.addIssue({code:"custom",message:"Native readiness identity changed"});});
