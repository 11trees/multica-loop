// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stringify } from "yaml";
import { z } from "zod";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineeringApplication, type ApplicationRequest } from "./application";
import { businessContractSchema, type BusinessStage } from "./business";
import { draftSchema, type ChainCommand } from "./runtime";

const stageOrder = ["intent", "business_design", "specification", "review"] as const;
const human = { kind: "human" as const, workspaceId: "11111111-1111-4111-8111-111111111111", issueId: "22222222-2222-4222-8222-222222222222", userId: "33333333-3333-4333-8333-333333333333" };
const projectId = "44444444-4444-4444-8444-444444444444";
const roles = Object.fromEntries(stageOrder.map(stage => [stage, randomUUID()])) as Record<BusinessStage, string>;
const namespace = { intent: "requirement-intent", business_design: "business-solution", specification: "requirement-specification", review: "specification-review" };
const specification = "# Reader specification\n\n## ACCEPTANCE\nContinue opens the selected item.";
const viewSchema = z.object({ chain: z.string(), contract: businessContractSchema, draft: draftSchema.nullable(), business: z.object({ stage: z.string(), generation: z.number(), upstream: z.array(z.unknown()), previous: z.unknown(), returnReason: z.unknown() }), conclusion: z.unknown().nullable() });
const overviewSchema = z.object({ chain: z.string(), sequence: z.number(), business: z.object({ stage: z.string(), generation: z.number(), reading_enabled: z.boolean(), history: z.array(z.object({ stage: z.string(), generation: z.number(), draft_id: z.string(), superseded: z.boolean(), settled: z.boolean(), result: z.object({ disposition: z.string(), artifact: z.object({ content: z.string() }), decisions: z.array(z.unknown()) }).nullable() })) }) });
type Outputs = Record<string, { key?: string; value: unknown }[]>;
const one = (value: unknown) => [{ value }], many = (key: string, value: unknown) => [{ key, value }];
function outputs(stage: BusinessStage): Outputs {
  if (stage === "intent") return { discovery: one("Investigated original reader intent"), "answer-review": one("All choices retain their source"), problem: one("Reader loses the current item"), actors: many("reader", { name: "Reader", role: "User", need: "Continue reading" }), goals: many("continue", { content: "Continue the selected item", source: "Original idea" }), success: many("continue", { outcome: "Selected item opens", measure: "Observed item identity" }) };
  if (stage === "business_design") return { exploration: one("Explored reader choices"), "answer-review": one("No new business branches"), summary: one("Continue the selected item"), actors: many("reader", { name: "Reader", responsibility: "Choose an item" }), scenarios: many("continue", { kind: "main", actor: "Reader", trigger: "Continue", outcome: "Item opens" }), flows: many("open", { scenario: "Continue", action: "Activate Continue", result: "Item opens" }), rules: many("selected", { content: "Use selected item", rationale: "Retain context" }), scope: many("continue", { direction: "included", content: "Selected item" }), success: many("continue", { outcome: "Item opens", measure: "Item identity" }) };
  if (stage === "specification") return { draft: one("Draft with source traceability"), verification: one("Reconciled every outcome and acceptance"), final: one(specification) };
  return { findings: many("reader", { subject: "Reader outcome", verdict: "passed", evidence: "Specification ACCEPTANCE", reason: "Retains selected item" }), "verdict-summary": one("Independent scope review passed"), "approved-specification": one(specification) };
}
let directory: string, repository: string, database: string, app: EngineeringApplication, allSources: string[];
const git = (args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
function open() { return new EngineeringApplication(database, allSources[0]!, allSources[1], allSources[2], { context: allSources[3]!, planning: allSources[4]!,review:allSources[9]! }, { intent: allSources[5]!, business_design: allSources[6]!, specification: allSources[7]!, review: allSources[8]! }); }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "multica-business-host-")); repository = join(directory, "repository"); database = join(directory, "engineering.sqlite");
  execFileSync("git", ["init", "-q", repository]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]); await writeFile(join(repository, "README.md"), "Reader fixture\n"); git(["add", "README.md"]); git(["commit", "-qm", "Fixture"]);
  allSources = await Promise.all(["verification", "development", "analysis", "context", "planning", "idea-context", "business-design", "requirement-spec", "spec-review", "review"].map(name => readFile(new URL(`./definitions/${name}.yaml`, import.meta.url), "utf8")));
  app = open();
});
afterEach(async () => { app.close(); await rm(directory, { recursive: true, force: true }); });
const invoke = (actor: ApplicationRequest["actor"], action: ApplicationRequest["action"], payload?: unknown) => app.invoke({ actor, action, payload });
const configuration = (mode: "in_place" | "worktree" = "in_place") => ({ expected_revision: 0, project_id: projectId, repository_path: repository, input: "Reader continues the selected item", roles, decision_mode: "balanced", auto_continue: true, execution_resources: stageOrder.map(() => ({ path: repository, mode })) });
const overview = async () => overviewSchema.parse(await invoke(human, "overview"));
const closureSchema=z.object({business:z.object({version:z.number(),specification:z.object({draft_id:z.string(),hash:z.string(),content:z.string(),ready:z.boolean(),acknowledgement:z.object({userId:z.string()}).nullable()}).nullable(),comments:z.array(z.object({id:z.string(),status:z.string(),reviewedBy:z.string().optional()})),readings:z.array(z.unknown())})});
const closure=async()=>closureSchema.parse(await invoke(human,"overview")).business;
const host={kind:"host" as const,workspaceId:human.workspaceId,issueId:human.issueId};
const actor = (stage: BusinessStage, attemptId = randomUUID()) => ({ kind: "task" as const, workspaceId: human.workspaceId, issueId: human.issueId, projectId, agentId: roles[stage], attemptId });
async function start(stage: BusinessStage, owner = actor(stage), mode: "in_place" | "worktree" = "in_place", path = repository) {
  await invoke({ ...owner, kind: "daemon" }, "bind", { work_dir: path, mode, overlays: [] });
  let state = viewSchema.parse(await invoke(owner, "start"));
  const command = async (command: ChainCommand) => state = viewSchema.parse(await invoke(owner, "command", { expected_sequence: state.draft!.sequence, command }));
  const next = () => command({ type: "phase.complete" });
  const put = (block: string, value: unknown, key?: string) => command({ type: "artifact.put", ref: `${namespace[stage]}.${block}`, content: typeof value === "string" ? value : stringify(value), key });
  const until = async (target: string | null, values = outputs(stage)) => {
    while (state.draft!.phase !== target) {
      const phase = state.draft!.definition.phases[state.draft!.phase!];
      if (!phase) throw new Error("Target business phase cannot be reached");
      if (phase.type === "artifact" || phase.type === "builtin") for (const ref of phase.artifacts) for (const row of values[ref.split(".")[1]!] ?? []) await put(ref.split(".")[1]!, row.value, row.key);
      await next();
    }
  };
  return { owner, get state() { return state; }, command, next, put, until };
}
it("runs all four source roles with frozen upstream publications and independent specification approval", async () => {
  await invoke(human, "configure-business", configuration());
  for (const stage of stageOrder) {
    const pending = await invoke({ kind: "coordinator" }, "continuations"); expect(pending).toEqual([expect.objectContaining({ agent_id: roles[stage], reason: "business_ready" })]);
    expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual(pending);
    const session = await start(stage); expect(session.state.business.upstream).toHaveLength(stageOrder.indexOf(stage)); await session.until(null);
    expect(session.state.conclusion).toMatchObject({ disposition: stage === "review" ? "approved" : "advance" });
    app.close(); app = open();
  }
  const state = await overview(); expect(state.business).toMatchObject({ stage: "review", generation: 1, reading_enabled: true }); expect(state.business.history.every(entry => entry.settled && !entry.superseded)).toBe(true); expect(state.business.history.at(-1)!.result!.artifact.content).toBe(specification);
  expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([]);
  await expect(invoke({ kind: "host", workspaceId: human.workspaceId, issueId: human.issueId }, "completion")).rejects.toThrow(/Read.*specification/);
  await expect(invoke(human, "prepare-run", { expected_revision: 1, expected_sequence: state.sequence })).rejects.toThrow(/terminal/);
});
const returns: { stage: BusinessStage; target: BusinessStage }[] = [{ stage: "business_design", target: "intent" }, { stage: "specification", target: "intent" }, { stage: "specification", target: "business_design" }, { stage: "review", target: "intent" }, { stage: "review", target: "business_design" }, { stage: "review", target: "specification" }];
function gaps(stage: BusinessStage, target: BusinessStage) {
  const values = outputs(stage), gap = { reason: "Selection boundary is missing", evidence: "Original input lacks a selection rule" };
  if (stage === "business_design") { for (const key of ["summary", "actors", "scenarios", "flows", "rules", "scope", "success"]) delete values[key]; values["upstream-gaps"] = many("selection", gap); }
  if (stage === "specification") { delete values.final; values["upstream-gaps"] = many("selection", { ...gap, target }); }
  if (stage === "review") { delete values["approved-specification"]; values.findings = many("selection", { subject: "Selection", verdict: "gap", evidence: gap.evidence, reason: gap.reason }); values.gaps = many("selection", { ...gap, target, affectedSections: ["ACCEPTANCE"] }); }
  return values;
}
it.each(returns)("supersedes downstream history and routes $stage back to a fresh $target checkpoint", async ({ stage, target }) => {
  await invoke(human, "configure-business", configuration());
  const sessions = new Map<BusinessStage, Awaited<ReturnType<typeof start>>>();
  for (const current of stageOrder.slice(0, stageOrder.indexOf(stage) + 1)) { const session = await start(current); sessions.set(current, session); await session.until(null, current === stage ? gaps(stage, target) : outputs(current)); }
  app.close(); app = open();
  const state = await overview(); expect(state.business).toMatchObject({ stage: target, generation: 2 });
  expect(state.business.history.filter(item => item.superseded).every(item => stageOrder.indexOf(item.stage as BusinessStage) >= stageOrder.indexOf(target))).toBe(true);
  expect(state.business.history.filter(item => !item.superseded && item.settled).map(item => item.stage)).toEqual(stageOrder.slice(0, stageOrder.indexOf(target)));
  const old = sessions.get(target)!.owner;
  await expect(invoke(old, "start")).rejects.toThrow(/another checkpoint/);
  await expect(invoke({ ...old, kind: "daemon" }, "bind", { work_dir: repository, mode: "in_place", overlays: [] })).rejects.toThrow(/cannot be replaced/);
  const revision = await start(target); expect(revision.state.business.previous).not.toBeNull(); expect(revision.state.business.returnReason).toMatchObject({ disposition: "return_revision", target }); expect(revision.state.draft!.artifacts).toEqual([]);
  await revision.until(null); expect((await overview()).business.history.at(-2)!.superseded).toBe(false);
}, 20000);
it("retains exact authenticated human choices when an upstream return creates a new intent revision", async () => {
  await invoke(human, "configure-business", configuration()); const session = await start("intent"); await session.until("clarification_proposal");
  await session.command({ type: "decision.propose", decision: { key: "selection", type: "business", title: "Selection", question: "Which item?", impact: "Reader context", options: [{ id: "selected", label: "Selected", consequence: "Retain" }, { id: "latest", label: "Latest", consequence: "Change" }], recommendation: { option: "selected", authority: "user", reason: "Retain context" }, dependencies: [] } }); await session.next(); await session.command({ type: "decision.ask", key: "selection" }); await session.next();
  const request = session.state.draft!.runtimeInputs[0]!;
  await expect(invoke(session.owner, "answer", { expected_sequence: session.state.draft!.sequence, request_id: request.id, answer: "Selected", selected_option: "selected" })).rejects.toThrow(/outside/);
  await invoke(human, "answer", { expected_sequence: session.state.draft!.sequence, request_id: request.id, answer: "", selected_option: "selected" });
  const resumed = await start("intent"); await resumed.command({ type: "decision.resolve", key: "selection", option: "selected", authority: "user", decision: "Use selected item", rationale: "Human chooses", evidence: request.id }); await resumed.until(null);
  const design = await start("business_design"); await design.until(null, gaps("business_design", "intent"));
  const revision = await start("intent"); expect(revision.state.draft!.decisions![0]!.resolution).toMatchObject({ userId: human.userId, questionId: request.id, option: "selected" }); expect(revision.state.draft!.runtimeInputs[0]!).toMatchObject({ id: request.id, active: false, answer: { userId: human.userId } });
  await revision.until(null); expect(revision.state.conclusion).toMatchObject({ decisions: [{ resolution: { userId: human.userId, questionId: request.id } }] });
});
it("keeps clean worktree conclusions after a finished runtime directory is removed", async () => {
  await invoke(human, "configure-business", configuration("worktree")); const worktree = join(directory, "business-worktree"); git(["worktree", "add", "-qb", "business-attempt", worktree]);
  const session = await start("intent", actor("intent"), "worktree", worktree); await session.until("finalize");
  // Simulate a process stopping after its atomic final draft write but before host settlement.
  const db = new DatabaseSync(database), saved = structuredClone(session.state.draft!); saved.status = "completed"; saved.phase = null; saved.completedPhases.push("finalize"); saved.sequence++; db.prepare("UPDATE chain_drafts SET sequence=?,payload=? WHERE id=?").run(saved.sequence, JSON.stringify(saved), saved.id); db.close();
  git(["worktree", "remove", worktree]); app.close(); app = open(); expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([expect.objectContaining({ agent_id: roles.business_design })]); expect((await overview()).business.history[0]!.settled).toBe(true);
});
it("rejects changed readonly code, mismatched resources, cross-workflow replacement and altered accepted history", async () => {
  const input = configuration(); input.execution_resources[3]!.mode = "worktree"; await expect(invoke(human, "configure-business", input)).rejects.toThrow(/one registered/);
  await invoke(human, "configure-business", configuration()); await expect(invoke(human, "configure", { kind: "requirement" })).rejects.toThrow(/owns business analysis/);
  const session = await start("intent"); await writeFile(join(repository, "dirty.txt"), "Unexpected change"); await expect(invoke(session.owner, "read")).rejects.toThrow(/uncommitted/); await rm(join(repository, "dirty.txt")); await session.until(null);
  const db = new DatabaseSync(database), row = db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(session.state.draft!.id)!, changed = JSON.parse(String(row.payload)); changed.artifacts.find((item: { ref: string }) => item.ref.endsWith(".problem")).content = "Rewritten accepted intent"; db.prepare("UPDATE chain_drafts SET payload=? WHERE id=?").run(JSON.stringify(changed), changed.id); db.close();
  await expect(overview()).rejects.toThrow(/Accepted business conclusion changed/);
});

it("rechecks the current native project on every business task operation and runtime binding", async () => {
  await invoke(human, "configure-business", configuration()); const session = await start("intent");
  const changed = { ...session.owner, projectId: randomUUID() };
  await expect(invoke(changed, "read")).rejects.toThrow(/Native business project changed/);
  await expect(invoke({ ...changed, kind: "daemon" }, "bind", { work_dir: repository, mode: "in_place", overlays: [] })).rejects.toThrow(/Native business project changed/);
  const { projectId: _project, ...missing } = session.owner;
  await expect(invoke(missing, "read")).rejects.toThrow(/Native business project changed/);
  expect(viewSchema.parse(await invoke(session.owner, "read")).draft!.id).toBe(session.state.draft!.id);
});

async function approved(){await invoke(human,"configure-business",configuration());for(const stage of stageOrder){const session=await start(stage);await session.until(null);}return closure();}
it("accepts only authenticated reading of the exact current approved specification and preserves an idempotent acknowledgement",async()=>{
  const current=await approved(),spec=current.specification!;
  const input={expected_version:current.version,draft_id:spec.draft_id,specification_hash:spec.hash};
  await expect(invoke(actor("review"),"business-read",input)).rejects.toThrow(/Only a human/);
  await expect(invoke(human,"business-read",{...input,specification_hash:"f".repeat(64)})).rejects.toThrow(/exact current/);
  await expect(invoke(human,"business-read",{...input,expected_version:current.version+1})).rejects.toThrow(/changed/);
  await expect(invoke(host,"completion")).rejects.toThrow(/Read.*specification/);
  expect(await invoke(human,"business-read",input)).toEqual({acknowledged:true});expect(await invoke(human,"business-read",input)).toEqual({acknowledged:true});
  expect((await closure()).readings).toHaveLength(1);expect(await invoke(host,"completion")).toMatchObject({configured:true,allowed:true,business_scope:{project_id:projectId,comments:[]}});
  await expect(invoke(host,"verified-binding")).rejects.toThrow(/not independent/);
},20000);
it("persists native comment publication before revising only Spec and Review and requires a new exact reading",async()=>{
  const current=await approved(),spec=current.specification!,requestId=randomUUID();
  const input={request_id:requestId,draft_id:spec.draft_id,specification_hash:spec.hash,content:"Explain which item remains selected",anchor_type:"selection",quoted_text:"selected item",start_offset:12,end_offset:25,intent:"change_request"};
  await expect(invoke(human,"business-comment",{...input,quoted_text:null})).rejects.toThrow(/quote/);
  const comment=z.object({comment_id:z.string()}).parse(await invoke(human,"business-comment",input));
  expect(await invoke({kind:"coordinator"},"continuations")).toEqual([expect.objectContaining({reason:"business_comment_publish",comment_id:comment.comment_id})]);
  await expect(invoke(human,"business-read",{expected_version:current.version+1,draft_id:spec.draft_id,specification_hash:spec.hash})).rejects.toThrow(/comments are reviewed/);
  app.close();app=open();
  const intent=z.object({content:z.string(),user_id:z.string()}).parse(await invoke(host,"business-comment-intent",comment));expect(intent.content).toBe("> selected item\n\nExplain which item remains selected");expect(intent.user_id).toBe(human.userId);
  const version=createHash("sha256").update(intent.content).digest("hex");
  await expect(invoke(actor("review"),"business-comment-ack",{...comment,version})).rejects.toThrow(/Only the native host/);
  await invoke(host,"business-comment-ack",{...comment,version});await invoke(host,"business-comment-ack",{...comment,version});
  expect(await invoke(human,"business-comment",input)).toEqual(comment);
  await expect(invoke(human,"business-comment",{...input,content:"Replace previous feedback"})).rejects.toThrow(/already bound/);
  const state=await overview();expect(state.business).toMatchObject({stage:"specification",generation:2});expect(state.business.history.filter(item=>item.superseded).map(item=>item.stage)).toEqual(["specification","review"]);
  expect(state.business.history.filter(item=>!item.superseded && item.settled).map(item=>[item.stage,item.generation])).toEqual([["intent",1],["business_design",1]]);
  const writer=await start("specification"),values=outputs("specification");values.final=one(specification+"\n\nThe selected item is the user's explicit selection.");await writer.until(null,values);
  const reviewer=await start("review"),reviewValues=outputs("review");reviewValues["approved-specification"]=values.final;await reviewer.until(null,reviewValues);
  expect(await invoke({kind:"coordinator"},"continuations")).toEqual([expect.objectContaining({reason:"business_comment_resolve",comment_id:comment.comment_id})]);
  await expect(invoke(host,"business-comment-resolved",{...comment,version:"e".repeat(64)})).rejects.toThrow(/exact native comment/);await invoke(host,"business-comment-resolved",{...comment,version});
  const revised=await closure();expect(revised.specification).toMatchObject({ready:true,acknowledgement:null});expect(revised.comments[0]).toMatchObject({status:"resolved"});expect(revised.specification!.draft_id).not.toBe(spec.draft_id);
  await expect(invoke(human,"business-read",{expected_version:revised.version,draft_id:spec.draft_id,specification_hash:spec.hash})).rejects.toThrow(/exact current/);
  await invoke(human,"business-read",{expected_version:revised.version,draft_id:revised.specification!.draft_id,specification_hash:revised.specification!.hash});expect(await invoke(host,"completion")).toMatchObject({allowed:true,business_scope:{comments:[{id:comment.comment_id,version,resolved:true}]}});
  expect(await invoke(host,"business-comment-protected",comment)).toEqual({protected:true});expect(await invoke(host,"business-comment-protected",{comment_id:randomUUID()})).toEqual({protected:false});
},20000);

const deliveryRoles={context:randomUUID(),planner:randomUUID(),analyst:randomUUID(),developer:randomUUID(),verifier:randomUUID(),reviewer:randomUUID()};
const endToEndConfiguration=()=>({...configuration(),delivery:{roles:deliveryRoles,maxReworks:2},execution_resources:Array.from({length:10},()=>({path:repository,mode:"in_place"}))});
const handoffPayload=(version:number)=>({expected_version:version,execution_resources:Array.from({length:6},()=>({path:repository,mode:"in_place"}))});
it("hands approved specifications and all source versions atomically into the initially authorized delivery workflow",async()=>{
  await invoke(human,"configure-business",endToEndConfiguration());
  for(const stage of stageOrder){const session=await start(stage);await session.until(null);}
  const before=await closure(),pending=await invoke({kind:"coordinator"},"continuations");expect(pending).toEqual([expect.objectContaining({reason:"business_handoff",agent_id:deliveryRoles.context,expected_sequence:before.version})]);
  await expect(invoke(human,"business-read",{expected_version:before.version,draft_id:before.specification!.draft_id,specification_hash:before.specification!.hash})).rejects.toThrow(/does not stop/);
  await expect(invoke(host,"completion")).rejects.toThrow(/End to End/);
  await expect(invoke(human,"business-handoff",handoffPayload(before.version))).rejects.toThrow(/native host/);
  await expect(invoke(host,"business-handoff",handoffPayload(before.version-1))).rejects.toThrow(/handoff changed/);
  await writeFile(join(repository,"unreviewed.txt"),"Unreviewed edit");await expect(invoke(host,"business-handoff",handoffPayload(before.version))).rejects.toThrow(/uncommitted/);await rm(join(repository,"unreviewed.txt"));
  const db=new DatabaseSync(database);db.exec("CREATE TRIGGER fail_business_handoff BEFORE UPDATE ON business_contract BEGIN SELECT RAISE(ABORT,'handoff failure'); END");
  await expect(invoke(host,"business-handoff",handoffPayload(before.version))).rejects.toThrow(/handoff failure/);expect(db.prepare("SELECT count(*) AS count FROM requirement_contract").get()!.count).toBe(0);db.exec("DROP TRIGGER fail_business_handoff");db.close();
  expect(await invoke(host,"business-handoff",handoffPayload(before.version))).toEqual({handed_off:true});app.close();app=open();expect(await invoke(host,"business-handoff",handoffPayload(before.version))).toEqual({handed_off:true});
  expect(await invoke({kind:"coordinator"},"continuations")).toEqual([expect.objectContaining({reason:"business_ready",agent_id:deliveryRoles.context})]);
  const state=z.object({chain:z.string(),requirement:z.object({end_to_end:z.boolean(),business_source:z.object({specification:z.string(),reviewHash:z.string(),stages:z.array(z.object({draftId:z.string(),hash:z.string(),conclusion:z.string()}))}),delivery_policy:z.object({analystId:z.string(),maxReworks:z.number()})})}).parse(await invoke(human,"overview"));expect(state.chain).toBe("context");expect(state.requirement.end_to_end).toBe(true);expect(state.requirement.business_source.specification).toBe(specification);expect(state.requirement.business_source.reviewHash).toBe(before.specification!.hash);expect(state.requirement.business_source.stages).toHaveLength(4);expect(state.requirement.delivery_policy).toMatchObject({analystId:deliveryRoles.analyst,maxReworks:2});
  for(const item of state.requirement.business_source.stages)expect(createHash("sha256").update(item.conclusion).digest("hex")).toBe(item.hash);
  const owner={...actor("intent"),agentId:deliveryRoles.context};expect(await invoke({...owner,projectId:undefined},"selection")).toMatchObject({configured:true,business_project_id:projectId,chain:"context"});await expect(invoke({...owner,kind:"daemon",projectId:randomUUID()},"bind",{work_dir:repository,mode:"in_place",overlays:[]})).rejects.toThrow(/project changed/);
  await invoke({...owner,kind:"daemon"},"bind",{work_dir:repository,mode:"in_place",overlays:[]});const view=z.object({contract:z.object({businessSource:z.object({specification:z.string()})}),draft:draftSchema.nullable()}).parse(await invoke(owner,"start"));expect(view.contract.businessSource.specification).toBe(specification);
  await expect(invoke(actor("review"),"start")).rejects.toThrow(/active requirement role/);
  await expect(invoke(human,"configure",{kind:"requirement",expected_revision:1})).rejects.toThrow(/frozen End to End origin/);
  const reopened=new DatabaseSync(database),row=reopened.prepare("SELECT payload FROM business_contract").get()!,record=JSON.parse(String(row.payload));record.entries.at(-1).settledHash="0".repeat(64);reopened.prepare("UPDATE business_contract SET payload=?").run(JSON.stringify(record));reopened.close();await expect(invoke(owner,"read")).rejects.toThrow(/conclusion changed/);
},30000);

it("requires the entire initial End to End authorization before any business record is created",async()=>{
  for(const input of [{...endToEndConfiguration(),auto_continue:false},{...endToEndConfiguration(),delivery:{roles:{...deliveryRoles,reviewer:roles.review},maxReworks:2}},{...endToEndConfiguration(),execution_resources:configuration().execution_resources}])await expect(invoke(human,"configure-business",input)).rejects.toThrow(/End to End|every frozen/);
  expect(await invoke(human,"overview")).toMatchObject({configured:false});
});
