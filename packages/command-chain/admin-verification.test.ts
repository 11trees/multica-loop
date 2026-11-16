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
function setup(authorize=true) {
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
 store.execution.bind(claim,{pid:41,marker:"repair-fixture-birth",group_id:41});
 if(authorize){store.execution.authorizeRepairWrite(claim,"Repair the original project");store.execution.recordRepairCandidate(claim,"actual");}
 command({action:"evidence",key:"actual-change",kind:"change",payload:{observation:"Candidate change was inspected"}});
 const result={outcome:"verification-requested",summary:"Request separate original-contract checks",repairVersion:version,originalObservationIds:["second","first"],repairEvidenceKeys:["actual-change","native-candidate/actual"],verification:{reproductionCommand:"REPAIRER_PROPOSED_COMMAND",versionCheckCommand:"REPAIRER_PROPOSED_VERSION",acceptanceChecks:[{targetRef:"invented-replacement",command:"REPAIRER_PROPOSED_ACCEPTANCE",expected:"Do not inherit this oracle"}]}};
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
 expect(()=>store.execution.prepareVerification(h.claim)).toThrow(/authorized cohort|cannot be replaced/);
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
 expect(store.execution.readVerificationPlan(h.authority,claim.attemptId)).toEqual(saved);
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

async function nativeExecution(){
 const {verificationArtifactsHash}=await import("./repair-verification-plan"),h=waitingVerification(),preparer=h.verifier.claim;
 store.execution.recordTakeoverProgress(preparer,h.progress);store.execution.launchVerification(preparer);store.execution.bind(preparer,{pid:42,marker:"preparation-birth",group_id:42});
 const {input}=store.execution.verificationCurrent(preparer,true),files=[{kind:"file" as const,path:"check.cjs",hash:"f".repeat(64),size:20,mode:384}],artifacts={directory:"/fixture/retained-plan",mode:448,files,hash:verificationArtifactsHash(files,448)};
 store.execution.recordVerificationPlan(preparer,{proposed:{reproduction:{targetRef:"original-failures",command:"node check.cjs reproduce"},acceptanceChecks:input.targets.map(target=>({targetRef:target.targetRef,command:"node check.cjs actual-target"}))},artifacts});
 store.execution.finish(preparer,{exit_confirmed:true,reason:"Independent author physically ended"});
 const executor=store.execution.claim(h.authority)!;
 expect(executor.attempt).toMatchObject({role:"verification-execution",status:"waiting",verification:{sourcePreparationAttemptId:preparer.attemptId}});
 expect(()=>store.execution.command(executor.claim,{action:"status"})).toThrow(/no Admin command/);
 store.execution.recordTakeoverProgress(executor.claim,h.progress);store.execution.launchVerification(executor.claim);store.execution.bind(executor.claim,{pid:43,marker:"native-birth",group_id:43});
 return {...h,executor,input,result:(kind:string)=>({exitCode:0,stdout:kind.startsWith("version-")?version:"Actual assertion ran",stderr:"",exitConfirmed:true,truncated:false,scopeConfirmed:true,artifactsUnchanged:true,workerPID:43,workerMarker:"native-birth"})};
}
it("executes the exact ordered plan once and requires every native witness plus final worker exit",async()=>{
 const h=await nativeExecution(),claim=h.executor.claim,total=h.input.targets.length+3;
 expect(()=>store.execution.startIndependentCheck(claim,1)).toThrow(/skipped/);
 for(let index=0;index<total;index++){
  const step=store.execution.startIndependentCheck(claim,index);
  expect(()=>store.execution.startIndependentCheck(claim,index)).toThrow(/replayed/);
  const result=h.result(step.kind);
  expect(()=>store.execution.finishIndependentCheck(claim,{ordinal:index,result:{...result,workerMarker:"foreign"}})).toThrow(/another native worker/);
  expect(store.execution.finishIndependentCheck(claim,{ordinal:index,result})).toEqual({recorded:true});
  expect(store.execution.finishIndependentCheck(claim,{ordinal:index,result})).toEqual({recorded:true});
  expect(()=>store.execution.finishIndependentCheck(claim,{ordinal:index,result:{...result,stdout:"replace"}})).toThrow(/cannot be replaced/);
 }
 const receipt=store.execution.compileIndependentVerification(claim,true,true);
 expect(receipt).toMatchObject({passed:true,exitConfirmed:true,workerExitConfirmed:true,expectedVersion:version});expect(receipt.checks).toHaveLength(total);
 expect(store.execution.finish(claim,{exit_confirmed:false,reason:"Worker group remains"})).toEqual({settled:false});expect(store.issue(workspaceId,issueId).status).toBe("running");
 store.execution.finish(claim,{exit_confirmed:true,reason:"Native worker group confirmed gone"});expect(store.issue(workspaceId,issueId)).toMatchObject({status:"verified",observation_count:2});
 expect(store.execution.claim(h.authority)).toBeNull();store.close();store=new AdminStore(filename,()=>now);expect(store.execution.readIndependentVerificationReceipt(h.authority,claim.attemptId)).toEqual(receipt);
 store.observe(h.authority,observation("new-after-verification"));expect(store.issue(workspaceId,issueId).status).toBe("queued");expect(store.execution.readIndependentVerificationReceipt(h.authority,claim.attemptId)).toEqual(receipt);
});
it("keeps failed native evidence after scope changes and does not continue or upgrade the receipt",async()=>{
 const h=await nativeExecution(),claim=h.executor.claim;
 const step=store.execution.startIndependentCheck(claim,0);
 store.observe(h.authority,observation("new-during-check"));
 store.execution.finishIndependentCheck(claim,{ordinal:0,result:{...h.result(step.kind),scopeConfirmed:false,stderr:"Original source changed while checking"}});
 expect(()=>store.execution.startIndependentCheck(claim,1)).toThrow();
 const receipt=store.execution.compileIndependentVerification(claim,true,true,"Changed original source");expect(receipt.passed).toBe(false);expect(receipt.checks[0]!.result!.stderr).toContain("source changed");
 expect(()=>store.execution.compileIndependentVerification(claim,true,true,"Replace failure history")).toThrow(/cannot be replaced/);
 store.execution.finish(claim,{exit_confirmed:true,reason:"Group gone"});expect(store.issue(workspaceId,issueId)).toMatchObject({status:"queued",observation_count:3});
});
it("cannot pass partial, truncated or physically unsettled native verification",async()=>{
 const h=await nativeExecution(),claim=h.executor.claim,step=store.execution.startIndependentCheck(claim,0);
 store.execution.finishIndependentCheck(claim,{ordinal:0,result:{...h.result(step.kind),truncated:true,exitConfirmed:false}});
 expect(()=>store.execution.startIndependentCheck(claim,1)).toThrow(/continue after failure/);
 expect(store.execution.compileIndependentVerification(claim,false,true)).toMatchObject({passed:false,exitConfirmed:false,workerExitConfirmed:false});
 expect(()=>store.execution.compileIndependentVerification(claim,true,true)).toThrow(/cannot be replaced/);
 store.execution.finish(claim,{exit_confirmed:true,reason:"Later physical cleanup confirmed"});expect(store.issue(workspaceId,issueId).status).toBe("queued");
});

it.each(["wrong-final-version","unconfirmed-worker","final-native-scope"])("does not pass otherwise complete checks with %s",async mode=>{
 const h=await nativeExecution(),claim=h.executor.claim,total=h.input.targets.length+3;
 for(let index=0;index<total;index++){
  const step=store.execution.startIndependentCheck(claim,index),result=h.result(step.kind);
  if(mode==="wrong-final-version"&&index===total-1)result.stdout=version.replaceAll("b","d");
  store.execution.finishIndependentCheck(claim,{ordinal:index,result});
 }
 const receipt=store.execution.compileIndependentVerification(claim,mode!=="unconfirmed-worker",mode!=="final-native-scope");expect(receipt.passed).toBe(false);
 store.execution.finish(claim,{exit_confirmed:true,reason:"Worker eventually cleaned up"});expect(store.issue(workspaceId,issueId).status).toBe("queued");
});

it("rechecks the complete saved receipt against actual journal facts before marking repair verified",async()=>{
 const h=await nativeExecution(),claim=h.executor.claim,total=h.input.targets.length+3;
 for(let index=0;index<total;index++){const step=store.execution.startIndependentCheck(claim,index);store.execution.finishIndependentCheck(claim,{ordinal:index,result:h.result(step.kind)});}
 const receipt=store.execution.compileIndependentVerification(claim,true,true);expect(receipt.passed).toBe(true);
 const changed={...receipt,checks:receipt.checks.map((check,index)=>index===0?{...check,result:{...check.result!,stdout:"fabricated retained version"}}:check)};
 const db=new DatabaseSync(filename);db.prepare("UPDATE admin_verification_receipt SET payload=? WHERE attempt_id=?").run(JSON.stringify(changed),claim.attemptId);db.close();
 store.execution.finish(claim,{exit_confirmed:true,reason:"Actual worker exited"});expect(store.issue(workspaceId,issueId).status).toBe("queued");
});

it("requires a host write grant and native candidate evidence before accepting verification",()=>{
 const h=setup(false);
 expect(h.command({action:"workspace-write",reason:"Repair the original project"})).toEqual({host_required:true});
 expect(store.execution.repairWrite(h.claim.attemptId)).toBeNull();
 expect(()=>store.execution.recordRepairCandidate(h.claim,"actual")).toThrow(/write authorization/);
 expect(()=>h.command({action:"evidence",key:"native-candidate/actual",kind:"change",payload:{forged:true}})).toThrow(/reserved/);
 expect(()=>h.command({action:"submit",result:{...h.result,repairEvidenceKeys:["actual-change"]}})).toThrow(/native repair candidate/);
 const grant=store.execution.authorizeRepairWrite(h.claim,"Repair the original project");
 expect(grant.body).toMatchObject({pid:41,baselineVersion:version,workspaceRoot:"/fixture/root",originalObservationIds:["first","second"]});
 const candidate=store.execution.recordRepairCandidate(h.claim,"actual");
 expect(candidate.body).toMatchObject({grantHash:grant.hash,evidenceKey:"native-candidate/actual",version});
 expect(h.command({action:"submit",result:h.result})).toMatchObject({submitted:true});
 expect(()=>store.execution.recordRepairCandidate(h.claim,"later")).toThrow(/before submission/);
 store.execution.prepareVerification(h.claim);
 expect(store.execution.verificationInput(h.claim.attemptId)?.nativeCandidateHash).toBe(candidate.hash);
});
it("retains the original write baseline and immutable candidate keys across real version updates",()=>{
 const h=setup(),grant=store.execution.repairWrite(h.claim.attemptId),nextVersion=version.replaceAll("b","d");
 store.execution.recordTakeoverProgress(h.claim,{...h.progress,workspace_version:nextVersion});
 expect(store.execution.authorizeRepairWrite(h.claim,"Repair the original project")).toEqual(grant);
 expect(()=>store.execution.authorizeRepairWrite(h.claim,"Replace reason")).toThrow(/reason cannot be replaced/);
 expect(()=>store.execution.recordRepairCandidate(h.claim,"actual")).toThrow(/key cannot be replaced/);
 const next=store.execution.recordRepairCandidate(h.claim,"next");
 expect(next.body.version).toBe(nextVersion);expect(store.execution.recordRepairCandidate(h.claim,"next")).toEqual(next);
 expect(()=>h.command({action:"submit",result:{...h.result,repairVersion:nextVersion}})).toThrow(/native repair candidate/);
 expect(h.command({action:"submit",result:{...h.result,repairVersion:nextVersion,repairEvidenceKeys:[next.body.evidenceKey]}})).toMatchObject({submitted:true});
 expect(store.execution.repairWrite(h.claim.attemptId)).toEqual(grant);
});
it("does not inherit write permission across changed cohorts, originals or stopped intent",()=>{
 const h=setup();store.execution.recordTakeoverProgress(h.claim,{...h.progress,targets_hash:"e".repeat(64)});
 expect(()=>store.execution.recordRepairCandidate(h.claim,"changed-cohort")).toThrow(/authorization changed/);
 store.execution.recordTakeoverProgress(h.claim,h.progress);store.observe(h.authority,observation("new-original"));
 expect(()=>store.execution.authorizeRepairWrite(h.claim,"Repair the original project")).toThrow(/authorization changed/);
 store.execution.setIntent({intent:"stopped",request_id:"stop-writes"});
 expect(()=>store.execution.recordRepairCandidate(h.claim,"after-stop")).toThrow(/identity, intent or generation/);
 expect(store.execution.repairCandidates(h.claim.attemptId)).toHaveLength(1);
});
it("rejects changed native candidate identity when reading a frozen verification input",()=>{
 const h=setup();h.command({action:"submit",result:h.result});store.execution.prepareVerification(h.claim);
 const db=new DatabaseSync(filename),row=db.prepare("SELECT payload FROM admin_repair_candidate").get()!,candidate=JSON.parse(String(row.payload));candidate.body.version=version.replaceAll("b","d");db.prepare("UPDATE admin_repair_candidate SET payload=?").run(JSON.stringify(candidate));db.close();
 expect(()=>store.execution.verificationInput(h.claim.attemptId)).toThrow(/candidate receipt changed/);
});

async function settledHandoff(){const h=await nativeExecution(),claim=h.executor.claim;for(let ordinal=0;ordinal<h.input.targets.length+3;ordinal++){const step=store.execution.startIndependentCheck(claim,ordinal);store.execution.finishIndependentCheck(claim,{ordinal,result:h.result(step.kind)});}store.execution.compileIndependentVerification(claim,true,true);store.execution.finish(claim,{exit_confirmed:true,reason:"Trusted host confirmed physical worker exit"});return h;}
it("prepares verified handoff identity only from the complete settled native receipt",async()=>{
 const h=await settledHandoff();
 const context=store.execution.handoffContext(h.authority,h.claim.caseId);
 expect(context.target).toMatchObject({caseId:h.claim.caseId,verificationAttemptId:h.executor.claim.attemptId,sourceRepairAttemptId:h.claim.attemptId,expectedVersion:version,originalObservationIds:["first","second"]});
 expect(context.request.claim.attemptId).toBe(h.executor.claim.attemptId);
 expect(store.execution.pendingHandoffs(h.authority)).toEqual([{case_id:h.claim.caseId}]);
 const prepared={prepared:true as const,hash:"f".repeat(64),target_hash:context.target_hash,continuation:{workspace_id:workspaceId,issue_id:issueId,agent_id:randomUUID(),user_id:randomUUID(),task_id:randomUUID(),expected_revision:1,expected_sequence:4,reason:"repair_ready" as const},kind:"yaml" as const,draft_id:randomUUID()};
 expect(store.execution.recordHandoffPreparation(h.authority,h.claim.caseId,prepared)).toEqual(prepared);
 expect(()=>store.execution.recordHandoffPreparation(h.authority,h.claim.caseId,{...prepared,hash:"e".repeat(64)})).toThrow(/cannot be replaced/);
 store.close();store=new AdminStore(filename,()=>now);expect(store.execution.handoffContext(h.authority,h.claim.caseId)).toMatchObject({target_hash:context.target_hash,preparation:prepared});
 expect(store.issue(workspaceId,issueId).status).toBe("verified");expect(store.execution.claim(h.authority)).toBeNull();
 store.execution.setIntent({intent:"stopped",request_id:"stop-handoff"});expect(()=>store.execution.handoffContext(h.authority,h.claim.caseId)).toThrow(/running intent/);expect(store.execution.pendingHandoffs(h.authority)).toEqual([]);
 now+=30001;const successor=store.acquireSupervisor("successor",30000,true)!;store.execution.setIntent({intent:"running",request_id:"resume-handoff"});
 expect(()=>store.execution.handoffContext(h.authority,h.claim.caseId)).toThrow(/authority/);
 expect(store.execution.handoffContext(successor,h.claim.caseId).target_hash).toBe(context.target_hash);
});
it("refuses handoff before physical settlement, after new originals or after receipt corruption",async()=>{
 const h=await nativeExecution();expect(()=>store.execution.handoffContext(h.authority,h.claim.caseId)).toThrow(/settled verified/);
});
it("recompiles a settled receipt before preparing a native handoff",async()=>{
 const h=await settledHandoff(),db=new DatabaseSync(filename),row=db.prepare("SELECT payload FROM admin_verification_receipt WHERE attempt_id=?").get(h.executor.claim.attemptId)!,receipt=JSON.parse(String(row.payload));receipt.checks[0].result.stdout="forged-version";db.prepare("UPDATE admin_verification_receipt SET payload=? WHERE attempt_id=?").run(JSON.stringify(receipt),h.executor.claim.attemptId);db.close();
 expect(()=>store.execution.handoffContext(h.authority,h.claim.caseId)).toThrow(/no longer compiles/);
});
it("keeps previous native handoff preparation but invalidates readiness for new original facts",async()=>{
 const h=await settledHandoff();store.execution.handoffContext(h.authority,h.claim.caseId);store.observe(h.authority,observation("after-handoff-preparation"));
 expect(store.execution.pendingHandoffs(h.authority)).toEqual([]);expect(()=>store.execution.handoffContext(h.authority,h.claim.caseId)).toThrow(/settled verified/);
});
