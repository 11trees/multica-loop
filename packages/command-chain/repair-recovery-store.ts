import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {draftSchema,DraftConflictError,type ChainDraft} from "./runtime";
import {InterventionStore,type InterventionRecord} from "./intervention-store";
import {readRepairApplication,repairRootPayload} from "./repair-stage-store";
import {repairDispatchForTask} from "./repair-dispatch-store";
import {repairProgressRequestSchema} from "./repair-progress-store";
import {repairExecutionHintForTask} from "./repair-execution";
import {handoffHash} from "./repair-handoff";

type Prepared=NonNullable<ReturnType<typeof readRepairApplication>>;
type SnapshotReader=(prepared:Prepared,draft:ChainDraft|null,attemptId:string,executionPath:string,original:InterventionRecord)=>unknown;

/** Read persisted state without repository probing or pretending an Agent read it. */
export function readRecoveryCheckpoint(db:DatabaseSync,scope:{workspaceId:string;issueId:string},raw:unknown,snapshot:SnapshotReader){
 const input=repairProgressRequestSchema.parse(raw),store=new InterventionStore(db),row=db.prepare("SELECT observation_id FROM engineering_repair_handoff_application WHERE target_hash=?").get(input.target_hash),original=row&&store.original(scope.workspaceId,scope.issueId,String(row.observation_id));
 if(!original)throw new DraftConflictError("Recovery observation has no original applied source");
 const prepared=readRepairApplication(db,original);if(!prepared||prepared.manifest.application.hash!==input.application_hash||prepared.proposal.targetHash!==input.target_hash)throw new DraftConflictError("Recovery observation changed its applied lineage");
 const p=prepared.proposal,c=p.continuation,dispatch=repairDispatchForTask(db,scope.workspaceId,scope.issueId,c.task_id);
 if(!dispatch||dispatch.ready.hash!==input.ready_hash||dispatch.ready.application_hash!==input.application_hash)throw new DraftConflictError("Recovery observation changed its dispatch grant");
 const pending=store.pending(scope.workspaceId,scope.issueId);
 if(pending)return {checkpoint:null,reason:"held",...(pending.recovery?.target_hash===input.target_hash?{held:pending}:{})};
 if(dispatch.state!=="active"||!dispatch.attemptId)return {checkpoint:null,reason:"unbound"};
 if(db.prepare("SELECT 1 FROM engineering_repair_business_progress WHERE target_hash=?").get(input.target_hash))return {checkpoint:null,reason:"applied"};
 const attemptId=dispatch.attemptId,taskId=z.uuid().parse(attemptId.split(":")[0]),hint=taskId!==c.task_id?repairExecutionHintForTask(db,scope.workspaceId,scope.issueId,taskId):undefined;
 if(taskId!==c.task_id){if(!hint||hint.target_hash!==input.target_hash||hint.entry_task_id!==c.task_id)throw new DraftConflictError("Recovery observation has no linked native execution");}
 if(store.surrendered(scope.workspaceId,scope.issueId,attemptId)||store.retired(scope.workspaceId,scope.issueId,attemptId))throw new DraftConflictError("Recovery observation cannot reuse retired native authority");
 const physical=db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(scope.workspaceId,scope.issueId,c.agent_id,attemptId);
 if(!physical)throw new DraftConflictError("Recovery observation has no actual repository binding");
 const binding=z.object({projectId:z.uuid(),repositoryPath:z.string().min(1),mode:z.enum(["in_place","worktree"])}).parse(JSON.parse(String(physical.payload)));
 if(binding.projectId!==p.target.workspaceBinding.projectId||binding.mode!==p.target.workspaceBinding.mode)throw new DraftConflictError("Recovery observation changed its project or execution mode");
 const root=repairRootPayload(db,p.rootKind,scope.workspaceId,scope.issueId);
 if(p.checkpoint.kind==="direct"&&z.object({result:z.unknown().optional(),nativeCompleted:z.boolean().optional()}).parse(JSON.parse(root)).result)return {checkpoint:null,reason:"stage-ended"};
 let draft:ChainDraft|null=null,execution:string|null=null;
 if(p.checkpoint.kind==="yaml"){
  const row=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(p.checkpoint.draft.id);if(!row)throw new DraftConflictError("Recovery draft disappeared");draft=draftSchema.parse(JSON.parse(String(row.payload)));
  if(draft.status==="waiting_for_answers")return {checkpoint:null,reason:"waiting-for-answers"};
  if(draft.status!=="editing"||!draft.phase)return {checkpoint:null,reason:"stage-ended"};
  if(draft.runtimeInputs.some(input=>input.active&&!input.answer))return {checkpoint:null,reason:"waiting-for-answers"};
  if(JSON.stringify(draft.binding)!==JSON.stringify(p.checkpoint.draft.binding)||JSON.stringify(draft.definition)!==JSON.stringify(p.checkpoint.draft.definition))throw new DraftConflictError("Recovery draft changed its frozen contract or definition");
  if(p.rootKind==="direct")throw new DraftConflictError("A YAML recovery needs its native workflow owner");
  const table={business:"business_execution",requirement:"requirement_execution",engineering:"engineering_execution"}[p.rootKind],saved=db.prepare(`SELECT payload FROM ${table} WHERE workspace_id=? AND issue_id=? AND revision=? AND agent_id=? AND attempt_id=?`).get(scope.workspaceId,scope.issueId,c.expected_revision,c.agent_id,attemptId);
  if(!saved)throw new DraftConflictError("Recovery observation has no ordinary execution binding");execution=String(saved.payload);
  const actual=z.object({repositoryPath:z.string(),draftId:z.string().optional(),feedbackCheckpoint:z.object({draftId:z.string()}).optional()}).parse(JSON.parse(execution));
  if(actual.repositoryPath!==binding.repositoryPath||actual.draftId&&actual.draftId!==draft.id||actual.feedbackCheckpoint&&actual.feedbackCheckpoint.draftId!==draft.id)throw new DraftConflictError("Recovery observation changed its execution stage");
 }
 const captured=snapshot(prepared,draft,attemptId,binding.repositoryPath,original),position={chain:original.chain,draftId:draft?.id??null,phase:draft?.phase??"bound",revision:c.expected_revision,sequence:draft?.sequence??z.object({version:z.number().int()}).parse(JSON.parse(root)).version};
 const body={...input,case_id:p.target.caseId,verification_attempt_id:p.target.verificationAttemptId,project_id:p.target.workspaceBinding.projectId,runtime_id:p.target.workspaceBinding.runtimeId,user_id:c.user_id,entry_task_id:c.task_id,task_id:taskId,attempt_id:attemptId,execution_hint_hash:hint?.hash??null,workspace_id:scope.workspaceId,issue_id:scope.issueId,agent_id:c.agent_id,revision:position.revision,sequence:position.sequence,chain:position.chain,draft_id:position.draftId,root_hash:handoffHash(root),snapshot_hash:handoffHash(captured),physical_hash:handoffHash(String(physical.payload)),execution_hash:handoffHash(execution)};
 return {checkpoint:{...body,hash:handoffHash(body)},reason:"editable",held:undefined,snapshot:captured,position};
}
