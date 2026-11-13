// @vitest-environment node
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { beforeEach,afterEach,it,expect } from "vitest";
import { EngineeringApplication,type ApplicationRequest } from "./application";

const human={kind:"human" as const,userId:"019a0000-0000-7000-8000-000000000001",workspaceId:"019a0000-0000-7000-8000-000000000002",issueId:"019a0000-0000-7000-8000-000000000003"};
const backlog="019a0000-0000-7000-8000-000000000004",planner="019a0000-0000-7000-8000-000000000005";
const task=(agentId=backlog,round=0)=>({kind:"task" as const,workspaceId:human.workspaceId,issueId:human.issueId,agentId,attemptId:`${agentId}:${round}`});
let app:EngineeringApplication,directory:string,repository:string,database:string,definitions:string[];
function reopen(){app=new EngineeringApplication(database,definitions[0]!,definitions[1],definitions[2],{context:definitions[3]!,planning:definitions[4]!});}
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"requirement-app-"));repository=join(directory,"repository");database=join(directory,"engineering.sqlite");execFileSync("git",["init","-q",repository]);
  const git=(...args:string[])=>execFileSync("git",["-C",repository,...args],{stdio:"ignore"});git("config","user.name","Requirement fixture");git("config","user.email","fixture@example.invalid");await writeFile(join(repository,"README.md"),"Frozen input\n");git("add",".");git("commit","-qm","Initialize fixture");
  definitions=await Promise.all(["verification","development","analysis","context","planning"].map(name=>readFile(new URL(`./definitions/${name}.yaml`,import.meta.url),"utf8")));reopen();});
afterEach(async()=>{app.close();await rm(directory,{recursive:true,force:true});});
async function invoke(actor:ApplicationRequest["actor"],action:ApplicationRequest["action"],payload?:unknown){const result=await app.invoke({actor,action,payload});if(!("draft" in result) || "rework" in result)throw new Error("Expected requirement checkpoint");return result;}
const configure=(extra={})=>invoke(human,"configure",{kind:"requirement",expected_revision:0,agent_id:backlog,planner_agent_id:planner,repository_path:repository,input:"A reader sees Ready and can activate Continue",auto_continue:true,...extra});
async function start(agentId=backlog,round=0){const actor=task(agentId,round);await app.invoke({actor:{...actor,kind:"daemon"},action:"bind",payload:{work_dir:repository,mode:"in_place",overlays:[]}});let state=await invoke(actor,"start");return {actor,get state(){return state;},command:async(command:unknown)=>{state=await invoke(actor,"command",{expected_sequence:state.draft!.sequence,command});return state;}};}
async function context(options:{kind?:string;expected?:boolean;conflict?:boolean;ask?:boolean;revision?:number;oracle?:string;removeAction?:boolean;headingKey?:string}={}){
  await configure({item_kind:options.kind ?? "requirement",expected_revision:options.revision ?? 0});let session=await start();const put=(block:string,key:string,value:unknown)=>session.command({type:"artifact.put",ref:`requirement-context.${block}`,...(key ? {key} : {}),content:typeof value === "string" ? value : stringify(value)});
  await put("intent","","Enable the reader's next action");await put("assertions","actual",{perspective:"actual",statement:"Reader sees Initial",evidence:options.conflict ? "conflicted" : "observed",source:"README.md:1"});
  if(options.expected)await put("assertions","expected",{perspective:"expected",statement:"Existing rules require Initial",evidence:"reported",source:"Existing business specification"});await session.command({type:"phase.complete"});
  if(options.ask)await session.command({type:"decision.propose",decision:{key:"button",type:"business",title:"Action label",question:"Which label?",impact:"Visible action",options:[{id:"continue",label:"Continue",consequence:"Continue reading"},{id:"next",label:"Next",consequence:"Next item"}],recommendation:{option:"continue",reason:"Original input",authority:"user"},dependencies:[]}});
  await session.command({type:"phase.complete"});
  if(options.ask){await session.command({type:"decision.ask",key:"button"});await session.command({type:"phase.complete"});const question=session.state.draft!.runtimeInputs[0]!;await invoke(human,"answer",{expected_sequence:session.state.draft!.sequence,request_id:question.id,answer:"",selected_option:"continue"});app.close();reopen();expect(await app.invoke({actor:{kind:"coordinator"},action:"continuations"})).toEqual([expect.objectContaining({reason:"human_answers",agent_id:backlog})]);session=await start(backlog,1);await session.command({type:"decision.resolve",key:"button",option:"continue",authority:"user",decision:"Continue",rationale:"Authenticated choice",evidence:question.id});}
  await session.command({type:"phase.complete"});await put("answer-review","","The selected outcome and input agree");await session.command({type:"phase.complete"});
  await put("assertions","target",{perspective:"target",statement:"Reader sees Ready and can Continue",evidence:"decided",source:"Frozen input",...(options.ask ? {decision:"button"} : {})});await session.command({type:"phase.complete"});
  await put("change-summary","","Change heading and add the action");await put("impacts","heading",{statement:"Show Ready and Continue",disposition:"change",rationale:"Observable reader outcome",source:"Frozen requirement"});await session.command({type:"phase.complete"});
  await put("scope","included",{direction:"included",content:"Heading and Continue"});await session.command({type:"phase.complete"});
  await session.command({type:"acceptance.put",acceptance:{key:options.headingKey ?? "heading",statement:"Heading is Ready",oracle:options.oracle ?? "Browser sees exact Ready",source:"Frozen input"}});
  if(!options.removeAction)await session.command({type:"acceptance.put",acceptance:{key:"action",statement:"Continue is available",oracle:"Browser activates Continue",source:"Frozen input"}});
  await session.command({type:"phase.complete"});return session;
}
async function plan(headingKey="heading"){const session=await start(planner);await session.command({type:"phase.complete"});await session.command({type:"artifact.put",ref:"delivery-plan.rationale",content:"Separate two independently observable reader outcomes"});await session.command({type:"phase.complete"});
  const units=[{key:"heading",title:"Ready heading",actor:"Reader",trigger:"Open page",observableOutcome:"Heading shows Ready",acceptance:"Exact Ready",sourceRefs:["impact:heading",`acceptance:${headingKey}`],dependsOn:[] as string[]},{key:"action",title:"Continue action",actor:"Reader",trigger:"Activate Continue",observableOutcome:"Next reading step",acceptance:"Continue activates",sourceRefs:["acceptance:action"],dependsOn:["heading"]}];
  const put=async(unit:typeof units[number])=>{const {key,...value}=unit;return session.command({type:"artifact.put",ref:"delivery-plan.units",key,content:stringify(value)});};
  for(const unit of units)await put(unit);await session.command({type:"phase.complete"});await session.command({type:"artifact.put",ref:"delivery-plan.coverage",content:"All changes and requirement acceptances are assigned"});await session.command({type:"artifact.put",ref:"delivery-plan.ordering",content:"Action needs the heading delivered first"});
  return {...session,units,put,finish:async()=>{await session.command({type:"phase.complete"});return session.command({type:"phase.complete"});}};
}

it("publishes stable requirement acceptances, freezes planning sources, and never equates a completed plan with delivery",async()=>{
  const session=await context({ask:true});await session.command({type:"phase.complete"});const overview=await app.invoke({actor:human,action:"overview"});expect(overview).toMatchObject({chain:"planning",requirement:{context:{acceptances:[{key:"heading",scope:"requirement",revision:1},{key:"action",revision:1}]}}});
  expect(await app.invoke({actor:{kind:"coordinator"},action:"continuations"})).toEqual([expect.objectContaining({reason:"context_handoff",agent_id:planner})]);
  const planning=await plan();await expect(planning.command({type:"artifact.put",ref:"delivery-plan.sources",key:"acceptance:heading",content:"kind: acceptance\ncontent: weaker\nsourceRef: invented"})).rejects.toThrow(/readonly|outside the current phase/);
  const done=await planning.finish();expect(done.conclusion).toMatchObject({kind:"delivery-plan",units:[{key:"heading",sourceRefs:[{kind:"change"},{kind:"acceptance"}]},{key:"action",dependsOn:["heading"]}]});
  await expect(app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:human.issueId},action:"completion"})).rejects.toThrow(/final review/);expect(await app.invoke({actor:{kind:"coordinator"},action:"continuations"})).toEqual([]);
},15000);

it.each([["bug",false,"Existing Expected"],["requirement",true,"Conflicting assertions"]])("rejects an incomplete %s context",async(kind,conflict,error)=>{const session=await context({kind,conflict});await expect(session.command({type:"phase.complete"})).rejects.toThrow(error);},15000);
it.each(["coverage","unknown","duplicate","ordering","cycle"])("rejects a malformed %s delivery plan",async(failure)=>{const session=await context();await session.command({type:"phase.complete"});const planning=await plan();
  if(failure === "coverage")await planning.put({...planning.units[1]!,sourceRefs:["acceptance:heading"]});
  if(failure === "unknown")await planning.put({...planning.units[1]!,sourceRefs:["missing"]});
  if(failure === "duplicate")await planning.put({...planning.units[1]!,title:planning.units[0]!.title});
  if(failure === "ordering")await planning.put({...planning.units[0]!,dependsOn:["action"]});
  if(failure === "cycle")for(const unit of planning.units)await planning.put({...unit,dependsOn:[unit.key === "heading" ? "action" : "heading"]});
  await expect(planning.finish()).rejects.toThrow(failure === "coverage" ? /uncovered/ : failure === "unknown" ? /unknown source/ : failure === "duplicate" ? /unique/ : failure === "cycle" ? /acyclic/ : /precede/);
},15000);

it("keeps acceptance identity across revisions and versions changed or retired meanings",async()=>{
  let session=await context();await session.command({type:"phase.complete"});const db=new DatabaseSync(database);const before=db.prepare("SELECT payload FROM requirement_acceptance WHERE acceptance_key='heading'").get()!;const identity=JSON.parse(String(before.payload));
  session=await context({revision:1,oracle:"Browser sees the visible exact Ready heading",removeAction:true});await session.command({type:"phase.complete"});
  const rows=db.prepare("SELECT payload FROM requirement_acceptance WHERE revision=2").all().map(row=>JSON.parse(String(row.payload)));expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({key:"heading",id:identity.id,revision:2,active:true}),expect.objectContaining({key:"action",revision:2,active:false})]));db.close();
},15000);

it("rejects stale owners, dirty repositories and changing the same issue into a competing delivery workflow",async()=>{await configure();const session=await start();await expect(start(planner)).rejects.toThrow(/owning runtime/);await writeFile(join(repository,"dirty.txt"),"Changed");await expect(invoke(session.actor,"read")).rejects.toThrow(/uncommitted/);await rm(join(repository,"dirty.txt"));await expect(invoke(human,"configure",{expected_revision:1})).rejects.toThrow(/requirement workflow/);});


it("settles a saved terminal context once after storage reopen",async()=>{
  const session=await context();await session.command({type:"phase.complete"});app.close();const db=new DatabaseSync(database),row=db.prepare("SELECT payload FROM requirement_contract WHERE revision=1").get()!;const record=JSON.parse(String(row.payload));record.contextHandoff=false;delete record.planningContract;record.acceptances=[];
  db.prepare("UPDATE requirement_contract SET payload=? WHERE revision=1").run(JSON.stringify(record));db.prepare("DELETE FROM requirement_acceptance").run();db.close();reopen();
  const first=await app.invoke({actor:{kind:"coordinator"},action:"continuations"});expect(first).toEqual([expect.objectContaining({reason:"context_handoff"})]);expect(await app.invoke({actor:{kind:"coordinator"},action:"continuations"})).toEqual(first);
  const reopened=new DatabaseSync(database);expect(reopened.prepare("SELECT count(*) AS count FROM requirement_acceptance").get()!.count).toBe(2);reopened.close();
},15000);
it("rebuilds the readonly acceptance projection after revisiting the acceptance phase",async()=>{
  const session=await context();await session.command({type:"phase.rewind",to:"acceptance",reason:"Remove deferred action"});
  await expect(session.command({type:"acceptance.put",acceptance:{key:"unit:reserved",statement:"Invalid",oracle:"Invalid",source:"Input"}})).rejects.toThrow(/reserved/);
  await session.command({type:"acceptance.remove",key:"action"});await session.command({type:"phase.complete"});await session.command({type:"phase.complete"});
  expect(await app.invoke({actor:human,action:"overview"})).toMatchObject({requirement:{context:{acceptances:[{key:"heading"}]}}});
},15000);


it("freezes stable child identities and oracles before publication, resumes partial acknowledgements and blocks unverified children",async()=>{
 const contextSession=await context();await contextSession.command({type:"phase.complete"});const planning=await plan(),done=await planning.finish(),payload={expected_revision:1,expected_sequence:done.draft!.sequence};
 const publish=()=>app.invoke({actor:human,action:"publication",payload});let publication=await publish();if(!("units" in publication))throw new Error("Expected publication");
 expect(publication.units).toHaveLength(2);const [first,second]=publication.units;expect(first!.sources.every(source=>source.kind === "acceptance")).toBe(true);expect(first!.unit.sourceRefs.some(source=>source.kind === "change")).toBe(true);expect(first!.sources).toEqual(expect.arrayContaining([expect.objectContaining({kind:"acceptance",oracle:"Browser sees exact Ready",sourceRef:expect.stringMatching(/^ACCEPTANCE:/)})]));expect(second!.unit.dependsOn).toEqual(["heading"]);
 app.close();reopen();expect(await publish()).toEqual(publication);
 expect(await app.invoke({actor:{...human,issueId:first!.issueId},action:"overview"})).toMatchObject({configured:false,managed_unit:{parentIssueId:human.issueId}});
 await expect(app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:first!.issueId},action:"completion"})).rejects.toThrow(/independent verification/);
 await expect(app.invoke({actor:{...human,issueId:first!.issueId},action:"configure",payload:{}})).rejects.toThrow(/frozen by/);
 await expect(app.invoke({actor:human,action:"publication-ack",payload:{issue_id:first!.issueId,contract_hash:first!.contractHash}})).rejects.toThrow(/Only the host/);
 await expect(app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:human.issueId},action:"publication-ack",payload:{issue_id:first!.issueId,contract_hash:"wrong"}})).rejects.toThrow(/does not match/);
 await app.invoke({actor:{kind:"host",workspaceId:human.workspaceId,issueId:human.issueId},action:"publication-ack",payload:{issue_id:first!.issueId,contract_hash:first!.contractHash}});
 publication=await publish();expect(publication).toMatchObject({units:[{issueId:first!.issueId,published:true},{issueId:second!.issueId,published:false}]});
 await expect(configure({expected_revision:1})).rejects.toThrow(/reconciled/);
},15000);
it("rejects a stale publication without creating child bindings",async()=>{
 const session=await context();await session.command({type:"phase.complete"});const planning=await plan();await planning.finish();await expect(app.invoke({actor:human,action:"publication",payload:{expected_revision:1,expected_sequence:0}})).rejects.toThrow(/plan changed/);
 const db=new DatabaseSync(database);expect(db.prepare("SELECT count(*) AS count FROM requirement_unit").get()!.count).toBe(0);db.close();
},15000);
it("preserves valid long acceptance keys through readonly planning projection and child scope",async()=>{
 const key="a".repeat(120),session=await context({headingKey:key});await session.command({type:"phase.complete"});const planning=await plan(key),done=await planning.finish();
 const result=await app.invoke({actor:human,action:"publication",payload:{expected_revision:1,expected_sequence:done.draft!.sequence}});if(!("units" in result))throw new Error("Expected publication");expect(result.units[0]!.sources.every(source=>source.key.length<=120)).toBe(true);expect(result.units[0]!.unit.sourceRefs.some(source=>source.key === `acceptance:${key}`)).toBe(true);
},15000);
