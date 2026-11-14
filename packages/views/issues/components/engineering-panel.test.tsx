import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import type { Agent, Issue } from "@multica/core/types";
import type { EngineeringOverview } from "@multica/core/issues";
import { renderWithI18n } from "../../test/i18n";
import { EngineeringPanel } from "./engineering-panel";

const endpoints = vi.hoisted(() => ({ getEngineeringOverview: vi.fn(), authorizeEngineeringFeedbackWork:vi.fn(), beginEngineeringFeedback:vi.fn(),cancelEngineeringFeedback:vi.fn(),listComments:vi.fn(), listAgents: vi.fn(), answerEngineering: vi.fn(), abandonEngineering: vi.fn(), configureEngineering: vi.fn(), configureRequirementEngineering:vi.fn(), configureRequirementReview:vi.fn(),acknowledgeRequirementReview:vi.fn(),authorizeEngineeringDelivery:vi.fn(),publishEngineeringUnits:vi.fn(),runEngineering: vi.fn() }));
vi.mock("@multica/core/api", async importOriginal => ({ ...await importOriginal<typeof import("@multica/core/api")>(), api: endpoints }));
vi.mock("@multica/core/hooks", async importOriginal => ({ ...await importOriginal<typeof import("@multica/core/hooks")>(), useWorkspaceId: () => "workspace" }));
const issue = { id: "issue", title: "Fixture delivery", revision: 4 } as Issue;
const initial: EngineeringOverview = {
  repair:null,intervention:null,directEnabled:false,direct:null,endToEndEnabled:false,businessEnabled:false,feedbackAllowed:false,autoContinue: false, enabled: true, configured: true, chain: "verification", agentId: "verifier", revision: 2, sequence: 7,
  codeVersion: "commit-fixture", repositoryPath: "/fixture", draftId: "draft", status: "waiting_for_answers", currentPhase: "plan", hasActiveRun: false,
  phases: [{ id: "inputs", status: "completed" }, { id: "plan", status: "current" }],
  sources: [{ key: "ac1", kind: "acceptance", description: "Survives reload", oracle: "Title visible", sourceRef: "ISSUE:fixture" }],
  questions: [{ id: "q1", title: "Fixture entry", question: "Which entry should be verified?", why: "Need isolated data", recommendation: "Use the local fixture", options:[],recommendationOption:"", active: true, phase: "plan", answer: null }],
  artifacts: [], result: null, rework: null, analysis:null, requirement:null, business:null, managedUnit:null, decisions:[],
};
let state: EngineeringOverview;
let client: QueryClient;
beforeEach(() => {
  state = structuredClone(initial); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  vi.mocked(api.getEngineeringOverview).mockImplementation(async () => structuredClone(state));
  vi.mocked(api.listAgents).mockResolvedValue([{ id: "developer", name: "Developer" }, { id: "verifier", name: "Verifier" }] as Agent[]);
  vi.mocked(api.answerEngineering).mockResolvedValue();
  vi.mocked(api.abandonEngineering).mockResolvedValue();
  vi.mocked(api.configureEngineering).mockResolvedValue();
  vi.mocked(api.runEngineering).mockResolvedValue({ id: "queued" } as Awaited<ReturnType<typeof api.runEngineering>>);
});
afterEach(() => { client.clear(); vi.resetAllMocks(); });
function renderPanel(locale: "en" | "zh-Hans" = "en") { return renderWithI18n(<QueryClientProvider client={client}><EngineeringPanel issue={issue} /></QueryClientProvider>, { locale }); }

it("keeps a failed answer editable and submits the current checkpoint before queueing a continuation", async () => {
  const user = userEvent.setup(); renderPanel();
  await screen.findByText("Which entry should be verified?");
  expect(screen.queryByRole("button", { name: "Continue run" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use recommendation" }));
  expect(api.answerEngineering).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Your answer")).toHaveValue("Use the local fixture");
  vi.mocked(api.answerEngineering).mockRejectedValueOnce(new Error("Checkpoint changed; reload"));
  await user.click(screen.getByRole("button", { name: "Submit answer" }));
  await screen.findByText("Checkpoint changed; reload");
  expect(screen.getByLabelText("Your answer")).toHaveValue("Use the local fixture");
  vi.mocked(api.answerEngineering).mockImplementationOnce(async () => { state.questions[0]!.answer = { text: "Use the local fixture", userId: "human", sequence: 8 }; state.sequence = 8; });
  await user.click(screen.getByRole("button", { name: "Submit answer" }));
  const resume = await screen.findByRole("button", { name: "Continue run" });
  expect(api.answerEngineering).toHaveBeenLastCalledWith("issue", { expectedSequence: 7, requestId: "q1", answer: "Use the local fixture" });
  await user.click(resume);
  expect(api.runEngineering).toHaveBeenCalledWith("issue", { expectedRevision: 2, expectedSequence: 8 });
});

it("renders unknown statuses without offering a run and hides a disabled feature", async () => {
  state.status = "future_status"; state.questions = [];
  const rendered = renderPanel();
  await screen.findByText("Status unavailable");
  expect(screen.queryByRole("button", { name: /Start run|Continue run|Abandon draft/ })).not.toBeInTheDocument();
  state.enabled = false; state.configured = false;
  await client.invalidateQueries();
  await waitFor(() => expect(rendered.container).toBeEmptyDOMElement());
});

it("preserves the reason when abandoning fails and exposes a new revision after success", async () => {
  const user = userEvent.setup(); renderPanel();
  await user.click(await screen.findByRole("button", { name: "Abandon draft" }));
  const dialog = screen.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "Abandon draft" });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByLabelText("Reason"), "Acceptance needs correction");
  vi.mocked(api.abandonEngineering).mockRejectedValueOnce(new Error("Checkpoint changed"));
  await user.click(confirm); await within(dialog).findByText("Checkpoint changed");
  expect(within(dialog).getByLabelText("Reason")).toHaveValue("Acceptance needs correction");
  vi.mocked(api.abandonEngineering).mockImplementationOnce(async () => { state.status = "abandoned"; state.sequence = 8; });
  await user.click(confirm);
  await screen.findByRole("button", { name: "New revision" });
  expect(api.abandonEngineering).toHaveBeenLastCalledWith("issue", { expectedSequence: 7, reason: "Acceptance needs correction" });
});

it("configures frozen scope with separate roles and preserves the form on failure", async () => {
  state.configured = false; state.revision = null; state.repositoryPath = "";
  const user = userEvent.setup(); renderPanel();
  await user.click(await screen.findByRole("button", { name: "Configure delivery" }));
  const dialog = screen.getByRole("dialog");
  await user.type(within(dialog).getByLabelText("Repository path"), "/fixture/repo");
  await user.click(within(dialog).getByRole("combobox", { name: "Development agent" }));
  await user.click(await screen.findByRole("option", { name: "Developer" }));
  await user.click(within(dialog).getByRole("combobox", { name: "Independent verification agent" }));
  await user.click(await screen.findByRole("option", { name: "Developer" }));
  expect(within(dialog).getByText("Development and verification need different agents.")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("combobox", { name: "Independent verification agent" }));
  await user.click(await screen.findByRole("option", { name: "Verifier" }));
  await user.type(within(dialog).getByLabelText("Implementation guidance"), "Preserve the frozen oracle");
  await user.type(within(dialog).getByLabelText("Scope"), "Survives reload");
  await user.type(within(dialog).getByLabelText("Expected result"), "Title remains visible");
  vi.mocked(api.configureEngineering).mockRejectedValueOnce(new Error("Repository has uncommitted changes"));
  await user.click(within(dialog).getByRole("button", { name: "Freeze scope" }));
  await within(dialog).findByText("Repository has uncommitted changes");
  expect(within(dialog).getByLabelText("Expected result")).toHaveValue("Title remains visible");
  expect(api.configureEngineering).toHaveBeenCalledWith("issue", expect.objectContaining({ maxReworks: 3, autoContinue: true, expectedRevision: 0, developerId: "developer", verifierId: "verifier", repositoryPath: "/fixture/repo",
    sources: [{ key: "scope-1", kind: "acceptance", description: "Survives reload", oracle: "Title remains visible", sourceRef: "ISSUE:issue:r4:scope-1" }] }));
});

it("uses the Chinese product vocabulary for human questions", async () => {
  renderPanel("zh-Hans"); await screen.findByText("工程交付");
  expect(screen.getByLabelText("你的回答")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "提交回答" })).toBeInTheDocument();
});

it("shows a stopped rework decision and retains the failed observation", async () => {
  state.status = "completed"; state.questions = []; state.result = { verdict:"failed" };
  state.rework = {rootRevision:1,round:1,limit:1,stopReason:"budget",history:[{revision:1,draftId:"failed-draft",codeVersion:"failed-commit",decision:"rework",artifacts:[{ref:"verification.results",key:"s1",content:"status: failed\nactualBehavior: Wrong heading"}]}]};
  const user = userEvent.setup(); renderPanel();
  await screen.findByText("The rework limit is reached. Review the failures before freezing a new contract.");
  expect(screen.queryByRole("button",{name:/Start run|Continue run/})).not.toBeInTheDocument();
  await user.click(screen.getByText("Failed verification history",{exact:true}));
  await user.click(screen.getAllByText("Revision 1",{exact:true}).find(element=>element.tagName === "SUMMARY")!);
  expect(screen.getByText(/actualBehavior: Wrong heading/)).toBeVisible();
  expect(screen.getByRole("button",{name:"New revision"})).toBeInTheDocument();
});

it("requires an explicit structured choice and never submits the recommendation automatically",async()=>{
  state.chain="analysis";state.currentPhase="decision_resolution";
  state.analysis={unit:{key:"unit",title:"Heading",actor:"Reader",trigger:"Open page",observableOutcome:"Ready heading",acceptance:"Ready",sourceRefs:[],dependsOn:[]},decisionMode:"balanced",handoff:false,spec:null};
  state.questions[0]!.decisionKey="placement";state.questions[0]!.options=[{id:"top",label:"Top",consequence:"Before content"},{id:"bottom",label:"Bottom",consequence:"After content"}];state.questions[0]!.recommendationOption="top";
  const user=userEvent.setup();renderPanel();await screen.findByRole("combobox",{name:"Your choice"});
  expect(screen.getByRole("button",{name:"Submit answer"})).toBeDisabled();
  await user.click(screen.getByRole("button",{name:"Use recommendation"}));expect(api.answerEngineering).not.toHaveBeenCalled();
  await user.click(screen.getByRole("combobox",{name:"Your choice"}));await user.click(await screen.findByRole("option",{name:/Bottom/}));
  await user.clear(screen.getByLabelText("Note (optional)"));await user.click(screen.getByRole("button",{name:"Submit answer"}));
  expect(api.answerEngineering).toHaveBeenCalledWith("issue",{expectedSequence:7,requestId:"q1",answer:"",selectedOption:"bottom"});
});


it("shows planned units and requirement acceptances without offering to rerun a finished plan",async()=>{
  state.chain="planning";state.status="completed";state.questions=[];
  state.requirement={end_to_end:false,business_source:null,feedback:null,reproduction:null,review_enabled:false,review:null,delivery_units:[],delivery_policy:null,accepted:{},progress:[],publication:null,kind:"requirement",input:"Original request",context:{intent:"Reader continues",changeSummary:"New action",acceptances:[{id:"acceptance",key:"heading",statement:"Shows Ready",oracle:"Exact visible Ready",sourceRef:"Input",revision:1}]},plan:{rationale:"Two observable outcomes",coverage:"Complete",units:[{key:"action",title:"Continue action",actor:"Reader",trigger:"Click",observableOutcome:"Next page",acceptance:"Continue works",sourceRefs:[],dependsOn:["heading"]}]}};
  const user=userEvent.setup();renderPanel();await screen.findByText("Plan ready. Delivery and final review are still required.");expect(screen.queryByRole("button",{name:/Start run|Continue run/})).not.toBeInTheDocument();await user.click(screen.getByText("Requirement acceptances",{exact:true}));await screen.findByText("Exact visible Ready");await screen.findByText("Prerequisites: heading");
});


it("keeps a failed publication retryable and freezes the plan after publication intent exists",async()=>{
 state.chain="planning";state.status="completed";state.questions=[];state.requirement={end_to_end:false,business_source:null,feedback:null,reproduction:null,review_enabled:false,review:null,delivery_units:[],delivery_policy:null,accepted:{},progress:[],publication:null,kind:"requirement",input:"Request",context:null,plan:{rationale:"One outcome",coverage:"Complete",units:[]}};
 const user=userEvent.setup();vi.mocked(api.publishEngineeringUnits).mockRejectedValueOnce(new Error("Publication interrupted; retry"));renderPanel();await user.click(await screen.findByRole("button",{name:"Publish units"}));await screen.findByText("Publication interrupted; retry");
 vi.mocked(api.publishEngineeringUnits).mockImplementationOnce(async()=>{state.requirement!.publication={requestedBy:"human",units:[{issueId:"child",published:true,unit:{key:"heading",title:"Heading"}}]};});await user.click(screen.getByRole("button",{name:"Publish units"}));await screen.findByText("Units published. Delivery and final review are still required.");expect(api.publishEngineeringUnits).toHaveBeenLastCalledWith("issue",{expectedRevision:2,expectedSequence:7});expect(screen.queryByRole("button",{name:"New revision"})).not.toBeInTheDocument();
});

it("authorizes distinct frozen delivery roles, keeps failures editable and shows accepted progress",async()=>{
  state.chain="planning";state.status="completed";state.questions=[];
  state.requirement={end_to_end:false,business_source:null,feedback:null,reproduction:null,review_enabled:false,review:null,delivery_units:[],delivery_policy:null,accepted:{},progress:[],publication:{requestedBy:"human",units:[{issueId:"child",published:true,unit:{key:"heading",title:"Ready heading"}}]},kind:"requirement",input:"Request",context:null,plan:{rationale:"One outcome",coverage:"Complete",units:[{key:"heading",title:"Ready heading",actor:"Reader",trigger:"Open",observableOutcome:"Ready",acceptance:"Ready visible",sourceRefs:[],dependsOn:[]}]}};
  vi.mocked(api.listAgents).mockResolvedValue([{id:"analyst",name:"Analyst"},{id:"developer",name:"Developer"},{id:"verifier",name:"Verifier"}] as Agent[]);
  const user=userEvent.setup();renderPanel();await user.click(await screen.findByRole("button",{name:"Start deliveries"}));const dialog=screen.getByRole("dialog");
  expect(within(dialog).getByRole("button",{name:"Authorize and start"})).toBeDisabled();
  for(const [label,name] of [["Analysis agent","Analyst"],["Development agent","Developer"],["Independent verification agent","Verifier"]]){await user.click(within(dialog).getByRole("combobox",{name:label}));await user.click(await screen.findByRole("option",{name}));}
  vi.mocked(api.authorizeEngineeringDelivery).mockRejectedValueOnce(new Error("Mapping changed; retry"));await user.click(within(dialog).getByRole("button",{name:"Authorize and start"}));await screen.findByText("Mapping changed; retry");
  vi.mocked(api.authorizeEngineeringDelivery).mockImplementationOnce(async()=>{state.requirement!.delivery_policy={analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:3,mode:"in_place",userId:"human"};state.requirement!.accepted.heading={workspaceId:"workspace",issueId:"child",revision:1,contractVersion:"spec",codeVersion:"verified-commit"};});
  await user.click(within(dialog).getByRole("button",{name:"Authorize and start"}));await screen.findByText("All units accepted. Final requirement review is still required.");expect(api.authorizeEngineeringDelivery).toHaveBeenLastCalledWith("issue",{expectedRevision:2,expectedSequence:7,analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:3});await screen.findByText("Accepted",{exact:true});expect(screen.queryByRole("button",{name:"Start deliveries"})).not.toBeInTheDocument();
});

it("selects a separate reviewer and records reading only against the current report",async()=>{
 state.chain="planning";state.status="completed";state.questions=[];
 state.requirement={end_to_end:false,business_source:null,feedback:null,reproduction:null,review_enabled:true,review:null,delivery_units:[],delivery_policy:{analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:1,mode:"in_place",userId:"human"},accepted:{heading:{workspaceId:"workspace",issueId:"child",revision:1,contractVersion:"spec",codeVersion:"verified"}},progress:[],publication:{requestedBy:"human",units:[{issueId:"child",published:true,unit:{key:"heading",title:"Heading"}}]},kind:"requirement",input:"Original",context:null,plan:{rationale:"One unit",coverage:"Complete",units:[]}};
 vi.mocked(api.listAgents).mockResolvedValue([{id:"analyst",name:"Analyst"},{id:"developer",name:"Developer"},{id:"verifier",name:"Verifier"},{id:"reviewer",name:"Reviewer"}] as Agent[]);
 const user=userEvent.setup();renderPanel();await user.click(await screen.findByRole("button",{name:"Start final review"}));const dialog=screen.getByRole("dialog");await user.click(within(dialog).getByRole("combobox",{name:"Review agent"}));expect(screen.queryByRole("option",{name:"Developer"})).not.toBeInTheDocument();await user.click(await screen.findByRole("option",{name:"Reviewer"}));
 vi.mocked(api.configureRequirementReview).mockImplementationOnce(async()=>{state.chain="review";state.status="unstarted";state.sequence=0;state.agentId="reviewer";state.requirement!.review={correction:null,current:true,generation:1,draft_id:"review",agent_id:"reviewer",report_hash:null,acknowledgement:null,result:null,history:[]};});await user.click(within(dialog).getByRole("button",{name:"Start final review"}));await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());expect(api.configureRequirementReview).toHaveBeenLastCalledWith("issue",{expectedRevision:2,expectedSequence:7,reviewerId:"reviewer"});
 state.status="completed";state.sequence=25;state.requirement.review!.report_hash="a".repeat(64);state.requirement.review!.result={verdict:"report_ready",report:"# Closure report\n\nOriginal obligations are closed",gaps:[],units:[]};state.requirement.review!.generation=2;state.requirement.review!.history=[{generation:1,draft_id:"prior-review",code_version:"prior-commit",result:{verdict:"closure_gap",report:null,gaps:[{key:"prior",subjectRef:"acceptance",kind:"missing_evidence",reason:"Prior missing evidence",boundary:"Observe original behavior"}],units:[{key:"followup",title:"Follow-up",actor:"Reader",trigger:"Open",observableOutcome:"Original behavior",acceptance:"Original oracle",gapKeys:["prior"],dependsOn:[]}]}}];await client.invalidateQueries();await screen.findByRole("heading",{name:"Closure report"});await screen.findByText("Read this report before closing the requirement.");expect(api.acknowledgeRequirementReview).not.toHaveBeenCalled();
 vi.mocked(api.acknowledgeRequirementReview).mockRejectedValueOnce(new Error("Report changed; read current version"));await user.click(screen.getByRole("button",{name:"I have read it; close requirement"}));await screen.findByText("Report changed; read current version");
 vi.mocked(api.acknowledgeRequirementReview).mockImplementationOnce(async()=>{state.requirement!.review!.acknowledgement={userId:"human",reportHash:"a".repeat(64),sequence:25,acknowledgedAt:"2026-11-14T00:00:00.000Z"};});await user.click(screen.getByRole("button",{name:"I have read it; close requirement"}));await screen.findByText("Reading confirmed for this report.");expect(api.acknowledgeRequirementReview).toHaveBeenLastCalledWith("issue",{expectedRevision:2,expectedSequence:25,reportHash:"a".repeat(64)});expect(screen.queryByRole("button",{name:"I have read it; close requirement"})).not.toBeInTheDocument();await user.click(screen.getByText("Review history",{exact:true}));await user.click(screen.getByText("Review 1",{exact:true}));await screen.findByText("Closure gaps recorded in this review.");expect(screen.queryByText("Closure gaps require follow-up delivery. The requirement remains open.")).not.toBeInTheDocument();
});

it("requires a separate bug reproducer and keeps an unsuccessful freeze editable",async()=>{
 state.configured=false;state.revision=null;state.repositoryPath="";
 vi.mocked(api.listAgents).mockResolvedValue([{id:"context",name:"Context"},{id:"planner",name:"Planner"},{id:"repro",name:"Reproducer"}] as Agent[]);
 const user=userEvent.setup();renderPanel();await user.click(await screen.findByRole("button",{name:"Plan requirement"}));const dialog=screen.getByRole("dialog");
 await user.type(within(dialog).getByLabelText("Repository path"),"/bug/repo");await user.click(within(dialog).getByRole("combobox",{name:"Requirement type"}));await user.click(await screen.findByRole("option",{name:"Bug"}));
 for(const [label,name] of [["Context agent","Context"],["Planning agent","Planner"]]){await user.click(within(dialog).getByRole("combobox",{name:label}));await user.click(await screen.findByRole("option",{name}));}
 expect(within(dialog).getByRole("button",{name:"Freeze requirement"})).toBeDisabled();await user.click(within(dialog).getByRole("combobox",{name:"Reproduction agent"}));expect(screen.queryByRole("option",{name:"Context"})).not.toBeInTheDocument();await user.click(await screen.findByRole("option",{name:"Reproducer"}));
 vi.mocked(api.configureRequirementEngineering).mockRejectedValueOnce(new Error("Runtime unavailable"));await user.click(within(dialog).getByRole("button",{name:"Freeze requirement"}));await within(dialog).findByText("Runtime unavailable");expect(within(dialog).getByLabelText("Repository path")).toHaveValue("/bug/repo");
 vi.mocked(api.configureRequirementEngineering).mockResolvedValueOnce();await user.click(within(dialog).getByRole("button",{name:"Freeze requirement"}));await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());expect(api.configureRequirementEngineering).toHaveBeenLastCalledWith("issue",expect.objectContaining({kind:"bug",contextAgentId:"context",plannerAgentId:"planner",reproductionAgentId:"repro"}));
});

it("shows pending reproduction facts without offering planning or publication",async()=>{
 state.chain="reproduction";state.requirement={end_to_end:false,business_source:null,feedback:null,reproduction:{agent_id:"repro",draft_id:"reproduction",status:"waiting_for_answers",observation:{status:"not_reproduced",expectedBehavior:"Continue activates",actualBehavior:"Continue works",environment:"Local",stability:"Once",impactScope:"Reader"},result:null},review_enabled:true,review:null,delivery_units:[],delivery_policy:null,accepted:{},progress:[],publication:null,kind:"bug",input:"Reported mismatch",context:null,plan:null};
 renderPanel();await screen.findByText("Not reproduced under the recorded conditions. Delivery planning remains blocked.");await screen.findByText("Which entry should be verified?");expect(screen.queryByRole("button",{name:"Publish units"})).not.toBeInTheDocument();expect(screen.queryByRole("button",{name:"Start run"})).not.toBeInTheDocument();
});

function completedFeedbackRequirement() {
 state.chain="review";state.status="completed";state.questions=[];state.feedbackAllowed=true;
 state.requirement={end_to_end:false,business_source:null,feedback:{capture_ready:true,enabled:true,active:false,unresolved_count:0,expected_batch_number:0,batches:[]},reproduction:null,review_enabled:true,review:{correction:null,current:true,generation:1,draft_id:"review",agent_id:"reviewer",report_hash:"a".repeat(64),acknowledgement:null,result:{verdict:"report_ready",report:"# Prior closure report",gaps:[],units:[]},history:[]},delivery_units:[],delivery_policy:{analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:1,mode:"in_place",userId:"human"},accepted:{heading:{workspaceId:"workspace",issueId:"child",revision:1,contractVersion:"spec",codeVersion:"commit"}},progress:[],publication:{requestedBy:"human",units:[{issueId:"child",published:true,unit:{key:"heading",title:"Heading"}}]},kind:"requirement",input:"Original scope",context:null,plan:null};
}

it("captures selected native comments on a closed requirement with separate roles and a retryable request",async()=>{
 completedFeedbackRequirement();
 vi.mocked(api.listAgents).mockResolvedValue([{id:"developer",name:"Developer"},{id:"triager",name:"Triager"},{id:"feedback-verifier",name:"Feedback verifier"},{id:"reviewer",name:"Report author"}] as Agent[]);
 vi.mocked(api.listComments).mockResolvedValue([{id:"comment",issue_id:"issue",author_type:"member",author_id:"human",type:"comment",content:"Explain the Continue control",parent_id:null,reactions:[],deleted_at:null,attachments:[],created_at:"2026-11-14T00:00:00Z",updated_at:"2026-11-14T00:00:00Z",resolved_at:null,resolved_by_type:null,resolved_by_id:null}]);
 const user=userEvent.setup();renderWithI18n(<QueryClientProvider client={client}><EngineeringPanel issue={issue} closed /></QueryClientProvider>,{locale:"en"});
 await user.click(await screen.findByRole("button",{name:"Process feedback"}));const dialog=screen.getByRole("dialog");
 expect(within(dialog).getByRole("button",{name:"Process feedback"})).toBeDisabled();
 await user.click(within(dialog).getByRole("combobox",{name:"Triage agent"}));expect(screen.queryByRole("option",{name:"Developer"})).not.toBeInTheDocument();await user.click(await screen.findByRole("option",{name:"Triager"}));
 await user.click(within(dialog).getByRole("combobox",{name:"Feedback verification agent"}));expect(screen.queryByRole("option",{name:"Triager"})).not.toBeInTheDocument();expect(screen.queryByRole("option",{name:"Report author"})).not.toBeInTheDocument();await user.click(await screen.findByRole("option",{name:"Feedback verifier"}));
 await user.click(await within(dialog).findByText("Explain the Continue control"));
 vi.mocked(api.beginEngineeringFeedback).mockRejectedValueOnce(new Error("Capture interrupted; retry"));await user.click(within(dialog).getByRole("button",{name:"Process feedback"}));await within(dialog).findByText("Capture interrupted; retry");expect(within(dialog).getByRole("checkbox")).toBeChecked();
 const first=vi.mocked(api.beginEngineeringFeedback).mock.calls[0]![1];
 vi.mocked(api.beginEngineeringFeedback).mockResolvedValueOnce();await user.click(within(dialog).getByRole("button",{name:"Process feedback"}));await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
 expect(first).toEqual({requestId:expect.any(String),expectedRevision:2,expectedSequence:7,expectedBatchNumber:0,agentId:"triager",verifierId:"feedback-verifier",commentIds:["comment"]});expect(api.beginEngineeringFeedback).toHaveBeenLastCalledWith("issue",first);
});

it("keeps cancelled unresolved feedback visible and removes the current report closing action",async()=>{
 completedFeedbackRequirement();state.requirement!.feedback={capture_ready:true,enabled:true,active:false,unresolved_count:1,expected_batch_number:1,batches:[{id:"batch",number:1,version:3,status:"cancelled",agent_id:"triager",verifier_id:"feedback-verifier",report_started:false,forward_work:null,summary:"New reader scope",comments:[],groups:[{verifications:[],id:"group",key:"addition",workType:"scope_addition",status:"waiting_for_plan",title:"Additional reader action",reason:"New scope",response:"",commentIds:["comment"],affectedDeliveryUnits:[],acceptance:["Separate outcome verified"]}]}]};
 const user=userEvent.setup();renderPanel();await screen.findByText("Feedback has unfinished work. The requirement cannot close.");await screen.findByText("Additional reader action");expect(screen.queryByRole("button",{name:"I have read it; close requirement"})).not.toBeInTheDocument();
 await user.click(screen.getByText("Previous report",{exact:true}));expect(screen.getByRole("heading",{name:"Prior closure report"})).toBeVisible();expect(screen.queryByRole("button",{name:"Cancel feedback processing"})).not.toBeInTheDocument();
});

it("authorizes pending feedback work with a separate planner and preserves failed input",async()=>{
 completedFeedbackRequirement();state.requirement!.feedback={capture_ready:true,enabled:true,active:true,unresolved_count:1,expected_batch_number:1,batches:[{id:"batch",number:1,version:1,status:"executing",agent_id:"triager",verifier_id:"feedback-verifier",report_started:false,forward_work:null,summary:"New scope",comments:[],groups:[{verifications:[],id:"group",key:"addition",workType:"scope_addition",status:"waiting_for_plan",title:"Additional reader action",reason:"New scope",response:"",commentIds:["comment"],affectedDeliveryUnits:[],acceptance:["New action observed"]}]}]};
 vi.mocked(api.listAgents).mockResolvedValue([{id:"planner",name:"Planner"},{id:"developer",name:"Developer"},{id:"feedback-verifier",name:"Feedback verifier"}] as Agent[]);
 const user=userEvent.setup();renderPanel();await user.click(await screen.findByRole("button",{name:"Authorize feedback deliveries"}));const dialog=screen.getByRole("dialog");expect(within(dialog).queryByRole("combobox",{name:"Reproduction agent"})).not.toBeInTheDocument();await user.click(within(dialog).getByRole("combobox",{name:"Planning agent"}));expect(screen.queryByRole("option",{name:"Developer"})).not.toBeInTheDocument();expect(screen.queryByRole("option",{name:"Feedback verifier"})).not.toBeInTheDocument();await user.click(await screen.findByRole("option",{name:"Planner"}));
 vi.mocked(api.authorizeEngineeringFeedbackWork).mockRejectedValueOnce(new Error("Resource mapping changed"));await user.click(within(dialog).getByRole("button",{name:"Authorize feedback deliveries"}));await within(dialog).findByText("Resource mapping changed");
 vi.mocked(api.authorizeEngineeringFeedbackWork).mockResolvedValueOnce();await user.click(within(dialog).getByRole("button",{name:"Authorize feedback deliveries"}));await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());expect(api.authorizeEngineeringFeedbackWork).toHaveBeenLastCalledWith("issue",{batchId:"batch",expectedVersion:1,plannerId:"planner"});
});

it("shows individual feedback results and keeps the old report historical while a new review is pending",async()=>{
 completedFeedbackRequirement();state.requirement!.review!.current=false;state.requirement!.feedback={capture_ready:false,enabled:true,active:false,unresolved_count:0,expected_batch_number:1,batches:[{id:"batch",number:1,version:4,status:"completed",agent_id:"triager",verifier_id:"feedback-verifier",report_started:false,forward_work:null,summary:"Comments independently checked",comments:[{id:"one",version:"v1",content:"Bookmark should show Saved",sourceRef:"COMMENT:one",authorId:"reader"}],groups:[{id:"group",key:"scope",workType:"scope_addition",status:"completed",title:"Bookmark",reason:"New scope",response:"",commentIds:["one"],affectedDeliveryUnits:[],acceptance:["Saved"],verifications:[{comment_id:"one",draft_id:"verify",code_version:"commit",work_version:"work",result:{verdict:"resolved",reason:"Saved was observed independently",evidence:[{key:"browser",content:"Chromium: Bookmark produced Saved"}]}}]}]}]};
 const user=userEvent.setup();renderPanel();await screen.findByText("Comments independently checked");await screen.findByText("All units accepted. Final requirement review is still required.");expect(screen.queryByRole("button",{name:"I have read it; close requirement"})).not.toBeInTheDocument();expect(screen.queryByRole("button",{name:"Process feedback"})).not.toBeInTheDocument();await user.click(screen.getByText("Feedback comment 1 · Completed",{exact:true}));expect(screen.getByText("Saved was observed independently")).toBeVisible();expect(screen.getByText("Chromium: Bookmark produced Saved")).toBeVisible();await user.click(screen.getByText("Previous report",{exact:true}));expect(screen.getByRole("heading",{name:"Prior closure report"})).toBeVisible();
});

it("shows a correction candidate and retained history while withholding reading and cancellation",async()=>{
 completedFeedbackRequirement();state.requirement!.review!.generation=2;state.requirement!.review!.current=false;state.requirement!.review!.correction={batch_id:"batch",group_id:"group",baseline_hash:"b".repeat(64),verified:false};state.requirement!.review!.history=[{generation:1,draft_id:"baseline",code_version:"commit",result:{verdict:"report_ready",report:"# Retained baseline report",gaps:[],units:[]}}];state.requirement!.feedback={capture_ready:false,enabled:true,active:true,unresolved_count:1,expected_batch_number:1,batches:[{id:"batch",number:1,version:2,status:"executing",agent_id:"triager",verifier_id:"feedback-verifier",forward_work:null,report_started:true,summary:"Correct environment wording",comments:[],groups:[{verifications:[],id:"group",key:"report",workType:"report_correction",status:"waiting_for_report",title:"Report environment",reason:"Report expression",response:"",commentIds:["comment"],affectedDeliveryUnits:[],acceptance:["Local environment accurately stated"]}]}]};
 const user=userEvent.setup();renderPanel();await screen.findByText("Candidate report",{exact:true});expect(screen.queryByRole("button",{name:"I have read it; close requirement"})).not.toBeInTheDocument();expect(screen.queryByRole("button",{name:"Cancel feedback processing"})).not.toBeInTheDocument();await user.click(screen.getByText("Candidate report",{exact:true}));await user.click(screen.getByText("Review history",{exact:true}));await user.click(screen.getByText("Review 1",{exact:true}));expect(screen.getByRole("heading",{name:"Retained baseline report"})).toBeVisible();
});

it("keeps initially authorized End to End input frozen while its context is unstarted",async()=>{
 state.chain="context";state.status="unstarted";state.questions=[];
 state.requirement={end_to_end:true,business_source:{projectId:"project",reviewDraftId:"approved",reviewHash:"a".repeat(64),specification:"# Approved reader specification",stages:(["intent","business_design","specification","review"] as const).map(stage=>({stage,draftId:stage === "review" ? "approved" : stage,hash:"a".repeat(64),conclusion:"Frozen accepted source"}))},feedback:null,reproduction:null,review_enabled:true,review:null,delivery_units:[],delivery_policy:{analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:1,mode:"in_place",userId:"human"},accepted:{},progress:[],publication:null,kind:"requirement",input:"Original idea",context:null,plan:null};
 renderPanel();await screen.findByText("Approved specification");expect(screen.queryByRole("button",{name:"New revision"})).not.toBeInTheDocument();expect(screen.queryByText("Delivery authorized. Open a unit to review progress or answer questions.")).not.toBeInTheDocument();
});

it("retains the frozen phase and original intervention evidence while refusing continuation", async () => {
 state.status="waiting_for_intervention";state.questions=[];state.intervention={id:"019a0000-0000-7000-8000-000000000001",status:"pending_admin",chain:"verification",phase:"plan",draft_id:"draft",revision:2,sequence:7,attempt_id:"native:claim",agent_id:"verifier",summary:"The original contract conflicts with the entry",reason:"An answer cannot replace the frozen oracle",evidence:"# Original evidence\n\nInspected the existing entry.",requested_at:"2026-11-14T00:00:00.000Z",observation_id:"role-request",snapshot_hash:"a".repeat(64)};
 renderWithI18n(<QueryClientProvider client={client}><EngineeringPanel issue={issue} /></QueryClientProvider>);
 const region=await screen.findByRole("region",{name:"Intervention"});expect(within(region).getByText(state.intervention.summary)).toBeVisible();
 await userEvent.click(within(region).getByText("Original investigation evidence"));expect(within(region).getByRole("heading",{name:"Original evidence"})).toBeVisible();
 expect(screen.queryByRole("button",{name:/Continue run|Start run/})).not.toBeInTheDocument();expect(screen.queryByRole("button",{name:"Abandon draft"})).not.toBeInTheDocument();
});

it("shows a recorded repair without claiming an investigation process is running",async()=>{
 state.repair={available:true,recorded:true,case_id:"REPAIR-original",status:"queued",original_version:"kernel-and-host-version",observation_count:2,supervision_active:true,desired_intent:"stopped",execution_connected:false};
 renderWithI18n(<QueryClientProvider client={client}><EngineeringPanel issue={issue} /></QueryClientProvider>);
 const region=await screen.findByRole("region",{name:"Repair case"});expect(within(region).getByText("Waiting for repair setup")).toBeVisible();expect(within(region).getByText("Retained observations: 2")).toBeVisible();expect(within(region).getByText("REPAIR-original")).toBeVisible();
});
