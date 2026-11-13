// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  app = new EngineeringApplication(join(dir, "application.sqlite"), source, await readFile(new URL("./definitions/development.yaml", import.meta.url), "utf8"));
});
afterEach(async () => { app.close(); await rm(dir, { recursive: true, force: true }); });
async function invoke(actor: ApplicationRequest["actor"], action: Exclude<ApplicationRequest["action"], "selection">, payload?: unknown) {
  if (action === "start" && actor.kind === "task") await app.invoke({ actor: { ...actor, kind: "daemon" }, action: "bind", payload: { work_dir: repo, mode: "in_place", overlays: [] } });
  const result = await app.invoke({ actor, action, payload });
  if (!("draft" in result)) throw new Error("Expected application state");
  return result;
}
function configure() { return invoke(human, "configure", { expected_revision: 0, agent_id: task.agentId, repository_path: repo, sources }); }
const host = { kind: "host" as const, workspaceId: human.workspaceId, issueId: human.issueId };
function completion() { return app.invoke({ actor: host, action: "completion" }); }

it("projects human progress and authorizes the frozen role only after every answer at the current checkpoint", async () => {
  expect(await app.invoke({ actor: human, action: "overview" })).toEqual({ enabled: true, configured: false });
  await configure();
  expect(await app.invoke({ actor: human, action: "overview" })).toMatchObject({ configured: true, agent_id: task.agentId, status: "unstarted", sequence: 0, revision: 1 });
  await expect(app.invoke({ actor: task, action: "overview" })).rejects.toThrow(/human actor/);
  await expect(app.invoke({ actor: human, action: "prepare-run", payload: { expected_revision: 2, expected_sequence: 0 } })).rejects.toThrow(/state changed/);
  expect(await app.invoke({ actor: human, action: "prepare-run", payload: { expected_revision: 1, expected_sequence: 0 } })).toMatchObject({ agent_id: task.agentId });
  let state = await invoke(task, "start");
  const command = async (value: unknown) => { state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: value }); };
  await command({ type: "phase.complete" });
  await command({ type: "runtime-input.put", key: "fixture", title: "Fixture", question: "Which entry?", why: "Need real data", recommendation: "Use local fixture" });
  expect(await app.invoke({ actor: human, action: "prepare-run", payload: { expected_revision: 1, expected_sequence: state.draft!.sequence } })).toMatchObject({ agent_id: task.agentId });
  await command({ type: "phase.complete" });
  const checkpoint = () => ({ expected_revision: 1, expected_sequence: state.draft!.sequence });
  await expect(app.invoke({ actor: human, action: "prepare-run", payload: checkpoint() })).rejects.toThrow(/every pending question/);
  const request = state.draft!.runtimeInputs[0]!;
  expect(await app.invoke({ actor: human, action: "overview" })).toMatchObject({ status: "waiting_for_answers", current_phase: "plan", questions: [{ id: request.id, answer: null }] });
  state = await invoke(human, "answer", { expected_sequence: state.draft!.sequence, request_id: request.id, answer: "Use the isolated fixture" });
  expect(await app.invoke({ actor: human, action: "overview" })).toMatchObject({ questions: [{ answer: { text: "Use the isolated fixture", user_id: human.userId } }] });
  expect(await app.invoke({ actor: human, action: "prepare-run", payload: checkpoint() })).toMatchObject({ agent_id: task.agentId });
  state = await invoke(human, "abandon", { expected_sequence: state.draft!.sequence, reason: "Scope changed" });
  await expect(app.invoke({ actor: human, action: "prepare-run", payload: checkpoint() })).rejects.toThrow(/new contract/);
});

it("checks the selected project repository before queueing and resumes interrupted development with partial edits", async () => {
  await invoke(human, "configure", { expected_revision: 0, agent_id: human.userId, developer_agent_id: task.agentId, implementation_guidance: "Implement fixture", repository_path: repo, sources });
  const unrelated = join(dir, "unrelated"); execFileSync("git", ["clone", "-q", repo, unrelated]);
  const prepare = (path: string) => app.invoke({ actor: human, action: "prepare-run", payload: { expected_revision: 1, expected_sequence: 0, execution_resources: [{ path, mode: "in_place" }] } });
  await expect(prepare(unrelated)).rejects.toThrow(/does not match/);
  expect(await prepare(repo)).toMatchObject({ agent_id: task.agentId });
  let state = await invoke(task, "start");
  state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: { type: "phase.complete" } });
  expect(state.draft!.phase).toBe("implement");
  await writeFile(join(repo, "partial.js"), "export const partial = true;\n");
  const reclaimed = { ...task, attemptId: "task:claim2" };
  const resumed = await invoke(reclaimed, "start");
  expect(resumed.draft).toMatchObject({ id: state.draft!.id, phase: "implement", binding: state.draft!.binding });
});

it("derives stable continuation tasks only for fully answered published checkpoints and retains them across restart", async () => {
  const pending = () => app.invoke({ actor: { kind: "coordinator" }, action: "continuations" });
  await expect(app.invoke({ actor: task, action: "continuations" })).rejects.toThrow(/Only the host/);
  await expect(app.invoke({ actor: { kind: "coordinator" }, action: "configure" })).rejects.toThrow(/cannot edit/);
  await invoke(human, "configure", { expected_revision: 0, agent_id: task.agentId, repository_path: repo, sources, auto_continue: true });
  expect(await pending()).toEqual([]);
  let state = await invoke(task, "start");
  const command = async (value: unknown) => { state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: value }); };
  await command({ type: "phase.complete" });
  for (const key of ["entry", "data"]) await command({ type: "runtime-input.put", key, title: key, question: "Which fixture?", why: "Need isolated data", recommendation: "Use the local fixture" });
  expect(await pending()).toEqual([]);
  await command({ type: "phase.complete" });
  expect(await pending()).toEqual([]);
  for (const [index, question] of state.draft!.runtimeInputs.entries()) {
    state = await invoke(human, "answer", { expected_sequence: state.draft!.sequence, request_id: question.id, answer: "Use the local fixture" });
    if (index === 0) expect(await pending()).toEqual([]);
  }
  const expected = await pending();
  expect(expected).toEqual([expect.objectContaining({ agent_id: task.agentId, user_id: human.userId, reason: "human_answers", expected_sequence: state.draft!.sequence })]);
  app.close(); app = new EngineeringApplication(join(dir, "application.sqlite"), source, await readFile(new URL("./definitions/development.yaml", import.meta.url), "utf8"));
  expect(await pending()).toEqual(expected);
  await invoke(human, "abandon", { expected_sequence: state.draft!.sequence, reason: "Oracle changed" });
  expect(await pending()).toEqual([]);
});

it("requires a runtime-owned repository binding and rejects an unrelated checkout or agent binding", async () => {
  await configure();
  await expect(app.invoke({ actor: task, action: "start" })).rejects.toThrow(/runtime must bind/);
  await expect(app.invoke({ actor: task, action: "bind", payload: { work_dir: repo, mode: "in_place", overlays: [] } })).rejects.toThrow(/Only the runtime/);
  const unrelated = join(dir, "unrelated"); execFileSync("git", ["clone", "-q", repo, unrelated]);
  await expect(app.invoke({ actor: { ...task, kind: "daemon" }, action: "bind", payload: { work_dir: unrelated, mode: "worktree", overlays: [] } })).rejects.toThrow(/not a worktree/);
  const worktree = join(dir, "worktree"); git("worktree", "add", "-qb", "verification-fixture", worktree);
  await expect(app.invoke({ actor: { ...task, kind: "daemon" }, action: "bind", payload: { work_dir: worktree, mode: "in_place", overlays: [] } })).rejects.toThrow(/registered repository/);
  await app.invoke({ actor: { ...task, kind: "daemon" }, action: "bind", payload: { work_dir: worktree, mode: "worktree", overlays: [] } });
  const started = await app.invoke({ actor: task, action: "start" });
  expect(started).toMatchObject({ repositoryPath: await import("node:fs/promises").then(fs => fs.realpath(worktree)) });
  await expect(app.invoke({ actor: { ...task, kind: "daemon" }, action: "bind", payload: { work_dir: repo, mode: "in_place", overlays: [] } })).rejects.toThrow(/binding changed/);
});

it("lets the runtime refresh generated context without changing the repository identity or original projection", async () => {
  await configure();
  const file = join(repo, "AGENTS.md");
  const bind = async (content: string) => {
    await writeFile(file, content);
    return app.invoke({ actor: { ...task, kind: "daemon" }, action: "bind", payload: { work_dir: repo, mode: "in_place", overlays: [{ path: file, hash: createHash("sha256").update(content).digest("hex") }] } });
  };
  await bind("Runtime initial session");
  await app.invoke({ actor: task, action: "start" });
  await bind("Runtime fresh session after resume rejection");
  expect(await app.invoke({ actor: task, action: "read" })).toMatchObject({ chain: "verification" });
  git("add", "AGENTS.md"); git("commit", "-qm", "Accidentally commit runtime context");
  await expect(bind("Replaced context")).rejects.toThrow(/frozen delivery commit|binding changed/);
});

it("keeps issue completion host-owned and refuses pending, abandoned, or unhanded development", async () => {
  expect(await completion()).toEqual({ configured: false, allowed: true });
  await expect(app.invoke({ actor: task, action: "completion" })).rejects.toThrow(/Only the host/);
  await expect(app.invoke({ actor: host, action: "configure", payload: {} })).rejects.toThrow(/cannot edit/);
  await configure();
  await expect(completion()).rejects.toThrow(/Complete independent verification/);
  const state = await invoke(task, "start");
  await expect(completion()).rejects.toThrow(/Complete independent verification/);
  await invoke(human, "abandon", { expected_sequence: state.draft!.sequence, reason: "Correct scope" });
  await expect(completion()).rejects.toThrow(/Complete independent verification/);
  await invoke(human, "configure", { expected_revision: 1, agent_id: human.userId, developer_agent_id: task.agentId, implementation_guidance: "Implement fixture", repository_path: repo, sources });
  await expect(completion()).rejects.toThrow(/not handed off/);
});

it.each(["passed", "failed"] as const)("authorizes only a current clean passed verification, observed verdict %s", async verdict => {
  await configure();
  let state = await invoke(task, "start");
  const command = async (value: unknown) => { state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: value }); };
  await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "verification.scenarios", key: "s1", content: "channel: frontend\ntitle: Fixture visible\nsetup: Open fixture\nsteps: Reload fixture\nexpected: Title visible\ncoverageRefs: [ac1]" });
  await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "verification.results", key: "s1", content: `status: ${verdict}\nevidence: Fixture observation${verdict === "failed" ? "\nfailureKind: implementation" : ""}` });
  await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "verification.evidence-review", content: "summary: Compared observations to frozen oracle" });
  await command({ type: "phase.complete" });
  await expect(completion()).rejects.toThrow(/Complete independent verification/);
  await command({ type: "phase.complete" });
  if (verdict === "failed") {
    await expect(completion()).rejects.toThrow(/verification failed; return to dev/);
    return;
  }
  expect(await completion()).toMatchObject({ configured: true, allowed: true, binding: state.contract.binding });
  await writeFile(join(repo, "README.md"), "Changed after verification\n");
  await expect(completion()).rejects.toThrow(/uncommitted changes/);
  git("add", "."); git("commit", "-qm", "Change after verification");
  await expect(completion()).rejects.toThrow(/commit changed after verification/);
  await invoke(human, "configure", { expected_revision: 1, agent_id: task.agentId, repository_path: repo, sources });
  await expect(completion()).rejects.toThrow(/Complete independent verification/);
});

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
  await expect(invoke(task, "start")).rejects.toThrow(/frozen delivery commit/);
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

it("hands a committed development result and frozen oracles to a different verification agent", async () => {
  const verifier = { ...task, agentId: human.userId, attemptId: "test:claim1" };
  await invoke(human, "configure", { auto_continue: true, expected_revision: 0, agent_id: verifier.agentId, developer_agent_id: task.agentId,
    implementation_guidance: "Implement the frozen fixture acceptance without changing its oracle", repository_path: repo, sources });
  await expect(invoke(verifier, "start")).rejects.toThrow(/not handed off/);
  expect(await app.invoke({actor:task,action:"selection"})).toMatchObject({configured:true,chain:"development"});
  let state = await invoke(task, "start");
  const command = async (value: unknown) => { state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: value }); };
  await command({ type: "phase.complete" });
  await expect(command({ type: "phase.complete" })).rejects.toThrow(/no implementation claim/);
  await writeFile(join(repo, "implementation.js"), "export const ready = true;\n");
  await command({ type: "acceptance.assess", key: "ac1", evidence: "implementation.js:1" });
  await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "development.code-review", content: "summary: Scope reviewed\nevidence: implementation.js:1" });
  await command({ type: "phase.complete" });
  await expect(command({ type: "check.record", key: "syntax", receipt_id: "invented", summary: "Invented success" })).rejects.toThrow(/not from the current run/);
  const receipt = { id: "command1", sequence: 10, command: "node --check implementation.js", cwd: repo, status: "completed", exit_code: 0 };
  const captured = await app.invoke({ actor: { ...task, kind: "daemon" }, action: "receipt", payload: receipt });
  if (!("captured" in captured)) throw new Error("Expected captured receipt");
  await command({ type: "check.record", key: "syntax", receipt_id: captured.captured, summary: "Syntax checked" });
  await command({ type: "phase.complete" });
  await expect(command({ type: "phase.complete", confirmation: "Done" })).rejects.toThrow(/uncommitted changes/);
  git("add", "."); git("commit", "-qm", "Implement fixture");
  await command({ type: "phase.complete", confirmation: "Scoped commit created" });
  await command({ type: "phase.complete", confirmation: "Evidence and commit match" });
  expect(state.draft?.status).toBe("completed");
  expect(state.conclusion).toMatchObject({ kind: "development", commit: git("rev-parse", "HEAD") });
  const pending = await app.invoke({ actor: { kind: "coordinator" }, action: "continuations" });
  expect(pending).toEqual([expect.objectContaining({ agent_id: verifier.agentId, reason: "development_handoff", expected_sequence: 0 })]);
  const testing = await invoke(verifier, "start");
  expect(await app.invoke({ actor: { kind: "coordinator" }, action: "continuations" })).toEqual([]);
  expect(testing.chain).toBe("verification");
  expect(testing.contract.binding.codeVersion).toBe(git("rev-parse", "HEAD"));
  expect(testing.contract.sources).toEqual(sources);
  expect(testing.draft?.development).toBeUndefined();
  expect(await app.invoke({actor:task,action:"selection"})).toMatchObject({configured:false,chain:"verification"});
  expect(await app.invoke({actor:verifier,action:"selection"})).toMatchObject({configured:true,chain:"verification"});
});

it("rejects a superseded/changed captured check and preserves the original receipt on replay", async () => {
  await invoke(human, "configure", { expected_revision: 0, agent_id: human.userId, developer_agent_id: task.agentId, implementation_guidance: "Implement fixture", repository_path: repo, sources });
  let state = await invoke(task, "start");
  const command = async (value: unknown) => { state = await invoke(task, "command", { expected_sequence: state.draft!.sequence, command: value }); };
  await command({ type: "phase.complete" }); await command({ type: "acceptance.assess", key: "ac1", evidence: "README.md" }); await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "development.code-review", content: "summary: Reviewed\nevidence: README.md" }); await command({ type: "phase.complete" });
  const receipt = { id: "check1", sequence: 1, command: "node --check README.md", cwd: repo, status: "completed", exit_code: 0 };
  const captured = await app.invoke({ actor: { ...task, kind: "daemon" }, action: "receipt", payload: receipt });
  if (!("captured" in captured)) throw new Error("Expected receipt");
  await command({ type: "check.record", key: "syntax", receipt_id: captured.captured, summary: "Fixture check" });
  await app.invoke({ actor: { ...task, kind: "daemon" }, action: "receipt", payload: { ...receipt, id: "check2", sequence: 2, status: "failed", exit_code: 1 } });
  await expect(command({ type: "phase.complete" })).rejects.toThrow(/superseded/);
  await writeFile(join(repo, "README.md"), "Changed after capture\n");
  expect(await app.invoke({ actor: { ...task, kind: "daemon" }, action: "receipt", payload: receipt })).toEqual(captured);
  await expect(command({ type: "phase.complete" })).rejects.toThrow(/Code changed after review/);
  await command({ type: "phase.rewind", to: "review", reason: "Review the changed implementation" });
  await command({ type: "phase.complete" });
  await command({ type: "check.record", key: "syntax", receipt_id: captured.captured, summary: "Old observation" });
  await expect(command({ type: "phase.complete" })).rejects.toThrow(/earlier repository snapshot/);
  await command({ type: "phase.rewind", to: "implement", reason: "Correct implementation" });
  expect(state.draft?.development?.checks).toEqual([]);
  expect(state.draft?.artifacts.some(item => item.ref === "development.code-review")).toBe(false);
});
