import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {draftSchema,DraftConflictError,type ChainDraft} from "./runtime";
import {InterventionStore,type InterventionRecord} from "./intervention-store";
import {handoffHash,type HandoffYamlCheckpoint} from "./repair-handoff";
import {repairExecutionHintForTask} from "./repair-execution";
import {repairDispatchForTask} from "./repair-dispatch-store";
import {readRepairApplication} from "./repair-stage-store";
import {repairBusinessProgressHash,repairBusinessProgressSchema} from "./repair-progress";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const repairProgressRequestSchema=z.strictObject({target_hash:hash,application_hash:hash,ready_hash:hash});
export function initializeRepairProgress(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS engineering_repair_business_progress(target_hash TEXT PRIMARY KEY,payload TEXT NOT NULL)");}
type AppliedResult={id:string;hash:string;event:unknown};
export function readRepairProgress(db:DatabaseSync,scope:{workspaceId:string;issueId:string},raw:unknown,readResult:(original:InterventionRecord,checkpoint:HandoffYamlCheckpoint|null,draft:ChainDraft|null,attemptId:string,rootKind:"direct"|"business"|"requirement"|"engineering")=>AppliedResult|undefined){
 const input=repairProgressRequestSchema.parse(raw),interventions=new InterventionStore(db),row=db.prepare("SELECT observation_id FROM engineering_repair_handoff_application WHERE target_hash=?").get(input.target_hash),original=row&&interventions.original(scope.workspaceId,scope.issueId,String(row.observation_id));
 if(!original)throw new DraftConflictError("Recovery progress has no original applied source");
 const staged=readRepairApplication(db,original);if(!staged||staged.manifest.application.hash!==input.application_hash||staged.proposal.targetHash!==input.target_hash)throw new DraftConflictError("Recovery progress changed its applied source");
 const {proposal}=staged,c=proposal.continuation,dispatch=repairDispatchForTask(db,scope.workspaceId,scope.issueId,c.task_id);
 if(!dispatch||dispatch.ready.hash!==input.ready_hash||dispatch.ready.application_hash!==input.application_hash)throw new DraftConflictError("Recovery progress changed its native dispatch");
 if(dispatch.state!=="active"||!dispatch.attemptId||interventions.pending(scope.workspaceId,scope.issueId))return {progress:null};
 const attemptId=dispatch.attemptId,taskId=z.uuid().parse(attemptId.split(":")[0]),hint=taskId!==c.task_id?repairExecutionHintForTask(db,scope.workspaceId,scope.issueId,taskId):undefined;if(taskId!==c.task_id&&(!hint||hint.entry_task_id!==c.task_id||hint.target_hash!==input.target_hash||hint.application_hash!==input.application_hash||hint.ready_hash!==input.ready_hash)||interventions.surrendered(scope.workspaceId,scope.issueId,attemptId))throw new DraftConflictError("Recovery progress is not a new native claim");
 const binding=db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(scope.workspaceId,scope.issueId,c.agent_id,attemptId);
 if(!binding||z.object({projectId:z.uuid()}).parse(JSON.parse(String(binding.payload))).projectId!==proposal.target.workspaceBinding.projectId)throw new DraftConflictError("Recovery progress has no exact native repository binding");
 if(db.prepare("SELECT 1 FROM engineering_process WHERE workspace_id=? AND issue_id=? AND attempt_id=? AND status<>'exited'").get(scope.workspaceId,scope.issueId,attemptId))return {progress:null};
 let draft:ChainDraft|null=null,checkpoint:HandoffYamlCheckpoint|null=null;
 if(proposal.checkpoint.kind==="yaml"){
  checkpoint=proposal.checkpoint;const saved=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(checkpoint.draft.id);if(!saved)return {progress:null};draft=draftSchema.parse(JSON.parse(String(saved.payload)));
  if(draft.status!=="completed"||draft.phase!==null)return {progress:null};
  const event=draft.events.at(-1);
  if(draft.attemptId!==attemptId||draft.sequence<=checkpoint.draft.sequence||JSON.stringify(draft.binding)!==JSON.stringify(checkpoint.draft.binding)||JSON.stringify(draft.definition)!==JSON.stringify(checkpoint.draft.definition)||!event||event.command!=="phase.complete"||event.phase!==null||event.sequence!==draft.sequence||event.attemptId!==attemptId||draft.runtimeInputs.some(item=>item.active&&!item.answer))throw new DraftConflictError("Recovery progress has no matching ordinary completion event");
 }
 const result=readResult(original,checkpoint,draft,attemptId,proposal.rootKind);if(!result)return {progress:null};
 const body={applied:true as const,case_id:proposal.target.caseId,verification_attempt_id:proposal.target.verificationAttemptId,target_hash:input.target_hash,application_hash:input.application_hash,ready_hash:input.ready_hash,workspace_id:scope.workspaceId,issue_id:scope.issueId,task_id:taskId,...(hint?{entry_task_id:c.task_id,execution_hint_hash:hint.hash}:{}),agent_id:c.agent_id,attempt_id:attemptId,chain:draft?.definition.id??"direct",draft_id:draft?.id??null,draft_hash:draft?handoffHash(draft):null,result_id:result.id,result_hash:result.hash,completion_event_hash:handoffHash(result.event),revision:c.expected_revision,sequence:draft?.sequence??0},value=repairBusinessProgressSchema.parse({...body,hash:repairBusinessProgressHash({...body,chain:repairBusinessProgressSchema.shape.chain.parse(body.chain)})}),encoded=JSON.stringify(value),previous=db.prepare("SELECT payload FROM engineering_repair_business_progress WHERE target_hash=?").get(input.target_hash);
 if(previous&&previous.payload!==encoded)throw new DraftConflictError("Applied recovery result cannot be replaced");
 if(!previous)db.prepare("INSERT INTO engineering_repair_business_progress VALUES(?,?)").run(input.target_hash,encoded);
 return {progress:value};
}
