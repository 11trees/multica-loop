import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {beforeEach,expect,it,vi} from "vitest";
import type {Agent} from "@multica/core/types";
import {renderWithI18n} from "../../test/i18n";
import {TeamWorkflowSection} from "./team-workflow";
const mocks=vi.hoisted(()=>({read:vi.fn(),save:vi.fn()}));
vi.mock("@multica/core/api",()=>({api:{getEngineeringTeam:mocks.read,saveEngineeringTeam:mocks.save}}));
const agent={id:"leader",name:"Executor",archived_at:null} as Agent;
function renderTeam(canManage=true){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});return renderWithI18n(<QueryClientProvider client={client}><TeamWorkflowSection workspaceId="workspace" teamId="team" leaderId={agent.id} members={[]} agents={[agent]} canManage={canManage} /></QueryClientProvider>)}
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockResolvedValue({enabled:true,profile:null});mocks.save.mockImplementation(async (_id:string,_revision:number,definition:unknown)=>({enabled:true,profile:{revision:1,definition}}))});
it("saves a predefined Team workflow with its member roles and no task input or repository",async()=>{
 renderTeam();const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"Set workflow"}));await user.click(screen.getByRole("button",{name:"Save"}));
 await waitFor(()=>expect(mocks.save).toHaveBeenCalledWith("team",0,{workflow:"direct",roles:{executor:"leader"},decision_mode:"balanced",max_reworks:2}));
});
it("preserves the settings form and its error after a rejected save",async()=>{
 mocks.save.mockRejectedValue(new Error("Team definition changed"));renderTeam();const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"Set workflow"}));await user.click(screen.getByRole("button",{name:"Save"}));expect(await screen.findByRole("alert")).toHaveTextContent("Team definition changed");expect(screen.getByRole("button",{name:"Save"})).toBeEnabled();
});
it("keeps Team editing unavailable for read-only users",async()=>{
 renderTeam(false);await waitFor(()=>expect(mocks.read).toHaveBeenCalledWith("team"));expect(screen.queryByRole("button",{name:"Set workflow"})).not.toBeInTheDocument();
});
