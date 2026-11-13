import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import type { Agent, Issue } from "@multica/core/types";
import type { EngineeringOverview } from "@multica/core/issues";
import { renderWithI18n } from "../../test/i18n";
import { EngineeringPanel } from "./engineering-panel";

const endpoints = vi.hoisted(() => ({ getEngineeringOverview: vi.fn(), listAgents: vi.fn(), answerEngineering: vi.fn(), abandonEngineering: vi.fn(), configureEngineering: vi.fn(), runEngineering: vi.fn() }));
vi.mock("@multica/core/api", async importOriginal => ({ ...await importOriginal<typeof import("@multica/core/api")>(), api: endpoints }));
vi.mock("@multica/core/hooks", async importOriginal => ({ ...await importOriginal<typeof import("@multica/core/hooks")>(), useWorkspaceId: () => "workspace" }));
const issue = { id: "issue", title: "Fixture delivery", revision: 4 } as Issue;
const initial: EngineeringOverview = {
  autoContinue: false, enabled: true, configured: true, chain: "verification", agentId: "verifier", revision: 2, sequence: 7,
  codeVersion: "commit-fixture", repositoryPath: "/fixture", draftId: "draft", status: "waiting_for_answers", currentPhase: "plan", hasActiveRun: false,
  phases: [{ id: "inputs", status: "completed" }, { id: "plan", status: "current" }],
  sources: [{ key: "ac1", kind: "acceptance", description: "Survives reload", oracle: "Title visible", sourceRef: "ISSUE:fixture" }],
  questions: [{ id: "q1", title: "Fixture entry", question: "Which entry should be verified?", why: "Need isolated data", recommendation: "Use the local fixture", active: true, phase: "plan", answer: null }],
  artifacts: [], result: null, rework: null,
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
