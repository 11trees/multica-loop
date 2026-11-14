// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const body = { enabled: true, configured: true, chain: "verification", agent_id: "verifier", revision: 2, sequence: 7, status: "editing", has_active_run: false,
  sources: [{ key: "ac1", kind: "acceptance", description: "Survives reload", oracle: "Title visible", source_ref: "ISSUE:fixture:r1" }],
  questions: [{ id: "q1", title: "Entry", question: "Which entry?", active: true, phase: "plan", answer: { text: "Local entry", user_id: "human", sequence: 7 } }],
};
const respond = (value: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })));
afterEach(() => vi.unstubAllGlobals());

it("binds business reading and comments to their exact published version at human endpoints",async()=>{
  const client=new ApiClient("https://api.example.test"),reading={expectedVersion:8,draftId:"spec-v2",specificationHash:"a".repeat(64)};
  respond({acknowledged:true});await client.acknowledgeBusinessSpecification("analysis",reading);expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({expected_version:8,draft_id:"spec-v2",specification_hash:"a".repeat(64)});
  respond({acknowledged:"true"});await expect(client.acknowledgeBusinessSpecification("analysis",reading)).rejects.toThrow(/Invalid specification reading/);
  const feedback={requestId:"request",draftId:"spec-v2",specificationHash:"a".repeat(64),content:"Clarify item identity",anchorType:"selection" as const,quotedText:"selected item",intent:"question" as const};
  respond({submitted:true,comment_id:"native-comment"});expect(await client.commentBusinessSpecification("analysis",feedback)).toEqual({commentId:"native-comment"});expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({request_id:"request",draft_id:"spec-v2",anchor_type:"selection",quoted_text:"selected item",intent:"question"});
  respond({submitted:true});await expect(client.commentBusinessSpecification("analysis",feedback)).rejects.toThrow(/Invalid specification comment/);
});
it("rejects incomplete specification reading and comment proofs",async()=>{
  const client=new ApiClient("https://api.example.test"),result={kind:"business-analysis",stage:"review",draftId:"review-v2",binding:{workspaceId:"workspace",issueId:"analysis",revision:1,contractVersion:"contract",codeVersion:"commit"},disposition:"approved",artifact:{title:"Specification",content:"# Selected item"}};
  const specification={draft_id:"review-v2",hash:"a".repeat(64),generation:2,title:"Specification",content:"# Selected item",ready:true,acknowledgement:null};
  const business={input:"Reader continues",project_id:"project",stage:"review",generation:2,version:8,reading_enabled:true,specification,comments:[],readings:[],history:[{stage:"review",generation:2,draft_id:"review-v2",superseded:false,settled:true,result}]};
  respond({...body,chain:"spec-review",business});expect(await client.getEngineeringOverview("analysis")).toMatchObject({business:{version:8,specification:{draftId:"review-v2",ready:true}}});
  for(const invalid of [{...business,version:undefined},{...business,specification:{...specification,content:"Other specification"}},{...business,specification:{...specification,acknowledgement:{userId:"human",draftId:"old",specificationHash:"a".repeat(64),expectedVersion:8,acknowledgedAt:"2026-11-14T00:00:00.000Z"}}},{...business,comments:[{id:"comment",draftId:"review-v1",content:"Clarify",quotedText:null,anchorType:"file",intent:"question",status:"resolved"}]}]){respond({...body,chain:"spec-review",business:invalid});await expect(client.getEngineeringOverview("analysis")).rejects.toThrow(/Invalid engineering overview/);}
});

it("freezes business roles through the dedicated human endpoint and rejects malformed confirmation",async()=>{
  const client=new ApiClient("https://api.example.test"),input={expectedRevision:0,repositoryPath:"/project",input:"Reader continues",roles:{intent:"intent",businessDesign:"design",specification:"spec",review:"review"},decisionMode:"balanced" as const,autoContinue:true};
  respond({configured:true});await client.configureBusinessEngineering("parent",input);expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("https://api.example.test/api/issues/parent/engineering/business-analysis");expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({roles:{intent:"intent",business_design:"design",specification:"spec",review:"review"},input:"Reader continues"});
  respond({configured:"true"});await expect(client.configureBusinessEngineering("parent",input)).rejects.toThrow(/Invalid business configuration/);
});
it("validates business history and keeps protocol approval separate from native completion",async()=>{
  const client=new ApiClient("https://api.example.test"),business={input:"Original idea",project_id:"project",stage:"intent",generation:1,reading_enabled:false,history:[{stage:"intent",generation:1,draft_id:"draft",superseded:false,settled:false,result:null}]};
  respond({...body,chain:"idea-context",business});expect(await client.getEngineeringOverview("parent")).toMatchObject({business:{input:"Original idea",projectId:"project",readingEnabled:false,history:[{draftId:"draft"}]}});
  for(const invalid of [null,{...business,input:""},{...business,history:[]},{...business,reading_enabled:"true"},{...business,history:[{...business.history[0],settled:true}]},{...business,generation:2}]){respond({...body,chain:"idea-context",business:invalid});await expect(client.getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);}
});

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

it("validates single-comment feedback proof and the stale report boundary",async()=>{
 const client=new ApiClient("https://api.example.test"),entry={comment_id:"one",draft_id:"verify-one",code_version:"accepted-commit",work_version:"frozen-work",result:null},group={id:"group",key:"scope",workType:"scope_addition",status:"verifying",title:"Reader action",reason:"New scope",response:"",commentIds:["one"],affectedDeliveryUnits:[],acceptance:["Saved"],verifications:[entry]},batch={id:"batch",number:1,version:3,status:"verifying",agent_id:"triager",verifier_id:"feedback-verifier",summary:null,comments:[],groups:[group]},feedback={enabled:true,active:true,capture_ready:false,unresolved_count:1,expected_batch_number:1,batches:[batch]},requirement={kind:"requirement",input:"Feedback",context:null,plan:null,feedback};
 respond({...body,chain:"feedback-verify",requirement});expect(await client.getEngineeringOverview("parent")).toMatchObject({requirement:{feedback:{capture_ready:false,batches:[{groups:[{verifications:[entry]}]}]}}});
 for(const verifications of [[],[{...entry,work_version:""}],[{...entry,result:{verdict:"resolved",reason:"Observed",evidence:[]}}]]){respond({...body,chain:"feedback-verify",requirement:{...requirement,feedback:{...feedback,batches:[{...batch,groups:[{...group,verifications}]}]}}});await expect(client.getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);}
});

it("keeps report candidates distinct and rejects malformed correction lineage",async()=>{
 const client=new ApiClient("https://api.example.test"),review={generation:2,draft_id:"candidate",agent_id:"reviewer",current:false,report_hash:"b".repeat(64),acknowledgement:null,result:{verdict:"report_ready",report:"# Candidate report",gaps:[],units:[]},history:[],correction:{batch_id:"batch",group_id:"group",baseline_hash:"a".repeat(64),verified:false}},requirement={kind:"requirement",input:"Correct report wording",context:null,plan:null,review};
 respond({...body,chain:"review",requirement});expect(await client.getEngineeringOverview("parent")).toMatchObject({requirement:{review:{current:false,correction:{verified:false}}}});
 for(const correction of [{...review.correction,verified:"true"},{...review.correction,baseline_hash:"invalid"},{...review.correction,group_id:""}]){respond({...body,chain:"review",requirement:{...requirement,review:{...review,correction}}});await expect(client.getEngineeringOverview("parent")).rejects.toThrow(/Invalid engineering overview/);}
});

it("preserves initial End to End roles and budget and rejects missing or inconsistent approved source versions",async()=>{
 const client=new ApiClient("https://api.example.test");
 const roles={context:"context",planner:"planner",analyst:"analyst",developer:"developer",verifier:"verifier",reviewer:"reviewer"};
 respond({configured:true});await client.configureBusinessEngineering("parent",{expectedRevision:0,repositoryPath:"/project",input:"Original idea",roles:{intent:"intent",businessDesign:"design",specification:"spec",review:"spec-review"},delivery:{roles,maxReworks:2},decisionMode:"balanced",autoContinue:true});
 expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({delivery:{roles,max_reworks:2},auto_continue:true});
 const {EngineeringOverviewSchema}=await import("../issues/engineering-schema");
 const base={enabled:true,configured:true,chain:"context",agent_id:"context",revision:1,sequence:0,requirement:{kind:"requirement",input:"Original idea",context:null,plan:null,end_to_end:true}};
 expect(EngineeringOverviewSchema.safeParse(base).success).toBe(false);
 const source={projectId:"project",reviewDraftId:"approved-review",reviewHash:"a".repeat(64),specification:"Exact approved specification",stages:["intent","business_design","specification","review"].map(stage=>({stage,draftId:stage === "review" ? "approved-review" : stage,hash:"a".repeat(64),conclusion:"Frozen complete conclusion"}))};
 expect(EngineeringOverviewSchema.parse({...base,requirement:{...base.requirement,business_source:source}}).requirement?.business_source?.specification).toBe(source.specification);
 expect(EngineeringOverviewSchema.safeParse({...base,requirement:{...base.requirement,business_source:{...source,reviewHash:"b".repeat(64)}}}).success).toBe(false);
});
