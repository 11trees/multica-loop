import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DraftConflictError } from "./runtime";
import type { InterventionRecord } from "./intervention-store";
import { readStagedRepair } from "./repair-stage-store";
import { handoffProposalSchema,handoffReadyHash,handoffReadyBodySchema,handoffReadySchema,handoffApplicationSchema,type HandoffApplication } from "./repair-handoff";

export function readyRepairDispatch(db:DatabaseSync,original:InterventionRecord,raw:HandoffApplication){
 const application=handoffApplicationSchema.parse(raw),staged=readStagedRepair(db,original);
 if(!staged||staged.manifest.application.hash!==application.hash)throw new DraftConflictError("Dispatch readiness requires the exact applied business witness");
 const c=application.continuation,body=handoffReadyBodySchema.parse({ready:true,target_hash:application.target_hash,reservation_hash:application.reservation_hash,application_hash:application.hash,expected_version:application.expected_version,continuation:c}),value=handoffReadySchema.parse({...body,hash:handoffReadyHash(body)}),encoded=JSON.stringify(value);
 const row=db.prepare("SELECT payload FROM engineering_repair_dispatch WHERE target_hash=?").get(value.target_hash);
 if(row&&row.payload!==encoded)throw new DraftConflictError("Business dispatch identity cannot be replaced");
 if(!row)db.prepare("INSERT INTO engineering_repair_dispatch(target_hash,observation_id,workspace_id,issue_id,task_id,state,payload) VALUES(?,?,?,?,?,'ready',?)").run(value.target_hash,original.observationId,c.workspace_id,c.issue_id,c.task_id,encoded);
 return value;
}
export function repairDispatchForTask(db:DatabaseSync,workspaceId:string,issueId:string,taskId:string){
 const row=db.prepare("SELECT payload,state,observation_id,attempt_id FROM engineering_repair_dispatch WHERE workspace_id=? AND issue_id=? AND task_id=?").get(workspaceId,issueId,taskId);if(!row)return undefined;
 return {ready:handoffReadySchema.parse(JSON.parse(String(row.payload))),state:z.enum(["ready","active"]).parse(row.state),observationId:String(row.observation_id),attemptId:row.attempt_id===null?null:String(row.attempt_id)};
}
/** Only an authenticated native claim for the fixed published task can bind. */
export function activateRepairDispatch(db:DatabaseSync,original:InterventionRecord,task:{workspaceId:string;issueId:string;agentId:string;projectId?:string;attemptId:string}){
 const dispatch=repairDispatchForTask(db,task.workspaceId,task.issueId,task.attemptId.split(":")[0]!);if(!dispatch)return false;
 if(dispatch.ready.continuation.agent_id!==task.agentId||dispatch.observationId!==original.observationId)throw new DraftConflictError("Native dispatch does not own this recovery checkpoint");
 db.exec("BEGIN IMMEDIATE");try{
  const staged=readStagedRepair(db,original);if(!staged||staged.manifest.application.hash!==dispatch.ready.application_hash||task.projectId!==staged.proposal.target.workspaceBinding.projectId)throw new DraftConflictError("Native dispatch changed its applied source or project");
  const changed=db.prepare("UPDATE engineering_repair_dispatch SET state='active',attempt_id=? WHERE target_hash=? AND state='ready' AND payload=?").run(task.attemptId,dispatch.ready.target_hash,JSON.stringify(dispatch.ready));
  if(changed.changes!==1)throw new DraftConflictError("Recovery dispatch changed before activation");db.exec("COMMIT");return true;
 }catch(error){db.exec("ROLLBACK");throw error;}
}

/** A native reclaim keeps the fixed task, but its authenticated claim changes. */
export function refreshRepairDispatchClaim(db:DatabaseSync,task:{workspaceId:string;issueId:string;agentId:string;projectId?:string;attemptId:string}){
 const dispatch=repairDispatchForTask(db,task.workspaceId,task.issueId,task.attemptId.split(":")[0]!);
 if(!dispatch||dispatch.state!=="active"||dispatch.attemptId===task.attemptId)return;
 db.exec("BEGIN IMMEDIATE");try{
  const proposalRow=db.prepare("SELECT payload FROM engineering_repair_handoff WHERE target_hash=?").get(dispatch.ready.target_hash);if(!proposalRow)throw new DraftConflictError("Recovery claim has no prepared origin");
  const proposal=handoffProposalSchema.parse(JSON.parse(String(proposalRow.payload)));
  if(task.agentId!==dispatch.ready.continuation.agent_id||task.projectId!==proposal.target.workspaceBinding.projectId||!dispatch.attemptId||db.prepare("SELECT 1 FROM engineering_process WHERE workspace_id=? AND issue_id=? AND attempt_id=? AND status<>'exited'").get(task.workspaceId,task.issueId,dispatch.attemptId)||db.prepare("SELECT 1 FROM engineering_repair_business_progress WHERE target_hash=?").get(dispatch.ready.target_hash))throw new DraftConflictError("Previous recovery claim is unsettled or already applied");
  db.prepare("INSERT INTO engineering_repair_retired_claim VALUES(?,?,?,?)").run(task.workspaceId,task.issueId,dispatch.attemptId,dispatch.ready.target_hash);
  const changed=db.prepare("UPDATE engineering_repair_dispatch SET attempt_id=? WHERE target_hash=? AND state='active' AND attempt_id=? AND payload=?").run(task.attemptId,dispatch.ready.target_hash,dispatch.attemptId,JSON.stringify(dispatch.ready));if(changed.changes!==1)throw new DraftConflictError("Recovery claim changed while binding its native replacement");db.exec("COMMIT");
 }catch(error){db.exec("ROLLBACK");throw error;}
}
