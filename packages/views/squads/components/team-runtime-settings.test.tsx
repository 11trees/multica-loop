import type {ReactNode} from "react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {screen,waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {beforeEach,expect,it,vi} from "vitest";
import type {Agent} from "@multica/core/types";
import type {EngineeringTeamProfile} from "@multica/core/squads";
import {renderWithI18n} from "../../test/i18n";
import {TeamRuntimeSettings} from "./team-runtime-settings";

const mocks=vi.hoisted(()=>({update:vi.fn()}));
vi.mock("@multica/core/api",()=>({api:{listRuntimes:async()=>[],listMembers:async()=>[],updateAgent:mocks.update}}));
vi.mock("@multica/core/paths",()=>({useWorkspacePaths:()=>({runtimes:()=>"/workspace/runtimes"})}));
vi.mock("../../navigation",()=>({AppLink:({href,children}:{href:string;children:ReactNode})=><a href={href}>{children}</a>}));
vi.mock("@multica/core/auth",()=>({useAuthStore:(select:(state:unknown)=>unknown)=>select({user:{id:"owner"}})}));
vi.mock("../../agents/components/runtime-picker",()=>({RuntimePicker:({onSelect,disabled}:{onSelect:(id:string)=>void;disabled:boolean})=><button disabled={disabled} onClick={()=>onSelect("runtime")}>Choose runtime</button>}));
const agents=[{id:"context",runtime_id:"runtime"},{id:"planner",runtime_id:null},{id:"developer",runtime_id:null}] as Agent[];
const profile={definition:{roles:{context:"context",planner:"planner",developer:"developer"}}} as unknown as EngineeringTeamProfile;
function renderSettings(canManage=true){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});renderWithI18n(<QueryClientProvider client={client}><TeamRuntimeSettings workspaceId="workspace" profile={profile} agents={agents} canManage={canManage}/></QueryClientProvider>);return client;}
beforeEach(()=>{vi.clearAllMocks();mocks.update.mockResolvedValue({})});
it("sets a Team runtime through ordinary Agent authorization and skips roles already using it",async()=>{
 const client=renderSettings(),user=userEvent.setup();await user.click(screen.getByRole("button",{name:"Choose runtime"}));await waitFor(()=>expect(screen.getByRole("button",{name:"Apply to Team"})).toBeEnabled());await user.click(screen.getByRole("button",{name:"Apply to Team"}));
 expect(await screen.findByRole("link",{name:"Connect a runtime"})).toHaveAttribute("href","/workspace/runtimes");
 await screen.findByRole("status");expect(mocks.update.mock.calls).toEqual([["planner",{runtime_id:"runtime"}],["developer",{runtime_id:"runtime"}]]);client.clear();
});
it("keeps a failed Team runtime update visible with its partial progress",async()=>{
 mocks.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Runtime is private"));const client=renderSettings(),user=userEvent.setup();await user.click(screen.getByRole("button",{name:"Choose runtime"}));await waitFor(()=>expect(screen.getByRole("button",{name:"Apply to Team"})).toBeEnabled());await user.click(screen.getByRole("button",{name:"Apply to Team"}));expect(await screen.findByRole("alert")).toHaveTextContent("Updated 2 of 3 roles. Retry to finish. Runtime is private");expect(screen.queryByRole("status")).not.toBeInTheDocument();client.clear();
});
it("does not expose runtime mutation to read-only Team viewers",()=>{
 const client=renderSettings(false);expect(screen.queryByRole("button",{name:"Choose runtime"})).not.toBeInTheDocument();expect(screen.getByText("Configure the Team runtime before starting.")).toBeInTheDocument();client.clear();
});
