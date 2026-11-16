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
export type HandoffYamlCheckpoint=Extract<z.infer<typeof handoffCheckpointSchema>,{kind:"yaml"}>;
export type HandoffRootChange={payload:string;sidecars?:{batchId:string;before:string;after:string}[]};
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

export const handoffApplicationBodySchema=z.strictObject({
  staged:z.literal(true),hold_retained:z.literal(true),target_hash:hash,preparation_hash:hash,reservation_hash:hash,
  root_kind:z.enum(["direct","business","requirement","engineering"]),continuation:handoffContinuationSchema,
  expected_version:repairContentVersionSchema,source_payload_hash:hash,applied_payload_hash:hash,source_hash:hash,sidecars_hash:hash,original_bindings_hash:hash,
  draft_id:text.nullable(),draft_hash:hash.nullable(),
});
export const handoffApplicationSchema=handoffApplicationBodySchema.extend({hash}).superRefine((value,ctx)=>{
  const {hash:actual,...body}=value;if(handoffHash(body)!==actual)ctx.addIssue({code:"custom",message:"Staged handoff receipt hash changed"});
  if(value.root_kind==="direct"?value.draft_id!==null||value.draft_hash!==null:value.draft_id===null||value.draft_hash===null)ctx.addIssue({code:"custom",message:"Staged draft identity differs from its workflow owner"});
});
export type HandoffApplication=z.infer<typeof handoffApplicationSchema>;
export const handoffReadyBodySchema=z.strictObject({ready:z.literal(true),target_hash:hash,reservation_hash:hash,application_hash:hash,expected_version:repairContentVersionSchema,continuation:handoffContinuationSchema});
export function handoffReadyHash(value:z.infer<typeof handoffReadyBodySchema>){const c=value.continuation,fields=["multica:repair-dispatch-ready:1",value.target_hash,value.reservation_hash,value.application_hash,value.expected_version,c.workspace_id,c.issue_id,c.agent_id,c.user_id,c.task_id,c.parent_issue_id??"",String(c.expected_revision),String(c.expected_sequence),c.reason],digest=createHash("sha256");for(const field of fields)digest.update(`${Buffer.byteLength(field,"utf8")}:${field}`,"utf8");return digest.digest("hex");}
export const handoffReadySchema=handoffReadyBodySchema.extend({hash}).superRefine((value,ctx)=>{if(handoffReadyHash(value)!==value.hash)ctx.addIssue({code:"custom",message:"Business dispatch readiness hash changed"});});
export type HandoffReady=z.infer<typeof handoffReadySchema>;
const publicationFields=z.strictObject({published:z.literal(true),hash,case_id:text,verification_attempt_id:text,target_hash:hash,reservation_hash:hash,application_hash:hash,ready_hash:hash,task_id:z.uuid(),workspace_id:z.uuid(),issue_id:z.uuid(),agent_id:z.uuid(),user_id:z.uuid(),runtime_id:z.uuid()});
export type HandoffPublication=z.infer<typeof publicationFields>;
export function handoffPublicationHash(value:Omit<HandoffPublication,"hash">){
 const fields=["multica:repair-handoff-publication:1",value.case_id,value.verification_attempt_id,value.target_hash,value.reservation_hash,value.application_hash,value.ready_hash,value.task_id,value.workspace_id,value.issue_id,value.agent_id,value.user_id,value.runtime_id],digest=createHash("sha256");
 for(const field of fields)digest.update(`${Buffer.byteLength(field,"utf8")}:${field}`,"utf8");return digest.digest("hex");
}
export const handoffPublicationSchema=publicationFields.superRefine((value,ctx)=>{if(handoffPublicationHash(value)!==value.hash)ctx.addIssue({code:"custom",message:"Native handoff publication hash changed"});});
