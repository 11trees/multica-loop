// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineeringApplication, type ApplicationRequest } from "./application";

const human = { kind: "human" as const, userId: "019a0000-0000-7000-8000-000000000001", workspaceId: "019a0000-0000-7000-8000-000000000002", issueId: "019a0000-0000-7000-8000-000000000003" };
const task = { kind: "task" as const, agentId: "019a0000-0000-7000-8000-000000000004", attemptId: "task:claim1", workspaceId: human.workspaceId, issueId: human.issueId };
const sources = [{ key: "ac1", kind: "acceptance", description: "Fixture survives reload", oracle: "Title remains visible", sourceRef: "FIXTURE:ac1:r1" }];
let dir: string, repo: string, app: EngineeringApplication, source: string;
function git(...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "engineering-app-"));
  repo = join(dir, "repository");
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.name", "Engineering fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "README.md"), "Fixture repository\n");
  git("add", "README.md"); git("commit", "-qm", "Initialize fixture");
  source = await readFile(new URL("./definitions/verification.yaml", import.meta.url), "utf8");
  app = new EngineeringApplication(join(dir, "application.sqlite"), source);
});
afterEach(async () => { app.close(); await rm(dir, { recursive: true, force: true }); });
async function invoke(actor: ApplicationRequest["actor"], action: Exclude<ApplicationRequest["action"], "selection">, payload?: unknown) {
  const result = await app.invoke({ actor, action, payload });
  if (!("draft" in result)) throw new Error("Expected application state");
  return result;
}
function configure() { return invoke(human, "configure", { expected_revision: 0, agent_id: task.agentId, repository_path: repo, sources }); }

it("freezes actual repository identity, stable contract content, and one draft per revision", async () => {
  const config = await configure();
  expect(config.contract.binding.codeVersion).toBe(git("rev-parse", "HEAD"));
  expect(config.contract.binding.contractVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(config.draft).toBeNull();
  const first = await invoke(task, "start");
  expect((await invoke(task, "start")).draft?.id).toBe(first.draft?.id);
  await expect(configure()).rejects.toThrow(/revision changed/);
  await expect(invoke(human, "configure", { expected_revision: 1, agent_id: task.agentId, repository_path: repo, sources })).rejects.toThrow(/Abandon the active/);
  app.close(); app = new EngineeringApplication(join(dir, "application.sqlite"), source);
  expect((await invoke(human, "read")).draft).toEqual(first.draft);
});

it("rejects task-owned configuration/answers, human run edits, and another agent or workspace", async () => {
  await expect(invoke(task, "configure", {})).rejects.toThrow(/Only a human/);
  await configure();
  await expect(invoke({ ...task, agentId: human.userId }, "start")).rejects.toThrow(/does not own/);
  await expect(invoke({ ...task, workspaceId: human.userId }, "read")).rejects.toThrow(/No verification contract/);
  await expect(invoke(human, "start")).rejects.toThrow(/run credential/);
  await expect(invoke(task, "answer", {})).rejects.toThrow(/human actor/);
});

it("rejects a dirty or changed checkout instead of trusting a submitted version label", async () => {
  await writeFile(join(repo, "uncommitted.txt"), "Changed\n");
  await expect(configure()).rejects.toThrow(/uncommitted changes/);
  await rm(join(repo, "uncommitted.txt"));
  await configure();
  await writeFile(join(repo, "README.md"), "Changed\n");
  await expect(invoke(task, "start")).rejects.toThrow(/uncommitted changes/);
  git("add", "README.md"); git("commit", "-qm", "Change fixture");
  await expect(invoke(task, "start")).rejects.toThrow(/commit changed/);
  expect((await invoke(human, "read")).draft).toBeNull();
});

it("persists a question, attributes the human answer, and resumes on a fresh claim", async () => {
  await configure();
  let state = await invoke(task, "start");
  const command = async (value: unknown) => { state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: value }); };
  await command({ type: "phase.complete" });
  await command({ type: "runtime-input.put", key: "entry", title: "Test entry", question: "Which entry?", why: "Need a real entry", recommendation: "Use local Web" });
  await command({ type: "phase.complete" });
  expect(state.draft?.status).toBe("waiting_for_answers");
  await expect(invoke({ ...task, attemptId: "task:claim2" }, "start")).rejects.toThrow(/require human answers/);
  const request = state.draft!.runtimeInputs[0]!;
  state = await invoke(human, "answer", { expected_sequence: state.draft!.sequence, request_id: request.id, answer: "Use the local fixture" });
  expect(state.draft?.runtimeInputs[0]?.answer?.userId).toBe(human.userId);
  const resumed = await invoke({ ...task, attemptId: "task:claim2" }, "start");
  expect(resumed.draft?.phase).toBe("plan");
  await expect(invoke(task, "command", { expected_sequence: resumed.draft!.sequence, command: { type: "phase.complete" } })).rejects.toThrow(/run attempt changed/);
});

it("preserves abandoned history and creates a new pinned revision", async () => {
  await configure();
  const initial = await invoke(task, "start");
  const abandoned = await invoke(human, "abandon", { expected_sequence: initial.draft!.sequence, reason: "Contract requires correction" });
  expect(abandoned.draft?.status).toBe("abandoned");
  expect(abandoned.draft?.events.at(-1)).toMatchObject({ command: "draft.abandon", userId: human.userId });
  await expect(invoke(task, "start")).rejects.toThrow(/abandoned/);
  const revised = await invoke(human, "configure", { expected_revision: 1, agent_id: task.agentId, repository_path: repo, sources });
  expect(revised.contract.binding.revision).toBe(2);
  expect(revised.contract.binding.contractVersion).not.toBe(initial.contract.binding.contractVersion);
  expect((await invoke(task, "start")).draft?.id).not.toBe(initial.draft?.id);
});
