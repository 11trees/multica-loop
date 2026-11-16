import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { InterventionRecord } from "./intervention-store";
import { draftSchema,DraftConflictError } from "./runtime";
import { repairHandoffTargetSchema,handoffProposalSchema,handoffHash,handoffUUID,handoffPreparationSchema,type RepairHandoffTarget } from "./repair-handoff";
import type { EngineeringTeamBinding } from "./team-store";
import { prepareRepairSuccessor } from "./repair-successor";

export function initializeRepairHandoffs(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS engineering_repair_handoff(target_hash TEXT PRIMARY KEY,payload TEXT NOT NULL)");}
/** Prepare a successor without editing the surrendered root or releasing a hold. */
export function prepareRepairHandoff(db:DatabaseSync,original:InterventionRecord,raw:RepairHandoffTarget,root:{kind:"direct"|"business"|"requirement"|"engineering";payload:string;userId:string;parentIssueId?:string;teamBinding:EngineeringTeamBinding|null}){
  const target=repairHandoffTargetSchema.parse(raw),targetHash=handoffHash(target),source=target.workspaceBinding;
  if(original.workspaceId!==source.workspaceId||original.issueId!==source.issueId||original.observationId!==target.observationId||original.snapshotHash!==target.snapshotHash||original.receiptHash!==target.sourceReceiptHash||original.attemptId!==source.sourceAttemptId||!target.originalObservationIds.includes(original.observationId))throw new DraftConflictError("Handoff must pin the acknowledged original source");
  const payload=z.record(z.string(),z.unknown()).parse(JSON.parse(root.payload));
  const taskId=handoffUUID(`multica:repair-handoff:${target.caseId}:${target.verificationAttemptId}`),draftId=handoffUUID(`multica:repair-draft:${targetHash}`);
  const team=root.teamBinding;
  if(team&&(team.startedBy!==root.userId||team.projectId!==source.projectId||![...Object.values(team.profile.definition.roles),...Object.values(team.profile.definition.feedback??{})].includes(original.agentId)))throw new DraftConflictError("Repair handoff differs from the frozen Team policy");
  const checkpoint=original.chain==="direct"?(()=>{
    const version=z.number().int().nonnegative().parse(payload.version);
    if(version!==original.sequence)throw new DraftConflictError("Direct changed before handoff preparation");
    return {kind:"direct" as const,originalVersion:version,nextVersion:version+1};
  })():(()=>{
    const frozen=z.object({draft:draftSchema,contract:z.record(z.string(),z.unknown())}).parse(original.snapshot);
    if(frozen.draft.status!=="editing"||frozen.draft.runtimeInputs.some(input=>input.active&&input.answer===null))throw new DraftConflictError("Handoff cannot bypass unresolved input or a terminal checkpoint");
    const binding={...frozen.draft.binding,codeVersion:target.expectedVersion.split(":")[1]!,contractVersion:handoffHash({original:frozen.draft.binding.contractVersion,repair:targetHash})};
    const successor=prepareRepairSuccessor(frozen.draft,frozen.contract,binding,draftId,`repair-handoff:${targetHash}`);
    return {kind:"yaml" as const,originalDraftId:frozen.draft.id,...successor};
  })();
  const proposal=handoffProposalSchema.parse({target,targetHash,rootKind:root.kind,sourcePayload:root.payload,sourcePayloadHash:handoffHash(root.payload),teamBinding:team,checkpoint,continuation:{workspace_id:original.workspaceId,issue_id:original.issueId,agent_id:original.agentId,user_id:root.userId,task_id:taskId,...(root.parentIssueId?{parent_issue_id:root.parentIssueId}:{}),expected_revision:original.revision,expected_sequence:checkpoint.kind==="direct"?checkpoint.nextVersion:checkpoint.draft.sequence,reason:"repair_ready"}});
  const encoded=JSON.stringify(proposal),prior=db.prepare("SELECT payload FROM engineering_repair_handoff WHERE target_hash=?").get(targetHash);
  if(prior&&String(prior.payload)!==encoded)throw new DraftConflictError("Prepared handoff source or successor cannot be replaced");
  if(!prior)db.prepare("INSERT INTO engineering_repair_handoff VALUES(?,?)").run(targetHash,encoded);
  return handoffPreparationSchema.parse({prepared:true,hash:handoffHash(proposal),target_hash:targetHash,continuation:proposal.continuation,kind:checkpoint.kind,draft_id:checkpoint.kind==="yaml"?checkpoint.draft.id:null});
}
