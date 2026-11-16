// @vitest-environment node
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,realpath,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,expect,it} from "vitest";
import {EngineeringApplication,type ApplicationRequest} from "./application";
import {teamWorkflowRoles} from "./team";
let app:EngineeringApplication,root:string,repository:string;
const workspaceId=randomUUID(),teamId=randomUUID(),userId=randomUUID(),projectId=randomUUID(),issueId=randomUUID();
const manager={kind:"team-manager" as const,workspaceId,teamId,userId};
const human={kind:"human" as const,workspaceId,issueId,userId};
const host={kind:"host" as const,workspaceId,issueId};
const invoke=(actor:ApplicationRequest["actor"],action:ApplicationRequest["action"],payload?:unknown)=>app.invoke({actor,action,payload});
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),"team-start-"));repository=join(root,"repository");execFileSync("git",["init","-q",repository]);repository=await realpath(repository);
 execFileSync("git",["-C",repository,"config","user.name","Team fixture"]);execFileSync("git",["-C",repository,"config","user.email","fixture@example.invalid"]);await writeFile(join(repository,"README.md"),"Original source\n");execFileSync("git",["-C",repository,"add","."]);execFileSync("git",["-C",repository,"commit","-qm","Original source"]);
 const sources=await Promise.all(["verification","development","analysis","context","planning","review","reproduction","idea-context","business-design","requirement-spec","spec-review"].map(name=>readFile(new URL(`./definitions/${name}.yaml`,import.meta.url),"utf8")));
 app=new EngineeringApplication(join(root,"business.sqlite"),sources[0]!,sources[1],sources[2],{context:sources[3]!,planning:sources[4]!,review:sources[5]!,reproduction:sources[6]!},{intent:sources[7]!,business_design:sources[8]!,specification:sources[9]!,review:sources[10]!});
});
afterEach(async()=>{app.close();await rm(root,{recursive:true,force:true})});
for(const workflow of Object.keys(teamWorkflowRoles) as (keyof typeof teamWorkflowRoles)[])it(`${workflow} starts from the Team's frozen roles and native task goal`,async()=>{
 const roles=Object.fromEntries(teamWorkflowRoles[workflow].map(role=>[role,randomUUID()]));const definition={workflow,roles,decision_mode:"balanced",max_reworks:2};
 await invoke(manager,"team-profile",{expected_revision:0,definition});
 const payload={team_id:teamId,team_revision:1,project_id:projectId,input:"Deliver the native task outcome",repository_path:repository,execution_resources:Object.keys(roles).map(()=>({path:repository,mode:"in_place"}))};
 const first=await invoke(human,"team-start",payload);expect(first).toMatchObject({started:true,binding:{input:payload.input,profile:{revision:1,definition}}});
 expect(await invoke(human,"team-start",payload)).toEqual(first);
 const pending=await invoke({kind:"coordinator"},"continuations");expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({issue_id:issueId,agent_id:roles.executor??roles.intent??roles.context})]));
 await invoke(manager,"team-profile",{expected_revision:1,definition:{...definition,roles:Object.fromEntries(Object.keys(roles).map(role=>[role,randomUUID()]))}});
 expect(await invoke(human,"team-start",payload)).toEqual(first);
 await expect(invoke(human,"configure-direct",{})).rejects.toThrow(/frozen Team/);
 if(workflow==="develop" || workflow==="bug_fix")expect(await invoke(host,"team-delivery-scope")).toMatchObject({project_id:projectId,user_id:userId,roles:Object.fromEntries(["context","planner","analyst","developer","verifier","reviewer"].map(role=>[role,roles[role]]))});
});
it("does not adopt legacy tasks automatically, and rejects per-task role overrides",async()=>{
 const definition={workflow:"direct",roles:{executor:randomUUID()},decision_mode:"balanced",max_reworks:2};await invoke(manager,"team-profile",{expected_revision:0,definition});
 expect(await invoke(host,"team-routing",{team_id:teamId,created_at:"2000-01-01T00:00:00.000Z"})).toMatchObject({owned:false});
 expect(await invoke(host,"team-routing",{team_id:teamId,created_at:"2099-01-01T00:00:00.000Z"})).toMatchObject({owned:true});
 await expect(invoke(human,"team-start",{team_id:teamId,team_revision:1,project_id:projectId,input:"Task goal",repository_path:repository,execution_resources:[{path:repository,mode:"in_place"}],agent_id:randomUUID()})).rejects.toThrow();
});
