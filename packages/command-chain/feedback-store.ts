import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";
import {DraftConflictError} from "./runtime";
import {parseCommandChainDefinition} from "./definition";
import type {SqliteDraftStore} from "./sqlite-store";
import {compileFeedbackTriageConclusion,compileFeedbackVerifyConclusion,feedbackTriageConclusionSchema,feedbackVerifyConclusionSchema,feedbackTriageContractSchema,feedbackVerifyContractSchema,feedbackGroupSchema,feedbackWorkEvidenceSchema,feedbackTriageProfile,feedbackVerifyProfile,type FeedbackTriageContract,type FeedbackGroup} from "./feedback";

const text=z.string().trim().min(1),seq=z.number().int().nonnegative();
const {batchId:_batchId,previousFeedback:_previousFeedback,...captureShape}=feedbackTriageContractSchema.shape;
const captureContractSchema=z.strictObject(captureShape);
const definitionsSchema=z.strictObject({triage:text,verify:text});
const policySchema=z.strictObject({agentId:z.uuid(),verifierId:z.uuid(),repositoryPath:text,mode:z.enum(["in_place","worktree"]),reviewDraftId:text,reportHash:text,restoreDone:z.boolean()});
const triageResult=feedbackTriageConclusionSchema,verifyResult=feedbackVerifyConclusionSchema;
const verificationSchema=z.strictObject({draftId:text,contract:feedbackVerifyContractSchema,result:verifyResult.optional()});
const groupSchema=z.strictObject({id:text,descriptor:feedbackGroupSchema,status:z.enum(["waiting_for_repro","waiting_for_plan","waiting_for_report","verifying","completed","reopened","cancelled"]),work:feedbackWorkEvidenceSchema.optional(),verifications:z.record(z.string(),verificationSchema)});
const batchSchema=z.strictObject({workspaceId:text,issueId:text,id:text,number:z.number().int().positive(),version:seq,requestId:text,requestHash:text,createdBy:text,policy:policySchema.optional(),definitions:definitionsSchema,contract:feedbackTriageContractSchema,triageDraftId:text,triage:triageResult.optional(),groups:z.array(groupSchema),status:z.enum(["triaging","executing","verifying","completed","cancelled"]),nativeRestored:z.boolean().default(false),cancellation:z.strictObject({userId:text,reason:text,at:z.iso.datetime()}).optional()});
export type FeedbackBatch=z.infer<typeof batchSchema>;
const commentStateSchema=z.strictObject({batchId:text,fingerprint:text,status:z.enum(["submitted","in_progress","resolved","reopened"]),verification:verifyResult.optional()});
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function stableId(value:string){const digest=createHash("sha256").update(value).digest("hex");return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;}
export type FeedbackWorkResolver=(scope:{workspaceId:string;issueId:string;batchId:string;groupId:string;group:FeedbackGroup;contract:FeedbackTriageContract})=>Promise<z.infer<typeof feedbackWorkEvidenceSchema>>;

/** Internal host storage. Native identity, lifecycle and authoritative work lookup belong to its caller. */
export class FeedbackStore {
 constructor(private readonly db:DatabaseSync,private readonly drafts:SqliteDraftStore,private readonly resolveWork?:FeedbackWorkResolver){
  db.exec("CREATE TABLE IF NOT EXISTS engineering_feedback_batch(workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,batch_id TEXT NOT NULL,number INTEGER NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,batch_id),UNIQUE(workspace_id,issue_id,number))");
  db.exec("CREATE TABLE IF NOT EXISTS engineering_feedback_comment(workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,comment_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id,comment_id))");
 }
 get(workspaceId:string,issueId:string,batchId:string){const row=this.db.prepare("SELECT payload FROM engineering_feedback_batch WHERE workspace_id=? AND issue_id=? AND batch_id=?").get(workspaceId,issueId,batchId);return row ? batchSchema.parse(JSON.parse(String(row.payload))) : undefined;}
 private require(workspaceId:string,issueId:string,batchId:string){const batch=this.get(workspaceId,issueId,batchId);if(!batch)throw new Error("Feedback batch is unavailable in this issue/workspace");return batch;}
 list(workspaceId:string,issueId:string){return this.db.prepare("SELECT payload FROM engineering_feedback_batch WHERE workspace_id=? AND issue_id=? ORDER BY number").all(workspaceId,issueId).map(row=>batchSchema.parse(JSON.parse(String(row.payload))));}
 private comment(batch:Pick<FeedbackBatch,"workspaceId"|"issueId">,id:string){const row=this.db.prepare("SELECT payload FROM engineering_feedback_comment WHERE workspace_id=? AND issue_id=? AND comment_id=?").get(batch.workspaceId,batch.issueId,id);return row ? commentStateSchema.parse(JSON.parse(String(row.payload))) : undefined;}
 private saveComment(batch:FeedbackBatch,id:string,value:z.infer<typeof commentStateSchema>){this.db.prepare("INSERT INTO engineering_feedback_comment(workspace_id,issue_id,comment_id,payload) VALUES(?,?,?,?) ON CONFLICT(workspace_id,issue_id,comment_id) DO UPDATE SET payload=excluded.payload").run(batch.workspaceId,batch.issueId,id,JSON.stringify(value));}
 private save(batch:FeedbackBatch,expectedVersion:number){
  batch.version=expectedVersion+1;batchSchema.parse(batch);
  const result=this.db.prepare("UPDATE engineering_feedback_batch SET version=?,payload=? WHERE workspace_id=? AND issue_id=? AND batch_id=? AND version=?").run(batch.version,JSON.stringify(batch),batch.workspaceId,batch.issueId,batch.id,expectedVersion);
  if(result.changes !== 1)throw new DraftConflictError("Feedback batch changed; reload its current version");
 }
 private atomic<T>(work:()=>T){this.db.exec("BEGIN IMMEDIATE");try{const result=work();this.db.exec("COMMIT");return result;}catch(error){this.db.exec("ROLLBACK");throw error;}}
 capture(input:{requestId:string;userId:string;expectedBatchNumber:number;policy?:z.infer<typeof policySchema>;definitions:z.infer<typeof definitionsSchema>;contract:Omit<FeedbackTriageContract,"batchId"|"previousFeedback">}){
  const request=z.strictObject({requestId:text,userId:text,expectedBatchNumber:seq,policy:policySchema.optional(),definitions:definitionsSchema,contract:captureContractSchema}).parse(input),{workspaceId,issueId}=request.contract.binding;
  parseCommandChainDefinition(request.definitions.triage,feedbackTriageProfile);parseCommandChainDefinition(request.definitions.verify,feedbackVerifyProfile);
  const id=stableId(`feedback:${workspaceId}:${issueId}:${request.requestId}`),requestHash=hash(request);
  return this.atomic(()=>{
   const existing=this.get(workspaceId,issueId,id);if(existing){if(existing.requestHash !== requestHash)throw new DraftConflictError("Feedback capture request was reused with different frozen facts");return existing;}
   const batches=this.list(workspaceId,issueId);if((batches.at(-1)?.number ?? 0) !== request.expectedBatchNumber)throw new DraftConflictError("Feedback batch number changed");
   if(batches.some(batch=>!["completed","cancelled"].includes(batch.status)))throw new DraftConflictError("Finish the active feedback batch before freezing another");
   const previousFeedback:FeedbackTriageContract["previousFeedback"]=[];
   for(const comment of request.contract.comments){const previous=this.comment({workspaceId,issueId},comment.id);if(previous?.status === "resolved" && previous.fingerprint === hash(comment))throw new Error("The same comment version is already resolved");if(previous?.status === "reopened" && previous.verification)previousFeedback.push({ref:`FEEDBACK_VERIFICATION:${previous.verification.draftId}`,version:String(previous.verification.sequence),content:JSON.stringify(previous.verification)});}
   const value={...request.contract,batchId:id,previousFeedback},binding={...value.binding,contractVersion:hash(value)},contract=feedbackTriageContractSchema.parse({...value,binding});
   const batch=batchSchema.parse({workspaceId,issueId,id,number:request.expectedBatchNumber+1,version:0,requestId:request.requestId,requestHash,createdBy:request.userId,policy:request.policy,definitions:request.definitions,contract,triageDraftId:stableId(`feedback-triage:${id}`),groups:[],status:"triaging"});
   this.db.prepare("INSERT INTO engineering_feedback_batch(workspace_id,issue_id,batch_id,number,version,payload) VALUES(?,?,?,?,?,?)").run(workspaceId,issueId,id,batch.number,0,JSON.stringify(batch));
   for(const comment of contract.comments)this.saveComment(batch,comment.id,{batchId:id,fingerprint:hash(comment),status:"in_progress"});return batch;
  });
 }
 async settleTriage(workspaceId:string,issueId:string,batchId:string,expectedVersion:number){
  const batch=this.require(workspaceId,issueId,batchId),draft=await this.drafts.read(batch.triageDraftId);if(!draft)throw new Error("Start and complete the frozen feedback triage draft first");
  const result=compileFeedbackTriageConclusion(draft,batch.contract);
  return this.atomic(()=>{
   const current=this.require(workspaceId,issueId,batchId);if(current.status === "cancelled")throw new Error("Feedback batch was cancelled");if(current.triage){if(hash(current.triage) !== hash(result))throw new DraftConflictError("Completed feedback triage facts changed");return current;}
   if(current.version !== expectedVersion)throw new DraftConflictError("Feedback batch changed before triage settlement");
   current.triage=result;current.groups=result.groups.map(descriptor=>({id:stableId(`feedback-group:${batchId}:${descriptor.key}`),descriptor,status:["reply","historical_correction","learning_only"].includes(descriptor.workType) ? "completed" as const : descriptor.workType === "bug" ? "waiting_for_repro" as const : descriptor.workType === "report_correction" ? "waiting_for_report" as const : "waiting_for_plan" as const,verifications:{}}));
   for(const group of current.groups)if(group.status === "completed")for(const commentId of group.descriptor.commentIds){const previous=this.comment(current,commentId)!;this.saveComment(current,commentId,{...previous,status:"resolved"});}
   this.status(current);this.save(current,expectedVersion);return current;
  });
 }
 private status(batch:FeedbackBatch){batch.status=batch.groups.length && batch.groups.every(group=>["completed","reopened"].includes(group.status)) ? "completed" : batch.groups.some(group=>group.status.startsWith("waiting_")) ? "executing" : "verifying";}
 private async evidence(batch:FeedbackBatch,group:z.infer<typeof groupSchema>){
  if(!this.resolveWork)throw new Error("An authoritative forward-work resolver is required before feedback verification");
  const proof=feedbackWorkEvidenceSchema.parse(await this.resolveWork({workspaceId:batch.workspaceId,issueId:batch.issueId,batchId:batch.id,groupId:group.id,group:structuredClone(group.descriptor),contract:structuredClone(batch.contract)}));
  if((group.descriptor.workType === "report_correction" ? "report" : "delivery") !== proof.kind)throw new Error("Feedback verification evidence has the wrong forward-work kind");
  return proof;
 }
 async freezeVerification(workspaceId:string,issueId:string,batchId:string,groupId:string,commentId:string,expectedVersion:number){
  const batch=this.require(workspaceId,issueId,batchId),group=batch.groups.find(group=>group.id === groupId);
  if(!group || group.status === "completed" || group.status === "reopened" || !group.descriptor.commentIds.includes(commentId))throw new Error("Feedback comment has no pending forward work in this group");
  const work=await this.evidence(batch,group);
  return this.atomic(()=>{
   const current=this.require(workspaceId,issueId,batchId),target=current.groups.find(group=>group.id === groupId)!;if(current.status === "cancelled")throw new Error("Feedback batch was cancelled");
   if(target.work && hash(target.work) !== hash(work))throw new DraftConflictError("Forward work changed within the frozen feedback group");
   if(target.verifications[commentId])return current;
   if(current.version !== expectedVersion)throw new DraftConflictError("Feedback batch changed before verification capture");
   const value={binding:{...batch.contract.binding,codeVersion:work.codeVersion},batchId,groupId,group:group.descriptor,comment:batch.contract.comments.find(comment=>comment.id === commentId)!,context:batch.contract.context,work};
   const contract=feedbackVerifyContractSchema.parse({...value,binding:{...value.binding,contractVersion:hash(value)}});
   target.work=work;target.verifications[commentId]={draftId:stableId(`feedback-verify:${groupId}:${commentId}`),contract};target.status="verifying";this.status(current);this.save(current,expectedVersion);return current;
  });
 }
 async settleVerification(workspaceId:string,issueId:string,batchId:string,groupId:string,commentId:string,expectedVersion:number){
  const batch=this.require(workspaceId,issueId,batchId),group=batch.groups.find(group=>group.id === groupId),verification=group?.verifications[commentId];
  if(!group || !verification)throw new Error("Feedback verification scope is not frozen");
  const draft=await this.drafts.read(verification.draftId);if(!draft)throw new Error("Complete the frozen single-comment verification draft first");
  const result=compileFeedbackVerifyConclusion(draft,verification.contract);
  if(!verification.result && hash(await this.evidence(batch,group)) !== hash(verification.contract.work))throw new DraftConflictError("Forward work changed before feedback verification settlement");
  return this.atomic(()=>{
   const current=this.require(workspaceId,issueId,batchId),target=current.groups.find(group=>group.id === groupId)!,entry=target.verifications[commentId]!;if(current.status === "cancelled")throw new Error("Feedback batch was cancelled");
   if(entry.result){if(hash(entry.result) !== hash(result))throw new DraftConflictError("Completed feedback verification changed");return current;}
   if(current.version !== expectedVersion)throw new DraftConflictError("Feedback batch changed before verification settlement");
   entry.result=result;const comment=this.comment(current,commentId)!;this.saveComment(current,commentId,{...comment,status:result.conclusion.verdict,verification:result});
   if(target.descriptor.commentIds.every(id=>target.verifications[id]?.result))target.status=Object.values(target.verifications).some(item=>item.result?.conclusion.verdict === "reopened") ? "reopened" : "completed";
   this.status(current);this.save(current,expectedVersion);return current;
  });
 }
 unresolved(workspaceId:string,issueId:string){return this.db.prepare("SELECT comment_id,payload FROM engineering_feedback_comment WHERE workspace_id=? AND issue_id=?").all(workspaceId,issueId).flatMap(row=>{const state=commentStateSchema.parse(JSON.parse(String(row.payload)));return state.status === "resolved" ? [] : [{commentId:String(row.comment_id),...state}];});}
 acknowledgeNativeRestore(workspaceId:string,issueId:string,batchId:string,expectedVersion:number){return this.atomic(()=>{
  const current=this.require(workspaceId,issueId,batchId);if(current.nativeRestored)return current;
  if(current.status !== "completed" || !current.policy?.restoreDone || current.version !== expectedVersion || this.unresolved(workspaceId,issueId).length || current.groups.some(group=>!["reply","historical_correction","learning_only"].includes(group.descriptor.workType)))throw new DraftConflictError("Feedback native restoration no longer matches its completed snapshot");
  current.nativeRestored=true;this.save(current,expectedVersion);return current;
 });}
 cancel(workspaceId:string,issueId:string,batchId:string,expectedVersion:number,userId:string,reason:string){
  const cancellation={userId:text.parse(userId),reason:text.parse(reason),at:new Date().toISOString()};return this.atomic(()=>{
   const current=this.require(workspaceId,issueId,batchId);if(current.status === "cancelled")return current;if(current.status === "completed" || current.version !== expectedVersion)throw new DraftConflictError("Only the current active feedback batch can be cancelled");
   current.cancellation=cancellation;current.status="cancelled";
   for(const group of current.groups)if(!["completed","reopened"].includes(group.status))group.status="cancelled";
   for(const comment of current.contract.comments){const state=this.comment(current,comment.id)!;if(state.status === "in_progress")this.saveComment(current,comment.id,{...state,status:"submitted"});}
   this.save(current,expectedVersion);return current;
  });
 }
}
