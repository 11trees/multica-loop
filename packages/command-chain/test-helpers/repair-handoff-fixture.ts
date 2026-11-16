import {repairRecoveryFaultHash,repairRecoveryFaultSchema,repairRecoveryPreparationSchema} from "../repair-recovery-fault";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readRepairWorkspaceVersion } from "../repair-workspace-version";
import { repairHandoffTargetSchema, handoffPreparationSchema, handoffReservationHash, handoffReservationSchema } from "../repair-handoff";

/** Synthetic host proof for the business-store layer; native receipt compilation
 * and authorization are exercised by the management and PostgreSQL tests. */
export async function hostHandoffTargetFixture(raw:unknown,scope:{workspaceId:string;issueId:string;projectId:string;repositoryPath:string;caseId:string}){
 const original=z.object({observationId:z.string(),snapshotHash:z.string(),receiptHash:z.string(),attemptId:z.string()}).parse(raw);
 return repairHandoffTargetSchema.parse({caseId:scope.caseId,verificationAttemptId:"verified-native-checks",sourceRepairAttemptId:"repair",sourcePreparationAttemptId:"independent-test",receiptHash:"a".repeat(64),inputHash:"b".repeat(64),nativeCandidateHash:"c".repeat(64),planHash:"d".repeat(64),expectedVersion:await readRepairWorkspaceVersion(scope.repositoryPath),workspaceBinding:{workspaceId:scope.workspaceId,issueId:scope.issueId,projectId:scope.projectId,runtimeId:randomUUID(),workspaceRoot:scope.repositoryPath,executionPath:scope.repositoryPath,mode:"in_place",sourceAttemptId:original.attemptId,snapshotHash:original.snapshotHash,targetsHash:"e".repeat(64)},originalObservationIds:[original.observationId],observationId:original.observationId,snapshotHash:original.snapshotHash,sourceReceiptHash:original.receiptHash});
}
/** Synthetic native receipt for business-store tests; the real private API has independent PostgreSQL tests. */
export function hostHandoffReservationFixture(raw:unknown,preparation:unknown){
 const target=repairHandoffTargetSchema.parse(raw),prepared=handoffPreparationSchema.parse(preparation),b=target.workspaceBinding;
 const value={reserved:true as const,case_id:target.caseId,verification_attempt_id:target.verificationAttemptId,target_hash:prepared.target_hash,preparation_hash:prepared.hash,project_id:b.projectId,expected_version:target.expectedVersion,continuation:prepared.continuation,
  fence:{attempt_id:target.verificationAttemptId,generation:3,owner_id:"host-fixture",supervision_token:1,intent_revision:1,observation_id:target.observationId,source_attempt_id:b.sourceAttemptId,source_revision:prepared.continuation.expected_revision,snapshot_hash:target.snapshotHash,workspace_path:b.workspaceRoot,targets_hash:b.targetsHash}};
 return handoffReservationSchema.parse({...value,hash:handoffReservationHash(value)});
}

/** Synthetic native terminal facts for the business-store layer only. */
export function hostRecoveryFaultFixture(raw:unknown,actualAttemptId?:string){
 const c=z.object({case_id:z.string(),verification_attempt_id:z.string(),target_hash:z.string(),application_hash:z.string(),ready_hash:z.string(),entry_task_id:z.string(),task_id:z.string(),attempt_id:z.string().nullable(),preparation:repairRecoveryPreparationSchema.optional(),execution_hint_hash:z.string().nullable(),workspace_id:z.string(),issue_id:z.string(),project_id:z.string(),runtime_id:z.string(),agent_id:z.string(),user_id:z.string(),hash:z.string()}).parse(raw);
 const {hash:checkpoint_hash,...scope}=c,body={...scope,attempt_id:actualAttemptId??c.attempt_id!,publication_hash:"1".repeat(64),checkpoint_hash,status:"failed" as const,completed_at:"2026-11-16T10:00:00Z",failure_reason:"Controlled native failure",context_hash:"2".repeat(64)};
 return repairRecoveryFaultSchema.parse({...body,hash:repairRecoveryFaultHash(body)});
}
