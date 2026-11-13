// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,beforeEach,expect,it } from "vitest";
import { EngineeringApplication,type ApplicationRequest } from "./application";
import { compileAnalysisConclusion } from "./analysis";
import { decisionGraphErrors,decisionProposalSchema,decisionStateSchema } from "./decisions";

const human={kind:"human" as const,userId:"019a0000-0000-7000-8000-000000000001",workspaceId:"019a0000-0000-7000-8000-000000000002",issueId:"019a0000-0000-7000-8000-000000000003"};
const analyst="019a0000-0000-7000-8000-000000000004",developer="019a0000-0000-7000-8000-000000000005",verifier="019a0000-0000-7000-8000-000000000006";
const sources=[{key:"ac1",kind:"acceptance",description:"Ready heading",oracle:"Browser sees Ready",sourceRef:"AC:fixture:r1"}];
const unit={key:"unit-1",title:"Heading",actor:"Reader",trigger:"Open the page",observableOutcome:"Heading visible",acceptance:"Ready heading",sourceRefs:[{key:"ac1",kind:"acceptance",content:"Ready heading",sourceRef:"AC:fixture:r1"}],dependsOn:[] as string[]};
const proposal={key:"placement",type:"business",title:"Heading location",question:"Where should the heading appear?",impact:"Changes the reader's visible result",options:[{id:"top",label:"Top",consequence:"Visible before content"},{id:"bottom",label:"Bottom",consequence:"Visible after content"}],recommendation:{option:"top",reason:"Visible immediately",authority:"user"},dependencies:[]};
let directory:string,repository:string,database:string,app:EngineeringApplication,definitionSources:string[];
const actor=(agentId:string,attempt="1",issueId=human.issueId)=>({kind:"task" as const,workspaceId:human.workspaceId,issueId,agentId,attemptId:`${agentId}:${attempt}`});
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),"engineering-analysis-"));repository=join(directory,"repo");database=join(directory,"engineering.sqlite");
  execFileSync("git",["init","-q",repository]);execFileSync("git",["-C",repository,"config","user.name","Analysis fixture"]);execFileSync("git",["-C",repository,"config","user.email","fixture@example.invalid"]);
  await writeFile(join(repository,"README.md"),"Frozen fixture\n");execFileSync("git",["-C",repository,"add","."]);execFileSync("git",["-C",repository,"commit","-qm","Initialize fixture"]);
  definitionSources=await Promise.all(["verification","development","analysis"].map(name=>readFile(new URL(`./definitions/${name}.yaml`,import.meta.url),"utf8")));
  app=new EngineeringApplication(database,definitionSources[0]!,definitionSources[1],definitionSources[2]);
});
afterEach(async()=>{app.close();await rm(directory,{recursive:true,force:true});});
async function invoke(owner:ApplicationRequest["actor"],action:ApplicationRequest["action"],payload?:unknown){const result=await app.invoke({actor:owner,action,payload});if(!("draft" in result))throw new Error("Expected chain state");return result;}
const configure=(extra={})=>invoke(human,"configure",{expected_revision:0,agent_id:verifier,developer_agent_id:developer,analyst_agent_id:analyst,repository_path:repository,sources,unit,auto_continue:true,...extra});
async function start(owner=actor(analyst)){
  await app.invoke({actor:{...owner,kind:"daemon"},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]}});
  let state=await invoke(owner,"start");
  const command=async(command:unknown)=>{state=await invoke(owner,"command",{expected_sequence:state.draft!.sequence,command});return state;};
  return {owner,command,get state(){return state;}};
}
async function resolution(mode="balanced",type="business"){
  await configure({decision_mode:mode});const session=await start();
  await session.command({type:"phase.complete"});
  await session.command({type:"artifact.put",ref:"delivery-analysis.impacts",key:"header",content:"area: Page header\nfinding: Heading needs placement\ndisposition: needs_decision\nevidence: README.md:1\ndecision: placement"});
  await session.command({type:"phase.complete"});await session.command({type:"decision.propose",decision:{...proposal,type}});await session.command({type:"phase.complete"});return session;
}

it("pins analysis, pauses for an authenticated option choice, reviews it, and publishes unchanged acceptances to development",async()=>{
  let session=await resolution();
  expect(await app.invoke({actor:actor(analyst),action:"selection"})).toMatchObject({configured:true,chain:"analysis"});
  await expect(app.invoke({actor:{...actor(developer),kind:"daemon"},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]}})).rejects.toThrow(/Analysis has not handed off/);
  await expect(app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:human.issueId},action:"completion"})).rejects.toThrow(/Complete delivery analysis/);
  await expect(session.command({type:"decision.resolve",key:"placement",option:"top",authority:"user",decision:"Top",rationale:"Requested",evidence:"Invented human choice"})).rejects.toThrow(/authenticated matching/);
  await session.command({type:"decision.ask",key:"placement"});
  await expect(session.command({type:"runtime-input.put",key:session.state.draft!.runtimeInputs[0]!.key,title:"Changed",question:"Replace choice?",why:"Override",recommendation:"Yes"})).rejects.toThrow(/owned by decision commands/);
  await session.command({type:"phase.complete"});expect(session.state.draft?.status).toBe("waiting_for_answers");
  const question=session.state.draft!.runtimeInputs[0]!;
  expect(question.options).toEqual(proposal.options);
  await expect(invoke(human,"answer",{expected_sequence:session.state.draft!.sequence,request_id:question.id,answer:"",selected_option:"unknown"})).rejects.toThrow(/published decision options/);
  const answered=await invoke(human,"answer",{expected_sequence:session.state.draft!.sequence,request_id:question.id,answer:"",selected_option:"bottom"});
  expect(answered.draft?.runtimeInputs[0]?.answer).toMatchObject({text:"Bottom",selectedOption:"bottom",userId:human.userId});
  app.close();app=new EngineeringApplication(database,definitionSources[0]!,definitionSources[1],definitionSources[2]);
  expect(await app.invoke({actor:{kind:"coordinator"},action:"continuations"})).toEqual([expect.objectContaining({agent_id:analyst,reason:"human_answers"})]);
  session=await start(actor(analyst,"2"));
  await expect(session.command({type:"decision.resolve",key:"placement",option:"top",authority:"user",decision:"Top",rationale:"Ignored human",evidence:"Mismatch"})).rejects.toThrow(/authenticated matching/);
  await session.command({type:"decision.resolve",key:"placement",option:"bottom",authority:"user",decision:"Bottom",rationale:"Human selected bottom",evidence:question.id});
  await session.command({type:"artifact.put",ref:"delivery-analysis.impacts",key:"header",content:"area: Page header\nfinding: Place heading after content\ndisposition: change\nevidence: Human choice\ndecision: placement"});await session.command({type:"phase.complete"});
  await expect(session.command({type:"phase.complete"})).rejects.toThrow(/answer-review/);
  await session.command({type:"artifact.put",ref:"delivery-analysis.answer-review",content:"All choices and combined effects match the scope."});await session.command({type:"phase.complete"});
  for(const [block,content] of [["summary","A heading after content"],["contract","Render exact Ready after the existing content."],["guardrails","content: Preserve existing content\nrationale: User context stays visible"],["verification-focus","expected: Heading follows content\noracle: Browser DOM order matches the chosen placement"]])await session.command({type:"artifact.put",ref:`delivery-analysis.${block}`,...(block === "guardrails" || block === "verification-focus" ? {key:"layout"} : {}),content});
  await session.command({type:"phase.complete"});await session.command({type:"phase.complete",confirmation:"Impacts, human choice, and contract align"});
  const wrongRole=structuredClone(session.state.draft!);wrongRole.definition.agent="other-agent";
  expect(()=>compileAnalysisConclusion(wrongRole,session.state.contract as Parameters<typeof compileAnalysisConclusion>[1])).toThrow();
  expect(session.state.conclusion).toMatchObject({kind:"analysis",acceptances:sources,decisions:[{resolution:{option:"bottom",userId:human.userId}}]});
  expect(await app.invoke({actor:{kind:"coordinator"},action:"continuations"})).toEqual([expect.objectContaining({agent_id:developer,reason:"analysis_handoff"})]);
  const dev=await start(actor(developer));expect(dev.state.contract).toMatchObject({implementationGuidance:"Render exact Ready after the existing content.",sources:expect.arrayContaining(sources)});
  expect(dev.state.contract.sources.map(source=>source.kind)).toEqual(["acceptance","guardrail","focus"]);
});

it.each(["conservative","balanced","autonomous"])("keeps business choices outside agent authority in %s mode",async mode=>{
  const session=await resolution(mode);await expect(session.command({type:"decision.resolve",key:"placement",option:"top",authority:"agent_authority",decision:"Top",rationale:"Convenient",evidence:"Agent preference"})).rejects.toThrow(/exceeds/);
});
it("fully autonomous mode refuses decision questions and can close its delegated choice",async()=>{
  const session=await resolution("fully_autonomous");await expect(session.command({type:"decision.ask",key:"placement"})).rejects.toThrow(/cannot ask/);
  await session.command({type:"decision.resolve",key:"placement",option:"top",authority:"agent_authority",decision:"Top",rationale:"Delegated by frozen mode",evidence:"Repository context"});
});
it("requires a fresh human selection after reopening an answered decision",async()=>{
  const session=await resolution();await session.command({type:"decision.ask",key:"placement"});await session.command({type:"phase.complete"});
  await invoke(human,"answer",{expected_sequence:session.state.draft!.sequence,request_id:session.state.draft!.runtimeInputs[0]!.id,answer:"",selected_option:"top"});
  const next=await start(actor(analyst,"2"));await next.command({type:"decision.reopen",key:"placement"});
  await expect(next.command({type:"decision.resolve",key:"placement",option:"bottom",authority:"project_evidence",decision:"Bottom",rationale:"Override",evidence:"Later note"})).rejects.toThrow(/authenticated matching/);
  expect(next.state.draft!.runtimeInputs[0]!.active).toBe(false);
});
it("rejects cycles, dangling dependencies, duplicate options, and missing recommendations",()=>{
  expect(()=>decisionProposalSchema.parse({...proposal,options:[proposal.options[0],proposal.options[0]]})).toThrow(/unique/);
  expect(()=>decisionProposalSchema.parse({...proposal,recommendation:{...proposal.recommendation,option:"missing"}})).toThrow(/missing/);
  const node=(key:string,dependency:string)=>decisionStateSchema.parse({...proposal,key,status:"proposed",dependencies:[{decision:dependency,option:"top"}]});
  expect(decisionGraphErrors([node("a","b"),node("b","a")])).toContain("Decision graph must be acyclic");expect(decisionGraphErrors([node("a","missing")]).join()).toMatch(/missing dependency/);
});
it("does not accept dirty analysis evidence",async()=>{await configure();const session=await start();await writeFile(join(repository,"dirty.txt"),"Changed\n");await expect(invoke(session.owner,"read")).rejects.toThrow(/uncommitted/);});
it("requires an actual passed dependency and rejects missing or self-referential mappings",async()=>{
  await expect(configure({unit:{...unit,dependsOn:["prior"]}})).rejects.toThrow(/mapping is missing/);
  await expect(configure({unit:{...unit,dependsOn:["prior"]},dependency_issues:[{key:"prior",issue_id:human.issueId}]})).rejects.toThrow(/self-referential/);
  await expect(configure({unit:{...unit,dependsOn:["prior"]},dependency_issues:[{key:"prior",issue_id:"019a0000-0000-7000-8000-000000000099"}]})).rejects.toThrow(/registered current passed/);
});

async function passDependency(dependencyId:string,revision:number){
  const dependencyHuman={...human,issueId:dependencyId};
    await invoke(dependencyHuman,"configure",{expected_revision:revision,agent_id:verifier,repository_path:repository,sources});
    const session=await start(actor(verifier,`dependency-${revision}`,dependencyId));
    await session.command({type:"phase.complete"});await session.command({type:"artifact.put",ref:"verification.scenarios",key:"s1",content:"channel: frontend\ntitle: Dependency heading\nsetup: Open fixture\nsteps: Observe heading\nexpected: Ready\ncoverageRefs: [ac1]"});await session.command({type:"phase.complete"});
    await session.command({type:"artifact.put",ref:"verification.results",key:"s1",content:"status: passed\nevidence: Recorded dependency fixture observation"});await session.command({type:"phase.complete"});
    await session.command({type:"artifact.put",ref:"verification.evidence-review",content:"summary: Dependency observation checked"});await session.command({type:"phase.complete"});await session.command({type:"phase.complete"});
}

it("freezes real dependency verification versions and rejects a later passed replacement",async()=>{
  const dependencyId="019a0000-0000-7000-8000-000000000099";
  await passDependency(dependencyId,0);await configure({unit:{...unit,dependsOn:["prior"]},dependency_issues:[{key:"prior",issue_id:dependencyId}]});
  const session=await start();expect("dependencies" in session.state.contract && session.state.contract.dependencies[0]!.binding.revision).toBe(1);
  await writeFile(join(repository,"downstream.txt"),"Downstream work in the shared repository\n");
  expect(await app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:dependencyId},action:"verified-binding"})).toMatchObject({allowed:true,binding:{revision:1}});
  await expect(app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:dependencyId},action:"completion"})).rejects.toThrow(/uncommitted/);
  await rm(join(repository,"downstream.txt"));
  await passDependency(dependencyId,1);await expect(invoke(session.owner,"read")).rejects.toThrow(/Dependency prior changed/);
  await expect(app.invoke({actor:human,action:"prepare-run",payload:{expected_revision:1,expected_sequence:session.state.draft!.sequence}})).rejects.toThrow(/Dependency prior changed/);
  await expect(app.invoke({actor:session.owner,action:"selection"})).rejects.toThrow(/Dependency prior changed/);
});

it("can publish a valid long decision key without exceeding runtime-question key limits",async()=>{
  await configure();const session=await start();const key="d".repeat(240);
  await session.command({type:"phase.complete"});await session.command({type:"artifact.put",ref:"delivery-analysis.impacts",key:"header",content:`area: Header\nfinding: Placement\ndisposition: needs_decision\nevidence: README.md\ndecision: ${key}`});await session.command({type:"phase.complete"});
  await session.command({type:"decision.propose",decision:{...proposal,key}});await session.command({type:"phase.complete"});await session.command({type:"decision.ask",key});
  expect(session.state.draft!.runtimeInputs[0]!.decisionKey).toBe(key);expect(session.state.draft!.runtimeInputs[0]!.key.length).toBeLessThanOrEqual(120);
});

it.each([["conservative",false],["balanced",true],["autonomous",true]] as const)("respects technical decision authority in %s mode",async(mode,allowed)=>{
  const session=await resolution(mode,"technical");
  const closing=session.command({type:"decision.resolve",key:"placement",option:"top",authority:"agent_authority",decision:"Top",rationale:"Equivalent reversible internal choice",evidence:"Repository investigation"});
  if(allowed)expect((await closing).draft!.decisions![0]!.resolution?.authority).toBe("agent_authority");else await expect(closing).rejects.toThrow(/exceeds/);
});

it("rejects a verified prerequisite commit that is not incorporated into the unit's Git base",async()=>{
  const dependencyId="019a0000-0000-7000-8000-000000000099";
  const git=(...args:string[])=>execFileSync("git",["-C",repository,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const initial=git("rev-parse","HEAD");await writeFile(join(repository,"README.md"),"Prerequisite delivered\n");git("add","README.md");git("commit","-qm","Deliver prerequisite");
  await passDependency(dependencyId,0);git("checkout","-qb","unincorporated-child",initial);
  await expect(configure({unit:{...unit,dependsOn:["prior"]},dependency_issues:[{key:"prior",issue_id:dependencyId}]})).rejects.toThrow(/not incorporated into the analysis base/);
});
