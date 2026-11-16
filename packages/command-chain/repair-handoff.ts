import { createHash } from "node:crypto";
import { z } from "zod";
import { repairVerificationInputSchema,repairContentVersionSchema } from "./repair-verification-input";
import { draftSchema } from "./runtime";
import { teamBindingSchema } from "./team-store";

const text=z.string().trim().min(1),hash=text.regex(/^[a-f0-9]{64}$/);
export const repairHandoffTargetSchema=z.strictObject({
  caseId:text,verificationAttemptId:text,sourceRepairAttemptId:text,sourcePreparationAttemptId:text,
  receiptHash:hash,inputHash:hash,nativeCandidateHash:hash,planHash:hash,expectedVersion:repairContentVersionSchema,
  workspaceBinding:repairVerificationInputSchema.shape.workspaceBinding,originalObservationIds:z.array(text).min(1),
  observationId:text,snapshotHash:text,sourceReceiptHash:text,
});
export type RepairHandoffTarget=z.infer<typeof repairHandoffTargetSchema>;
export const handoffContinuationSchema=z.strictObject({workspace_id:z.uuid(),issue_id:z.uuid(),agent_id:z.uuid(),user_id:z.uuid(),task_id:z.uuid(),parent_issue_id:z.uuid().optional(),expected_revision:z.number().int().positive(),expected_sequence:z.number().int().nonnegative(),reason:z.literal("repair_ready")});
export const handoffPreparationSchema=z.strictObject({prepared:z.literal(true),hash,target_hash:hash,continuation:handoffContinuationSchema,kind:z.enum(["direct","yaml"]),draft_id:z.string().nullable()});
export const handoffCheckpointSchema=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("direct"),originalVersion:z.number().int().nonnegative(),nextVersion:z.number().int().positive()}),
  z.strictObject({kind:z.literal("yaml"),originalDraftId:text,draft:draftSchema,contract:z.record(z.string(),z.unknown())}),
]);
export const handoffProposalSchema=z.strictObject({target:repairHandoffTargetSchema,targetHash:hash,rootKind:z.enum(["direct","business","requirement","engineering"]),sourcePayload:text,sourcePayloadHash:hash,teamBinding:teamBindingSchema.nullable(),checkpoint:handoffCheckpointSchema,continuation:handoffContinuationSchema});
export const handoffHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function handoffUUID(value:string){const h=handoffHash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}

const reservationFields=z.strictObject({
  reserved:z.literal(true),hash,case_id:text,verification_attempt_id:text,target_hash:hash,preparation_hash:hash,
  project_id:z.uuid(),expected_version:repairContentVersionSchema,continuation:handoffContinuationSchema,
  fence:z.strictObject({attempt_id:text,generation:z.number().int().positive(),owner_id:text,supervision_token:z.number().int().positive(),intent_revision:z.number().int().positive(),observation_id:text,source_attempt_id:text,source_revision:z.number().int().positive(),snapshot_hash:text,workspace_path:text,targets_hash:hash}),
});
export type HandoffReservation=z.infer<typeof reservationFields>;
/** Length-prefixed UTF-8 fields have the same representation in the native host. */
export function handoffReservationHash(value:Omit<HandoffReservation,"hash">){
  const c=value.continuation,f=value.fence;
  const fields=["multica:repair-handoff-reservation:1",value.case_id,value.verification_attempt_id,value.target_hash,value.preparation_hash,value.project_id,value.expected_version,
    c.workspace_id,c.issue_id,c.agent_id,c.user_id,c.task_id,c.parent_issue_id??"",c.expected_revision,c.expected_sequence,c.reason,
    f.attempt_id,f.generation,f.owner_id,f.supervision_token,f.intent_revision,f.observation_id,f.source_attempt_id,f.source_revision,f.snapshot_hash,f.workspace_path,f.targets_hash];
  const digest=createHash("sha256");
  for(const field of fields){const text=String(field);digest.update(`${Buffer.byteLength(text,"utf8")}:${text}`,"utf8");}
  return digest.digest("hex");
}
export const handoffReservationSchema=reservationFields.superRefine((value,ctx)=>{
  if(handoffReservationHash(value)!==value.hash)ctx.addIssue({code:"custom",message:"Native handoff reservation hash changed"});
});
