// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, it, expect } from "vitest";
import { AdminStore } from "./admin-store";
import { originalRepairTargets } from "./repair-verification-input";

let directory:string,filename:string,store:AdminStore,now:number;
const workspaceId=randomUUID(),issueId=randomUUID();
const version=`workspace-content-v1:${"a".repeat(40)}:${"b".repeat(64)}`;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"admin-verification-"));filename=join(directory,"admin.sqlite");now=1000;store=new AdminStore(filename,()=>now);});
afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
function observation(id:string,chain="verification") {
 const snapshot=chain==="direct" ? {direct:{input:"Original task with full materials"}} : {contract:{sources:[{key:"acceptance",kind:"acceptance",oracle:"Observe the original user-visible entry"},{key:"guardrail",kind:"guardrail",oracle:"Retain the original restrictions"}]},executedInput:{doNotDiscard:"Original dependency and execution facts"}};
 return {observationId:id,workspaceId,issueId,scope:"work-item",scopeKey:"same-native-source",fingerprint:id,sourceVersion:"original-runtime",summary:"Original failure",origin:"business",evidence:{original:{observationId:id,workspaceId,issueId,chain,snapshotHash:"original-snapshot",receiptHash:"original-receipt",attemptId:"native:123",snapshot}}};
}
function setup() {
 const authority=store.acquireSupervisor("host",30000,true)!, originals=[observation("first"),observation("second","direct")];
 const repair=store.observe(authority,originals[0]);store.observe(authority,originals[1]);
 store.execution.configure({expected_revision:0,configuration:{provider:"codex",executablePath:"/fixture/never-launched"}});
 store.execution.setIntent({intent:"running",request_id:"start"});
 const {claim}=store.execution.claim(authority)!;
 const command=(payload:unknown)=>store.execution.command(claim,payload);
 command({action:"status"});command({action:"workspace-takeover",observation_id:"first",reason:"Recover the original failed work"});
 store.execution.inspectTakeover(claim,{observation_id:"first",snapshot_hash:"original-snapshot",source_attempt_id:"native:123",project_id:randomUUID(),runtime_id:randomUUID(),registered_repository_path:"/fixture/root",execution_repository_path:"/fixture/removed-worktree",mode:"worktree",receipt_hash:"original-receipt",code_version:"original-code",kernel_version:"original-kernel",host_version:"original-host"});
 const progress={phase:"owned",cancelled:1,unfinished_controllers:0,unknown_tasks:0,targets_hash:"c".repeat(64),workspace_root:"/fixture/root",workspace_version:version,source_attempt_id:"native:123",snapshot_hash:"original-snapshot"};
 store.execution.recordTakeoverProgress(claim,progress);
 command({action:"evidence",key:"actual-change",kind:"change",payload:{observation:"Candidate change was inspected"}});
 const result={outcome:"verification-requested",summary:"Request separate original-contract checks",repairVersion:version,originalObservationIds:["second","first"],repairEvidenceKeys:["actual-change"],verification:{reproductionCommand:"REPAIRER_PROPOSED_COMMAND",versionCheckCommand:"REPAIRER_PROPOSED_VERSION",acceptanceChecks:[{targetRef:"invented-replacement",command:"REPAIRER_PROPOSED_ACCEPTANCE",expected:"Do not inherit this oracle"}]}};
 return {authority,repair,claim,command,progress,result,originals};
}
it("freezes every original target from host facts, excludes repairer checks, and waits for actual exit before handing off",()=>{
 const h=setup();
 expect(h.command({action:"submit",result:h.result})).toMatchObject({submitted:true,agent_action:"end_execution"});
 expect(()=>h.command({action:"verification-prepare"})).toThrow();
 expect(store.execution.prepareVerification(h.claim)).toMatchObject({prepared:true,target_count:7});
 const frozen=store.execution.verificationInput(h.claim.attemptId)!;
 expect(frozen.input.originalObservations).toEqual(h.originals);
 expect(frozen.input.targets).toEqual(originalRepairTargets(h.originals));
 expect(frozen.input.workspaceBinding).toMatchObject({workspaceRoot:"/fixture/root",executionPath:"/fixture/removed-worktree",sourceAttemptId:"native:123",targetsHash:h.progress.targets_hash});
 expect(JSON.stringify(frozen)).not.toContain("REPAIRER_PROPOSED");
 expect(JSON.stringify(frozen)).not.toContain("invented-replacement");
 const status=h.command({action:"status"});
 expect(status).toMatchObject({verificationInput:{hash:frozen.hash,targetCount:7,expectedVersion:version}});
 if (!("verificationInput" in status) || !status.verificationInput) throw new Error("Missing prepared summary");
 expect(status.verificationInput).not.toHaveProperty("input");
 expect(store.execution.prepareVerification(h.claim)).toMatchObject({input_hash:frozen.hash});
 store.close();store=new AdminStore(filename,()=>now);
 expect(store.execution.verificationInput(h.claim.attemptId)).toEqual(frozen);
 expect(store.execution.finish(h.claim,{exit_confirmed:false,reason:"Child remains alive"})).toEqual({settled:false});
 expect(store.issue(workspaceId,issueId).status).toBe("running");
 expect(store.execution.finish(h.claim,{exit_confirmed:true,reason:"Physical exit confirmed"})).toEqual({settled:true});
 expect(store.issue(workspaceId,issueId)).toMatchObject({status:"verifying",original_version:"original-runtime",observation_count:2});
 expect(store.execution.active()).toEqual([]);
 const verifier=store.execution.claim(h.authority)!;
 expect(verifier.attempt).toMatchObject({role:"verification",status:"waiting",pid:null,verification:{sourceRepairAttemptId:h.claim.attemptId,inputHash:frozen.hash}});
 expect(store.execution.verificationCurrent(verifier.claim)).toMatchObject({ready:false});
 expect(()=>store.execution.prepareVerification(h.claim)).toThrow(/identity, intent or generation/);
 expect(store.execution.verificationInput(h.claim.attemptId)).toEqual(frozen);
 expect(store.execution.readVerificationInput(h.authority,h.claim.attemptId)).toEqual(frozen);
 expect(()=>store.execution.readVerificationInput({...h.authority,ownerId:"foreign"},h.claim.attemptId)).toThrow(/supervision authority/);
});
it("requeues a prepared request if another original observation arrives before physical settlement",()=>{
 const h=setup();h.command({action:"submit",result:h.result});store.execution.prepareVerification(h.claim);
 const frozen=store.execution.verificationInput(h.claim.attemptId);
 store.observe(h.authority,observation("new-original"));
 store.execution.finish(h.claim,{exit_confirmed:true,reason:"Actual repair process ended"});
 expect(store.issue(workspaceId,issueId)).toMatchObject({status:"queued",observation_count:3});
 expect(store.execution.verificationInput(h.claim.attemptId)).toEqual(frozen);
});
it("rejects incomplete originals, stale content, foreign evidence and duplicate repair references before submission",()=>{
 const h=setup();
 for(const change of [{originalObservationIds:["first"]},{originalObservationIds:["first","second","foreign"]},{repairEvidenceKeys:["foreign"]},{repairEvidenceKeys:["actual-change","actual-change"]},{repairVersion:version.replaceAll("b","d")}]) expect(()=>h.command({action:"submit",result:{...h.result,...change}})).toThrow();
 store.execution.recordTakeoverProgress(h.claim,{...h.progress,phase:"draining",workspace_root:null,workspace_version:null});
 expect(()=>h.command({action:"submit",result:h.result})).toThrow(/owned workspace takeover/);
 expect(store.execution.verificationInput(h.claim.attemptId)).toBeNull();
});
it("retains a submitted request as failed history when fresh host content no longer matches, without starting verification",()=>{
 const h=setup();h.command({action:"submit",result:h.result});
 store.execution.recordTakeoverProgress(h.claim,{...h.progress,workspace_version:version.replaceAll("b","d")});
 expect(()=>store.execution.prepareVerification(h.claim)).toThrow(/actual repair version/);
 expect(()=>h.command({action:"submit",result:{...h.result,repairVersion:version.replaceAll("b","d")}})).toThrow(/cannot be rewritten/);
 store.execution.finish(h.claim,{exit_confirmed:true,reason:"Request ended"});
 expect(store.issue(workspaceId,issueId).status).toBe("queued");
 const next=store.execution.claim(h.authority)!;
 const status=JSON.stringify(store.execution.command(next.claim,{action:"status"}));
 expect(status).toContain("Verification request has no current host-prepared original input");
 expect(status).toContain("verification-requested");
 expect(store.execution.verificationInput(h.claim.attemptId)).toBeNull();
});
it("does not replace an already frozen input when its cohort changes or authority is revoked",()=>{
 const h=setup();h.command({action:"submit",result:h.result});store.execution.prepareVerification(h.claim);
 const frozen=store.execution.verificationInput(h.claim.attemptId);
 store.execution.recordTakeoverProgress(h.claim,{...h.progress,targets_hash:"e".repeat(64)});
 expect(()=>store.execution.prepareVerification(h.claim)).toThrow(/cannot be replaced/);
 store.execution.setIntent({intent:"stopped",request_id:"stop"});
 expect(()=>store.execution.prepareVerification(h.claim)).toThrow(/identity, intent or generation/);
 expect(store.execution.verificationInput(h.claim.attemptId)).toEqual(frozen);
 now+=30001;store.acquireSupervisor("successor",30000,true);
 expect(()=>store.execution.prepareVerification(h.claim)).toThrow(/supervision authority/);
});
it("detects damaged saved input instead of trusting its declared hash",()=>{
 const h=setup();h.command({action:"submit",result:h.result});store.execution.prepareVerification(h.claim);
 const db=new DatabaseSync(filename),row=db.prepare("SELECT payload FROM admin_verification_input").get()!,saved=JSON.parse(String(row.payload));
 saved.input.originalObservations[0].summary="Changed original";db.prepare("UPDATE admin_verification_input SET payload=?").run(JSON.stringify(saved));db.close();
 expect(()=>store.execution.verificationInput(h.claim.attemptId)).toThrow(/input changed/);
});
it("rejects missing original oracles and conflicting target identities while retaining full Direct inputs",()=>{
 const first=observation("first"), duplicate=observation("first");
 expect(()=>originalRepairTargets([first,duplicate])).toThrow(/unique/);
 expect(()=>originalRepairTargets([{...first,evidence:{original:{...first.evidence.original,snapshot:{contract:{sources:[{key:"missing-oracle"}]}}}}}])).toThrow();
 expect(()=>originalRepairTargets([{...first,issueId:randomUUID()}])).toThrow(/identity/);
 expect(originalRepairTargets([observation("direct","direct")])[0]!.original).toBe("Original task with full materials");
});

function waitingVerification(){const h=setup();h.command({action:"submit",result:h.result});store.execution.prepareVerification(h.claim);store.execution.finish(h.claim,{exit_confirmed:true,reason:"Original repair invocation ended"});const verifier=store.execution.claim(h.authority)!;return {...h,verifier};}
it("requires a new owned scope and a durable launch reservation, with no Admin commands for the separate Test",()=>{
 const h=waitingVerification(),claim=h.verifier.claim;
 expect(store.execution.claim(h.authority)).toBeNull();
 expect(()=>store.execution.command(claim,{action:"status"})).toThrow(/no Admin command authority/);
 expect(()=>store.execution.bind(claim,{pid:42,marker:"fixture-birth",group_id:42})).toThrow(/durable launch/);
 expect(()=>store.execution.launchVerification(claim)).toThrow(/not currently owned/);
 store.execution.recordTakeoverProgress(claim,h.progress);
 expect(store.execution.verificationCurrent(claim,true)).toMatchObject({ready:true,input:{sourceRepairAttemptId:h.claim.attemptId}});
 expect(store.execution.launchVerification(claim)).toEqual({reserved:true});
 expect(()=>store.execution.launchVerification(claim)).toThrow(/already reserved/);
 store.execution.bind(claim,{pid:42,marker:"fixture-birth",group_id:42});
 expect(()=>store.execution.cancelWaitingVerification(h.authority,claim.attemptId)).toThrow(/never-launched/);
});
it("safely requeues a durable never-launched Test across stop and supervisor replacement without inheriting permission",()=>{
 const h=waitingVerification();store.execution.setIntent({intent:"stopped",request_id:"stop-waiting"});
 store.close();store=new AdminStore(filename,()=>now);expect(store.execution.active()).toMatchObject([{role:"verification",status:"waiting",pid:null}]);
 now+=30001;const successor=store.acquireSupervisor("successor",30000,true)!;
 expect(()=>store.execution.verificationCurrent(h.verifier.claim)).toThrow(/authority/);
 expect(store.execution.cancelWaitingVerification(successor,h.verifier.claim.attemptId)).toEqual({cancelled:true});
 expect(store.execution.active()).toEqual([]);expect(store.issue(workspaceId,issueId).status).toBe("verifying");
 store.execution.setIntent({intent:"running",request_id:"resume-waiting"});const next=store.execution.claim(successor)!;
 expect(next.attempt).toMatchObject({role:"verification",status:"waiting",generation:h.verifier.attempt.generation+1});
 expect(store.execution.verificationCurrent(next.claim)).toMatchObject({ready:false});
});
it("preserves a separate Test plan against exact original targets and physical exit without declaring repair passed",async()=>{
 const {verificationArtifactsHash}=await import("./repair-verification-plan");const h=waitingVerification(),claim=h.verifier.claim;
 store.execution.recordTakeoverProgress(claim,h.progress);store.execution.launchVerification(claim);store.execution.bind(claim,{pid:42,marker:"test-birth",group_id:42});
 const view=store.execution.verificationCurrent(claim,true);
 const files=[{path:"independent.cjs",kind:"file" as const,hash:"f".repeat(64),size:70,mode:448}],artifacts={directory:"/fixture/private-test",mode:448,files,hash:verificationArtifactsHash(files,448)};
 const proposed={reproduction:{targetRef:"original-failures",command:"node independent.cjs reproduce"},acceptanceChecks:view.input.targets.map(target=>({targetRef:target.targetRef,command:"node independent.cjs actual-assertion"}))};
 expect(()=>store.execution.recordVerificationPlan(claim,{proposed:{...proposed,passed:true},artifacts})).toThrow();
 expect(()=>store.execution.recordVerificationPlan(claim,{proposed:{...proposed,acceptanceChecks:proposed.acceptanceChecks.slice(1)},artifacts})).toThrow(/every exact/);
 expect(()=>store.execution.recordVerificationPlan(claim,{proposed,artifacts:{...artifacts,hash:"0".repeat(64)}})).toThrow(/manifest hash/);
 expect(store.execution.recordVerificationPlan(claim,{proposed,artifacts})).toEqual({prepared:true});
 const saved=store.execution.verificationPlan(claim.attemptId);
 expect(()=>store.execution.recordVerificationPlan(claim,{proposed:{...proposed,reproduction:{...proposed.reproduction,command:"replace"}},artifacts})).toThrow(/cannot be replaced/);
 expect(store.execution.finish(claim,{exit_confirmed:false,reason:"Test group remains"})).toEqual({settled:false});
 expect(store.issue(workspaceId,issueId).status).toBe("running");
 store.execution.finish(claim,{exit_confirmed:true,reason:"Test preparation physically ended"});
 expect(store.issue(workspaceId,issueId)).toMatchObject({status:"verification-prepared",observation_count:2});
 expect(store.execution.claim(h.authority)).toBeNull();expect(store.execution.readVerificationPlan(h.authority,claim.attemptId)).toEqual(saved);
 store.observe(h.authority,observation("new-after-plan"));
 expect(store.issue(workspaceId,issueId).status).toBe("queued");
 expect(store.execution.readVerificationPlan(h.authority,claim.attemptId)).toEqual(saved);
 expect(store.execution.claim(h.authority)!.attempt.role).toBe("investigation");
});

it("returns a cancelled waiting Test to repair when new original facts invalidate its frozen input",()=>{
 const h=waitingVerification();store.observe(h.authority,observation("new-while-waiting"));
 expect(()=>store.execution.verificationCurrent(h.verifier.claim)).toThrow(/observations changed/);
 store.execution.cancelWaitingVerification(h.authority,h.verifier.claim.attemptId);
 expect(store.issue(workspaceId,issueId).status).toBe("queued");expect(store.execution.claim(h.authority)!.attempt.role).toBe("investigation");
});
