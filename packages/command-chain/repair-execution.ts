import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {draftSchema,DraftConflictError} from "./runtime";
import {handoffProposalSchema,type HandoffReady} from "./repair-handoff";
import {repairProgressHash} from "./repair-progress";
const text=z.string().min(1),hash=z.string().regex(/^[a-f0-9]{64}$/);
const fields=z.strictObject({hash,kind:z.enum(["entry","continuation"]),target_hash:hash,application_hash:hash,ready_hash:hash,entry_task_id:z.uuid(),workspace_id:z.uuid(),issue_id:z.uuid(),agent_id:z.uuid(),user_id:z.uuid(),draft_id:text.nullable(),revision:z.number().int().positive(),sequence:z.number().int().nonnegative()});
export type RepairExecutionHint=z.infer<typeof fields>;
export function repairExecutionHintHash(h:Omit<RepairExecutionHint,"hash">){return repairProgressHash(["multica:repair-execution-hint:1",h.kind,h.target_hash,h.application_hash,h.ready_hash,h.entry_task_id,h.workspace_id,h.issue_id,h.agent_id,h.user_id,h.draft_id??"",String(h.revision),String(h.sequence)]);}
export const repairExecutionHintSchema=fields.superRefine((h,ctx)=>{if(repairExecutionHintHash(h)!==h.hash)ctx.addIssue({code:"custom",message:"Recovery execution hint hash changed"});});
export function initializeRepairExecutions(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS engineering_repair_execution_hint(hash TEXT PRIMARY KEY,target_hash TEXT NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS engineering_repair_execution(task_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,target_hash TEXT NOT NULL,hint_hash TEXT NOT NULL)");}
function saveHint(db:DatabaseSync,body:Omit<RepairExecutionHint,"hash">){const value=repairExecutionHintSchema.parse({...body,hash:repairExecutionHintHash(body)}),encoded=JSON.stringify(value),row=db.prepare("SELECT payload FROM engineering_repair_execution_hint WHERE hash=?").get(value.hash);if(row&&row.payload!==encoded)throw new DraftConflictError("Recovery execution hint cannot be replaced");if(!row)db.prepare("INSERT INTO engineering_repair_execution_hint VALUES(?,?,?)").run(value.hash,value.target_hash,encoded);return value;}
function surrenderedStage(db:DatabaseSync,workspaceId:string,issueId:string,attemptId:unknown,target:unknown){return !!db.prepare("SELECT 1 FROM engineering_repair_prebind WHERE target_hash=?").get(typeof target==="string"?target:null)||typeof attemptId==="string"&&!!db.prepare("SELECT 1 FROM engineering_intervention WHERE workspace_id=? AND issue_id=? AND attempt_id=?").get(workspaceId,issueId,attemptId);}
export function entryRepairExecutionHint(db:DatabaseSync,ready:HandoffReady,draftId:string|null){const c=ready.continuation;return saveHint(db,{kind:"entry",target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash,entry_task_id:c.task_id,workspace_id:c.workspace_id,issue_id:c.issue_id,agent_id:c.agent_id,user_id:c.user_id,draft_id:draftId,revision:c.expected_revision,sequence:c.expected_sequence});}
/** A normal, already validated human prepare-run may continue the same stage.
 * Recording the hint does not enqueue a task or claim that execution happened. */
export function prepareRepairExecutionHint(db:DatabaseSync,scope:{workspaceId:string;issueId:string;userId:string},agentId:string,revision:number,sequence:number,currentDraftId:string|null|undefined){
 const rows=db.prepare("SELECT d.target_hash,d.payload,d.attempt_id,p.payload AS proposal FROM engineering_repair_dispatch d JOIN engineering_repair_handoff p ON p.target_hash=d.target_hash WHERE d.workspace_id=? AND d.issue_id=? AND d.state='active'").all(scope.workspaceId,scope.issueId);
 for(const row of rows){if(surrenderedStage(db,scope.workspaceId,scope.issueId,row.attempt_id,row.target_hash))continue;const p=handoffProposalSchema.parse(JSON.parse(String(row.proposal))),c=p.continuation;if(c.agent_id!==agentId||c.user_id!==scope.userId||c.expected_revision!==revision)continue;
  const draftId=p.checkpoint.kind==="yaml"?p.checkpoint.draft.id:null;if(draftId!==currentDraftId)continue;
  if(draftId){const saved=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(draftId);if(!saved)continue;const draft=draftSchema.parse(JSON.parse(String(saved.payload)));if(draft.sequence!==sequence||!["editing","waiting_for_answers"].includes(draft.status)||draft.status==="waiting_for_answers"&&draft.runtimeInputs.some(input=>input.active&&!input.answer))continue;}
  else{const record=db.prepare("SELECT payload,version FROM direct_contract WHERE workspace_id=? AND issue_id=?").get(scope.workspaceId,scope.issueId);if(!record||record.version!==sequence||z.object({result:z.unknown().optional()}).parse(JSON.parse(String(record.payload))).result)continue;}
  const ready=z.object({target_hash:hash,application_hash:hash,hash}).parse(JSON.parse(String(row.payload)));
  return saveHint(db,{kind:"continuation",target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash,entry_task_id:c.task_id,workspace_id:c.workspace_id,issue_id:c.issue_id,agent_id:c.agent_id,user_id:c.user_id,draft_id:draftId,revision,sequence});
 }
 return undefined;
}
/** Native daemon authentication and task-context validation happen in Go. */
export function bindRepairExecutionHint(db:DatabaseSync,actor:{workspaceId:string;issueId:string;agentId:string;attemptId:string;projectId?:string},raw:RepairExecutionHint,currentDraftId:string|null|undefined){
 const hint=repairExecutionHintSchema.parse(raw),saved=db.prepare("SELECT payload FROM engineering_repair_execution_hint WHERE hash=?").get(hint.hash),dispatch=db.prepare("SELECT payload,state,attempt_id FROM engineering_repair_dispatch WHERE target_hash=?").get(hint.target_hash),proposalRow=db.prepare("SELECT payload FROM engineering_repair_handoff WHERE target_hash=?").get(hint.target_hash);
 if(!saved||saved.payload!==JSON.stringify(hint)||!dispatch||!proposalRow)throw new DraftConflictError("Native recovery execution has no host-prepared hint");
 if(surrenderedStage(db,actor.workspaceId,actor.issueId,dispatch.attempt_id,hint.target_hash))throw new DraftConflictError("Recovery stage surrendered to a later repair generation");
 if(currentDraftId===undefined||hint.draft_id!==currentDraftId)throw new DraftConflictError("Native recovery execution no longer owns the active stage");
 const p=handoffProposalSchema.parse(JSON.parse(String(proposalRow.payload))),ready=z.object({hash,application_hash:hash}).parse(JSON.parse(String(dispatch.payload)));
 if(hint.workspace_id!==actor.workspaceId||hint.issue_id!==actor.issueId||hint.agent_id!==actor.agentId||hint.user_id!==p.continuation.user_id||hint.entry_task_id!==p.continuation.task_id||hint.application_hash!==ready.application_hash||hint.ready_hash!==ready.hash||actor.projectId!==p.target.workspaceBinding.projectId||hint.revision!==p.continuation.expected_revision)throw new DraftConflictError("Native recovery execution changed its prepared scope");
 if(hint.draft_id){const row=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(hint.draft_id);if(!row)throw new DraftConflictError("Recovery stage disappeared");const draft=draftSchema.parse(JSON.parse(String(row.payload)));if(p.checkpoint.kind!=="yaml"||hint.draft_id!==p.checkpoint.draft.id||draft.sequence<hint.sequence||!["editing","waiting_for_answers"].includes(draft.status)||JSON.stringify(draft.binding)!==JSON.stringify(p.checkpoint.draft.binding)||draft.status==="waiting_for_answers"&&draft.runtimeInputs.some(input=>input.active&&!input.answer))throw new DraftConflictError("Native recovery execution no longer owns this editable stage");}
 if(!hint.draft_id){const direct=db.prepare("SELECT payload,version FROM direct_contract WHERE workspace_id=? AND issue_id=?").get(actor.workspaceId,actor.issueId);if(!direct||Number(direct.version)<hint.sequence||z.object({result:z.unknown().optional()}).parse(JSON.parse(String(direct.payload))).result)throw new DraftConflictError("Direct recovery execution changed its checkpoint");}
 if(dispatch.state!=="active"&&!(hint.kind==="entry"&&actor.attemptId.split(":")[0]===hint.entry_task_id))throw new DraftConflictError("Recovery execution cannot bypass its entry dispatch");
 const taskId=actor.attemptId.split(":")[0]!,prior=db.prepare("SELECT target_hash,hint_hash FROM engineering_repair_execution WHERE task_id=?").get(taskId);if(prior&&(prior.target_hash!==hint.target_hash||prior.hint_hash!==hint.hash))throw new DraftConflictError("Native task cannot move between recovery checkpoints");if(!prior)db.prepare("INSERT INTO engineering_repair_execution VALUES(?,?,?,?,?)").run(taskId,actor.workspaceId,actor.issueId,hint.target_hash,hint.hash);return hint;
}
export function repairExecutionHintForTask(db:DatabaseSync,workspaceId:string,issueId:string,taskId:string){const row=db.prepare("SELECT h.payload FROM engineering_repair_execution e JOIN engineering_repair_execution_hint h ON h.hash=e.hint_hash WHERE e.task_id=? AND e.workspace_id=? AND e.issue_id=?").get(taskId,workspaceId,issueId);return row?repairExecutionHintSchema.parse(JSON.parse(String(row.payload))):undefined;}

/** An unrelated native task must not silently consume the prepared stage. */
export function assertRepairExecutionBinding(db:DatabaseSync,actor:{workspaceId:string;issueId:string;attemptId:string},currentDraftId:string|null|undefined){
 if(currentDraftId===undefined)return;
 for(const row of db.prepare("SELECT d.target_hash,d.task_id,d.attempt_id,p.payload FROM engineering_repair_dispatch d JOIN engineering_repair_handoff p ON p.target_hash=d.target_hash WHERE d.workspace_id=? AND d.issue_id=? AND d.state='active'").all(actor.workspaceId,actor.issueId)){
  if(surrenderedStage(db,actor.workspaceId,actor.issueId,row.attempt_id,row.target_hash))continue;
  const p=handoffProposalSchema.parse(JSON.parse(String(row.payload))),draftId=p.checkpoint.kind==="yaml"?p.checkpoint.draft.id:null;if(draftId!==currentDraftId)continue;
  const taskId=actor.attemptId.split(":")[0]!,hint=repairExecutionHintForTask(db,actor.workspaceId,actor.issueId,taskId);
  if(taskId!==row.task_id&&hint?.target_hash!==row.target_hash)throw new DraftConflictError("Prepared recovery stage requires its native continuation context");
 }
}
