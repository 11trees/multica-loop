// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandChainEngine, DraftConflictError, MulticaChainBridge, MulticaRunClient, parseCommandChainDefinition, type ChainBinding, type CommandChainProfile, type MulticaRunContext } from "./index";
import { SqliteDraftStore } from "./sqlite-store";

const ids = {
  workspace: "019a0000-0000-7000-8000-000000000001", issue: "019a0000-0000-7000-8000-000000000002",
  task: "019a0000-0000-7000-8000-000000000003", agent: "019a0000-0000-7000-8000-000000000004",
  runtime: "019a0000-0000-7000-8000-000000000005",
};
const wire = {
  api_version: 1, workspace_id: ids.workspace, issue_id: ids.issue, task_id: ids.task,
  agent_id: ids.agent, runtime_id: ids.runtime, attempt: 1, claim_id: "1794534000000000",
  attempt_id: `${ids.task}:1794534000000000`, status: "running",
};
const binding: ChainBinding = { workspaceId: ids.workspace, issueId: ids.issue, revision: 1, contractVersion: "spec-v1", codeVersion: "commit-v1" };
let store: SqliteDraftStore;
beforeEach(() => { store = new SqliteDraftStore(":memory:"); });
afterEach(() => { store.close(); });

async function setup() {
  const profile: CommandChainProfile = {
    id: "development", agent: "dev-agent", requiredBuiltins: ["delivery-spec", "implementation-evidence", "command-verification"],
    builtins: { "delivery-spec": { acceptsArtifacts: false }, "implementation-evidence": { acceptsArtifacts: true }, "command-verification": { acceptsArtifacts: true } },
    metadataKeys: ["tracking.requirement_card_id"], repositoryAdapters: [],
  };
  const chain = parseCommandChainDefinition(await readFile(new URL("./definitions/development.yaml", import.meta.url), "utf8"), profile);
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(wire));
  const client = new MulticaRunClient({ baseUrl: "http://localhost:18729", taskToken: "mat_test_only", fetch: transport });
  const engine = new CommandChainEngine(store, { "delivery-spec": () => ({ errors: [] }) });
  const resolveBinding = vi.fn<(run: MulticaRunContext) => ChainBinding>().mockImplementation(() => structuredClone(binding));
  const bridge = new MulticaChainBridge({ client, engine, agentId: ids.agent, chain, resolveBinding });
  return { bridge, engine, transport, resolveBinding, client, chain };
}

describe("Multica run context transport", () => {
  it("uses task bearer authentication, rejects redirects, and derives camelCase identity", async () => {
    const { client, transport } = await setup();
    expect(await client.context()).toMatchObject({ taskId: ids.task, attemptId: wire.attempt_id, issueId: ids.issue });
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:18729/api/engineering/run");
    expect(init).toMatchObject({ headers: { Authorization: "Bearer mat_test_only" }, cache: "no-store", redirect: "error" });
    expect(() => new MulticaRunClient({ baseUrl: "http://localhost", taskToken: "mul_human_pat" })).toThrow(/task token/);
  });

  it.each([
    { ...wire, attempt_id: "forged-attempt" }, { ...wire, status: "completed" },
    { ...wire, workspace_id: "not-a-uuid" }, { ...wire, api_version: 2 }, { ...wire, attempt: -1 },
  ])("fails closed on malformed or unsupported host identity", async value => {
    const { client, transport } = await setup();
    transport.mockResolvedValueOnce(Response.json(value));
    await expect(client.context()).rejects.toThrow();
  });

  it("does not echo credentials or server error bodies on rejection", async () => {
    const { client, transport } = await setup();
    transport.mockResolvedValueOnce(new Response("Private diagnostic", { status: 403 }));
    await expect(client.context()).rejects.toThrow("Multica rejected the run context (HTTP 403)");
  });
});

describe("trusted run to command-chain binding", () => {
  it("creates and executes with server identity and checks the host on every call", async () => {
    const { bridge, transport, resolveBinding } = await setup();
    const draft = await bridge.create("bound-draft");
    expect(draft.attemptId).toBe(wire.attempt_id);
    expect(draft.binding).toEqual(binding);
    const next = await bridge.execute(draft.id, draft.sequence, { type: "phase.complete" });
    expect(next.phase).toBe("implement");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(resolveBinding.mock.calls[0]?.[0]).toMatchObject({ agentId: ids.agent, taskId: ids.task });
  });

  it("rejects another agent, issue, workspace, or role without changing the draft", async () => {
    const { bridge, engine, transport, client, chain, resolveBinding } = await setup();
    const draft = await bridge.create("bound-draft");
    transport.mockResolvedValueOnce(Response.json({ ...wire, agent_id: ids.issue }));
    await expect(bridge.execute(draft.id, 0, { type: "phase.complete" })).rejects.toThrow(/does not own/);
    transport.mockResolvedValueOnce(Response.json({ ...wire, issue_id: ids.agent }));
    await expect(bridge.read(draft.id)).rejects.toThrow(/authenticated issue/);
    transport.mockResolvedValueOnce(Response.json({ ...wire, workspace_id: ids.agent }));
    await expect(bridge.read(draft.id)).rejects.toThrow(/authenticated issue/);
    const wrongRole = new MulticaChainBridge({ client, engine, agentId: ids.agent, chain: { ...chain, definition: { ...chain.definition, id: "other-chain" } }, resolveBinding });
    await expect(wrongRole.read(draft.id)).rejects.toThrow(/another command-chain role/);
    expect(await engine.read(draft.id)).toEqual(draft);
  });

  it("rejects stale contract/code revisions before mutation", async () => {
    const { bridge, engine, resolveBinding } = await setup();
    const draft = await bridge.create("bound-draft");
    for (const change of [{ contractVersion: "spec-v2" }, { codeVersion: "commit-v2" }, { revision: 2 }]) {
      resolveBinding.mockReturnValueOnce({ ...binding, ...change });
      await expect(bridge.execute(draft.id, 0, { type: "phase.complete" })).rejects.toBeInstanceOf(DraftConflictError);
    }
    expect(await engine.read(draft.id)).toEqual(draft);
  });

  it("resumes a reclaimed claim and rejects the old claim even with the current sequence", async () => {
    const { bridge, engine, transport } = await setup();
    const draft = await bridge.create("bound-draft");
    const newClaim = { ...wire, claim_id: "1794534001000000", attempt_id: `${ids.task}:1794534001000000` };
    transport.mockResolvedValueOnce(Response.json(newClaim));
    const resumed = await bridge.resume(draft.id, draft.sequence);
    expect(resumed.attemptId).toBe(newClaim.attempt_id);
    await expect(bridge.execute(draft.id, resumed.sequence, { type: "phase.complete" })).rejects.toBeInstanceOf(DraftConflictError);
    expect(await engine.read(draft.id)).toEqual(resumed);
  });
});
