import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {draftSchema,DraftConflictError,type ChainDraft} from "./runtime";
import {InterventionStore,type InterventionRecord} from "./intervention-store";
import {readRepairApplication,readStagedRepair,retainedRepairPreparation,repairRootPayload} from "./repair-stage-store";
import {repairDispatchForTask} from "./repair-dispatch-store";
import {repairProgressRequestSchema} from "./repair-progress-store";
import {repairExecutionHintForTask} from "./repair-execution";
import {handoffHash} from "./repair-handoff";

type Prepared=NonNullable<ReturnType<typeof readRepairApplication>>;
type SnapshotReader=(prepared:Prepared,draft:ChainDraft|null,attemptId:string|null,executionPath:string,original:InterventionRecord)=>unknown;

/** Read persisted state without repository probing or pretending an Agent read it. */
export function readRecoveryCheckpoint(db:DatabaseSync,scope:{workspaceId:string;issueId:string},raw:unknown,snapshot:SnapshotReader){
 const input=repairProgressRequestSchema.parse(raw),store=new InterventionStore(db),row=db.prepare("SELECT observation_id FROM engineering_repair_handoff_application WHERE target_hash=?").get(input.target_hash),original=row&&store.original(scope.workspaceId,scope.issueId,String(row.observation_id));
 if(!original)throw new DraftConflictError("Recovery observation has no original applied source");
 const prepared=readRepairApplication(db,original);if(!prepared||prepared.manifest.application.hash!==input.application_hash||prepared.proposal.targetHash!==input.target_hash)throw new DraftConflictError("Recovery observation changed its applied lineage");
 const p=prepared.proposal,c=p.continuation,dispatch=repairDispatchForTask(db,scope.workspaceId,scope.issueId,c.task_id);
 if(!dispatch||dispatch.ready.hash!==input.ready_hash||dispatch.ready.application_hash!==input.application_hash)throw new DraftConflictError("Recovery observation changed its dispatch grant");
 const pending=store.pending(scope.workspaceId,scope.issueId);
 if(pending&&!(dispatch.state==="ready"&&pending.observationId===original.observationId))return {checkpoint:null,reason:"held",...((pending.dispatchStall??pending.recovery)?.target_hash===input.target_hash?{held:pending}:{})};
 if(dispatch.state==="ready"&&!dispatch.attemptId){
  if(db.prepare("SELECT 1 FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND attempt_id LIKE ?").get(scope.workspaceId,scope.issueId,c.task_id+":%"))throw new DraftConflictError("Prepared recovery already has a recorded execution binding");
  const staged=readStagedRepair(db,original);if(!staged)throw new DraftConflictError("Prepared recovery lost its staged source");
  const draft=p.checkpoint.kind==="yaml"?p.checkpoint.draft:null;
  if(draft&&(draft.status!=="editing"||!draft.phase||draft.runtimeInputs.some(item=>item.active&&!item.answer)))return {checkpoint:null,reason:"waiting-or-ended"};
  const captured=snapshot(prepared,draft,null,p.target.workspaceBinding.workspaceRoot,original),position={chain:original.chain,draftId:draft?.id??null,phase:draft?.phase??"prepared",revision:c.expected_revision,sequence:draft?.sequence??p.continuation.expected_sequence};
  const preparation={observation_id:original.observationId,receipt_hash:original.receiptHash,source_attempt_id:original.attemptId,bindings_hash:handoffHash(staged.manifest.bindings)};
  const body={...input,case_id:p.target.caseId,verification_attempt_id:p.target.verificationAttemptId,project_id:p.target.workspaceBinding.projectId,runtime_id:p.target.workspaceBinding.runtimeId,user_id:c.user_id,entry_task_id:c.task_id,task_id:c.task_id,attempt_id:null,execution_hint_hash:null,workspace_id:scope.workspaceId,issue_id:scope.issueId,agent_id:c.agent_id,revision:position.revision,sequence:position.sequence,chain:position.chain,draft_id:position.draftId,root_hash:handoffHash(repairRootPayload(db,p.rootKind,scope.workspaceId,scope.issueId)),snapshot_hash:handoffHash(captured),preparation};
  return {checkpoint:{...body,hash:handoffHash(body)},reason:"prepared",held:undefined,snapshot:captured,position};
 }
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

/** A prepared failure retains the preceding physical anchor, not a new execution. */
export function readPreparedRecoverySource(db:DatabaseSync,original:InterventionRecord,caseId:string){
 const prepared=retainedRepairPreparation(db,original),p=prepared.proposal,native=(original.dispatchStall??original.recovery)!,pin=native.preparation!,store=new InterventionStore(db),source=store.original(original.workspaceId,original.issueId,pin.observation_id)!;
 if(!readStagedRepair(db,source)||native.case_id!==caseId||("entry_task_id" in native?native.entry_task_id:native.task_id)!==p.continuation.task_id||("entry_task_id" in native&&native.task_id!==native.entry_task_id)||original.agentId!==p.continuation.agent_id||original.revision!==p.continuation.expected_revision||original.sequence!==p.continuation.expected_sequence||db.prepare("SELECT 1 FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND attempt_id LIKE ?").get(original.workspaceId,original.issueId,original.dispatchStall?native.task_id+":%":original.attemptId))throw new DraftConflictError("Prepared recovery no longer owns its unchanged unbound checkpoint");
 if(p.checkpoint.kind==="yaml"&&(original.draftId!==p.checkpoint.draft.id||JSON.stringify(draftSchema.parse(z.object({draft:z.unknown()}).parse(original.snapshot).draft))!==JSON.stringify(p.checkpoint.draft)))throw new DraftConflictError("Prepared recovery draft changed");
 const frozen=original.chain==="direct"?z.object({code_version:z.string()}).parse(original.snapshot).code_version:z.object({contract:z.object({binding:z.object({codeVersion:z.string()})})}).parse(original.snapshot).contract.binding.codeVersion;
 return {...prepared.manifest.source,observation_id:original.observationId,case_id:caseId,snapshot_hash:original.snapshotHash,receipt_hash:original.receiptHash,kernel_version:original.kernelVersion??null,host_version:original.hostVersion??null,workspace_id:original.workspaceId,issue_id:original.issueId,agent_id:original.agentId,attempt_id:original.attemptId,chain:original.chain,revision:original.revision,sequence:original.sequence,code_version:frozen,checkpoint_state:"prepared",execution_binding_origin:"retained-preparation",execution_source_attempt_id:z.string().min(1).parse(prepared.manifest.source.execution_source_attempt_id??pin.source_attempt_id),...(original.dispatchStall?{dispatch_hold_hash:original.dispatchStall.hash,dispatch_task_id:original.dispatchStall.task_id}: {})};
}
