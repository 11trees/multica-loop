// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const body = { enabled: true, configured: true, chain: "verification", agent_id: "verifier", revision: 2, sequence: 7, status: "editing", has_active_run: false,
  sources: [{ key: "ac1", kind: "acceptance", description: "Survives reload", oracle: "Title visible", source_ref: "ISSUE:fixture:r1" }],
  questions: [{ id: "q1", title: "Entry", question: "Which entry?", active: true, phase: "plan", answer: { text: "Local entry", user_id: "human", sequence: 7 } }],
};
const respond = (value: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })));
afterEach(() => vi.unstubAllGlobals());

it("parses overview identity and answer attribution and maps wire fields at the API boundary", async () => {
  respond(body);
  const state = await new ApiClient("https://api.example.test").getEngineeringOverview("issue");
  expect(state).toMatchObject({ autoContinue: false, agentId: "verifier", revision: 2, sequence: 7, hasActiveRun: false, currentPhase: null, artifacts: [],
    sources: [{ sourceRef: "ISSUE:fixture:r1" }], questions: [{ answer: { text: "Local entry", userId: "human", sequence: 7 } }] });
  expect(state).not.toHaveProperty("agent_id");
});

it("reads an explicitly enabled automatic continuation policy", async () => {
  respond({ ...body, auto_continue: true });
  expect(await new ApiClient("https://api.example.test").getEngineeringOverview("issue")).toMatchObject({ autoContinue: true });
});

it("keeps unknown statuses readable and treats absent run availability as unknown", async () => {
  respond({ ...body, status: "future_state", has_active_run: undefined });
  expect(await new ApiClient("https://api.example.test").getEngineeringOverview("issue")).toMatchObject({ status: "future_state", hasActiveRun: null });
});

it.each([{ enabled: false, configured: false }, { enabled: true, configured: false }])("supports unconfigured and disabled hosts", async value => {
  respond(value); expect(await new ApiClient("https://api.example.test").getEngineeringOverview("issue")).toMatchObject(value);
});

it.each([{ configured: true }, { ...body, revision: null }, { ...body, questions: "invalid" }, { ...body, agent_id: 42 }, { ...body, status: "waiting_for_answers", questions: undefined }])("rejects malformed configured data without pretending delivery is unconfigured", async value => {
  respond(value); await expect(new ApiClient("https://api.example.test").getEngineeringOverview("issue")).rejects.toThrow(/Invalid engineering overview/);
});

it("sends the current checkpoint and immutable request identity when answering", async () => {
  respond({ contract: { binding: { issueId: "issue", revision: 2 } }, draft: { sequence: 8, status: "editing" } });
  await new ApiClient("https://api.example.test").answerEngineering("issue", { expectedSequence: 7, requestId: "q1", answer: "Line one\nLine two" });
  const request = vi.mocked(fetch).mock.calls[0]!;
  expect(request[0]).toBe("https://api.example.test/api/issues/issue/engineering/verification/answers");
  expect(JSON.parse(String(request[1]?.body))).toEqual({ expected_sequence: 7, request_id: "q1", answer: "Line one\nLine two" });
});

it("rejects an invalid successful mutation response", async () => {
  respond({ ok: true }); await expect(new ApiClient("https://api.example.test").abandonEngineering("issue", { expectedSequence: 7, reason: "Changed scope" })).rejects.toThrow(/Invalid engineering write/);
});

it("validates rework history and maps its revision and repository evidence", async () => {
  const rework={root_revision:1,round:1,limit:3,stop_reason:"future_stop",history:[{revision:1,draft_id:"failed",code_version:"old-commit",decision:"rework",artifacts:[{ref:"verification.results",key:"s1",content:"status: failed"}]}]};
  respond({...body,rework});
  expect(await new ApiClient("https://api.example.test").getEngineeringOverview("issue")).toMatchObject({rework:{rootRevision:1,stopReason:"future_stop",history:[{draftId:"failed",codeVersion:"old-commit"}]}});
  respond({...body,rework:{...rework,history:"invalid"}});
  await expect(new ApiClient("https://api.example.test").getEngineeringOverview("issue")).rejects.toThrow(/Invalid engineering overview/);
});

it.each([undefined,2])("sends only the explicitly requested rework budget %s", async budget => {
  respond({contract:{binding:{issueId:"issue",revision:1}},draft:null});
  await new ApiClient("https://api.example.test").configureEngineering("issue",{expectedRevision:0,verifierId:"verifier",developerId:"developer",autoContinue:true,maxReworks:budget,repositoryPath:"/fixture",implementationGuidance:"Implement",sources:[]});
  const request=vi.mocked(fetch).mock.calls[0]!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({max_reworks:budget ?? 0,auto_continue:true});
});

it("validates structured decision snapshots and sends the selected option without inventing an answer",async()=>{
  respond({...body,questions:[{...body.questions[0],decision_key:"placement",answer:null,options:[{id:"top",label:"Top",consequence:"Before"},{id:"bottom",label:"Bottom",consequence:"After"}],recommendation_option:"top"}]});
  expect((await new ApiClient("https://api.example.test").getEngineeringOverview("issue")).questions[0]).toMatchObject({decisionKey:"placement",recommendationOption:"top",options:[{id:"top"},{id:"bottom"}]});
  respond({...body,questions:[{...body.questions[0],decision_key:"placement"}]});await expect(new ApiClient("https://api.example.test").getEngineeringOverview("issue")).rejects.toThrow(/Invalid engineering overview/);
  respond({contract:{binding:{issueId:"issue",revision:2}},draft:{sequence:8,status:"waiting_for_answers"}});
  await new ApiClient("https://api.example.test").answerEngineering("issue",{expectedSequence:7,requestId:"q1",answer:"",selectedOption:"bottom"});
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_sequence:7,request_id:"q1",answer:"",selected_option:"bottom"});
});
