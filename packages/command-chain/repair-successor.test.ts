// @vitest-environment node
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { expect, it } from "vitest";
import { commandChainDefinitionSchema } from "./definition";
import { draftSchema, CommandChainEngine, type ChainDraft } from "./runtime";
import { prepareRepairSuccessor } from "./repair-successor";
import { createVerificationHandlers, verificationContractSchema, compileVerificationConclusion } from "./verification";
import { createDevelopmentHandlers, developmentContractSchema, compileDevelopmentConclusion } from "./development";
import { decisionResolutionErrors } from "./decisions";
import { SqliteDraftStore } from "./sqlite-store";

const binding = { workspaceId: "workspace", issueId: "issue", revision: 2, contractVersion: "original-contract", codeVersion: "original-head" };
const repaired = { ...binding, contractVersion: "repair-derived-contract", codeVersion: "repaired-head" };
const sources = [{ key: "continue", kind: "acceptance", description: "Reader continues", oracle: "The next page appears", sourceRef: "ACCEPTANCE:continue:r2" }];
const planningSources = [{ key: "continue", kind: "acceptance", content: "Reader continues", sourceRef: "ACCEPTANCE:continue:r2" }];
const group = { key: "continue", workType: "bug", title: "Restore Continue", reason: "The action failed", commentIds: ["comment"], affectedDeliveryUnits: [1], acceptance: ["The next page appears"] };
const comment = { id: "comment", version: "1", content: "Continue does nothing", sourceRef: "COMMENT:1", authorId: "reader" };
const context = { ref: "REPORT:1", version: "report-hash", content: "Original obligations and delivered work" };
const cases: [string, Record<string, unknown>][] = [
  ["verification", { binding, sources }],
  ["development", { binding, sources, implementationGuidance: "Restore Continue without changing Expected" }],
  ["analysis", { binding, sources, unit: { key: "continue", title: "Continue reading", actor: "Reader", trigger: "Activate Continue", observableOutcome: "Next page opens", acceptance: "Next page appears", sourceRefs: planningSources }, decisionMode: "balanced", dependencies: [] }],
  ["reproduction", { binding, decisionMode: "balanced", contextRef: "CONTEXT:1", contextFingerprint: "a".repeat(64), contextContent: "Existing reader behavior", expectedBehavior: "Next page opens" }],
  ["review", { binding, generation: 1, subjects: [{ key: "continue", kind: "acceptance", content: "Next page opens", requiredEvidenceRefs: ["test:continue"] }], evidence: [{ ref: "test:continue", kind: "independent-verification", status: "passed", revision: "2", fingerprint: "b".repeat(64), independentTest: true, content: "Original independent verification" }] }],
  ["feedback-verify", { binding, batchId: "batch", groupId: group.key, group, comment, context, work: { kind: "delivery", ref: "WORK:1", version: "work-hash", codeVersion: binding.codeVersion, content: "Accepted work" } }],
  ["feedback-triage", { binding, batchId: "batch", decisionMode: "balanced", comments: [comment], context, units: [], previousFeedback: [] }],
  ["context", { binding, input: "Reader continues", kind: "requirement", decisionMode: "balanced" }],
  ["planning", { binding, sources: planningSources, existingKeys: [] }],
  ...([['idea-context', 'intent'], ['business-design', 'business_design'], ['requirement-spec', 'specification'], ['spec-review', 'review']] as const).map(([name, stage]): [string, Record<string, unknown>] => [name, { binding, stage, decisionMode: "balanced" }]),
];
async function checkpoint(name: string) {
  const definition = commandChainDefinitionSchema.parse(parse(await readFile(new URL(`./definitions/${name}.yaml`, import.meta.url), "utf8")));
  const phases = Object.keys(definition.phases);
  return draftSchema.parse({ schemaVersion: 1, id: "surrendered-draft", binding, definition, sequence: 19, attemptId: "surrendered-attempt", status: "editing", phase: phases.at(-1),
    inputs: { "requirement-card": "CARD-42" }, artifacts: [{ ref: "old.conclusion", key: "", content: "Old conclusion", phase: phases[0], attemptId: "surrendered-attempt" }],
    frozen: [{ ref: "old.conclusion", key: "", phase: phases[0] }], writeRules: [{ ref: "old.conclusion", mode: "sealed", phase: phases[0] }],
    completedPhases: phases.slice(0, -1), runtimeInputs: [], events: [{ sequence: 19, attemptId: "surrendered-attempt", command: "phase.complete", phase: phases[0] }],
  });
}
function prepare(draft: ChainDraft, contract: Record<string, unknown>, next = repaired) { return prepareRepairSuccessor(draft, contract, next, "successor-draft", "host-repair-attempt"); }

it.each(cases)("rechecks the %s stage without changing original obligations or checkpoint history", async (name, contract) => {
  const previous = await checkpoint(name), before = structuredClone(previous);
  const next = ["review", "feedback-verify"].includes(name) ? { ...repaired, codeVersion: binding.codeVersion } : repaired;
  const successor = prepare(previous, contract, next);
  expect(successor.contract).toMatchObject({ ...contract, binding: next });
  expect(successor.draft).toMatchObject({ id: "successor-draft", binding: next, phase: Object.keys(previous.definition.phases)[0], completedPhases: [], artifacts: [], frozen: [], writeRules: [], inputs: previous.inputs });
  expect(previous).toEqual(before);
  expect(successor.draft.sequence).toBe(previous.sequence + 1);
  expect(successor.draft.events.at(-1)).toMatchObject({ command: "host.repair.prepare", phase: successor.draft.phase });
});

it.each(["review", "feedback-verify"])("keeps %s held when accepted work needs a new code version", async name => {
  const previous = await checkpoint(name), contract = cases.find(([id]) => id === name)![1];
  expect(() => prepare(previous, contract)).toThrow(/normal independent verification/);
  expect(previous.binding).toEqual(binding);
});

it("preserves exact authenticated human choices while reopening evidence-based decisions", async () => {
  const previous = await checkpoint("analysis"), contract = cases.find(([id]) => id === "analysis")![1];
  const node = { key: "boundary", type: "business", title: "Which reader?", question: "Keep the current reader?", impact: "Original scope", options: [{ id: "keep", label: "Keep", consequence: "Original scope" }, { id: "change", label: "Change", consequence: "New scope" }], recommendation: { option: "keep", reason: "Preserve scope", authority: "upstream" }, dependencies: [], status: "resolved", humanRequested: true,
    resolution: { option: "keep", authority: "user", decision: "Keep", rationale: "Original scope", evidence: "Authenticated answer", userId: "human", questionId: "original-question" } };
  previous.decisions = draftSchema.shape.decisions.parse([node, { ...node, key: "implementation", type: "technical", humanRequested: false, resolution: { ...node.resolution, authority: "project_evidence", userId: undefined, questionId: undefined } }]);
  previous.runtimeInputs = draftSchema.shape.runtimeInputs.parse([{ id: "original-question", key: "boundary", title: node.title, question: node.question, why: node.impact, recommendation: "Keep", options: node.options, decisionKey: node.key, phase: "decision_resolution", attemptId: previous.attemptId, active: true, answer: { text: "Keep", userId: "human", sequence: 10, selectedOption: "keep" } }]);
  const successor = prepare(previous, contract).draft;
  expect(successor.decisions![0]).toEqual(previous.decisions![0]);
  expect(successor.decisions![1]).toMatchObject({ status: "proposed" });
  expect(successor.decisions![1]!.resolution).toBeUndefined();
  expect(successor.runtimeInputs[0]).toEqual({ ...previous.runtimeInputs[0], active: false });
  expect(decisionResolutionErrors(successor)).toEqual(["Decision implementation is not resolved"]);
});

it("retains Expected scenarios but requires new independent observations through the normal engine", async () => {
  const previous = await checkpoint("verification"), contract = cases[0]![1];
  const artifact = (ref: string, key: string, value: unknown) => ({ ref, key, content: stringify(value).trim(), phase: "execute", attemptId: previous.attemptId });
  previous.artifacts = [artifact("verification.scenarios", "next-page", { channel: "frontend", title: "Continue", setup: "Reader open", steps: "Activate Continue", expected: "Next page appears", coverageRefs: ["continue"] }), artifact("verification.results", "next-page", { status: "passed", evidence: "Old screenshot" }), artifact("verification.evidence-review", "", { summary: "Old observations passed" })];
  const successor = prepare(previous, contract), verifiedContract = verificationContractSchema.parse(successor.contract);
  expect(successor.draft.artifacts).toEqual([previous.artifacts[0]]);
  expect(() => compileVerificationConclusion(successor.draft, verifiedContract)).toThrow();
  const directory = await mkdtemp(join(tmpdir(), "repair-successor-")), store = new SqliteDraftStore(join(directory, "state.sqlite"));
  try {
    await store.create(successor.draft);
    const engine = new CommandChainEngine(store, createVerificationHandlers(verifiedContract));
    let draft = await engine.resume(successor.draft.id, successor.draft.sequence, "new-native-attempt");
    const next = async () => { draft = await engine.execute(draft.id, { expectedSequence: draft.sequence, attemptId: draft.attemptId }, { type: "phase.complete" }); };
    await next(); await next();
    expect(draft.phase).toBe("execute");
    await expect(next()).rejects.toThrow(/result|observation/i);
    const put = async (ref: string, key: string, value: unknown) => { draft = await engine.execute(draft.id, { expectedSequence: draft.sequence, attemptId: draft.attemptId }, { type: "artifact.put", ref, ...(key ? { key } : {}), content: stringify(value).trim() }); };
    await put("verification.results", "next-page", { status: "passed", evidence: "New controlled test observation at repaired-head" });
    await next();
    await put("verification.evidence-review", "", { summary: "Reviewed the new controlled observation" });
    await next(); await next();
    expect(compileVerificationConclusion(draft, verifiedContract)).toMatchObject({ verdict: "passed", binding: repaired, attemptId: "new-native-attempt", results: [{ key: "next-page", evidence: "New controlled test observation at repaired-head" }] });
    expect(previous.artifacts[1]!.content).toContain("Old screenshot");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

it("requires fresh implementation claims, review and captured commands after repair", async () => {
  const previous = await checkpoint("development"), contract = cases[1]![1];
  previous.development = { claims: [{ key: "continue", evidence: "Old claim", attemptId: previous.attemptId }], checks: [{ key: "test", receiptId: "old-success", summary: "Old successful check" }], reviewFingerprint: "old-fingerprint" };
  const successor = prepare(previous, contract), development = developmentContractSchema.parse(successor.contract);
  expect(successor.draft.development).toEqual({ claims: [], checks: [] });
  const runtime = { receipts: () => [], fingerprint: () => "repaired-fingerprint" };
  expect(() => compileDevelopmentConclusion(successor.draft, development, runtime)).toThrow();
  const handler = createDevelopmentHandlers(development, runtime)["command-verification"]!;
  expect((await handler(successor.draft)).errors).toEqual(expect.arrayContaining([expect.stringMatching(/no implementation claim/), expect.stringMatching(/current successful captured command/), "Code review is missing"]));
});

it.each(["unanswered", "terminal", "changed-contract", "unknown"])("refuses a %s repair successor", async failure => {
  const previous = await checkpoint("verification"), contract = structuredClone(cases[0]![1]);
  if (failure === "unanswered") previous.runtimeInputs = [{ id: "question", key: "missing", title: "Missing fact", question: "What entry?", why: "Original oracle", recommendation: "Preserve", phase: "execute", attemptId: previous.attemptId, active: true, answer: null }];
  if (failure === "terminal") previous.status = "completed";
  if (failure === "changed-contract") contract.binding = { ...binding, codeVersion: "unverified-head" };
  if (failure === "unknown") previous.definition.id = "unknown";
  expect(() => prepare(previous, contract)).toThrow();
});
