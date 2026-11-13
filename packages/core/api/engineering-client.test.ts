// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const body = { enabled: true, configured: true, chain: "verification", agent_id: "verifier", revision: 2, sequence: 7, status: "editing", has_active_run: false,
  sources: [{ key: "ac1", kind: "acceptance", description: "Survives reload", oracle: "Title visible", source_ref: "ISSUE:fixture:r1" }],
  questions: [{ id: "q1", title: "Entry", question: "Which entry?", active: true, phase: "plan", answer: { text: "Local entry", user_id: "human", sequence: 7 } }],
};
const respond = (value: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })));
afterEach(() => vi.unstubAllGlobals());

it("keeps requirement reviewer selection and exact report reading identity at the human API boundary",async()=>{
  const client=new ApiClient("https://api.example.test");
  respond({configured:true});await client.configureRequirementReview("parent",{expectedRevision:1,expectedSequence:17,reviewerId:"reviewer"});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_revision:1,expected_sequence:17,agent_id:"reviewer"});
  respond({acknowledged:true});await client.acknowledgeRequirementReview("parent",{expectedRevision:1,expectedSequence:25,reportHash:"a".repeat(64)});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_revision:1,expected_sequence:25,report_hash:"a".repeat(64)});
  respond({acknowledged:"true"});await expect(client.acknowledgeRequirementReview("parent",{expectedRevision:1,expectedSequence:25,reportHash:"a".repeat(64)})).rejects.toThrow(/Invalid report reading/);
});

it("rejects incomplete reports and reading acknowledgements for another report generation",async()=>{
  const review={generation:1,draft_id:"review",agent_id:"reviewer",report_hash:"a".repeat(64),acknowledgement:null,result:{verdict:"report_ready",report:"# Closure report",gaps:[],units:[]},history:[]};
  const requirement={kind:"requirement",input:"Original",context:null,plan:null,review_enabled:true,review};respond({...body,chain:"review",requirement});expect(await new ApiClient("https://api.example.test").getEngineeringOverview("parent")).toMatchObject({requirement:{review:{result:{verdict:"report_ready"},acknowledgement:null}}});
  for(const invalid of [{...review,report_hash:null},{...review,result:{...review.result,report:null}},{...review,acknowledgement:{userId:"human",reportHash:"b".repeat(64),sequence:25,acknowledgedAt:"2026-11-14T00:00:00.000Z"}}]){respond({...body,chain:"review",requirement:{...requirement,review:invalid}});await expect(new ApiClient("https://api.example.test").getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);}
});

it("authorizes the exact managed delivery checkpoint and rejects a malformed acknowledgement",async()=>{
  const input={expectedRevision:2,expectedSequence:17,analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:3};
  respond({authorized:true});await new ApiClient("https://api.example.test").authorizeEngineeringDelivery("issue",input);
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_revision:2,expected_sequence:17,analyst_agent_id:"analyst",developer_agent_id:"developer",agent_id:"verifier",max_reworks:3});
  respond({authorized:"true"});await expect(new ApiClient("https://api.example.test").authorizeEngineeringDelivery("issue",input)).rejects.toThrow(/Invalid delivery authorization/);
});

it("validates frozen managed policy, accepted versions and child progress",async()=>{
  const requirement={kind:"requirement",input:"Original",context:null,plan:null,delivery_policy:{analystId:"analyst",developerId:"developer",verifierId:"verifier",maxReworks:3,mode:"worktree",userId:"human"},accepted:{unit:{workspaceId:"workspace",issueId:"child",revision:1,contractVersion:"spec",codeVersion:"verified"}},progress:[{key:"unit",chain:"verification",status:"completed",stop_reason:null}]};
  respond({...body,chain:"planning",requirement});expect(await new ApiClient("https://api.example.test").getEngineeringOverview("parent")).toMatchObject({requirement:{delivery_policy:{mode:"worktree"},accepted:{unit:{codeVersion:"verified"}},progress:[{key:"unit",status:"completed"}]}});
  respond({...body,chain:"planning",requirement:{...requirement,accepted:{unit:{codeVersion:"unbound"}}}});await expect(new ApiClient("https://api.example.test").getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);
  respond({...body,chain:"planning",requirement:{...requirement,delivery_policy:{...requirement.delivery_policy,maxReworks:100}}});await expect(new ApiClient("https://api.example.test").getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);
});

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


it("validates requirement context/plan projections and fails closed when their frozen input is missing",async()=>{
  respond({...body,chain:"context",requirement:{kind:"requirement",input:"Original request",context:null,plan:null}});
  expect(await new ApiClient("https://api.example.test").getEngineeringOverview("issue")).toMatchObject({requirement:{input:"Original request"}});
  respond({...body,chain:"planning"});await expect(new ApiClient("https://api.example.test").getEngineeringOverview("issue")).rejects.toThrow(/Invalid engineering overview/);
});
it("sends a distinct requirement configuration without inventing delivery sources or verifier identity",async()=>{
  respond({contract:{binding:{issueId:"issue",revision:1}},draft:null});
  await new ApiClient("https://api.example.test").configureRequirementEngineering("issue",{expectedRevision:0,contextAgentId:"backlog",plannerAgentId:"planner",repositoryPath:"/fixture",input:"Original request",kind:"bug",decisionMode:"balanced",autoContinue:true});
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({kind:"requirement",expected_revision:0,agent_id:"backlog",planner_agent_id:"planner",repository_path:"/fixture",input:"Original request",item_kind:"bug",decision_mode:"balanced",auto_continue:true});
});


it("publishes only the frozen checkpoint and refuses malformed success responses",async()=>{
 respond({published:true});await new ApiClient("https://api.example.test").publishEngineeringUnits("parent",{expectedRevision:1,expectedSequence:9});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_revision:1,expected_sequence:9});
 respond({published:false});await expect(new ApiClient("https://api.example.test").publishEngineeringUnits("parent",{expectedRevision:1,expectedSequence:9})).rejects.toThrow(/Invalid publication/);
});
it("decodes immutable managed-unit scope and fails closed on malformed publication identities",async()=>{
 const unit={key:"heading",title:"Heading",actor:"Reader",trigger:"Open",observableOutcome:"Ready",acceptance:"Exact Ready",sourceRefs:[],dependsOn:[]};
 respond({enabled:true,configured:false,managed_unit:{parentIssueId:"parent",parentRevision:1,planDraftId:"plan",published:true,unit,sources:[]}});expect(await new ApiClient("https://api.example.test").getEngineeringOverview("child")).toMatchObject({managedUnit:{parentIssueId:"parent",unit:{key:"heading"}}});
 respond({...body,chain:"planning",requirement:{kind:"requirement",input:"Request",context:null,plan:null,publication:{requested_by:"human",units:[{published:true,unit}]}}});await expect(new ApiClient("https://api.example.test").getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);
});

it("freezes a bug reproducer and rejects malformed reproduction overview facts",async()=>{
 const client=new ApiClient("https://api.example.test");respond({contract:{binding:{revision:1,issueId:"bug"}},draft:null});await client.configureRequirementEngineering("bug",{expectedRevision:0,contextAgentId:"context",plannerAgentId:"planner",reproductionAgentId:"repro",repositoryPath:"/repo",input:"Reported mismatch",kind:"bug",decisionMode:"balanced",autoContinue:true});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({item_kind:"bug",reproduction_agent_id:"repro"});
 const requirement={kind:"bug",input:"Reported mismatch",context:null,plan:null,reproduction:{agent_id:"repro",draft_id:"draft",status:"editing",observation:{status:"not_reproduced",expectedBehavior:"Continue activates",actualBehavior:"Continue works",environment:"Local",stability:"Once",impactScope:"Reader"},result:null}};
 respond({...body,chain:"reproduction",requirement});expect(await client.getEngineeringOverview("bug")).toMatchObject({chain:"reproduction",requirement:{reproduction:{observation:{status:"not_reproduced"}}}});
 for(const reproduction of [null,{...requirement.reproduction,observation:{...requirement.reproduction.observation,status:"passed"}},{...requirement.reproduction,result:{verdict:"not_reproduced",report:"Not observed",code_version:"old"}}]){respond({...body,chain:"reproduction",requirement:{...requirement,reproduction}});await expect(client.getEngineeringOverview("bug")).rejects.toThrow(/Invalid engineering overview/);}
});

it("captures only native comment identities and refuses malformed feedback acknowledgements",async()=>{
 const client=new ApiClient("https://api.example.test"),input={requestId:"019a0000-0000-7000-8000-000000000071",expectedRevision:1,expectedSequence:25,expectedBatchNumber:0,agentId:"triager",verifierId:"feedback-verifier",commentIds:["comment"]};
 respond({configured:true,batch_id:input.requestId,reopen_required:true});await client.beginEngineeringFeedback("parent",input);expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({request_id:input.requestId,expected_revision:1,expected_sequence:25,expected_batch_number:0,agent_id:"triager",verifier_id:"feedback-verifier",comment_ids:["comment"]});
 respond({configured:"true",batch_id:input.requestId,reopen_required:true});await expect(client.beginEngineeringFeedback("parent",input)).rejects.toThrow(/Invalid feedback capture/);
 respond({cancelled:true});await client.cancelEngineeringFeedback("parent",{batchId:input.requestId,expectedVersion:2,reason:"Preserve pending work"});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({batch_id:input.requestId,expected_version:2,reason:"Preserve pending work"});
 respond({...body,chain:"feedback-triage",requirement:null});await expect(client.getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);
});

it("authorizes only feedback role identities and validates forward work overview facts",async()=>{
 const client=new ApiClient("https://api.example.test"),input={batchId:"batch",expectedVersion:1,plannerId:"planner",reproducerId:"reproducer"};
 respond({authorized:true});await client.authorizeEngineeringFeedbackWork("parent",input);expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({batch_id:"batch",expected_version:1,planner_agent_id:"planner",reproduction_agent_id:"reproducer"});
 respond({authorized:"true"});await expect(client.authorizeEngineeringFeedbackWork("parent",input)).rejects.toThrow(/Invalid feedback work authorization/);
 const work={planner_id:"planner",reproducer_id:"reproducer",appended:true,unit_ids:["child"]},batch={id:"batch",number:1,version:1,status:"executing",agent_id:"triager",verifier_id:"feedback-verifier",forward_work:work,summary:null,comments:[],groups:[]};
 const requirement={kind:"requirement",input:"Frozen feedback",context:null,plan:null,feedback:{enabled:true,active:true,unresolved_count:1,expected_batch_number:1,batches:[batch]}};
 respond({...body,chain:"feedback-triage",requirement});expect(await client.getEngineeringOverview("parent")).toMatchObject({requirement:{feedback:{batches:[{forward_work:work}]}}});
 for(const invalid of [{...work,appended:"true"},{...work,planner_id:""},{...work,unit_ids:[null]}]){respond({...body,chain:"feedback-triage",requirement:{...requirement,feedback:{...requirement.feedback,batches:[{...batch,forward_work:invalid}]}}});await expect(client.getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);}
});
