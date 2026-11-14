// @vitest-environment node
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineeringApplication, type ApplicationRequest } from "./application";
import { SqliteDraftStore } from "./sqlite-store";
import { interventionRequestSchema } from "./intervention-store";

const human = { kind: "human" as const, workspaceId: randomUUID(), issueId: randomUUID(), userId: randomUUID() };
const agentId = randomUUID(), projectId = randomUUID();
const owner = { kind: "task" as const, workspaceId: human.workspaceId, issueId: human.issueId, agentId, projectId, attemptId: `${randomUUID()}:123456` };
const host = { kind: "host" as const, workspaceId: human.workspaceId, issueId: human.issueId };
const body = { summary: "Frozen scope contradicts the observed entry", reason: "The supplied answer does not establish the original oracle", evidence: "# Investigation\n\nThe original contract and README.md disagree." };
let directory: string, repository: string, database: string, definition: string, app: EngineeringApplication;
const invoke = (actor: ApplicationRequest["actor"], action: ApplicationRequest["action"], payload?: unknown) => app.invoke({ actor, action, payload });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "intervention-host-")); repository = join(directory, "repository"); database = join(directory, "state.sqlite");
  execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  git("config", "user.name", "Intervention fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "README.md"), "Original source\n"); git("add", "."); git("commit", "-qm", "Original fixture");
  definition = await readFile(new URL("./definitions/verification.yaml", import.meta.url), "utf8"); app = new EngineeringApplication(database, definition);
});
afterEach(async () => { app.close(); await rm(directory, { recursive: true, force: true }); });
async function direct() {
  await invoke(human, "configure-direct", { expected_revision: 0, agent_id: agentId, project_id: projectId, repository_path: repository, input: "Read the source faithfully", execution_resources: [{ path: repository, mode: "in_place" }] });
  await invoke({ ...owner, kind: "daemon" }, "bind", { work_dir: repository, mode: "in_place", overlays: [] });
}
it("surrenders Direct only after RUN, persists one exact terminal receipt and blocks all advancement after reopening", async () => {
  await direct(); await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/Direct RUN/);
  await invoke(owner, "direct-run"); const result = await invoke(owner, "intervention-request", body);
  expect(result).toMatchObject({ submitted: true, owner: "admin", agent_action: "end_execution", intervention: { status: "pending_admin", chain: "direct", phase: "run", ...body } });
  app.close(); app = new EngineeringApplication(database, definition);
  expect(await invoke(owner, "intervention-request", body)).toEqual(result);
  await expect(invoke(owner, "intervention-request", { ...body, reason: "Replace history" })).rejects.toThrow(/immutable/);
  for (const action of ["direct-submit", "direct-run", "prepare-run", "selection", "completion", "configure"] as const) {
    await expect(invoke(action === "completion" ? host : owner, action, { summary: "Do not complete" })).rejects.toThrow(/surrendered/);
  }
  expect(await invoke(human, "overview")).toMatchObject({ status: "waiting_for_intervention", direct: { result: null }, intervention: { summary: body.summary } });
  expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([]);
  const observations = await invoke({ kind: "coordinator" }, "repair-observations");
  expect(observations).toEqual([expect.objectContaining({ attemptId: owner.attemptId, snapshot: expect.objectContaining({ direct: expect.objectContaining({ input: "Read the source faithfully" }) }) })]);
  await expect(invoke(owner, "repair-observations")).rejects.toThrow(/Only the host/);
});
it("requires this attempt's viewed editable YAML draft and preserves it against a writer that read before surrender", async () => {
  await invoke(human, "configure", { expected_revision: 0, agent_id: agentId, repository_path: repository, sources: [{ key: "original", kind: "acceptance", description: "Original entry", oracle: "Observe the original entry", sourceRef: "README.md" }] });
  await invoke({ ...owner, kind: "daemon" }, "bind", { work_dir: repository, mode: "in_place", overlays: [] });
  await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/editable checkpoint/);
  const state = await invoke(owner, "start"); if (!("draft" in state) || !state.draft) throw new Error("Missing fixture draft");
  const store = new SqliteDraftStore(database), before = await store.read(state.draft.id); if (!before) throw new Error("Missing draft");
  await writeFile(join(repository, "observed-drift.md"), "Readonly workspace drift must still be reportable\n");
  await invoke(owner, "intervention-request", body);
  await expect(invoke(owner, "command", { expected_sequence: before.sequence, command: { type: "phase.complete" } })).rejects.toThrow(/surrendered/);
  await expect(store.save({ ...before, sequence: before.sequence + 1 }, before.sequence)).rejects.toThrow(/Draft changed/);
  expect(await store.read(before.id)).toEqual(before); store.close();
});
it("rejects human, foreign agent and unviewed attempts without creating observations", async () => {
  await direct(); await invoke(owner, "direct-run");
  await expect(invoke(human, "intervention-request", body)).rejects.toThrow(/native task/);
  await expect(invoke({ ...owner, agentId: randomUUID() }, "intervention-request", body)).rejects.toThrow(/agent|role/);
  const db = new DatabaseSync(database); db.prepare("DELETE FROM engineering_intervention_view").run(); db.close();
  await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/Read this attempt/);
  expect(await invoke({ kind: "coordinator" }, "repair-observations")).toEqual([]);
});
it("refuses a request after an explicit Direct result", async () => {
  await direct(); await invoke(owner, "direct-run"); await invoke(owner, "direct-submit", { summary: "Actual result" });
  await expect(invoke(owner, "intervention-request", body)).rejects.toThrow(/submitted work/);
});
it("enforces the source request's separate summary, reason and evidence limits", () => {
  expect(interventionRequestSchema.parse(body)).toEqual(body);
  for (const invalid of [{ ...body, summary: "x".repeat(4001) }, { ...body, reason: "x".repeat(8001) }, { ...body, evidence: "x".repeat(100001) }, { ...body, issue_id: randomUUID() }]) expect(() => interventionRequestSchema.parse(invalid)).toThrow();
});

it("revalidates the original checkpoint and immutable receipt identity on later reads", async () => {
 await direct();await invoke(owner,"direct-run");await invoke(owner,"intervention-request",body);
 await writeFile(join(repository,"later-work.md"),"Unrelated later workspace change\n");
 expect(await invoke(owner,"read")).toMatchObject({agent_action:"end_execution",intervention:{summary:body.summary}});
 const db=new DatabaseSync(database),row=db.prepare("SELECT payload FROM engineering_intervention").get()!,record=JSON.parse(String(row.payload));record.phase="fabricated-phase";db.prepare("UPDATE engineering_intervention SET payload=?").run(JSON.stringify(record));db.close();
 await expect(invoke(human,"overview")).rejects.toThrow(/identity or receipt changed/);
});
