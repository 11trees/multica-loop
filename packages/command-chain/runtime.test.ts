// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandChainEngine, DraftConflictError, parseCommandChainDefinition,
  type BuiltinHandlers, type ChainCommand, type ChainDraft, type CommandChainProfile,
} from "./index";
import { SqliteDraftStore } from "./sqlite-store";

const binding = { workspaceId: "workspace", issueId: "issue", revision: 1, contractVersion: "spec-v1", codeVersion: "commit-v1" };
const devProfile: CommandChainProfile = {
  id: "development", agent: "dev-agent",
  requiredBuiltins: ["delivery-spec", "implementation-evidence", "command-verification"],
  builtins: {
    "delivery-spec": { acceptsArtifacts: false },
    "implementation-evidence": { acceptsArtifacts: true },
    "command-verification": { acceptsArtifacts: true },
  },
  metadataKeys: ["tracking.requirement_card_id"], repositoryAdapters: [],
};
// Test validators deliberately do not claim to implement engineering gates.
const acceptingDevHandlers: BuiltinHandlers = Object.fromEntries(devProfile.requiredBuiltins.map(id => [id, () => ({ errors: [] })]));
let dir: string;
let stores: SqliteDraftStore[];
function openStore() {
  const store = new SqliteDraftStore(join(dir, "drafts.sqlite"));
  stores.push(store);
  return store;
}
async function createDevelopment(handlers: BuiltinHandlers = acceptingDevHandlers) {
  const chain = parseCommandChainDefinition(await readFile(new URL("./fixtures/development.yaml", import.meta.url), "utf8"), devProfile);
  const engine = new CommandChainEngine(openStore(), handlers);
  const draft = await engine.create({ id: "development-unit", chain, binding, attemptId: "run-1" });
  return { engine, draft, chain };
}
function execute(engine: CommandChainEngine, draft: ChainDraft, command: ChainCommand) {
  return engine.execute(draft.id, { attemptId: draft.attemptId, expectedSequence: draft.sequence }, command);
}
const complete = { type: "phase.complete" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "multica-chain-"));
  stores = [];
});
afterEach(async () => {
  for (const store of stores) store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("durable command-chain drafts", () => {
  it("keeps the real development chain checkpoint after a storage/engine restart", async () => {
    const { engine, draft } = await createDevelopment();
    const implemented = await execute(engine, await execute(engine, draft, complete), complete);
    expect(implemented.phase).toBe("review");
    stores.pop()!.close();
    const restarted = new CommandChainEngine(openStore(), acceptingDevHandlers);
    expect(await restarted.read(draft.id)).toEqual(implemented);
    let next = await execute(restarted, implemented, {
      type: "artifact.put", ref: "development.code-review", content: "summary: Responsibilities reviewed\nevidence: src/handler.ts:20",
    });
    next = await execute(restarted, next, complete);
    next = await execute(restarted, next, complete);
    expect(next.phase).toBe("commit");
    await expect(execute(restarted, next, complete)).rejects.toThrow(/explicit confirmation/);
    next = await execute(restarted, next, { ...complete, confirmation: "Scoped commit abc123 includes this delivery" });
    next = await execute(restarted, next, { ...complete, confirmation: "Evidence and commit are consistent" });
    expect(next.status).toBe("completed");
    expect(next.phase).toBeNull();
    expect(next.completedPhases).toHaveLength(6);
    expect(next.events.at(-1)?.reason).toBe("Evidence and commit are consistent");
    await expect(execute(restarted, next, complete)).rejects.toThrow(/no editable phase/);
  });

  it("rejects missing builtin implementations and failed validators without changing the checkpoint", async () => {
    const { engine, draft } = await createDevelopment({});
    await expect(execute(engine, draft, complete)).rejects.toThrow(/delivery-spec is not implemented/);
    const rejecting = new CommandChainEngine(openStore(), { "delivery-spec": () => ({ errors: ["Frozen spec is no longer current"] }) });
    await expect(execute(rejecting, draft, complete)).rejects.toThrow(/no longer current/);
    expect(await engine.read(draft.id)).toEqual(draft);
  });

  it("enforces phase write boundaries, cardinality, required artifacts, and YAML field validation", async () => {
    const { engine, draft } = await createDevelopment();
    await expect(execute(engine, draft, { type: "artifact.put", ref: "development.code-review", content: "summary: premature" }))
      .rejects.toThrow(/outside the current phase/);
    const review = await execute(engine, await execute(engine, draft, complete), complete);
    await expect(execute(engine, review, complete)).rejects.toThrow(/Required artifact development.code-review/);
    for (const [content, error] of [
      ["summary: reviewed", /evidence is missing/],
      ["summary: ' '\nevidence: file:1", /nonempty string/],
      ["summary: reviewed\nevidence: file:1\nstatus: passed", /Undeclared artifact field status/],
      ["- summary: reviewed", /YAML object/],
      ["summary: reviewed\nsummary: duplicate", /unique/],
    ] as const) {
      await expect(execute(engine, review, { type: "artifact.put", ref: "development.code-review", content })).rejects.toThrow(error);
    }
    await expect(execute(engine, review, { type: "artifact.put", ref: "development.code-review", key: "extra", content: "summary: ok\nevidence: file:1" }))
      .rejects.toThrow(/Singleton/);
    expect(await engine.read(draft.id)).toEqual(review);
    const implement = await execute(engine, review, { type: "phase.rewind", to: "implement", reason: "Need to record recovery" });
    await expect(execute(engine, implement, { type: "artifact.put", ref: "development.recovery-resolutions", content: "summary: ok\nevidence: file:1" }))
      .rejects.toThrow(/stable item key/);
  });

  it("invalidates downstream review on rewind and retains the reason after reopening storage", async () => {
    const { engine, draft } = await createDevelopment();
    let next = await execute(engine, await execute(engine, draft, complete), complete);
    next = await execute(engine, next, { type: "artifact.put", ref: "development.code-review", content: "summary: reviewed\nevidence: commit-v1" });
    next = await execute(engine, next, complete);
    const rewound = await execute(engine, next, { type: "phase.rewind", to: "implement", reason: "Review found missing behavior" });
    expect(rewound.artifacts).toEqual([]);
    expect(rewound.completedPhases).toEqual(["delivery_spec"]);
    expect(rewound.events.at(-1)?.reason).toBe("Review found missing behavior");
    const backToReview = await execute(engine, rewound, complete);
    await expect(execute(engine, backToReview, complete)).rejects.toThrow(/code-review is missing/);
    await expect(execute(engine, backToReview, { type: "phase.rewind", to: "finalize", reason: "skip ahead" })).rejects.toThrow(/earlier phase/);
    expect(await new CommandChainEngine(openStore()).read(draft.id)).toEqual(backToReview);
  });

  it("rejects stale writes and fences a superseded run attempt", async () => {
    const { engine, draft } = await createDevelopment();
    const resumed = await engine.resume(draft.id, draft.sequence, "run-2");
    expect(resumed.phase).toBe(draft.phase);
    expect(resumed.binding).toEqual(binding);
    await expect(execute(engine, draft, complete)).rejects.toBeInstanceOf(DraftConflictError);
    await expect(engine.execute(draft.id, { attemptId: "run-1", expectedSequence: resumed.sequence }, complete)).rejects.toBeInstanceOf(DraftConflictError);
    await expect(engine.resume(draft.id, draft.sequence, "run-3")).rejects.toBeInstanceOf(DraftConflictError);
    expect((await execute(engine, resumed, complete)).phase).toBe("implement");
  });

  it("atomically rejects a competing completion from another engine connection", async () => {
    const { engine, draft, chain } = await createDevelopment();
    const competitor = new CommandChainEngine(openStore(), acceptingDevHandlers);
    const outcomes = await Promise.allSettled([execute(engine, draft, complete), execute(competitor, draft, complete)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DraftConflictError);
    expect((await engine.read(draft.id)).sequence).toBe(1);
    await expect(engine.create({ id: draft.id, chain, binding, attemptId: "duplicate" })).rejects.toBeInstanceOf(DraftConflictError);
    expect((await engine.read(draft.id)).attemptId).toBe("run-1");
  });
});

describe("independent verification draft boundaries", () => {
  async function createVerification() {
    const profile: CommandChainProfile = {
      id: "verification", agent: "test-agent",
      requiredBuiltins: ["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"],
      builtins: Object.fromEntries(["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"].map(id => [id, { acceptsArtifacts: true }])),
      metadataKeys: [], repositoryAdapters: [],
    };
    const chain = parseCommandChainDefinition(await readFile(new URL("./definitions/verification.yaml", import.meta.url), "utf8"), profile);
    const handlers: BuiltinHandlers = {
      "verification-inputs": () => ({ errors: [] }),
      "verification-plan": () => ({ errors: [], freeze: ["verification.scenarios"] }),
    };
    const engine = new CommandChainEngine(openStore(), handlers);
    const draft = await engine.create({
      id: "verification-unit", chain, binding, attemptId: "test-1",
      readonlyArtifacts: [{ ref: "verification.sources", key: "ac1", content: "kind: acceptance\ndescription: Can create issue\noracle: Issue is visible after reload\nsourceRef: spec-v1#ac1" }],
    });
    return { engine, draft };
  }
  const scenario = "channel: frontend\ntitle: Create issue\nsetup: Local workspace\nsteps: Create and reload\nexpected: Issue visible\ncoverageRefs: [spec-v1#ac1]";

  it("preserves frozen expected results, allows new scenarios, and requires rewind to change the plan", async () => {
    const { engine, draft } = await createVerification();
    let plan = await execute(engine, draft, complete);
    await expect(execute(engine, plan, { type: "artifact.put", ref: "verification.sources", key: "ac1", content: "kind: acceptance" }))
      .rejects.toThrow(/outside the current phase/);
    plan = await execute(engine, plan, { type: "artifact.put", ref: "verification.scenarios", key: "s1", content: scenario });
    let execution = await execute(engine, plan, complete);
    expect(execution.phase).toBe("execute");
    await expect(execute(engine, execution, { type: "artifact.put", ref: "verification.scenarios", key: "s1", content: scenario.replace("Issue visible", "Anything passes") }))
      .rejects.toThrow(/frozen/);
    await expect(execute(engine, execution, { type: "artifact.remove", ref: "verification.scenarios", key: "s1" })).rejects.toThrow(/frozen/);
    execution = await execute(engine, execution, { type: "artifact.put", ref: "verification.scenarios", key: "s2", content: scenario });
    execution = await execute(engine, execution, { type: "artifact.put", ref: "verification.results", key: "s1", content: "status: failed\nfailureKind: implementation\nevidence: Browser observation" });
    const rewound = await execute(engine, execution, { type: "phase.rewind", to: "plan", reason: "Oracle requires a clearer expected result" });
    expect(rewound.artifacts.filter(item => item.ref === "verification.results")).toEqual([]);
    expect(rewound.artifacts.find(item => item.ref === "verification.sources")?.content).toContain("spec-v1#ac1");
    expect(rewound.frozen).toEqual([]);
    const revised = await execute(engine, rewound, { type: "artifact.put", ref: "verification.scenarios", key: "s1", content: scenario.replace("Issue visible", "Issue title visible") });
    expect(revised.artifacts.find(item => item.key === "s1")?.content).toContain("Issue title visible");
  });

  it.each([
    ["status: success\nevidence: screenshot", /must be one of passed, failed, blocked/],
    ["channel: frontend\ntitle: Case\nsetup: Ready\nsteps: Click\nexpected: Visible\ncoverageRefs: []", /at least 1 items/],
  ])("rejects invalid enum/array content: %s", async (content, error) => {
    const { engine, draft } = await createVerification();
    let next = await execute(engine, draft, complete);
    const ref = content.startsWith("status") ? "verification.results" : "verification.scenarios";
    if (ref === "verification.results") {
      next = await execute(engine, next, { type: "artifact.put", ref: "verification.scenarios", key: "s1", content: scenario });
      next = await execute(engine, next, complete);
    }
    await expect(execute(engine, next, { type: "artifact.put", ref, key: "s1", content })).rejects.toThrow(error);
  });
});

describe("host output and metadata", () => {
  const source = `
version: 1
id: inspection
agent: inspector
inputs:
  ticket: { metadata: tracking.ticket, required: true }
artifacts:
  audit:
    type: builtin
    title: Audit
    blocks:
      sources: { title: Sources, cardinality: one, format: text, writable: false, required: true }
      result: { title: Result, cardinality: one, format: markdown, required: true }
phases:
  inputs: { type: builtin, builtin: freeze, artifacts: [audit.sources] }
  metadata: { type: metadata, inputs: [ticket], instructions: Set tracking ticket }
  review: { type: artifact, artifacts: [audit.result], instructions: Inspect the result }
  finalize: { type: confirmation, instructions: Confirm the result }
`;
  const profile: CommandChainProfile = {
    id: "inspection", agent: "inspector", requiredBuiltins: ["freeze"],
    builtins: { freeze: { acceptsArtifacts: true, allowsReadonlyArtifacts: true } },
    metadataKeys: ["tracking.ticket"], repositoryAdapters: [],
  };
  async function create(handlers: BuiltinHandlers) {
    const engine = new CommandChainEngine(openStore(), handlers);
    const draft = await engine.create({ id: "inspection", chain: parseCommandChainDefinition(source, profile), binding, attemptId: "inspect-1" });
    return { engine, draft };
  }

  it("publishes trusted readonly output atomically and gates required metadata", async () => {
    const { engine, draft } = await create({ freeze: () => ({ errors: [], artifacts: [{ ref: "audit.sources", content: "Pinned source revision" }] }) });
    await expect(execute(engine, draft, { type: "artifact.put", ref: "audit.sources", content: "Agent supplied source" })).rejects.toThrow(/readonly/);
    let next = await execute(engine, draft, complete);
    expect(next.artifacts[0]).toMatchObject({ ref: "audit.sources", attemptId: "inspect-1" });
    await expect(execute(engine, next, complete)).rejects.toThrow(/Required input ticket/);
    await expect(execute(engine, next, { type: "metadata.set", input: "unknown", value: "X" })).rejects.toThrow(/outside/);
    next = await execute(engine, next, { type: "metadata.set", input: "ticket", value: "LOCAL-1" });
    next = await execute(engine, next, complete);
    await expect(execute(engine, next, { type: "metadata.set", input: "ticket", value: "LOCAL-2" })).rejects.toThrow(/outside/);
    next = await execute(engine, next, { type: "artifact.put", ref: "audit.result", content: "# Reviewed\n\nEvidence supports the result." });
    next = await execute(engine, next, { type: "artifact.remove", ref: "audit.result" });
    await expect(execute(engine, next, complete)).rejects.toThrow(/Required artifact audit.result/);
  });

  it("keeps failed builtin output out of storage", async () => {
    const { engine, draft } = await create({ freeze: () => ({ errors: ["Host snapshot unavailable"], artifacts: [{ ref: "audit.sources", content: "Invalid output" }] }) });
    await expect(execute(engine, draft, complete)).rejects.toThrow(/snapshot unavailable/);
    expect(await engine.read(draft.id)).toEqual(draft);
    const invalidOutput = new CommandChainEngine(openStore(), {
      freeze: () => ({ errors: [], artifacts: [{ ref: "audit.sources", content: "Snapshot" }, { ref: "audit.unknown", content: "Invalid" }] }),
    });
    await expect(execute(invalidOutput, draft, complete)).rejects.toThrow(/Unknown artifact/);
    expect(await engine.read(draft.id)).toEqual(draft);
  });
});
