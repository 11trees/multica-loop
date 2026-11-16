import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {draftSchema,DraftConflictError,type ChainDraft} from "./runtime";
import {InterventionStore} from "./intervention-store";
import {readRepairApplication,readStagedRepair,repairRootPayload} from "./repair-stage-store";
import {repairDispatchForTask} from "./repair-dispatch-store";
import {repairProgressRequestSchema} from "./repair-progress-store";
import {handoffHash} from "./repair-handoff";

type Prepared=NonNullable<ReturnType<typeof readRepairApplication>>;
export function readRepairDispatchReadiness(db:DatabaseSync,scope:{workspaceId:string;issueId:string},raw:unknown,assertOwner:(prepared:Prepared,draft:ChainDraft)=>void){
 const input=repairProgressRequestSchema.parse(raw),interventions=new InterventionStore(db),row=db.prepare("SELECT observation_id FROM engineering_repair_handoff_application WHERE target_hash=?").get(input.target_hash),original=row&&interventions.original(scope.workspaceId,scope.issueId,String(row.observation_id));
 if(!original)throw new DraftConflictError("Dispatch observation has no original applied source");
 const prepared=readRepairApplication(db,original);if(!prepared||prepared.proposal.targetHash!==input.target_hash||prepared.manifest.application.hash!==input.application_hash)throw new DraftConflictError("Dispatch observation changed its applied lineage");
 const p=prepared.proposal,c=p.continuation,dispatch=repairDispatchForTask(db,scope.workspaceId,scope.issueId,c.task_id);
 if(!dispatch||dispatch.ready.hash!==input.ready_hash)throw new DraftConflictError("Dispatch observation changed its native readiness grant");
 const root=repairRootPayload(db,p.rootKind,scope.workspaceId,scope.issueId),pending=interventions.pending(scope.workspaceId,scope.issueId);
 let state="eligible",reason="editable-checkpoint",sequence=c.expected_sequence,draftId:string|null=null;
 if(pending&&(dispatch.state!=="ready"||pending.observationId!==original.observationId)){state="paused";reason="business-held";}
 else if(dispatch.state==="ready"){readStagedRepair(db,original);reason="prepared-entry";}
 if(p.checkpoint.kind==="yaml"){
  draftId=p.checkpoint.draft.id;const row=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(draftId);if(!row)throw new DraftConflictError("Recovery dispatch draft disappeared");const draft=draftSchema.parse(JSON.parse(String(row.payload)));sequence=draft.sequence;
  if(state!=="paused"){
   assertOwner(prepared,draft);
   if(JSON.stringify(draft.binding)!==JSON.stringify(p.checkpoint.draft.binding)||JSON.stringify(draft.definition)!==JSON.stringify(p.checkpoint.draft.definition))throw new DraftConflictError("Recovery dispatch changed its frozen definition or binding");
   if(["completed","abandoned"].includes(draft.status)){state="ended";reason="stage-ended";}
   else if(draft.runtimeInputs.some(item=>item.active&&!item.answer)){state="waiting";reason="human-answers-pending";}
  }
 }else{
  const current=z.object({agentId:z.string(),createdBy:z.string(),contractHash:z.string(),version:z.number().int(),result:z.unknown().optional(),nativeCompleted:z.boolean()}).parse(JSON.parse(root));sequence=current.version;
  if(state!=="paused"){
   if(current.agentId!==c.agent_id||current.createdBy!==c.user_id||current.contractHash!==z.object({direct:z.object({contract_hash:z.string()})}).parse(original.snapshot).direct.contract_hash)throw new DraftConflictError("Direct dispatch changed its frozen input or role");
   if(current.result||current.nativeCompleted){state="ended";reason="direct-submitted";}
  }
 }
 const value={...input,...scope,entry_task_id:c.task_id,task_id:dispatch.attemptId?.split(":")[0]??c.task_id,attempt_id:dispatch.attemptId,agent_id:c.agent_id,user_id:c.user_id,draft_id:draftId,revision:c.expected_revision,sequence,state,reason,root_hash:handoffHash(root)};
 return {...value,hash:handoffHash(value)};
}
