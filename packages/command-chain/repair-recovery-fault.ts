import {z} from "zod";
import {repairProgressHash} from "./repair-progress";

const text=z.string().min(1),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const repairRecoveryPreparationSchema=z.strictObject({observation_id:text,receipt_hash:hash,source_attempt_id:text,bindings_hash:hash});
const fields=z.strictObject({
 hash,case_id:text,verification_attempt_id:text,target_hash:hash,application_hash:hash,ready_hash:hash,publication_hash:hash,
 entry_task_id:z.uuid(),task_id:z.uuid(),attempt_id:text,execution_hint_hash:hash.nullable(),workspace_id:z.uuid(),issue_id:z.uuid(),project_id:z.uuid(),runtime_id:z.uuid(),agent_id:z.uuid(),user_id:z.uuid(),
 preparation:repairRecoveryPreparationSchema.optional(),checkpoint_hash:hash,status:z.enum(["completed","failed"]),completed_at:z.iso.datetime({offset:true}),failure_reason:text.nullable(),context_hash:hash,
});
export type RepairRecoveryFault=z.infer<typeof fields>;
export function repairRecoveryFaultHash(p:Omit<RepairRecoveryFault,"hash">){return repairProgressHash([
 p.preparation?"multica:repair-recovery-fault:2":"multica:repair-recovery-fault:1",p.case_id,p.verification_attempt_id,p.target_hash,p.application_hash,p.ready_hash,p.publication_hash,p.entry_task_id,p.task_id,p.attempt_id,p.execution_hint_hash??"",
 p.workspace_id,p.issue_id,p.project_id,p.runtime_id,p.agent_id,p.user_id,p.checkpoint_hash,p.status,p.completed_at,p.failure_reason??"",p.context_hash,...(p.preparation?[p.preparation.observation_id,p.preparation.receipt_hash,p.preparation.source_attempt_id,p.preparation.bindings_hash]:[]),
]);}
export const repairRecoveryFaultSchema=fields.superRefine((p,ctx)=>{
 if(repairRecoveryFaultHash(p)!==p.hash||!p.attempt_id.startsWith(p.task_id+":")||p.preparation&&(p.task_id!==p.entry_task_id||p.execution_hint_hash!==null||p.preparation.source_attempt_id===p.attempt_id))ctx.addIssue({code:"custom",message:"Native recovery fault identity changed"});
});
