import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readRepairWorkspaceVersion } from "../repair-workspace-version";
import { repairHandoffTargetSchema } from "../repair-handoff";

/** Synthetic host proof for the business-store layer; native receipt compilation
 * and authorization are exercised by the management and PostgreSQL tests. */
export async function hostHandoffTargetFixture(raw:unknown,scope:{workspaceId:string;issueId:string;projectId:string;repositoryPath:string;caseId:string}){
 const original=z.object({observationId:z.string(),snapshotHash:z.string(),receiptHash:z.string(),attemptId:z.string()}).parse(raw);
 return repairHandoffTargetSchema.parse({caseId:scope.caseId,verificationAttemptId:"verified-native-checks",sourceRepairAttemptId:"repair",sourcePreparationAttemptId:"independent-test",receiptHash:"a".repeat(64),inputHash:"b".repeat(64),nativeCandidateHash:"c".repeat(64),planHash:"d".repeat(64),expectedVersion:await readRepairWorkspaceVersion(scope.repositoryPath),workspaceBinding:{workspaceId:scope.workspaceId,issueId:scope.issueId,projectId:scope.projectId,runtimeId:randomUUID(),workspaceRoot:scope.repositoryPath,executionPath:scope.repositoryPath,mode:"in_place",sourceAttemptId:original.attemptId,snapshotHash:original.snapshotHash,targetsHash:"e".repeat(64)},originalObservationIds:[original.observationId],observationId:original.observationId,snapshotHash:original.snapshotHash,sourceReceiptHash:original.receiptHash});
}
