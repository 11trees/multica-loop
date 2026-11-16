import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {beforeEach,expect,it,vi} from "vitest";
import type {Agent,SquadMember} from "@multica/core/types";
import {renderWithI18n} from "../../test/i18n";
import {TeamWorkflowSection} from "./team-workflow";
const mocks=vi.hoisted(()=>({read:vi.fn(),save:vi.fn()}));
vi.mock("@multica/core/api",()=>({api:{getEngineeringTeam:mocks.read,saveEngineeringTeam:mocks.save}}));
const agent={id:"019a0000-0000-7000-8000-000000000004",name:"Executor",archived_at:null} as Agent;
function renderTeam(canManage=true){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return renderWithI18n(<QueryClientProvider client={client}><TeamWorkflowSection workspaceId="workspace" teamId="team" leaderId={agent.id} members={[]} agents={[agent]} canManage={canManage} /></QueryClientProvider>)}
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockResolvedValue({enabled:true,profile:null});mocks.save.mockImplementation(async (_id:string,_revision:number,definition:unknown)=>({enabled:true,profile:{revision:1,definition}}))});
it("saves a predefined Team workflow with its member roles and no task input or repository",async()=>{
 renderTeam();const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"Set workflow"}));await user.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith("team",0,{workflow:"direct",roles:{executor:agent.id},decision_mode:"balanced",max_reworks:2}));
});
it("preserves the settings form and its error after a rejected save",async()=>{
 mocks.save.mockRejectedValue(new Error("Team definition changed"));renderTeam();const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"Set workflow"}));await user.click(screen.getByRole("button",{name:"Save"}));expect(await screen.findByRole("alert")).toHaveTextContent("Team definition changed");expect(screen.getByRole("button",{name:"Save"})).toBeEnabled();
});
it("keeps Team editing unavailable for read-only users",async()=>{
 renderTeam(false);await waitFor(()=>expect(mocks.read).toHaveBeenCalledWith("team"));expect(screen.queryByRole("button",{name:"Set workflow"})).not.toBeInTheDocument();
});

it("configures Feedback once on the Team and freezes explicit roles in the next definition version",async()=>{
 const agents=Array.from({length:8},(_,index)=>({id:`019a0000-0000-7000-8000-${String(index+40).padStart(12,"0")}`,name:`Member ${index}`,archived_at:null} as Agent));
 const definition={workflow:"develop",roles:{context:agents[0]!.id,planner:agents[1]!.id,analyst:agents[2]!.id,developer:agents[3]!.id,verifier:agents[4]!.id,reviewer:agents[5]!.id},decision_mode:"balanced",max_reworks:1};
 mocks.read.mockResolvedValue({enabled:true,profile:{revision:1,definition}});const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 renderWithI18n(<QueryClientProvider client={client}><TeamWorkflowSection workspaceId="workspace" teamId="team" leaderId={agents[0]!.id} members={agents.slice(1).map(agent=>({member_type:"agent",member_id:agent.id})) as SquadMember[]} agents={agents} canManage /></QueryClientProvider>);
 const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"Edit"}));await user.click(screen.getByRole("checkbox",{name:"Feedback"}));expect(screen.getByRole("button",{name:"Save"})).toBeDisabled();
 for(const [label,index] of [["Triage agent",0],["Feedback verification agent",7],["Planning agent",1],["Reproduction agent",6]] as const){await user.click(screen.getByRole("combobox",{name:`Feedback · ${label}`}));if(index===7)expect(screen.queryByRole("option",{name:"Member 5"})).not.toBeInTheDocument();await user.click(await screen.findByRole("option",{name:`Member ${index}`}));}
 await user.click(screen.getByRole("button",{name:"Save"}));await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith("team",1,{...definition,feedback:{triager:agents[0]!.id,verifier:agents[7]!.id,planner:agents[1]!.id,reproducer:agents[6]!.id}}));client.clear();
});
