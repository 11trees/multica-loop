import { expect, it, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Issue } from "@multica/core/types";
import type { EngineeringOverview } from "@multica/core/issues";
import { renderWithI18n } from "../../test/i18n";
import { BusinessConfigure, BusinessAnalysisPanel } from "./business-analysis";

const listAgents=vi.hoisted(()=>vi.fn());
vi.mock("@multica/core/api",async original=>({...await original<typeof import("@multica/core/api")>(),api:{listAgents}}));
const business:NonNullable<EngineeringOverview["business"]>={endToEnd:false,input:"Reader continues the selected item",projectId:"project",stage:"review",generation:2,version:8,readingEnabled:true,comments:[],readings:[],specification:{draftId:"specification-v2",hash:"a".repeat(64),generation:2,title:"Specification",content:"# Selected item\n\nContinue opens the selected item.",ready:true,acknowledgement:null},history:[]};
it("preserves configuration input after a failed save and submits four distinct native roles",async()=>{
  const user=userEvent.setup(),save=vi.fn().mockRejectedValueOnce(new Error("Project mapping unavailable")).mockResolvedValue(undefined),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  listAgents.mockResolvedValue(["Intent","Design","Writer","Reviewer"].map(name=>({id:name,name,archived_at:null})) as Agent[]);
  renderWithI18n(<QueryClientProvider client={client}><BusinessConfigure workspaceId="workspace" issue={{id:"issue",title:"Reader continuity"} as Issue} pending={false} onSave={save} /></QueryClientProvider>);
  await user.click(screen.getByRole("button",{name:"Analyze idea"}));const dialog=screen.getByRole("dialog");
  await user.type(within(dialog).getByLabelText("Repository path"),"/project");
  for(const [label,role] of [["Intent agent","Intent"],["Business design agent","Design"],["Specification agent","Writer"],["Specification review agent","Reviewer"]]){await user.click(within(dialog).getByRole("combobox",{name:label}));await user.click(await screen.findByRole("option",{name:role}));}
  await user.click(within(dialog).getByRole("button",{name:"Freeze analysis"}));expect(await within(dialog).findByRole("alert")).toHaveTextContent("Project mapping unavailable");expect(within(dialog).getByLabelText("Repository path")).toHaveValue("/project");
  await user.click(within(dialog).getByRole("button",{name:"Freeze analysis"}));await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());expect(save).toHaveBeenLastCalledWith(expect.objectContaining({expectedRevision:0,input:"Reader continuity",roles:{intent:"Intent",businessDesign:"Design",specification:"Writer",review:"Reviewer"}}));client.clear();
});
it("submits the exact visible specification reading and retains the document when acknowledgement fails",async()=>{
  const read=vi.fn().mockRejectedValue(new Error("Specification changed"));
  renderWithI18n(<BusinessAnalysisPanel business={business} pending={false} disabled={false} closed={false} onRead={read} onComment={vi.fn()} />);
  await userEvent.click(screen.getByRole("button",{name:"I have read it; close analysis"}));expect(read).toHaveBeenCalledWith({expectedVersion:8,draftId:"specification-v2",specificationHash:"a".repeat(64)});expect(await screen.findByRole("alert")).toHaveTextContent("Specification changed");expect(screen.getByRole("heading",{name:"Selected item"})).toBeVisible();
});
it("keeps a feedback request ID stable across an unchanged retry and carries its quote",async()=>{
  const submit=vi.fn().mockRejectedValueOnce(new Error("Publication pending")).mockResolvedValue({commentId:"native-comment"}),user=userEvent.setup();
  renderWithI18n(<BusinessAnalysisPanel business={business} pending={false} disabled={false} closed={false} onRead={vi.fn()} onComment={submit} />);
  await user.click(screen.getByText("Comment on specification",{exact:true}));await user.type(screen.getByLabelText("Specification feedback"),"Clarify item identity");await user.click(screen.getByText("Quoted text (optional)",{exact:true,selector:"summary"}));await user.type(screen.getByLabelText("Quoted text (optional)"),"selected item");await user.click(screen.getByRole("button",{name:"Submit feedback"}));expect(await screen.findByRole("alert")).toHaveTextContent("Publication pending");
  const input=submit.mock.calls[0]![0];expect(input).toMatchObject({draftId:"specification-v2",specificationHash:"a".repeat(64),content:"Clarify item identity",anchorType:"selection",quotedText:"selected item"});expect(input.requestId).toBeTruthy();
  await user.click(screen.getByRole("button",{name:"Submit feedback"}));expect(submit.mock.calls[1]![0]).toEqual(input);
});
it("keeps reading disabled while the native run is active and hides it after acknowledgement",()=>{
  const {unmount}=renderWithI18n(<BusinessAnalysisPanel business={business} pending={false} disabled={true} closed={false} onRead={vi.fn()} onComment={vi.fn()} />);expect(screen.getByRole("button",{name:"I have read it; close analysis"})).toBeDisabled();unmount();
  renderWithI18n(<BusinessAnalysisPanel business={{...business,specification:{...business.specification!,acknowledgement:{userId:"human",draftId:"specification-v2",specificationHash:"a".repeat(64),expectedVersion:8,acknowledgedAt:"2026-11-14T00:00:00.000Z"}}}} pending={false} disabled={false} closed={true} onRead={vi.fn()} onComment={vi.fn()} />);expect(screen.queryByRole("button",{name:"I have read it; close analysis"})).not.toBeInTheDocument();expect(screen.getByText("Specification reading confirmed.")).toBeVisible();
});

it("authorizes all ten End to End roles and a bounded initial delivery policy",async()=>{
 const user=userEvent.setup(),save=vi.fn().mockResolvedValue(undefined),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const labels=["Intent agent","Business design agent","Specification agent","Specification review agent","Context agent","Planning agent","Analysis agent","Development agent","Independent verification agent","Review agent"];
 listAgents.mockResolvedValue(labels.map((name,index)=>({id:`role-${index}`,name,archived_at:null})) as Agent[]);
 renderWithI18n(<QueryClientProvider client={client}><BusinessConfigure endToEnd workspaceId="workspace" issue={{id:"issue",title:"Reader idea"} as Issue} pending={false} onSave={save} /></QueryClientProvider>);
 await user.click(screen.getByRole("button",{name:"End to End"}));const dialog=screen.getByRole("dialog");await user.type(within(dialog).getByLabelText("Repository path"),"/project");
 for(const label of labels){await user.click(within(dialog).getByRole("combobox",{name:label}));await user.click(await screen.findByRole("option",{name:label}));}
 await user.click(within(dialog).getByRole("button",{name:"Start End to End"}));await waitFor(()=>expect(save).toHaveBeenCalledOnce());
 expect(save).toHaveBeenCalledWith(expect.objectContaining({autoContinue:true,delivery:{roles:{context:"role-4",planner:"role-5",analyst:"role-6",developer:"role-7",verifier:"role-8",reviewer:"role-9"},maxReworks:2}}));client.clear();
});
