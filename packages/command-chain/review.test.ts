// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { beforeEach, afterEach, it, expect } from "vitest";
import { CommandChainEngine, type ChainDraft, type ChainCommand } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";
import { parseCommandChainDefinition } from "./definition";
import { compileReviewConclusion, createReviewHandlers, reviewContractSchema, reviewGapSources, reviewProfile, type ReviewContract } from "./review";

const contract:ReviewContract={binding:{workspaceId:"workspace",issueId:"requirement",revision:1,contractVersion:"frozen-review",codeVersion:"final-commit"},generation:1,
  subjects:[{key:"intent",kind:"intent",content:"Reader continues",requiredEvidenceRefs:["test:first","test:second"]},{key:"acceptance",kind:"acceptance",content:"Continue activates",sourceRef:"ACCEPTANCE:action:r1",requiredEvidenceRefs:["test:second"]}],
  evidence:[{ref:"context",kind:"requirement-context",status:"completed",revision:"1",fingerprint:"0".repeat(64),independentTest:false,content:"Original requirement"},...['first','second'].map(key=>({ref:`test:${key}`,kind:"independent-verification",status:"passed",revision:"1",fingerprint:"a".repeat(64),independentTest:true,content:`Actual ${key} verification conclusion`}))]};
let directory:string,store:SqliteDraftStore;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"multica-review-"));store=new SqliteDraftStore(join(directory,"drafts.sqlite"));});
afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
async function setup(input=contract){
  const engine=new CommandChainEngine(store,createReviewHandlers(input));
  const chain=parseCommandChainDefinition(await readFile(new URL("./definitions/review.yaml",import.meta.url),"utf8"),reviewProfile);
  let draft=await engine.create({id:"review-draft",chain,binding:input.binding,attemptId:"review-attempt"});
  const command=async(command:ChainCommand)=>draft=await engine.execute(draft.id,{expectedSequence:draft.sequence,attemptId:draft.attemptId},command);
  const put=(block:string,value:unknown,key?:string)=>command({type:"artifact.put",ref:`review.${block}`,key,content:stringify(value)});
  const next=()=>command({type:"phase.complete"});await next();
  return {engine,get draft(){return draft;},command,put,next};
}
it("clones a pinned report correction without turning its instructions into independent delivery proof",async()=>{
 const baselineRef="REPORT_BASELINE:original",input=reviewContractSchema.parse({...contract,correction:{batchId:"batch",groupId:"wording",baselineDraftId:"original",baselineHash:"b".repeat(64),baselineReport:"Original complete report",sections:["outcome","scope","implementation","verification","risks"].map(kind=>({key:kind,kind,content:`Retain original ${kind}`})),assessment:{summary:"Original assessment",evidenceBoundary:"Local environment only",residualRisk:"No packaged deployment acceptance"}},subjects:[...contract.subjects,{key:"FEEDBACK_GROUP:wording:report_correction",kind:"feedback_acceptance",content:"Correct environment wording",requiredEvidenceRefs:[baselineRef]}],evidence:[...contract.evidence,{ref:baselineRef,kind:"report-baseline",status:"completed",revision:"1",fingerprint:"b".repeat(64),independentTest:false,content:"Original complete report"}]});
 const session=await setup(input);expect(session.draft.artifacts.filter(item=>item.ref === "review.report-sections")).toHaveLength(5);expect(session.draft.artifacts.find(item=>item.ref === "review.meta")?.content).toContain("mode: report_correction");
 await expect(session.command({type:"runtime-input.put",key:"change",title:"Meaning",question:"Change delivery?",why:"Scope",recommendation:"No"})).rejects.toThrow();
 await session.put("gaps",{subjectRef:input.subjects[0]!.key,kind:"fact_conflict",reason:"Cannot change facts",boundary:"Return to triage"},"wrong");await expect(session.next()).rejects.toThrow(/expression correction/);await session.command({type:"artifact.remove",ref:"review.gaps",key:"wrong"});
 for(const [i,subject] of input.subjects.entries())await session.put("reconciliations",{subjectRef:subject.key,result:"Retained accepted facts; scoped expression corrected",evidenceRefs:subject.requiredEvidenceRefs},`s${i}`);
 await session.next();await session.next();await session.put("report-sections",{kind:"verification",content:"Independent tests ran locally"},"verification");await session.next();await session.next();const result=compileReviewConclusion(session.draft,input);expect(result.report).toContain("No packaged deployment acceptance");expect(result.report).toContain("Retain original scope");expect(result.report).toContain("Independent tests ran locally");expect(result.units).toEqual([]);
 expect(()=>reviewContractSchema.parse({...input,correction:undefined})).toThrow(/independent passed/);expect(()=>reviewContractSchema.parse({...input,subjects:input.subjects.map(item=>item.key.includes("report_correction") ? {...item,kind:"intent"} : item)})).toThrow(/independent passed/);
});
async function assessed(gap=false,both=false){
  const session=await setup();
  if(both)await session.put("gaps",{subjectRef:"intent",kind:"missing_evidence",reason:"Overall outcome not verified",boundary:"Observe original intent"},"intent");
  else await session.put("reconciliations",{subjectRef:"intent",result:"Both reader outcomes align",evidenceRefs:["test:first","test:second"]},"intent");
  if(gap)await session.put("gaps",{subjectRef:"acceptance",kind:"missing_evidence",reason:"Combined final behavior was not observed",boundary:"Observe Continue on the final combined commit"},"combined");
  else await session.put("reconciliations",{subjectRef:"acceptance",result:"Continue observed",evidenceRefs:["test:second"]},"action");
  await session.next();await session.put("assessment",{summary:"Requirement-level fact assessment",evidenceBoundary:"Both exact independent verification references; final commit is explicit",residualRisk:"External deployments were not tested"});await session.next();return session;
}
it("imports the actual review phase order and compiles a source-bound report only after all gates",async()=>{
  const session=await assessed();expect(Object.keys(session.draft.definition.phases)).toEqual(["inputs","fact_reconciliation","closure_assessment","closure_output","finalize"]);
  for(const kind of ["outcome","scope","implementation","verification","risks"])await session.put("report-sections",{kind,content:`Current ${kind} with original provenance`},kind);
  await session.next();expect(()=>compileReviewConclusion(session.draft,contract)).toThrow(/not completed/);await session.next();
  const conclusion=compileReviewConclusion(session.draft,contract);expect(conclusion).toMatchObject({verdict:"report_ready",binding:contract.binding,generation:1,gaps:[],units:[]});expect(conclusion.report).toContain("External deployments were not tested");
  store.close();store=new SqliteDraftStore(join(directory,"drafts.sqlite"));expect(compileReviewConclusion((await store.read(session.draft.id))!,contract)).toEqual(conclusion);
});
it("does not accept supporting facts, unrelated unit tests or duplicate handling as closure proof",async()=>{
  const session=await setup();
  await session.put("reconciliations",{subjectRef:"intent",result:"Claim",evidenceRefs:["context","test:first"]},"intent");await expect(session.next()).rejects.toThrow(/independent verification.*scope/);
  await session.put("reconciliations",{subjectRef:"intent",result:"Claim",evidenceRefs:["test:first","test:second"]},"intent");await session.put("reconciliations",{subjectRef:"acceptance",result:"Claim",evidenceRefs:["test:first"]},"action");await expect(session.next()).rejects.toThrow(/independent verification.*scope/);
  await session.put("reconciliations",{subjectRef:"acceptance",result:"Observed",evidenceRefs:["test:second"]},"action");await session.put("gaps",{subjectRef:"acceptance",kind:"fact_conflict",reason:"Conflict",boundary:"Resolve conflict"},"conflict");await expect(session.next()).rejects.toThrow(/exactly one/);
});
it("freezes evidence and rejects stale bindings, fingerprints and missing current passed proof",async()=>{
  const session=await setup();await expect(session.put("subjects",{kind:"intent",content:"Weaker scope"},"intent")).rejects.toThrow(/readonly|outside/);
  const changed=structuredClone(contract);changed.evidence[1]!.fingerprint="b".repeat(64);await expect(new CommandChainEngine(store,createReviewHandlers(changed)).execute(session.draft.id,{expectedSequence:session.draft.sequence,attemptId:session.draft.attemptId},{type:"phase.complete"})).rejects.toThrow(/Frozen review/);
  const draft:ChainDraft=structuredClone(session.draft);draft.binding.codeVersion="different-final-commit";expect(()=>compileReviewConclusion(draft,contract)).toThrow(/binding changed/);
  changed.evidence[1]!.status="failed";expect(()=>reviewContractSchema.parse(changed)).toThrow(/independent passed/);
});
it("compiles closure gaps into complete forward units instead of a report",async()=>{
  const session=await assessed(true);await expect(session.next()).rejects.toThrow(/forward delivery units|covered exactly once/);
  await session.put("forward-units",{title:"Combined reader behavior",actor:"Reader",trigger:"Activate Continue",observableOutcome:"Continued on final combined page",acceptance:"Observe the original Continue oracle on final commit",gapKeys:["combined"],dependsOn:[]},"combined");
  await session.next();await session.next();expect(compileReviewConclusion(session.draft,contract)).toMatchObject({verdict:"closure_gap",report:null,gaps:[{key:"combined",subjectRef:"acceptance"}],units:[{key:"combined",gapKeys:["combined"]}]});
});
it("retains full subject context and the exact source review identity across bounded chunks",()=>{
  const content="Original acceptance clause. ".repeat(400),subjects=[{...contract.subjects[1]!,content}];
  const sources=reviewGapSources(subjects,[{key:"combined",subjectRef:subjects[0]!.key,kind:"missing_evidence",reason:"Missing final observation",boundary:"Observe original behavior"}],"source-review");
  expect(sources.filter(item=>item.key.includes(":subject:")).map(item=>item.content).join("")).toBe(content);expect(sources.every(item=>item.content.length<=4000)).toBe(true);expect(sources.at(-1)?.sourceRef).toBe("REVIEW_GAP:source-review:combined");
});
it("pauses fact reconciliation for an authenticated answer and fences the previous attempt",async()=>{
  const session=await setup();await session.command({type:"runtime-input.put",key:"evidence",title:"Evidence provenance",question:"Which recorded observation should be reconciled?",why:"Resolve a source ambiguity",recommendation:"Use the retained independent result"});await session.next();expect(session.draft.status).toBe("waiting_for_answers");
  const question=session.draft.runtimeInputs[0]!;await session.engine.answerRuntimeInput(session.draft.id,{expectedSequence:session.draft.sequence,requestId:question.id,answer:"Use the retained independent result",userId:"authenticated-human"});const answered=(await store.read(session.draft.id))!;
  const resumed=await session.engine.resume(answered.id,answered.sequence,"new-review-attempt");expect(resumed.runtimeInputs[0]!.answer).toMatchObject({userId:"authenticated-human"});await expect(session.engine.execute(resumed.id,{expectedSequence:resumed.sequence,attemptId:"review-attempt"},{type:"phase.complete"})).rejects.toThrow(/run attempt/);
});
it.each(["missing","unknown","duplicate","cycle","mixed"])("rejects %s gap forwarding outputs",async(failure)=>{
  const session=await assessed(true,failure === "cycle"),unit={title:"Combined",actor:"Reader",trigger:"Continue",observableOutcome:"Continued",acceptance:"Original oracle",gapKeys:["combined"],dependsOn:[] as string[]};
  await session.put("forward-units",{...unit,...(failure === "unknown" ? {gapKeys:["invented"]} : {}),...(failure === "cycle" ? {dependsOn:["other"]} : {})},"combined");
  if(failure === "duplicate" || failure === "cycle")await session.put("forward-units",{...unit,title:"Other",gapKeys:failure === "duplicate" ? ["combined"] : ["intent"],dependsOn:["combined"]},"other");
  if(failure === "missing")await session.command({type:"artifact.remove",ref:"review.forward-units",key:"combined"});
  if(failure === "mixed")await session.put("report-sections",{kind:"outcome",content:"Premature report"},"outcome");
  await expect(session.next()).rejects.toThrow();
});
