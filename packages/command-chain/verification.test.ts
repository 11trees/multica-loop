// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandChainEngine, compileVerificationConclusion, createVerificationHandlers, parseCommandChainDefinition,
  type ChainCommand, type ChainDraft, type CommandChainProfile, type VerificationContract,
} from "./index";
import { SqliteDraftStore } from "./sqlite-store";

const profile: CommandChainProfile = {
  id: "verification", agent: "test-agent",
  requiredBuiltins: ["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"],
  builtins: Object.fromEntries(["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"].map(id => [id, { acceptsArtifacts: true }])),
  metadataKeys: [], repositoryAdapters: [],
};
const baseContract: VerificationContract = {
  binding: { workspaceId: "workspace", issueId: "issue", revision: 1, contractVersion: "spec-v1", codeVersion: "commit-v1" },
  sources: [
    { key: "ac1", kind: "acceptance", description: "User creates issue", oracle: "Issue survives reload", sourceRef: "ACCEPTANCE:ac1:r1" },
    { key: "guard1", kind: "guardrail", description: "Workspace remains isolated", oracle: "Other workspace cannot see the issue", sourceRef: "GUARDRAIL:guard1:r1" },
  ],
};
const scenario = {
  channel: "frontend", title: "Create issue", setup: "Local workspace", steps: "Create issue and reload",
  expected: "Issue title remains visible", coverageRefs: ["ac1", "guard1"],
};
const complete = { type: "phase.complete" } as const;
let dir: string;
let stores: SqliteDraftStore[];
function openStore() {
  const store = new SqliteDraftStore(join(dir, "drafts.sqlite"));
  stores.push(store);
  return store;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "multica-verification-"));
  stores = [];
});
afterEach(async () => {
  for (const store of stores) store.close();
  await rm(dir, { recursive: true, force: true });
});

function execute(engine: CommandChainEngine, draft: ChainDraft, command: ChainCommand) {
  return engine.execute(draft.id, { expectedSequence: draft.sequence, attemptId: draft.attemptId }, command);
}
function put(engine: CommandChainEngine, draft: ChainDraft, block: string, value: unknown, key?: string) {
  return execute(engine, draft, { type: "artifact.put", ref: `verification.${block}`, key, content: stringify(value) });
}
async function setup(contract = structuredClone(baseContract)) {
  const engine = new CommandChainEngine(openStore(), createVerificationHandlers(contract));
  const chain = parseCommandChainDefinition(await readFile(new URL("./fixtures/verification.yaml", import.meta.url), "utf8"), profile);
  const draft = await engine.create({ id: "test-unit", chain, binding: contract.binding, attemptId: "test-run-1" });
  return { engine, draft, contract };
}
async function executionPhase() {
  const { engine, draft, contract } = await setup();
  const plan = await execute(engine, draft, complete);
  const prepared = await put(engine, plan, "scenarios", scenario, "s1");
  return { engine, draft: await execute(engine, prepared, complete), contract };
}

describe("independent verification builtins", () => {
  it.each(["passed", "failed"] as const)("compiles a %s conclusion tied to the frozen delivery and code version", async status => {
    const { engine, draft, contract } = await executionPhase();
    let next = await put(engine, draft, "results", {
      status, ...(status === "failed" ? { failureKind: "implementation" } : {}),
      evidence: "Browser capture test-run-1/s1", actualBehavior: status === "passed" ? "Issue visible after reload" : "Issue disappeared after reload",
    }, "s1");
    next = await execute(engine, next, complete);
    next = await put(engine, next, "evidence-review", { summary: "Compared expected, observed behavior, and browser capture" });
    next = await execute(engine, next, complete);
    expect(() => compileVerificationConclusion(next, contract)).toThrow(/not completed/);
    next = await execute(engine, next, complete);
    const result = compileVerificationConclusion(await engine.read(draft.id), contract);
    expect(result.verdict).toBe(status);
    expect(result.rewindTo).toBe(status === "failed" ? "dev" : undefined);
    expect(result.binding).toEqual(contract.binding);
    expect(result.attemptId).toBe("test-run-1");
    expect(result.results[0]?.evidence).toContain("test-run-1/s1");
    expect(next.status).toBe("completed");
  });

  it("rejects a different contract, code version, issue, or workspace at the input gate", async () => {
    const { engine, draft, contract } = await setup();
    for (const [field, value] of [
      ["contractVersion", "spec-v2"], ["codeVersion", "commit-v2"], ["issueId", "other-issue"],
      ["workspaceId", "other-workspace"], ["revision", 2],
    ] as const) {
      const changed = structuredClone(contract);
      Object.assign(changed.binding, { [field]: value });
      const stale = new CommandChainEngine(openStore(), createVerificationHandlers(changed));
      await expect(execute(stale, draft, complete)).rejects.toThrow(new RegExp(`binding ${field}`));
      expect(await engine.read(draft.id)).toEqual(draft);
    }
  });

  it("takes sources only from the host contract and detects a changed source on resume", async () => {
    const { engine, draft, contract } = await setup();
    const frozen = await execute(engine, draft, complete);
    expect(frozen.artifacts.filter(item => item.ref === "verification.sources")).toHaveLength(2);
    expect(frozen.frozen).toHaveLength(2);
    const changed = structuredClone(contract);
    changed.sources[0]!.oracle = "Changed oracle";
    const restarted = new CommandChainEngine(openStore(), createVerificationHandlers(changed));
    const plan = await put(engine, frozen, "scenarios", scenario, "s1");
    await expect(execute(restarted, plan, complete)).rejects.toThrow(/source ac1 differs/);
    expect(await engine.read(draft.id)).toEqual(plan);
  });

  it.each([
    [{ ...scenario, coverageRefs: ["ac1"] }, /guard1 has no scenario coverage/],
    [{ ...scenario, coverageRefs: ["ac1", "guard1", "unknown"] }, /unknown verification source unknown/],
    [{ ...scenario, coverageRefs: ["ac1", "guard1", "ac1"] }, /repeats coverage/],
    [{ ...scenario, channel: "api" }, /frontend scenario/],
  ])("rejects an incomplete or invalid verification plan", async (value, error) => {
    const { engine, draft } = await setup();
    let next = await execute(engine, draft, complete);
    next = await put(engine, next, "scenarios", value, "s1");
    await expect(execute(engine, next, complete)).rejects.toThrow(error);
    expect((await engine.read(draft.id)).frozen.map(item => item.ref)).not.toContain("verification.scenarios");
  });

  it("preserves the current policy of all-source coverage and at least one frontend acceptance", async () => {
    const contract = structuredClone(baseContract);
    contract.sources.push({ key: "ac2", kind: "acceptance", description: "API validation", oracle: "Reject invalid input", sourceRef: "ACCEPTANCE:ac2:r1" });
    const { engine, draft } = await setup(contract);
    let next = await execute(engine, draft, complete);
    next = await put(engine, next, "scenarios", scenario, "s1");
    next = await put(engine, next, "scenarios", { ...scenario, channel: "api", coverageRefs: ["ac2"] }, "s2");
    expect((await execute(engine, next, complete)).phase).toBe("execute");
  });

  it("requires one observed result for every scenario and rejects orphan result keys", async () => {
    const { engine, draft } = await executionPhase();
    await expect(execute(engine, draft, complete)).rejects.toThrow(/no observed result/);
    const orphan = await put(engine, draft, "results", { status: "passed", evidence: "Observation" }, "unplanned");
    await expect(execute(engine, orphan, complete)).rejects.toThrow(/no matching scenario/);
    expect((await engine.read(draft.id)).phase).toBe("execute");
  });

  it.each([
    [{ status: "passed", failureKind: "implementation" }, /must not declare a failure kind/],
    [{ status: "failed", failureKind: "environment" }, /implementation or specification attribution/],
    [{ status: "failed" }, /implementation or specification attribution/],
    [{ status: "blocked", failureKind: "implementation" }, /environment or inconclusive attribution/],
    [{ status: "blocked", failureKind: "environment" }, /resolve runtime input and rerun/],
    [{ status: "blocked", failureKind: "inconclusive" }, /resolve runtime input and rerun/],
  ])("keeps contradictory or blocked observations from completing", async (result, error) => {
    const { engine, draft } = await executionPhase();
    const next = await put(engine, draft, "results", { ...result, evidence: "Independent observation" }, "s1");
    await expect(execute(engine, next, complete)).rejects.toThrow(error);
    expect(await engine.read(draft.id)).toEqual(next);
  });

  it("retains the frozen plan after reopening storage and resuming a new run attempt", async () => {
    const { draft, contract } = await executionPhase();
    stores.pop()!.close();
    const restarted = new CommandChainEngine(openStore(), createVerificationHandlers(contract));
    let next = await restarted.resume(draft.id, draft.sequence, "test-run-2");
    await expect(put(restarted, next, "scenarios", { ...scenario, expected: "Altered after observation" }, "s1")).rejects.toThrow(/frozen/);
    next = await put(restarted, next, "results", { status: "passed", evidence: "New independent observation test-run-2" }, "s1");
    expect((await execute(restarted, next, complete)).phase).toBe("evidence_review");
    expect(next.binding.codeVersion).toBe("commit-v1");
  });

  it("accepts declared extension fields without weakening builtin semantic fields", async () => {
    const raw = parse(await readFile(new URL("./fixtures/verification.yaml", import.meta.url), "utf8"));
    raw.artifacts.verification.blocks.scenarios.fields.observer = { type: "string", required: true };
    raw.artifacts.verification.blocks.scenarios.fields.expected.required = false;
    const chain = parseCommandChainDefinition(stringify(raw), profile);
    const engine = new CommandChainEngine(openStore(), createVerificationHandlers(baseContract));
    let draft = await engine.create({ id: "extended", chain, binding: baseContract.binding, attemptId: "test-run-1" });
    draft = await execute(engine, draft, complete);
    const { expected: _expected, ...missingExpected } = scenario;
    draft = await put(engine, draft, "scenarios", { ...missingExpected, observer: "Browser automation" }, "s1");
    await expect(execute(engine, draft, complete)).rejects.toThrow(/expected/);
    draft = await put(engine, draft, "scenarios", { ...scenario, observer: "Browser automation" }, "s1");
    expect((await execute(engine, draft, complete)).phase).toBe("execute");
  });

  it("does not let an added authoring phase record observations before plan freezing", async () => {
    const raw = parse(await readFile(new URL("./fixtures/verification.yaml", import.meta.url), "utf8"));
    raw.phases = {
      preobserve: { type: "artifact", artifacts: ["verification.results"], instructions: "Record observations early" },
      ...raw.phases,
    };
    const engine = new CommandChainEngine(openStore(), createVerificationHandlers(baseContract));
    let draft = await engine.create({ id: "early-results", chain: parseCommandChainDefinition(stringify(raw), profile), binding: baseContract.binding, attemptId: "test-run-1" });
    draft = await put(engine, draft, "results", { status: "passed", evidence: "Premature observation" }, "s1");
    draft = await execute(engine, draft, complete);
    draft = await execute(engine, draft, complete);
    draft = await put(engine, draft, "scenarios", scenario, "s1");
    await expect(execute(engine, draft, complete)).rejects.toThrow(/results cannot precede/);
  });

  it("routes mixed specification and implementation failures back to analysis", async () => {
    const { engine, draft, contract } = await executionPhase();
    let next = await put(engine, draft, "scenarios", { ...scenario, title: "Additional risk" }, "s2");
    next = await put(engine, next, "results", { status: "failed", failureKind: "implementation", evidence: "Missing implementation" }, "s1");
    next = await put(engine, next, "results", { status: "failed", failureKind: "specification", evidence: "Contradictory oracle" }, "s2");
    next = await execute(engine, next, complete);
    next = await put(engine, next, "evidence-review", { summary: "Both findings supported by independent observations" });
    next = await execute(engine, next, complete);
    next = await execute(engine, next, complete);
    expect(compileVerificationConclusion(next, contract)).toMatchObject({ verdict: "failed", failureKind: "specification", rewindTo: "analysis" });
  });

  it("keeps newly appended scenarios immutable through execution retries", async () => {
    const { engine, draft } = await executionPhase();
    let next = await put(engine, draft, "scenarios", { ...scenario, title: "New risk" }, "s2");
    await expect(put(engine, next, "scenarios", { ...scenario, expected: "Rewritten new risk" }, "s2")).rejects.toThrow(/append-only/);
    await expect(execute(engine, next, { type: "artifact.remove", ref: "verification.scenarios", key: "s2" })).rejects.toThrow(/append-only/);
    next = await put(engine, next, "results", { status: "passed", evidence: "s1 observation" }, "s1");
    next = await put(engine, next, "results", { status: "passed", evidence: "s2 observation" }, "s2");
    next = await execute(engine, next, complete);
    next = await execute(engine, next, { type: "phase.rewind", to: "execute", reason: "Recheck evidence" });
    expect(next.writeRules).toEqual([{ ref: "verification.scenarios", mode: "append-only", phase: "plan" }]);
    await expect(put(engine, next, "scenarios", { ...scenario, expected: "Rewritten after retry" }, "s2")).rejects.toThrow(/append-only/);
    expect((await put(engine, next, "results", { status: "failed", failureKind: "implementation", evidence: "New observation" }, "s2")).phase).toBe("execute");
  });

  it("seals observed results against additional authoring phases after execution", async () => {
    const raw = parse(await readFile(new URL("./fixtures/verification.yaml", import.meta.url), "utf8"));
    const { inputs, plan, execute: execution, ...remaining } = raw.phases;
    raw.phases = {
      inputs, plan, execute: execution,
      postprocess: { type: "artifact", artifacts: ["verification.scenarios", "verification.results"], instructions: "Postprocess" },
      ...remaining,
    };
    const engine = new CommandChainEngine(openStore(), createVerificationHandlers(baseContract));
    let next = await engine.create({ id: "sealed", chain: parseCommandChainDefinition(stringify(raw), profile), binding: baseContract.binding, attemptId: "test-run-1" });
    next = await execute(engine, next, complete);
    next = await put(engine, next, "scenarios", scenario, "s1");
    next = await execute(engine, next, complete);
    next = await put(engine, next, "results", { status: "passed", evidence: "Observed before review" }, "s1");
    next = await execute(engine, next, complete);
    expect(next.phase).toBe("postprocess");
    await expect(put(engine, next, "results", { status: "failed", failureKind: "implementation", evidence: "Overwritten" }, "s1")).rejects.toThrow(/sealed/);
    await expect(put(engine, next, "scenarios", scenario, "s2")).rejects.toThrow(/sealed/);
  });

  it("rejects malformed contracts before draft creation", () => {
    const missingAcceptance = structuredClone(baseContract);
    missingAcceptance.sources = missingAcceptance.sources.filter(source => source.kind !== "acceptance");
    expect(() => createVerificationHandlers(missingAcceptance)).toThrow(/include an acceptance/);
    const duplicated = structuredClone(baseContract);
    duplicated.sources.push(duplicated.sources[0]!);
    expect(() => createVerificationHandlers(duplicated)).toThrow(/unique/);
  });
});
