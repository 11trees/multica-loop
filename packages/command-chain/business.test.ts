// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { afterEach, beforeEach, expect, it } from "vitest";
import { businessProfiles, compileBusinessConclusion, createBusinessHandlers, type BusinessContract, type BusinessStage } from "./business";
import { parseCommandChainDefinition } from "./definition";
import { CommandChainEngine, type ChainCommand, type ChainDraft } from "./runtime";
import { SqliteDraftStore } from "./sqlite-store";

const binding = { workspaceId: "workspace", issueId: "business", revision: 1, contractVersion: "frozen-inputs", codeVersion: "readonly-commit" };
const stages = ["intent", "business_design", "specification", "review"] as const;
const definitions = { intent: "idea-context", business_design: "business-design", specification: "requirement-spec", review: "spec-review" };
const namespaces = { intent: "requirement-intent", business_design: "business-solution", specification: "requirement-specification", review: "specification-review" };
const orders = {
  intent: ["discovery", "research", "clarification_proposal", "clarification_resolution", "answer_review", "synthesis", "finalize"],
  business_design: ["exploration", "research", "decision_proposal", "decision_resolution", "answer_review", "solution", "finalize"],
  specification: ["composition", "verification", "finalize"], review: ["inspection", "classification", "verdict", "finalize"],
};
const research = { claim: "A consulted source informs the terminology", sourceTitle: "Official source", sourceUrl: "https://example.com/source", applicability: "This workflow", limitations: "Does not decide product scope", confidence: "high" };
const specification = "# Reader specification\n\n## Outcome\nReader continues from the selected item.\n\n## ACCEPTANCE\nActivate Continue and observe the selected item.";
type Row = { key?: string; content: unknown };
type Outputs = Record<string, Row[]>;
const one = (content: unknown): Row[] => [{ content }];
const many = (key: string, content: unknown): Row[] => [{ key, content }];
function normal(stage: BusinessStage): Outputs {
  if (stage === "intent") return {
    discovery: one("Internal discovery; do not publish"), "research-sources": many("internal-research-key", research), "answer-review": one("Internal answer review; do not publish"),
    problem: one("# Reader problem\n\n```md\n# Keep code heading\n```"), actors: many("reader", { name: "Reader", role: "User", need: "Continue reading" }),
    goals: many("continuity", { content: "Continue the selected item", source: "Original idea" }), success: many("continue", { outcome: "Reader continues", measure: "Selected item remains active" }),
  };
  if (stage === "business_design") return {
    exploration: one("Internal alternatives; do not publish"), "research-sources": many("internal-research-key", research), "answer-review": one("All choices reviewed"),
    summary: one("Continue the selected item"), actors: many("reader", { name: "Reader", responsibility: "Choose an item" }),
    scenarios: many("continue", { kind: "main", actor: "Reader", trigger: "Activate Continue", outcome: "Item opens" }),
    flows: many("open", { scenario: "Continue", action: "Activate Continue", result: "Selected item opens" }),
    rules: many("selection", { content: "Use the selected item", rationale: "Preserve reading context" }),
    scope: many("continue", { direction: "included", content: "Continue the selected item" }), success: many("continue", { outcome: "Item opens", measure: "Selected item is visible" }),
  };
  if (stage === "specification") return { draft: one("Private draft"), verification: one("Sources and acceptances reconciled"), final: one(specification) };
  return { findings: many("coverage", { subject: "Original reader outcome", verdict: "passed", evidence: "Specification Outcome and ACCEPTANCE", reason: "Preserves the confirmed business outcome" }), "verdict-summary": one("Independent review passed"), "approved-specification": one(specification) };
}
let directory: string, store: SqliteDraftStore, id = 0;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "multica-business-")); store = new SqliteDraftStore(join(directory, "drafts.sqlite")); });
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
async function setup(stage: BusinessStage, decisionMode: BusinessContract["decisionMode"] = "balanced") {
  const contract: BusinessContract = { binding, stage, decisionMode };
  const chain = parseCommandChainDefinition(await readFile(new URL(`./definitions/${definitions[stage]}.yaml`, import.meta.url), "utf8"), businessProfiles[stage]);
  const engine = new CommandChainEngine(store, createBusinessHandlers(contract));
  let draft = await engine.create({ id: `business-${++id}`, chain, binding, attemptId: "run-1" });
  const command = async (input: ChainCommand) => draft = await engine.execute(draft.id, { expectedSequence: draft.sequence, attemptId: draft.attemptId }, input);
  const put = (block: string, content: unknown, key?: string) => command({ type: "artifact.put", ref: `${namespaces[stage]}.${block}`, key, content: typeof content === "string" ? content : stringify(content) });
  const next = () => command({ type: "phase.complete" });
  const fill = async (outputs: Outputs) => {
    const phase = draft.definition.phases[draft.phase!];
    if (phase?.type === "artifact" || phase?.type === "builtin") for (const ref of phase.artifacts) for (const row of outputs[ref.split(".")[1]!] ?? []) await put(ref.split(".")[1]!, row.content, row.key);
  };
  const until = async (target: string | null, outputs = normal(stage)) => {
    while (draft.phase !== target) { if (!draft.phase) throw new Error(`Cannot reach ${target}`); await fill(outputs); await next(); }
  };
  return { contract, engine, get draft() { return draft; }, set draft(value: ChainDraft) { draft = value; }, command, put, next, fill, until };
}

it.each(stages)("executes the frozen %s source phases and recompiles the same conclusion after a database restart", async stage => {
  const session = await setup(stage);
  expect(Object.keys(session.draft.definition.phases)).toEqual(orders[stage]);
  await session.until("finalize");
  expect(() => compileBusinessConclusion(session.draft, session.contract)).toThrow(/not completed/);
  await session.next();
  const conclusion = compileBusinessConclusion(session.draft, session.contract);
  expect(conclusion).toMatchObject({ kind: "business-analysis", stage, disposition: stage === "review" ? "approved" : "advance", binding, gaps: [] });
  expect(conclusion.artifact.content).not.toContain("Internal");
  expect(conclusion.artifact.content).not.toContain("internal-research-key");
  if (stage === "intent" || stage === "business_design") {
    expect(conclusion.artifact.content).toContain("[Official source](https://example.com/source)");
    expect(conclusion.artifact.content).toContain("**置信度**：高");
    expect(conclusion.artifact.content).toContain("Does not decide product scope");
    expect(conclusion.artifacts.some(item => item.key === "internal-research-key")).toBe(true);
  } else expect(conclusion.artifact.content).toBe(specification);
  if (stage === "intent") { expect(conclusion.artifact.content).toContain("### Reader problem"); expect(conclusion.artifact.content).toContain("```md\n# Keep code heading\n```"); }
  store.close(); store = new SqliteDraftStore(join(directory, "drafts.sqlite"));
  expect(compileBusinessConclusion((await store.read(session.draft.id))!, session.contract)).toEqual(conclusion);
  conclusion.binding.revision = 99; expect((await store.read(session.draft.id))!.binding.revision).toBe(1);
});

const returns: { stage: BusinessStage; target: "intent" | "business_design" | "specification" }[] = [
  { stage: "business_design", target: "intent" }, { stage: "specification", target: "intent" }, { stage: "specification", target: "business_design" },
  { stage: "review", target: "intent" }, { stage: "review", target: "business_design" }, { stage: "review", target: "specification" },
];
function returning(stage: BusinessStage, target: string): Outputs {
  const outputs = normal(stage), gap = { reason: "The selected item is ambiguous", evidence: "Original idea does not select an item" };
  if (stage === "business_design") {
    for (const key of ["summary", "actors", "scenarios", "flows", "rules", "scope", "success"]) delete outputs[key];
    outputs["upstream-gaps"] = many("selected-item", gap);
  } else if (stage === "specification") { delete outputs.final; outputs["upstream-gaps"] = many("selected-item", { ...gap, target }); }
  else {
    delete outputs["approved-specification"];
    outputs.findings = many("coverage", { subject: "Selected item", verdict: "gap", evidence: "Original idea", reason: gap.reason });
    outputs.gaps = many("selected-item", { ...gap, target, affectedSections: ["Outcome"] });
  }
  return outputs;
}
it.each(returns)("compiles $stage gaps to the sole $target owner without approving or advancing", async ({ stage, target }) => {
  const session = await setup(stage); await session.until(null, returning(stage, target));
  expect(compileBusinessConclusion(session.draft, session.contract)).toMatchObject({ disposition: "return_revision", target, reason: "selected-item：The selected item is ambiguous", gaps: [{ key: "selected-item" }] });
  const result = compileBusinessConclusion(session.draft, session.contract);
  expect(result.artifact.content).toContain("The selected item is ambiguous");
  expect(result.artifact.content).not.toContain("Independent review passed");
});
it.each(["business_design", "specification", "review"] as const)("rejects conflicting return and normal outputs for %s", async stage => {
  const session = await setup(stage), outputs = { ...returning(stage, "intent"), ...normal(stage) };
  await session.until("finalize", outputs); const before = structuredClone(session.draft);
  await expect(session.next()).rejects.toThrow(/cannot include solution|cannot coexist/);
  expect(await store.read(session.draft.id)).toEqual(before);
});
it.each(["specification", "review"] as const)("rejects ambiguous responsibility targets for %s", async stage => {
  const session = await setup(stage), outputs = returning(stage, "intent"), block = stage === "review" ? "gaps" : "upstream-gaps";
  outputs[block]!.push({ key: "other-gap", content: { ...(outputs[block]![0]!.content as object), target: "business_design" } });
  await session.until("finalize", outputs); await expect(session.next()).rejects.toThrow(/one responsibility target/);
});
it("requires a blocking finding for a blocking review and declared affected sections", async () => {
  const session = await setup("review"), outputs = returning("review", "specification"); outputs.findings = normal("review").findings!;
  await session.until("classification", outputs);
  await expect(session.put("gaps", { target: "specification", evidence: "Spec", reason: "Missing observable outcome", affectedSections: [] }, "gap")).rejects.toThrow(/at least 1/);
  await session.until("finalize", outputs); await expect(session.next()).rejects.toThrow(/gap finding/);
});
it.each(stages)("rejects missing normal business output for %s", async stage => {
  const session = await setup(stage), outputs = normal(stage);
  const missing = { intent: "success", business_design: "success", specification: "final", review: "approved-specification" }[stage]; delete outputs[missing];
  if (stage === "intent") { await session.until("synthesis", outputs); await session.fill(outputs); await expect(session.next()).rejects.toThrow(/success/); }
  else { await session.until("finalize", outputs); await expect(session.next()).rejects.toThrow(new RegExp(missing)); }
});

it.each(["intent", "business_design"] as const)("binds %s human decisions to authenticated options and fences resumed/rewound attempts", async stage => {
  const session = await setup(stage), proposalPhase = stage === "intent" ? "clarification_proposal" : "decision_proposal";
  await session.until(proposalPhase);
  await session.command({ type: "decision.propose", decision: { key: "selection", type: "business", title: "Selection", question: "Which item should Continue open?", impact: "Changes visible behavior", options: [{ id: "selected", label: "Selected item", consequence: "Retains context" }, { id: "latest", label: "Latest item", consequence: "Changes context" }], recommendation: { option: "selected", authority: "user", reason: "Preserve current context" }, dependencies: [] } });
  await session.next();
  const resolution = { type: "decision.resolve", key: "selection", option: "selected", authority: "user", decision: "Use selected", rationale: "User chooses", evidence: "Authenticated answer" } as const;
  await expect(session.command(resolution)).rejects.toThrow(/authenticated/);
  await session.command({ type: "decision.ask", key: "selection" });
  const question = session.draft.runtimeInputs[0]!;
  await expect(session.command({ type: "runtime-input.put", key: question.key, title: "Override", question: "Other?", why: "Other", recommendation: "Latest" })).rejects.toThrow(/Structured decision/);
  await session.next(); expect(session.draft.status).toBe("waiting_for_answers");
  await expect(session.engine.answerRuntimeInput(session.draft.id, { expectedSequence: session.draft.sequence, requestId: question.id, answer: "I choose selected", selectedOption: "invented", userId: "local-user" })).rejects.toThrow(/published decision options/);
  session.draft = await session.engine.answerRuntimeInput(session.draft.id, { expectedSequence: session.draft.sequence, requestId: question.id, answer: "I choose selected", selectedOption: "selected", userId: "local-user" });
  const previous = structuredClone(session.draft);
  session.draft = await session.engine.resume(session.draft.id, session.draft.sequence, "run-2");
  await expect(session.engine.execute(previous.id, { attemptId: previous.attemptId, expectedSequence: previous.sequence }, resolution)).rejects.toThrow(/changed/);
  await expect(session.command({ ...resolution, authority: "agent_authority" })).rejects.toThrow(/Human authority/);
  await session.command(resolution); await session.until("finalize");
  await session.command({ type: "phase.rewind", to: proposalPhase, reason: "Recheck the decision combination" });
  expect(session.draft.decisions![0]).toMatchObject({ status: "proposed", humanRequested: true }); expect(session.draft.decisions![0]!.resolution).toBeUndefined();
  expect(session.draft.runtimeInputs[0]!.answer).toMatchObject({ selectedOption: "selected", userId: "local-user" }); expect(session.draft.runtimeInputs[0]!.active).toBe(false);
  await session.next();
  await expect(session.command({ ...resolution, authority: "agent_authority" })).rejects.toThrow(/Human authority/);
  await session.command({ type: "decision.ask", key: "selection" }); await session.next();
  const renewed = session.draft.runtimeInputs.at(-1)!;
  session.draft = await session.engine.answerRuntimeInput(session.draft.id, { expectedSequence: session.draft.sequence, requestId: renewed.id, answer: "Still the selected item", selectedOption: "selected", userId: "local-user" });
  session.draft = await session.engine.resume(session.draft.id, session.draft.sequence, "run-3");
  await session.command(resolution); await session.until(null);
  const completed = structuredClone(session.draft);
  const conclusion = compileBusinessConclusion(completed, session.contract);
  expect(conclusion.decisions[0]!.resolution).toMatchObject({ userId: "local-user", questionId: renewed.id });
  expect(conclusion.runtimeInputs[0]!.answer?.selectedOption).toBe("selected");
  completed.runtimeInputs.at(-1)!.answer!.selectedOption = "latest";
  expect(() => compileBusinessConclusion(completed, session.contract)).toThrow(/authenticated human choice/);
});
it("keeps autonomous business decisions inside the frozen policy", async () => {
  const session = await setup("intent", "fully_autonomous"); await session.until("clarification_proposal");
  await session.command({ type: "decision.propose", decision: { key: "selection", type: "business", title: "Selection", question: "Which item?", impact: "Reader context", options: [{ id: "selected", label: "Selected", consequence: "Retain" }, { id: "latest", label: "Latest", consequence: "Change" }], recommendation: { option: "selected", authority: "agent_authority", reason: "Retain context" }, dependencies: [] } });
  await session.next(); await expect(session.command({ type: "decision.ask", key: "selection" })).rejects.toThrow(/Fully autonomous/);
  await session.command({ type: "decision.resolve", key: "selection", option: "selected", authority: "agent_authority", decision: "Selected", rationale: "Retains context", evidence: "Original idea" });
  await session.until(null); expect(compileBusinessConclusion(session.draft, session.contract).decisions[0]!.resolution?.authority).toBe("agent_authority");
});
it.each(["binding", "stage", "unknown-field", "duplicate", "cardinality", "required", "phase-history"])("revalidates saved %s evidence rather than trusting a completed status", async failure => {
  const session = await setup("intent"); await session.until(null); const draft = structuredClone(session.draft);
  if (failure === "binding") draft.binding.contractVersion = "other-inputs";
  if (failure === "stage") draft.definition.agent = "other-agent";
  if (failure === "unknown-field") draft.artifacts.find(item => item.ref.endsWith(".research-sources"))!.content += "\ndebugOnly: hidden";
  if (failure === "duplicate") draft.artifacts.push(structuredClone(draft.artifacts[0]!));
  if (failure === "cardinality") draft.artifacts[0]!.key = "singleton-cannot-have-a-key";
  if (failure === "required") draft.artifacts = draft.artifacts.filter(item => !item.ref.endsWith(".answer-review"));
  if (failure === "phase-history") draft.completedPhases.reverse();
  expect(() => compileBusinessConclusion(draft, session.contract)).toThrow();
});
