import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {InterventionStore,type InterventionRecord} from "./intervention-store";
import { draftSchema, DraftConflictError } from "./runtime";
import { EngineeringTeamStore } from "./team-store";
import { handoffHash, handoffProposalSchema, handoffReservationSchema, handoffApplicationSchema, handoffApplicationBodySchema, handoffPreparationSchema, type HandoffReservation, type HandoffRootChange } from "./repair-handoff";

const sidecarSchema=z.strictObject({batchId:z.string(),before:z.string(),after:z.string()});
const bindingsSchema=z.strictObject({physical:z.string(),execution:z.string().nullable()});
const manifestSchema=z.strictObject({application:handoffApplicationSchema,reservation:handoffReservationSchema,source:z.record(z.string(),z.unknown()),sidecars:z.array(sidecarSchema),bindings:bindingsSchema});
export function originalRepairBindings(db:DatabaseSync,original:InterventionRecord,kind:"direct"|"business"|"requirement"|"engineering"){
 if(original.dispatchStall||original.recovery?.preparation)return retainedRepairPreparation(db,original).manifest.bindings;
 const physical=db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(original.workspaceId,original.issueId,original.agentId,original.attemptId);
 if(!physical)throw new DraftConflictError("Original physical repository binding disappeared during recovery");
 let execution:string|null=null;
 if(kind!=="direct"){const table={business:"business_execution",requirement:"requirement_execution",engineering:"engineering_execution"}[kind],row=db.prepare(`SELECT payload FROM ${table} WHERE workspace_id=? AND issue_id=? AND revision=? AND agent_id=? AND attempt_id=?`).get(original.workspaceId,original.issueId,original.revision,original.agentId,original.attemptId);if(!row)throw new DraftConflictError("Original execution binding disappeared during recovery");execution=String(row.payload);}
 return {physical:String(physical.payload),execution};
}
export function initializeRepairApplications(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS engineering_repair_handoff_application(target_hash TEXT PRIMARY KEY,observation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL)");}
export const repairRootTable=(kind:"direct"|"business"|"requirement"|"engineering")=>({direct:"direct_contract",business:"business_contract",requirement:"requirement_contract",engineering:"engineering_contract"})[kind];
export function repairRootPayload(db:DatabaseSync,kind:Parameters<typeof repairRootTable>[0],workspaceId:string,issueId:string){
 const row=db.prepare(`SELECT payload FROM ${repairRootTable(kind)} WHERE workspace_id=? AND issue_id=? ORDER BY ${kind==="direct"?"version":"revision"} DESC LIMIT 1`).get(workspaceId,issueId);
 if(!row)throw new DraftConflictError("Recovery root is unavailable");return String(row.payload);
}
export function reservedRepairProposal(db:DatabaseSync,raw:HandoffReservation,original:InterventionRecord){
 const reservation=handoffReservationSchema.parse(raw),row=db.prepare("SELECT payload FROM engineering_repair_handoff WHERE target_hash=?").get(reservation.target_hash);
 if(!row)throw new DraftConflictError("Native reservation has no prepared business successor");
 const proposal=handoffProposalSchema.parse(JSON.parse(String(row.payload))),t=proposal.target,b=t.workspaceBinding,f=reservation.fence;
 if(handoffHash(proposal)!==reservation.preparation_hash||handoffHash(t)!==proposal.targetHash||proposal.targetHash!==reservation.target_hash||reservation.case_id!==t.caseId||reservation.verification_attempt_id!==t.verificationAttemptId||reservation.project_id!==b.projectId||reservation.expected_version!==t.expectedVersion||JSON.stringify(reservation.continuation)!==JSON.stringify(proposal.continuation)||
  original.observationId!==t.observationId||original.snapshotHash!==t.snapshotHash||original.receiptHash!==t.sourceReceiptHash||original.attemptId!==b.sourceAttemptId||f.observation_id!==original.observationId||f.snapshot_hash!==original.snapshotHash||f.source_attempt_id!==original.attemptId||f.source_revision!==original.revision||f.workspace_path!==b.workspaceRoot||f.targets_hash!==b.targetsHash)throw new DraftConflictError("Native reservation differs from the original prepared handoff");
 const c=proposal.continuation,team=new EngineeringTeamStore(db).binding(c.workspace_id,c.parent_issue_id??c.issue_id);
 if(JSON.stringify(team??null)!==JSON.stringify(proposal.teamBinding))throw new DraftConflictError("Frozen task Team changed before recovery activation");
 return proposal;
}
export function readRepairApplication(db:DatabaseSync,original:InterventionRecord){
 const row=db.prepare("SELECT payload FROM engineering_repair_handoff_application WHERE observation_id=?").get(original.observationId);if(!row)return undefined;
 const delivery=db.prepare("SELECT case_id,snapshot_hash FROM engineering_intervention_delivery WHERE observation_id=?").get(original.observationId);
 const manifest=manifestSchema.parse(JSON.parse(String(row.payload))),a=manifest.application,proposal=reservedRepairProposal(db,manifest.reservation,original),checkpoint=proposal.checkpoint;
 if(delivery?.case_id!==proposal.target.caseId||delivery.snapshot_hash!==original.snapshotHash||a.target_hash!==proposal.targetHash||a.reservation_hash!==manifest.reservation.hash||a.preparation_hash!==manifest.reservation.preparation_hash||a.root_kind!==proposal.rootKind||a.source_payload_hash!==proposal.sourcePayloadHash||a.expected_version!==proposal.target.expectedVersion||JSON.stringify(a.continuation)!==JSON.stringify(proposal.continuation)||a.source_hash!==handoffHash(manifest.source)||a.sidecars_hash!==handoffHash(manifest.sidecars)||a.original_bindings_hash!==handoffHash(manifest.bindings)||JSON.stringify(originalRepairBindings(db,original,proposal.rootKind))!==JSON.stringify(manifest.bindings))throw new DraftConflictError("Staged recovery checkpoint or immutable lineage changed");
 if(checkpoint.kind==="yaml"){
  const old=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(checkpoint.originalDraftId);
  if(a.draft_id!==checkpoint.draft.id||a.draft_hash!==handoffHash(checkpoint.draft)||!old||JSON.stringify(draftSchema.parse(JSON.parse(String(old.payload))))!==JSON.stringify(z.object({draft:draftSchema}).parse(original.snapshot).draft))throw new DraftConflictError("Staged or surrendered draft changed");
 }else if(a.draft_id!==null||a.draft_hash!==null)throw new DraftConflictError("Direct recovery cannot inherit a YAML checkpoint");
 return {manifest,proposal};
}
export function readStagedRepair(db:DatabaseSync,original:InterventionRecord){
 const staged=readRepairApplication(db,original);if(!staged)return undefined;
 const {manifest,proposal}=staged,a=manifest.application;
 if(handoffHash(repairRootPayload(db,a.root_kind,original.workspaceId,original.issueId))!==a.applied_payload_hash)throw new DraftConflictError("Staged recovery checkpoint or immutable lineage changed");
 for(const sidecar of manifest.sidecars){const saved=db.prepare("SELECT payload FROM engineering_feedback_batch WHERE workspace_id=? AND issue_id=? AND batch_id=?").get(original.workspaceId,original.issueId,sidecar.batchId);if(saved?.payload!==sidecar.after)throw new DraftConflictError("Staged Feedback checkpoint changed");}
 if(proposal.checkpoint.kind==="yaml"){const saved=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(proposal.checkpoint.draft.id);if(!saved||handoffHash(draftSchema.parse(JSON.parse(String(saved.payload))))!==a.draft_hash)throw new DraftConflictError("Staged or surrendered draft changed");}
 return staged;
}
export function stagedPreparation(staged:NonNullable<ReturnType<typeof readStagedRepair>>){
 const p=staged.proposal,c=p.checkpoint;return handoffPreparationSchema.parse({prepared:true,hash:handoffHash(p),target_hash:p.targetHash,continuation:p.continuation,kind:c.kind,draft_id:c.kind==="yaml"?c.draft.id:null});
}
/** Caller holds the business transaction and has validated the exact native reservation. */
export function persistStagedRepair(db:DatabaseSync,original:InterventionRecord,reservation:HandoffReservation,source:Record<string,unknown>,change:HandoffRootChange){
 const proposal=reservedRepairProposal(db,reservation,original),checkpoint=proposal.checkpoint,sidecars=change.sidecars??[],before=repairRootPayload(db,proposal.rootKind,original.workspaceId,original.issueId),bindings=originalRepairBindings(db,original,proposal.rootKind);
 if(before!==proposal.sourcePayload||handoffHash(before)!==proposal.sourcePayloadHash)throw new DraftConflictError("Recovery root changed before applying the prepared successor");
 if(checkpoint.kind==="yaml")db.prepare("INSERT INTO chain_drafts(id,sequence,payload) VALUES(?,?,?)").run(checkpoint.draft.id,checkpoint.draft.sequence,JSON.stringify(checkpoint.draft));
 const after=z.record(z.string(),z.unknown()).parse(JSON.parse(change.payload)),table=repairRootTable(proposal.rootKind),versioned=proposal.rootKind==="direct"||proposal.rootKind==="business";
 const changed=db.prepare(`UPDATE ${table} SET payload=?${versioned?",version=?":""} WHERE workspace_id=? AND issue_id=? AND payload=?`).run(change.payload,...(versioned?[z.number().int().parse(after.version)]:[]),original.workspaceId,original.issueId,before);
 if(changed.changes!==1)throw new DraftConflictError("Recovery root was replaced concurrently");
 for(const sidecar of sidecars){const version=z.object({version:z.number().int()}).parse(JSON.parse(sidecar.after)).version;const changed=db.prepare("UPDATE engineering_feedback_batch SET payload=?,version=? WHERE workspace_id=? AND issue_id=? AND batch_id=? AND payload=?").run(sidecar.after,version,original.workspaceId,original.issueId,sidecar.batchId,sidecar.before);if(changed.changes!==1)throw new DraftConflictError("Feedback recovery was replaced concurrently");}
 const body=handoffApplicationBodySchema.parse({staged:true,hold_retained:true,target_hash:proposal.targetHash,preparation_hash:reservation.preparation_hash,reservation_hash:reservation.hash,root_kind:proposal.rootKind,continuation:proposal.continuation,expected_version:proposal.target.expectedVersion,source_payload_hash:proposal.sourcePayloadHash,applied_payload_hash:handoffHash(change.payload),source_hash:handoffHash(source),sidecars_hash:handoffHash(sidecars),original_bindings_hash:handoffHash(bindings),draft_id:checkpoint.kind==="yaml"?checkpoint.draft.id:null,draft_hash:checkpoint.kind==="yaml"?handoffHash(checkpoint.draft):null});
 const application=handoffApplicationSchema.parse({...body,hash:handoffHash(body)}),manifest=manifestSchema.parse({application,reservation,source,sidecars,bindings});
 db.prepare("INSERT INTO engineering_repair_handoff_application VALUES(?,?,?)").run(proposal.targetHash,original.observationId,JSON.stringify(manifest));
 readStagedRepair(db,original);return application;
}

/** Retained lineage is a resource anchor, never a binding for the failed claim. */
export function retainedRepairPreparation(db:DatabaseSync,original:InterventionRecord):NonNullable<ReturnType<typeof readRepairApplication>>{
 const native=original.dispatchStall??original.recovery,p=native?.preparation;
 if(!native||!p)throw new DraftConflictError("Prepared recovery has no retained lineage");
 const row=db.prepare("SELECT observation_id,source_observation_id,payload FROM engineering_repair_prebind WHERE target_hash=?").get(native.target_hash),source=new InterventionStore(db).original(original.workspaceId,original.issueId,p.observation_id);
 if(row?.observation_id!==original.observationId||row.source_observation_id!==p.observation_id||row.payload!==JSON.stringify(native)||!source||source.receiptHash!==p.receipt_hash||source.attemptId!==p.source_attempt_id)throw new DraftConflictError("Prepared recovery retained source changed");
 const prepared=readRepairApplication(db,source);
 if(!prepared||prepared.proposal.targetHash!==native.target_hash||prepared.manifest.application.hash!==native.application_hash||prepared.proposal.continuation.task_id!==("entry_task_id" in native?native.entry_task_id:native.task_id)||handoffHash(prepared.manifest.bindings)!==p.bindings_hash)throw new DraftConflictError("Prepared recovery retained application changed");
 return prepared;
}
