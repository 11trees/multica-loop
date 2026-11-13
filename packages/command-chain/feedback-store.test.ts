// @vitest-environment node
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {beforeEach,afterEach,it,expect} from "vitest";
import {CommandChainEngine,type ChainCommand} from "./runtime";
import {SqliteDraftStore} from "./sqlite-store";
import {parseCommandChainDefinition} from "./definition";
import {createFeedbackTriageHandlers,createFeedbackVerifyHandlers,feedbackTriageProfile,feedbackVerifyProfile,type FeedbackGroup} from "./feedback";
import {FeedbackStore,type FeedbackBatch,type FeedbackWorkResolver} from "./feedback-store";

let definitions:{triage:string;verify:string};
let directory:string,db:DatabaseSync,drafts:SqliteDraftStore,store:FeedbackStore,work:Awaited<ReturnType<FeedbackWorkResolver>>;
function reopen(resolver=true){db=new DatabaseSync(join(directory,"feedback.sqlite"));drafts=new SqliteDraftStore(join(directory,"drafts.sqlite"));store=new FeedbackStore(db,drafts,resolver ? async()=>structuredClone(work) : undefined);}
beforeEach(async()=>{definitions={triage:await readFile(new URL("./definitions/feedback-triage.yaml",import.meta.url),"utf8"),verify:await readFile(new URL("./definitions/feedback-verify.yaml",import.meta.url),"utf8")};directory=await mkdtemp(join(tmpdir(),"feedback-store-"));work={kind:"delivery",ref:"VERIFICATION:fix",version:"verified-r1",codeVersion:"fixed-commit",content:"Actual independent delivery result and original acceptance"};reopen();});
afterEach(async()=>{drafts.close();db.close();await rm(directory,{recursive:true,force:true});});
function request(comments=["a","b"]){return {definitions,requestId:"capture-1",userId:"human",expectedBatchNumber:0,contract:{binding:{workspaceId:"workspace",issueId:"issue",revision:1,contractVersion:"parent-contract",codeVersion:"original-commit"},decisionMode:"balanced" as const,comments:comments.map(id=>({id,version:`${id}:v1`,content:`Reader comment ${id}`,sourceRef:`COMMENT:${id}`,authorId:"reader"})),context:{ref:"REPORT:1",version:"report-hash",content:"Original delivered obligations"},units:[{index:1,key:"unit",version:"unit-contract",content:"Unchanged original oracle"}]}};}
const locate=(batch:FeedbackBatch)=>[batch.workspaceId,batch.issueId,batch.id] as const;
async function triage(batch:FeedbackBatch,groups:FeedbackGroup[]){
 const chain=parseCommandChainDefinition(batch.definitions.triage,feedbackTriageProfile),engine=new CommandChainEngine(drafts,createFeedbackTriageHandlers(batch.contract));let draft=await engine.create({id:batch.triageDraftId,chain,binding:batch.contract.binding,attemptId:"triager"});
 const command=async(command:ChainCommand)=>draft=await engine.execute(draft.id,{expectedSequence:draft.sequence,attemptId:draft.attemptId},command);for(let n=0;n<3;n++)await command({type:"phase.complete"});await command({type:"artifact.put",ref:"feedback.answer-review",content:"Frozen facts suffice"});await command({type:"phase.complete"});await command({type:"artifact.put",ref:"feedback.summary",content:"Separate original feedback requirements"});
 for(const {key,...group} of groups){const content=Object.fromEntries(Object.entries(group).filter(([key,value])=>!["title","response"].includes(key) || !!value));await command({type:"artifact.put",ref:"feedback.groups",key,content:JSON.stringify(content)});}await command({type:"phase.complete"});await command({type:"phase.complete"});return store.settleTriage(...locate(batch),batch.version);
}
function group(commentIds=["a","b"],workType:FeedbackGroup["workType"]="bug"):FeedbackGroup{return {key:"group",workType,title:"Restore original shortcut",reason:"Observed mismatch",response:"Original behavior explained",commentIds,affectedDeliveryUnits:[1],acceptance:["The original shortcut activates"]};}
async function verify(batch:FeedbackBatch,commentId:string,verdict:"resolved"|"reopened"){
 const g=batch.groups[0]!,entry=g.verifications[commentId]!;const chain=parseCommandChainDefinition(batch.definitions.verify,feedbackVerifyProfile),engine=new CommandChainEngine(drafts,createFeedbackVerifyHandlers(entry.contract));let draft=await engine.create({id:entry.draftId,chain,binding:entry.contract.binding,attemptId:`verifier:${commentId}`});const command=async(command:ChainCommand)=>draft=await engine.execute(draft.id,{expectedSequence:draft.sequence,attemptId:draft.attemptId},command);
 await command({type:"phase.complete"});await command({type:"artifact.put",ref:"feedback.summary",content:"Independent saved-state observation"});await command({type:"artifact.put",ref:"feedback.evidence",key:"browser",content:"Chromium activation and visible output at fixed commit"});await command({type:"artifact.put",ref:"feedback.conclusion",content:JSON.stringify({verdict,reason:verdict === "resolved" ? "Original requirement met" : "Saved-state failure remains"})});await command({type:"phase.complete"});await command({type:"phase.complete"});
}
it("captures immutable comment versions once, isolates workspaces and rejects competing batches atomically",()=>{
 const input=request(),batch=store.capture(input);expect(store.capture(input)).toEqual(batch);expect(()=>store.capture({...input,contract:{...input.contract,comments:input.contract.comments.map(c=>({...c,content:"Edited"}))}})).toThrow(/reused/);
 const otherDb=new DatabaseSync(join(directory,"feedback.sqlite")),otherDrafts=new SqliteDraftStore(join(directory,"drafts.sqlite")),other=new FeedbackStore(otherDb,otherDrafts);
 expect(()=>other.capture({...input,requestId:"other"})).toThrow(/number changed|active/);expect(store.list("workspace","issue")).toHaveLength(1);expect(store.get("other","issue",batch.id)).toBeUndefined();
 expect(other.capture({...input,contract:{...input.contract,binding:{...input.contract.binding,workspaceId:"other"}}}).workspaceId).toBe("other");otherDrafts.close();otherDb.close();
});
it("settles every work type without fabricating delivery or report completion and preserves IDs across reopen",async()=>{
 const kinds=["reply","historical_correction","learning_only","bug","behavior_change","scope_addition","technical_change","report_correction"] as const;let batch=store.capture(request(kinds.map((_,i)=>`comment-${i}`)));batch=await triage(batch,kinds.map((kind,i)=>({...group([`comment-${i}`],kind),key:`group-${i}`})));
 expect(batch.groups.map(g=>g.status)).toEqual(["completed","completed","completed","waiting_for_repro","waiting_for_plan","waiting_for_plan","waiting_for_plan","waiting_for_report"]);expect(store.unresolved("workspace","issue")).toHaveLength(5);
 const original=structuredClone(batch);drafts.close();db.close();reopen();expect(await store.settleTriage(...locate(batch),0)).toEqual(original);expect(store.get(...locate(batch))).toEqual(original);expect(()=>store.capture({...request(),requestId:"next",expectedBatchNumber:1})).toThrow(/active/);
});
it("refuses verification without authoritative work and rejects report/delivery kind confusion",async()=>{
 let batch=store.capture(request());batch=await triage(batch,[group()]);const without=new FeedbackStore(db,drafts);await expect(without.freezeVerification(...locate(batch),batch.groups[0]!.id,"a",batch.version)).rejects.toThrow(/authoritative/);work.kind="report";await expect(store.freezeVerification(...locate(batch),batch.groups[0]!.id,"a",batch.version)).rejects.toThrow(/kind/);expect(store.get(...locate(batch))!.version).toBe(batch.version);
});
it("keeps single-comment results independent, retains failed evidence and opens a distinct forward batch",async()=>{
 let batch=await triage(store.capture(request()),[group()]);const groupId=batch.groups[0]!.id;batch=await store.freezeVerification(...locate(batch),groupId,"a",batch.version);await verify(batch,"a","reopened");batch=await store.settleVerification(...locate(batch),groupId,"a",batch.version);expect(batch.status).toBe("verifying");expect(batch.groups[0]!.status).toBe("verifying");expect(store.unresolved("workspace","issue")).toHaveLength(2);
 batch=await store.freezeVerification(...locate(batch),groupId,"b",batch.version);await verify(batch,"b","resolved");const expectedVersion=batch.version;batch=await store.settleVerification(...locate(batch),groupId,"b",expectedVersion);expect(batch.status).toBe("completed");expect(batch.groups[0]!.status).toBe("reopened");expect(store.unresolved("workspace","issue")).toMatchObject([{commentId:"a",status:"reopened"}]);
 drafts.close();db.close();reopen();expect(await store.settleVerification(...locate(batch),groupId,"b",expectedVersion)).toEqual(batch);
 const next=store.capture({...request(["a"]),requestId:"second",expectedBatchNumber:1});expect(next.id).not.toBe(batch.id);expect(next.triageDraftId).not.toBe(batch.triageDraftId);expect(next.contract.previousFeedback[0]!.content).toContain("Saved-state failure remains");expect(next.contract.comments[0]!.version).toBe("a:v1");expect(store.get(...locate(batch))).toEqual(batch);
});
it("rejects a stale work version without accepting a comment and lets explicit cancellation preserve pending work",async()=>{
 let batch=await triage(store.capture(request()),[group()]);const groupId=batch.groups[0]!.id;batch=await store.freezeVerification(...locate(batch),groupId,"a",batch.version);await verify(batch,"a","resolved");work={...work,version:"new-work",codeVersion:"new-commit"};await expect(store.settleVerification(...locate(batch),groupId,"a",batch.version)).rejects.toThrow(/Forward work changed/);expect(store.unresolved("workspace","issue").every(c=>c.status === "in_progress")).toBe(true);
 const cancelled=store.cancel(...locate(batch),batch.version,"human","Reconcile changed forward work");expect(cancelled.status).toBe("cancelled");expect(cancelled.cancellation?.reason).toBe("Reconcile changed forward work");expect(await store.settleTriage(...locate(batch),0).catch(e=>e.message)).toContain("cancelled");expect(store.unresolved("workspace","issue").every(c=>c.status === "submitted")).toBe(true);expect(store.capture({...request(),requestId:"reconcile",expectedBatchNumber:1}).number).toBe(2);
});
it("requires all comments to resolve and rejects a duplicate resolved source version",async()=>{
 let batch=await triage(store.capture(request(["a"])),[group(["a"],"report_correction")]);work={...work,kind:"report",ref:"REPORT:corrected",version:"new-report"};const id=batch.groups[0]!.id;batch=await store.freezeVerification(...locate(batch),id,"a",batch.version);expect(batch.groups[0]!.verifications.a!.contract.work.ref).toBe("REPORT:corrected");await verify(batch,"a","resolved");batch=await store.settleVerification(...locate(batch),id,"a",batch.version);expect(batch.status).toBe("completed");expect(store.unresolved("workspace","issue")).toEqual([]);expect(()=>store.capture({...request(["a"]),requestId:"duplicate",expectedBatchNumber:1})).toThrow(/already resolved/);
 const changed=request(["a"]);changed.contract.comments[0]!.version="a:v2";expect(store.capture({...changed,requestId:"edited",expectedBatchNumber:1}).number).toBe(2);
});
it("rolls back comment and group settlement together after a SQLite write failure",async()=>{
 let batch=await triage(store.capture(request()),[group()]);const id=batch.groups[0]!.id;batch=await store.freezeVerification(...locate(batch),id,"a",batch.version);await verify(batch,"a","resolved");
 db.exec("CREATE TRIGGER feedback_failure BEFORE UPDATE ON engineering_feedback_batch BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");await expect(store.settleVerification(...locate(batch),id,"a",batch.version)).rejects.toThrow(/fixture write failure/);
 expect(store.get(...locate(batch))!.version).toBe(batch.version);expect(store.get(...locate(batch))!.groups[0]!.verifications.a!.result).toBeUndefined();expect(store.unresolved("workspace","issue")).toHaveLength(2);
 db.exec("DROP TRIGGER feedback_failure");expect((await store.settleVerification(...locate(batch),id,"a",batch.version)).groups[0]!.verifications.a!.result?.conclusion.verdict).toBe("resolved");
});
it("does not revive a batch cancelled while authoritative work lookup was pending",async()=>{
 const batch=await triage(store.capture(request()),[group()]);let release!:(value:typeof work)=>void;const pendingWork=new Promise<typeof work>(resolve=>{release=resolve;});const waiting=new FeedbackStore(db,drafts,async()=>pendingWork);
 const pending=waiting.freezeVerification(...locate(batch),batch.groups[0]!.id,"a",batch.version);store.cancel(...locate(batch),batch.version,"human","Stop this batch");release(work);await expect(pending).rejects.toThrow(/cancelled/);expect(store.get(...locate(batch))!.groups[0]!.verifications).toEqual({});expect(store.unresolved("workspace","issue").every(c=>c.status === "submitted")).toBe(true);
});
