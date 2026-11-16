// @vitest-environment node
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {afterEach,beforeEach,expect,it} from "vitest";
import {EngineeringTeamStore} from "./team-store";
import {teamDefinitionSchema,teamWorkflowRoles} from "./team";
let db:DatabaseSync,store:EngineeringTeamStore;
const workspace=randomUUID(),team=randomUUID(),user=randomUUID(),issue=randomUUID(),project=randomUUID();
const definition=()=>({workflow:"direct" as const,roles:{executor:randomUUID()},decision_mode:"balanced" as const,max_reworks:2});
beforeEach(()=>{db=new DatabaseSync(":memory:");store=new EngineeringTeamStore(db)});afterEach(()=>db.close());
it("validates each predefined workflow and its independent roles",()=>{
 for(const [workflow,roles] of Object.entries(teamWorkflowRoles)){
  const value={...definition(),workflow,roles:Object.fromEntries(roles.map(role=>[role,randomUUID()]))};expect(teamDefinitionSchema.parse(value).workflow).toBe(workflow);
  expect(()=>teamDefinitionSchema.parse({...value,roles:{}})).toThrow();
  expect(()=>teamDefinitionSchema.parse({...value,roles:{...value.roles,extra:randomUUID()}})).toThrow();
  if(roles.length>1)expect(()=>teamDefinitionSchema.parse({...value,roles:Object.fromEntries(roles.map(role=>[role,user]))})).toThrow();
 }
 expect(()=>teamDefinitionSchema.parse({...definition(),repository_path:"/task-specific"})).toThrow();
});
it("versions Team definitions and rejects stale edits and workspace leakage",()=>{
 const first=store.configure(workspace,team,user,{expected_revision:0,definition:definition()});
 expect(first.revision).toBe(1);expect(store.current(randomUUID(),team)).toBeNull();
 expect(()=>store.configure(workspace,team,user,{expected_revision:0,definition:definition()})).toThrow(/changed/);
 expect(store.configure(workspace,team,user,{expected_revision:1,definition:definition()}).revision).toBe(2);
 expect(db.prepare("SELECT count(*) AS count FROM engineering_team_profile").get()!.count).toBe(2);
});
it("freezes a task's Team, project and input independently of later Team edits",()=>{
 const first=store.configure(workspace,team,user,{expected_revision:0,definition:definition()});
 const input={team_id:team,team_revision:1,project_id:project,input:"Deliver the original outcome"};
 const bound=store.bind(workspace,issue,user,input);expect(bound.profile).toEqual(first);
 const second=store.configure(workspace,team,user,{expected_revision:1,definition:definition()});
 expect(second.definition.roles).not.toEqual(first.definition.roles);expect(store.bind(workspace,issue,user,input)).toEqual(bound);
 for(const change of [{team_id:randomUUID()},{team_revision:2},{project_id:randomUUID()},{input:"Replace original goal"}])expect(()=>store.bind(workspace,issue,user,{...input,...change})).toThrow(/retains/);
 expect(()=>store.bind(workspace,randomUUID(),user,input)).toThrow(/changed/);
 expect(store.bind(workspace,randomUUID(),user,{...input,team_revision:2}).profile).toEqual(second);
 expect(store.binding(randomUUID(),issue)).toBeNull();
});
