import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandChainEngine, MulticaChainBridge, MulticaRunClient, compileVerificationConclusion,
  createVerificationHandlers, parseCommandChainDefinition, pendingRuntimeInputs,
  type ChainCommand, type CommandChainProfile, type VerificationContract,
} from "../packages/command-chain/index";
import { SqliteDraftStore } from "../packages/command-chain/sqlite-store";
import { TestApiClient } from "./fixtures";

test("live Multica run identity binds verification, human checkpoints, and reclaimed claims", async () => {
  test.skip(process.env.MULTICA_LOCAL_AUTH !== "true" || !process.env.DATABASE_URL, "Requires the managed local single-user environment");
  const api = new TestApiClient();
  await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(value => value.slug === "loopwork-local");
  expect(workspace).toBeDefined();
  api.setWorkspaceId(workspace!.id);
  api.setWorkspaceSlug(workspace!.slug);
  const directory = await mkdtemp(join(tmpdir(), "multica-engineering-e2e-"));
  let store: SqliteDraftStore | undefined;
  try {
    const run = await api.seedEngineeringRun();
    const profile: CommandChainProfile = {
      id: "verification", agent: "test-agent",
      requiredBuiltins: ["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"],
      builtins: Object.fromEntries(["verification-inputs", "verification-plan", "verification-execution", "verification-finalize"].map(id => [id, { acceptsArtifacts: true }])),
      metadataKeys: [], repositoryAdapters: [],
    };
    const chain = parseCommandChainDefinition(await readFile(new URL("../packages/command-chain/definitions/verification.yaml", import.meta.url), "utf8"), profile);
    const contract: VerificationContract = {
      binding: { workspaceId: run.workspaceId, issueId: run.issueId, revision: 1, contractVersion: "fixture-spec-v1", codeVersion: "fixture-code-v1" },
      sources: [{ key: "ac1", kind: "acceptance", description: "Fixture issue persists", oracle: "Fixture title is preserved", sourceRef: "FIXTURE:ac1:r1" }],
    };
    const client = new MulticaRunClient({ baseUrl: run.apiBase, taskToken: run.taskToken });
    const context = await client.context();
    expect(context).toMatchObject({ workspaceId: workspace!.id, issueId: run.issueId, taskId: run.taskId, agentId: run.agentId });
    store = new SqliteDraftStore(join(directory, "draft.sqlite"));
    let engine = new CommandChainEngine(store, createVerificationHandlers(contract));
    let bridge = new MulticaChainBridge({ client, engine, chain, agentId: run.agentId, resolveBinding: () => contract.binding });
    let draft = await bridge.create(`fixture-${run.taskId}`);
    const command = async (value: ChainCommand) => { draft = await bridge.execute(draft.id, draft.sequence, value); };
    await command({ type: "phase.complete" });
    await command({ type: "artifact.put", ref: "verification.scenarios", key: "s1", content:
      "channel: frontend\ntitle: Fixture observation\nsetup: Isolated fixture\nsteps: Observe the fixture\nexpected: Fixture title is preserved\ncoverageRefs: [ac1]",
    });
    await command({ type: "phase.complete" });
    await command({ type: "artifact.put", ref: "verification.results", key: "s1", content: "status: blocked\nfailureKind: environment\nevidence: Fixture environment unavailable" });
    await command({ type: "runtime-input.put", key: "fixture-environment", title: "Fixture environment", question: "Is the fixture ready?", why: "Need to repeat the observation", recommendation: "Prepare the isolated fixture" });
    await command({ type: "phase.complete" });
    expect(draft.status).toBe("waiting_for_answers");
    const request = pendingRuntimeInputs(draft)[0]!;
    store.close();
    store = new SqliteDraftStore(join(directory, "draft.sqlite"));
    engine = new CommandChainEngine(store, createVerificationHandlers(contract));
    draft = await engine.read(draft.id);
    draft = await engine.answerRuntimeInput(draft.id, { expectedSequence: draft.sequence, requestId: request.id, answer: "Fixture ready", userId: run.userId });
    const newToken = await api.reclaimEngineeringRun(run.taskId);
    await expect(client.context()).rejects.toThrow(/HTTP 403/);
    const nextClient = new MulticaRunClient({ baseUrl: run.apiBase, taskToken: newToken });
    const nextContext = await nextClient.context();
    expect(nextContext.attemptId).not.toBe(context.attemptId);
    bridge = new MulticaChainBridge({ client: nextClient, engine, chain, agentId: run.agentId, resolveBinding: () => contract.binding });
    draft = await bridge.resume(draft.id, draft.sequence);
    expect(draft.phase).toBe("execute");
    expect(draft.attemptId).toBe(nextContext.attemptId);
    await expect(bridge.execute(draft.id, draft.sequence, { type: "phase.complete" })).rejects.toThrow(/resolve runtime input and rerun/);
    await command({ type: "artifact.put", ref: "verification.results", key: "s1", content: "status: passed\nevidence: New fixture observation after the human answer" });
    await command({ type: "phase.complete" });
    await command({ type: "artifact.put", ref: "verification.evidence-review", content: "summary: Fixture evidence and result are consistent" });
    await command({ type: "phase.complete" });
    await command({ type: "phase.complete" });
    expect(compileVerificationConclusion(await bridge.read(draft.id), contract)).toMatchObject({
      verdict: "passed", attemptId: nextContext.attemptId, binding: contract.binding,
    });
  } finally {
    store?.close();
    await api.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
