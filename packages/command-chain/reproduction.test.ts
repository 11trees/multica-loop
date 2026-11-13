// @vitest-environment node
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {stringify} from "yaml";
import {beforeEach,afterEach,it,expect} from "vitest";
import {CommandChainEngine,type ChainCommand} from "./runtime";
import {SqliteDraftStore} from "./sqlite-store";
import {parseCommandChainDefinition} from "./definition";
import {createReproductionHandlers,compileReproductionConclusion,reproductionProfile,type ReproductionContract} from "./reproduction";

const contract:ReproductionContract={binding:{workspaceId:"workspace",issueId:"bug",revision:1,contractVersion:"frozen-context",codeVersion:"original-commit"},decisionMode:"balanced",contextRef:"CONTEXT:1",contextFingerprint:"a".repeat(64),contextContent:"Existing business rules and reported mismatch",expectedBehavior:"Continue activates the next page"};
let directory:string,store:SqliteDraftStore;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"reproduction-"));store=new SqliteDraftStore(join(directory,"draft.sqlite"));});
afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
async function setup(status:"reproduced"|"not_reproduced"="reproduced"){
  const engine=new CommandChainEngine(store,createReproductionHandlers(contract)),chain=parseCommandChainDefinition(await readFile(new URL("./definitions/reproduction.yaml",import.meta.url),"utf8"),reproductionProfile);
  let draft=await engine.create({id:"reproduction",chain,binding:contract.binding,attemptId:"first"});
  const command=async(command:ChainCommand)=>draft=await engine.execute(draft.id,{expectedSequence:draft.sequence,attemptId:draft.attemptId},command);
  const put=(block:string,value:unknown,key?:string)=>command({type:"artifact.put",ref:`reproduction.${block}`,key,content:typeof value === "string" ? value : stringify(value)}),next=()=>command({type:"phase.complete"});
  const investigate=async(status:"reproduced"|"not_reproduced")=>{
    await put("verdict",{status,expectedBehavior:contract.expectedBehavior,actualBehavior:status === "reproduced" ? "Continue does nothing" : "Continue activates normally",environment:"Local page with saved reading state",stability:"Three observations",impactScope:"Reader Continue action"});
    await put("steps",{action:"Activate Continue",expected:contract.expectedBehavior,actual:status === "reproduced" ? "No navigation" : "Next page opens"},"activate");await put("evidence",{kind:"observation",content:"Observed current page after activation",source:"browser:local/index.html"},"browser");
  };
  await investigate(status);
  return {engine,get draft(){return draft;},command,put,next,investigate,resume:async()=>{draft=await engine.resume(draft.id,(await engine.read(draft.id)).sequence,"second");}};
}
it("imports the original phases and compiles complete reproduced evidence without requiring a hypothesis",async()=>{
  const s=await setup();expect(Object.keys(s.draft.definition.phases)).toEqual(["investigation","alignment_proposal","alignment_resolution","answer_review","finalize"]);
  await s.next();await s.next();await s.next();await s.put("answer-review","No human facts missing; existing Expected preserved");await s.next();await s.next();
  const result=compileReproductionConclusion(s.draft,contract);expect(result).toMatchObject({verdict:{status:"reproduced",expectedBehavior:contract.expectedBehavior},hypotheses:[],binding:contract.binding});expect(result.report).toContain("browser:local/index.html");
  store.close();store=new SqliteDraftStore(join(directory,"draft.sqlite"));expect(compileReproductionConclusion((await store.read(s.draft.id))!,contract)).toEqual(result);
});
it.each(["expected","steps","evidence","not_reproduced"])("rejects an invalid %s reproduction",async(failure)=>{
  const s=await setup(failure === "not_reproduced" ? "not_reproduced" : "reproduced");
  if(failure === "expected"){await s.put("verdict",{status:"reproduced",expectedBehavior:"Any output is acceptable",actualBehavior:"No output",environment:"Local",stability:"Once",impactScope:"Continue"});await expect(s.next()).rejects.toThrow(/Existing Expected/);return;}
  if(failure === "steps" || failure === "evidence"){await s.command({type:"artifact.remove",ref:`reproduction.${failure}`,key:failure === "steps" ? "activate" : "browser"});await expect(s.next()).rejects.toThrow(/required|至少|missing/i);return;}
  await s.next();await s.next();await s.next();await s.put("answer-review","No missing facts yet observed");await s.next();await expect(s.next()).rejects.toThrow(/Only a reproduced/);
});
it("waits for authenticated human facts, fences the previous attempt and requires renewed investigation before planning",async()=>{
  const s=await setup("not_reproduced");await s.next();await s.command({type:"decision.propose",decision:{key:"state",type:"technical",title:"Saved state",question:"Which state?",impact:"Reproduction condition",options:[{id:"saved",label:"Saved",consequence:"Use saved state"},{id:"empty",label:"Empty",consequence:"Use empty state"}],recommendation:{option:"saved",reason:"Report",authority:"user"},dependencies:[]}});await s.next();await s.command({type:"decision.ask",key:"state"});await s.next();expect(s.draft.status).toBe("waiting_for_answers");
  const q=s.draft.runtimeInputs[0]!;await s.engine.answerRuntimeInput(s.draft.id,{expectedSequence:s.draft.sequence,requestId:q.id,userId:"human",selectedOption:"saved",answer:"Use saved state"});await s.resume();
  await expect(s.engine.execute(s.draft.id,{expectedSequence:s.draft.sequence,attemptId:"first"},{type:"phase.complete"})).rejects.toThrow(/attempt|owner|stale/i);
  await s.command({type:"decision.resolve",key:"state",option:"saved",authority:"user",decision:"Use saved state",rationale:"Authenticated fact",evidence:q.id});await s.next();await s.put("answer-review","Saved state needs new observation");await s.next();await expect(s.next()).rejects.toThrow(/Only a reproduced/);
  await s.command({type:"phase.rewind",to:"investigation",reason:"Observe the authenticated saved-state condition"});expect(s.draft.artifacts).toHaveLength(0);await s.investigate("reproduced");await s.next();await s.next();await s.next();await s.put("answer-review","Fresh observations under saved state now reproduce the mismatch");await s.next();await s.next();const conclusion=compileReproductionConclusion(s.draft,contract);expect(conclusion.decisions[0]?.resolution?.userId).toBe("human");expect(conclusion.history[0]?.artifacts.find(item=>item.ref === "reproduction.verdict")?.content).toContain("not_reproduced");expect(conclusion.verdict?.status).toBe("reproduced");
});
it("does not ask for human facts after claiming reproduced, including generic runtime inputs",async()=>{
  const s=await setup();await s.next();await s.next();await s.command({type:"runtime-input.put",key:"environment",title:"Environment",question:"Which state?",why:"Condition",recommendation:"Saved"});await expect(s.next()).rejects.toThrow(/Only not_reproduced/);expect(s.draft.status).toBe("editing");
});
it("rejects stale frozen reproduction bindings",async()=>{const s=await setup();await s.next();await s.next();await s.next();await s.put("answer-review","Existing facts agree");await s.next();await s.next();expect(()=>compileReproductionConclusion(s.draft,{...contract,binding:{...contract.binding,codeVersion:"other"}})).toThrow(/binding changed/);});
