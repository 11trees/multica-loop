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
it("freezes explicit Team Feedback roles and enforces the protocol's independent verification boundary",()=>{
 const roles=Object.fromEntries(teamWorkflowRoles.develop.map(role=>[role,randomUUID()])),feedback={triager:roles.context!,planner:roles.planner!,reproducer:randomUUID(),verifier:randomUUID()};
 const value={...definition(),workflow:"develop",roles,feedback};expect(teamDefinitionSchema.parse(value).feedback).toEqual(feedback);
 for(const change of [{verifier:roles.reviewer},{triager:roles.analyst},{planner:feedback.verifier},{reproducer:feedback.planner}])expect(()=>teamDefinitionSchema.parse({...value,feedback:{...feedback,...change}})).toThrow(/independent/);
 expect(()=>teamDefinitionSchema.parse({...definition(),feedback})).toThrow(/delivery workflow/);
 store.configure(workspace,team,user,{expected_revision:0,definition:value});const input={team_id:team,team_revision:1,project_id:project,input:"Original task"};const frozen=store.bind(workspace,issue,user,input);
 store.configure(workspace,team,user,{expected_revision:1,definition:{...value,feedback:{...feedback,verifier:randomUUID()}}});
 expect(store.binding(workspace,issue)?.profile.definition.feedback).toEqual(frozen.profile.definition.feedback);
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

it("keeps OpenSpec context on the frozen Team without changing older default definitions",()=>{
 const old=definition();expect(teamDefinitionSchema.parse(old)).toEqual(old);expect(()=>teamDefinitionSchema.parse({...old,context_adapter:"openspec"})).toThrow(/delivery workflow/);
 const value={...old,workflow:"develop",roles:Object.fromEntries(teamWorkflowRoles.develop.map(role=>[role,randomUUID()])),context_adapter:"openspec"};store.configure(workspace,team,user,{expected_revision:0,definition:value});const frozen=store.bind(workspace,issue,user,{team_id:team,team_revision:1,project_id:project,input:"Original OpenSpec task"});const {context_adapter:_,...next}=value;store.configure(workspace,team,user,{expected_revision:1,definition:next});expect(store.binding(workspace,issue)?.profile.definition.context_adapter).toBe("openspec");expect(frozen.profile.definition.context_adapter).toBe("openspec");expect(store.current(workspace,team)?.definition).not.toHaveProperty("context_adapter");
});
