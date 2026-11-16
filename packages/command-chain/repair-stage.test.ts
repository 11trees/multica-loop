// @vitest-environment node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it } from "vitest";
import { EngineeringApplication } from "./application";
import { InterventionStore } from "./intervention-store";
import { EngineeringProcessStore } from "./process-store";
import { FeedbackStore } from "./feedback-store";
import { SqliteDraftStore } from "./sqlite-store";
import { CommandChainEngine, draftSchema } from "./runtime";
import { parseCommandChainDefinition } from "./definition";
import { reviewContractSchema, reviewProfile } from "./review";
import { feedbackTriageProfile, feedbackVerifyProfile, feedbackVerifyContractSchema } from "./feedback";
import { planningContractSchema, planningProfile } from "./planning";
import { reproductionContractSchema, reproductionProfile } from "./reproduction";
import { hostHandoffTargetFixture, hostHandoffReservationFixture,hostRecoveryFaultFixture,hostDispatchStallFixture } from "./test-helpers/repair-handoff-fixture";
import {z} from "zod";
import { handoffApplicationSchema,handoffReadySchema } from "./repair-handoff";

// Typed owner fixtures exercise pointer/sidecar activation. Their accepted-work
// evidence is synthetic; normal delivery and native ownership have separate tests.
let directory:string,repository:string,database:string,app:EngineeringApplication,db:DatabaseSync,store:SqliteDraftStore;
let definitions:string[];
const human={kind:"human" as const,workspaceId:randomUUID(),issueId:randomUUID(),userId:randomUUID()},projectId=randomUUID(),agentId=randomUUID();
const owner={kind:"task" as const,workspaceId:human.workspaceId,issueId:human.issueId,agentId,projectId,attemptId:`${randomUUID()}:123456`};
const host={kind:"host" as const,workspaceId:human.workspaceId,issueId:human.issueId};
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),"repair-stage-"));repository=join(directory,"repository");database=join(directory,"state.sqlite");
 execFileSync("git",["init","-q",repository]);repository=await realpath(repository);
 const git=(...args:string[])=>execFileSync("git",["-C",repository,...args],{stdio:"ignore"});git("config","user.name","Recovery fixture");git("config","user.email","fixture@example.invalid");await writeFile(join(repository,"README.md"),"Original source\n");git("add",".");git("commit","-qm","Original fixture");
 definitions=await Promise.all(["verification","development","analysis","context","planning","review","reproduction","feedback-triage","feedback-verify"].map(name=>readFile(new URL(`./definitions/${name}.yaml`,import.meta.url),"utf8")));
 app=new EngineeringApplication(database,definitions[0]!,definitions[1],definitions[2],{context:definitions[3]!,planning:definitions[4]!,review:definitions[5]!,reproduction:definitions[6]!,feedback:{triage:definitions[7]!,verify:definitions[8]!}});
 db=new DatabaseSync(database);store=new SqliteDraftStore(database);
 await app.invoke({actor:human,action:"configure",payload:{kind:"requirement",expected_revision:0,agent_id:randomUUID(),planner_agent_id:randomUUID(),repository_path:repository,input:"Preserve the reader outcome",decision_mode:"balanced",auto_continue:true}});
});
afterEach(async()=>{store.close();db.close();app.close();await rm(directory,{recursive:true,force:true});});
async function fixture(mode:"review"|"feedback-triage"|"feedback-verify"|"feedback-planning"|"feedback-reproduction"){
 const root=JSON.parse(String(db.prepare("SELECT payload FROM requirement_contract").get()!.payload)),binding=root.contextContract.binding;
 root.contextHandoff=true;root.accepted={reader:binding};
 let contract:unknown,source:string,profile:typeof reviewProfile,chain:string,draftId:string=randomUUID();
 if(mode==="review"){
  contract=reviewContractSchema.parse({binding,generation:1,subjects:[{key:"reader",kind:"acceptance",content:"Next page opens",requiredEvidenceRefs:["test:reader"]}],evidence:[{ref:"test:reader",kind:"independent-verification",status:"passed",revision:"1",fingerprint:"a".repeat(64),independentTest:true,content:"Controlled owner fixture evidence"}]});
  source=definitions[5]!;profile=reviewProfile;chain="review";root.reviews=[{agentId,userId:human.userId,draftId,source,contract,units:[{issue_id:randomUUID(),contract_hash:"unit",plan_draft_id:root.planDraftId,parent_revision:1,unit_key:"reader"}],accepted:root.accepted,settled:false}];
 }else{
  const feedback=new FeedbackStore(db,store),group={key:"reader",workType:"bug" as const,title:"Restore Continue",reason:"Reader action failed",response:"",commentIds:["comment"],affectedDeliveryUnits:[1],acceptance:["Next page opens"]};
  const batch=feedback.capture({requestId:randomUUID(),userId:human.userId,expectedBatchNumber:0,definitions:{triage:definitions[7]!,verify:definitions[8]!},policy:{agentId,verifierId:agentId,repositoryPath:repository,mode:"in_place",reviewDraftId:randomUUID(),reportHash:"report",restoreDone:false},contract:{binding,decisionMode:"balanced",comments:[{id:"comment",version:"1",content:"Continue does nothing",sourceRef:"COMMENT:1",authorId:"reader"}],context:{ref:"REPORT:1",version:"report",content:"Original obligations"},units:[]}});
  if(mode==="feedback-triage"){contract=batch.contract;draftId=batch.triageDraftId;source=definitions[7]!;profile=feedbackTriageProfile;chain="feedback-triage";}
  else{
   const groupId=randomUUID(),work={kind:"delivery" as const,ref:"WORK:1",version:"accepted-work",codeVersion:binding.codeVersion,content:"Controlled accepted-work fixture"};
   batch.status=mode==="feedback-verify"?"verifying":"executing";batch.groups=[{id:groupId,descriptor:group,status:mode==="feedback-verify"?"verifying":mode==="feedback-planning"?"waiting_for_plan":"waiting_for_repro",work,verifications:{}}];
   if(mode==="feedback-verify"){
    contract=feedbackVerifyContractSchema.parse({binding,batchId:batch.id,groupId,group,comment:batch.contract.comments[0],context:batch.contract.context,work});batch.groups[0]!.verifications.comment={draftId,contract:feedbackVerifyContractSchema.parse(contract)};source=definitions[8]!;profile=feedbackVerifyProfile;chain="feedback-verify";
   }else{
    const planning=planningContractSchema.parse({binding,sources:[{key:"reader",kind:"acceptance",content:"Next page opens",sourceRef:"ACCEPTANCE:reader"}],feedback:{batchId:batch.id,groupId,group,comments:batch.contract.comments,context:batch.contract.context,units:[]}}),planId=mode==="feedback-planning"?draftId:randomUUID();
    const reproduction=mode==="feedback-reproduction"?{agentId,draftId,source:definitions[6]!,contract:reproductionContractSchema.parse({binding,decisionMode:"balanced",contextRef:"CONTEXT:1",contextFingerprint:"b".repeat(64),contextContent:"Original reader facts",expectedBehavior:"Next page opens"}),handoff:false}:undefined;
    root.feedbackWork=[{batchId:batch.id,userId:human.userId,plannerId:agentId,reproducerId:agentId,groups:[{groupId,draftId:planId,source:definitions[4]!,contract:planning,settled:false,unitIds:[],reproduction}],appended:false}];
    contract=reproduction?.contract??planning;source=reproduction?definitions[6]!:definitions[4]!;profile=reproduction?reproductionProfile:planningProfile;chain=reproduction?"reproduction":"planning";
   }
   db.prepare("UPDATE engineering_feedback_batch SET payload=? WHERE batch_id=?").run(JSON.stringify(batch),batch.id);
  }
 }
 db.prepare("UPDATE requirement_contract SET payload=?").run(JSON.stringify(root));
 const frozenBinding=draftSchema.shape.binding.parse((contract as {binding:unknown}).binding);
 const draft=await new CommandChainEngine(store,{}).create({id:draftId,binding:frozenBinding,attemptId:owner.attemptId,chain:parseCommandChainDefinition(source!,profile!)});
 db.prepare("INSERT INTO requirement_execution VALUES(?,?,?,?,?,?)").run(human.workspaceId,human.issueId,1,agentId,owner.attemptId,JSON.stringify({repositoryPath:repository,overlays:[],feedbackCheckpoint:{draftId,mode:"in_place",branchRef:null}}));
 new EngineeringProcessStore(db).bind({workspaceId:owner.workspaceId,issueId:owner.issueId,agentId,attemptId:owner.attemptId},projectId,repository,"in_place");
 const snapshot={chain:chain!,repositoryPath:repository,contract:contract!,draft},interventions=new InterventionStore(db);interventions.viewed(owner,snapshot);interventions.request(owner,{summary:"Original owner failure",reason:"Reconcile this editable stage",evidence:"Controlled owner fixture"},snapshot);
 const [original]=interventions.observations();if(!original)throw new Error("Missing original fixture");const pin={case_id:"REPAIR-owner",observation_id:original.observationId,snapshot_hash:original.snapshotHash};await app.invoke({actor:host,action:"repair-observation-ack",payload:pin});
 return {original,pin,root,draftId};
}
it.each(["review","feedback-triage","feedback-verify","feedback-planning","feedback-reproduction"] as const)("stages %s through its owner without settling accepted work or comments",async mode=>{
 const f=await fixture(mode),target=await hostHandoffTargetFixture(f.original,{...human,projectId,repositoryPath:repository,caseId:f.pin.case_id}),prepared=await app.invoke({actor:host,action:"repair-handoff-prepare",payload:target}),reservation=hostHandoffReservationFixture(target,prepared);
 const comments=db.prepare("SELECT payload FROM engineering_feedback_comment").all();
 const applied=await app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation});expect(applied).toMatchObject({staged:true,hold_retained:true,root_kind:"requirement"});
 expect(await app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation})).toEqual(applied);
 const root=JSON.parse(String(db.prepare("SELECT payload FROM requirement_contract").get()!.payload));expect(root.repairEpoch).toBe(1);expect(root.accepted).toEqual(f.root.accepted);expect(db.prepare("SELECT payload FROM engineering_feedback_comment").all()).toEqual(comments);
 expect(db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(f.draftId)).toBeDefined();expect(await app.invoke({actor:host,action:"repair-source",payload:f.pin})).toMatchObject({checkpoint_state:"staged",attempt_id:owner.attemptId});expect(await app.invoke({actor:host,action:"execution-permission"})).toEqual({allowed:false});
});
it("keeps accepted requirement work held when a new commit needs normal verification",async()=>{
 const f=await fixture("feedback-planning"),before=db.prepare("SELECT payload FROM requirement_contract").get()!.payload;
 await writeFile(join(repository,"repair.txt"),"Repair changed source");execFileSync("git",["-C",repository,"add","."]);execFileSync("git",["-C",repository,"commit","-qm","Repaired source"]);
 const target=await hostHandoffTargetFixture(f.original,{...human,projectId,repositoryPath:repository,caseId:f.pin.case_id}),reservation=hostHandoffReservationFixture(target,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:target}));
 await expect(app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation})).rejects.toThrow(/normal independent verification/);expect(db.prepare("SELECT payload FROM requirement_contract").get()!.payload).toBe(before);expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_handoff_application").get()!.n).toBe(0);
});
it("rolls back the root and new draft when a Feedback sidecar cannot be staged",async()=>{
 const f=await fixture("feedback-verify"),target=await hostHandoffTargetFixture(f.original,{...human,projectId,repositoryPath:repository,caseId:f.pin.case_id}),reservation=hostHandoffReservationFixture(target,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:target}));
 const root=db.prepare("SELECT payload FROM requirement_contract").get()!.payload,batch=db.prepare("SELECT payload FROM engineering_feedback_batch").get()!.payload;
 db.exec("CREATE TRIGGER fail_sidecar BEFORE UPDATE ON engineering_feedback_batch BEGIN SELECT RAISE(ABORT,'fixture sidecar failure'); END");
 await expect(app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation})).rejects.toThrow(/sidecar failure/);
 expect(db.prepare("SELECT payload FROM requirement_contract").get()!.payload).toBe(root);expect(db.prepare("SELECT payload FROM engineering_feedback_batch").get()!.payload).toBe(batch);expect(db.prepare("SELECT count(*) AS n FROM chain_drafts").get()!.n).toBe(1);expect(db.prepare("SELECT count(*) AS n FROM engineering_repair_handoff_application").get()!.n).toBe(0);
 db.exec("DROP TRIGGER fail_sidecar");expect(await app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation})).toMatchObject({staged:true});
});
it("refuses changed successor or surrendered draft content when reading staged lineage",async()=>{
 const f=await fixture("feedback-triage"),target=await hostHandoffTargetFixture(f.original,{...human,projectId,repositoryPath:repository,caseId:f.pin.case_id}),reservation=hostHandoffReservationFixture(target,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:target}));
 const applied=handoffApplicationSchema.parse(await app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation})),saved=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(applied.draft_id!)!.payload;
 const changed=JSON.parse(String(saved));changed.inputs.injected="Unconfirmed new scope";db.prepare("UPDATE chain_drafts SET payload=? WHERE id=?").run(JSON.stringify(changed),applied.draft_id!);
 await expect(app.invoke({actor:host,action:"repair-source",payload:f.pin})).rejects.toThrow(/draft changed/);
 db.prepare("UPDATE chain_drafts SET payload=? WHERE id=?").run(String(saved),applied.draft_id!);expect(await app.invoke({actor:host,action:"repair-source",payload:f.pin})).toMatchObject({checkpoint_state:"staged"});
 const original=JSON.parse(String(db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(f.draftId)!.payload));original.inputs.injected="Rewritten original";db.prepare("UPDATE chain_drafts SET payload=? WHERE id=?").run(JSON.stringify(original),f.draftId);
 await expect(app.invoke({actor:host,action:"repair-source",payload:f.pin})).rejects.toThrow(/draft changed/);
});

it.each(["review","feedback-triage","feedback-verify","feedback-planning","feedback-reproduction"] as const)("preserves unbound %s owner facts through failure and a second staged handoff",async mode=>{
 const f=await fixture(mode),target=await hostHandoffTargetFixture(f.original,{...human,projectId,repositoryPath:repository,caseId:f.pin.case_id}),reservation=hostHandoffReservationFixture(target,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:target})),application=await app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation}),ready=handoffReadySchema.parse(await app.invoke({actor:host,action:"repair-handoff-ready",payload:application})),pin={target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash};
 const source=z.object({checkpoint:z.record(z.string(),z.unknown()),reason:z.literal("prepared")}).parse(await app.invoke({actor:host,action:"repair-recovery-checkpoint",payload:pin})),native=hostRecoveryFaultFixture(source.checkpoint,`${ready.continuation.task_id}:999999`),held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string()}).passthrough()}).parse(await app.invoke({actor:host,action:"repair-recovery-hold",payload:{...pin,native}})).held;
 const nextPin={case_id:target.caseId,observation_id:held.observationId,snapshot_hash:held.snapshotHash};await app.invoke({actor:host,action:"repair-observation-ack",payload:nextPin});expect(await app.invoke({actor:host,action:"repair-source",payload:nextPin})).toMatchObject({checkpoint_state:"prepared",execution_source_attempt_id:owner.attemptId,attempt_id:native.attempt_id});
 const nextTarget=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:target.caseId});nextTarget.verificationAttemptId=`verified-again-${randomUUID()}`;const nextReservation=hostHandoffReservationFixture(nextTarget,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:nextTarget}));expect(await app.invoke({actor:host,action:"repair-handoff-stage",payload:nextReservation})).toMatchObject({staged:true,hold_retained:true});expect(JSON.parse(String(db.prepare("SELECT payload FROM requirement_contract").get()!.payload)).accepted).toEqual(f.root.accepted);expect(db.prepare("SELECT count(*) AS n FROM requirement_execution WHERE attempt_id=?").get(native.attempt_id)!.n).toBe(0);
});

it("preserves Feedback sidecars and accepted work through a never-claimed dispatch hold",async()=>{
 const f=await fixture("feedback-verify"),target=await hostHandoffTargetFixture(f.original,{...human,projectId,repositoryPath:repository,caseId:f.pin.case_id}),reservation=hostHandoffReservationFixture(target,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:target})),application=await app.invoke({actor:host,action:"repair-handoff-stage",payload:reservation}),ready=handoffReadySchema.parse(await app.invoke({actor:host,action:"repair-handoff-ready",payload:application})),pin={target_hash:ready.target_hash,application_hash:ready.application_hash,ready_hash:ready.hash},source=z.object({checkpoint:z.record(z.string(),z.unknown())}).parse(await app.invoke({actor:host,action:"repair-recovery-checkpoint",payload:pin})),native=await hostDispatchStallFixture(source.checkpoint),held=z.object({held:z.object({observationId:z.string(),snapshotHash:z.string()}).passthrough()}).parse(await app.invoke({actor:host,action:"repair-dispatch-hold",payload:{...pin,native}})).held;
 const ack={case_id:native.case_id,observation_id:held.observationId,snapshot_hash:held.snapshotHash};await app.invoke({actor:host,action:"repair-observation-ack",payload:ack});expect(await app.invoke({actor:host,action:"repair-source",payload:ack})).toMatchObject({dispatch_task_id:native.task_id});const nextTarget=await hostHandoffTargetFixture(held,{...human,projectId,repositoryPath:repository,caseId:native.case_id});nextTarget.verificationAttemptId=`verified-dispatch-${randomUUID()}`;const nextReservation=hostHandoffReservationFixture(nextTarget,await app.invoke({actor:host,action:"repair-handoff-prepare",payload:nextTarget}));expect(await app.invoke({actor:host,action:"repair-handoff-stage",payload:nextReservation})).toMatchObject({staged:true});expect(JSON.parse(String(db.prepare("SELECT payload FROM requirement_contract").get()!.payload)).accepted).toEqual(f.root.accepted);
});
