// @vitest-environment node
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineeringApplication, type ApplicationRequest } from "./application";

const human = { kind: "human" as const, userId: "019a0000-0000-7000-8000-000000000001", workspaceId: "019a0000-0000-7000-8000-000000000002", issueId: "019a0000-0000-7000-8000-000000000003" };
const developer = "019a0000-0000-7000-8000-000000000004", verifier = "019a0000-0000-7000-8000-000000000005";
const sources = [{ key: "ac1", kind: "acceptance", description: "Ready heading", oracle: "Heading is exactly Ready", sourceRef: "FIXTURE:heading:r1" }];
let mode: "in_place" | "worktree";
let directory: string, repository: string, database: string, app: EngineeringApplication, verificationSource: string, developmentSource: string;
function git(...args: string[]) { return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function reopen() { app = new EngineeringApplication(database, verificationSource, developmentSource); }
beforeEach(async () => {
  mode = "in_place";
  directory = await mkdtemp(join(tmpdir(), "engineering-rework-")); repository = join(directory, "repo"); database = join(directory, "engineering.sqlite");
  execFileSync("git", ["init", "-q", repository]); git("config", "user.name", "Rework fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "index.html"), "<h1>Initial</h1>"); git("add", "."); git("commit", "-qm", "Initialize fixture");
  verificationSource = await readFile(new URL("./definitions/verification.yaml", import.meta.url), "utf8");
  developmentSource = await readFile(new URL("./definitions/development.yaml", import.meta.url), "utf8"); reopen();
});
afterEach(async () => { app.close(); await rm(directory, { recursive: true, force: true }); });
const actor = (agentId: string, round: number) => ({ kind: "task" as const, workspaceId: human.workspaceId, issueId: human.issueId, agentId, attemptId: `${agentId}:${round}` });
async function invoke(owner: ApplicationRequest["actor"], action: ApplicationRequest["action"], payload?: unknown) {
  const state = await app.invoke({ actor: owner, action, payload }); if (!("draft" in state)) throw new Error("Expected chain state"); return state;
}
function configure(max = 3) { return invoke(human, "configure", { expected_revision: 0, agent_id: verifier, developer_agent_id: developer, implementation_guidance: "Implement frozen heading", repository_path: repository, sources, auto_continue: true, max_reworks: max }); }
const pending = () => app.invoke({ actor: { kind: "coordinator" }, action: "continuations" });
async function start(agentId: string, round: number) {
  const owner = actor(agentId, round);
  await app.invoke({ actor: { ...owner, kind: "daemon" }, action: "bind", payload: { work_dir: repository, mode, overlays: [] } });
  return { owner, state: await invoke(owner, "start") };
}
async function develop(round: number, change = true, emptyCommit = false) {
  const { owner, state: initial } = await start(developer, round); let state = initial;
  expect(state.draft?.development?.claims ?? []).toEqual([]); expect(state.draft?.development?.checks ?? []).toEqual([]);
  expect(state.draft?.artifacts.some(item => item.ref === "development.code-review")).toBe(false);
  const command = async (command: unknown) => { state = await invoke(owner, "command", { expected_sequence: state.draft!.sequence, command }); };
  await command({ type: "phase.complete" });
  if (change) await writeFile(join(repository, "index.html"), `<h1>Attempt ${round}</h1>`);
  await command({ type: "acceptance.assess", key: "ac1", evidence: "index.html:1" });
  for (const recovery of state.contract.sources.filter(source => source.kind === "recovery")) await command({ type: "artifact.put", ref: "development.recovery-resolutions", key: recovery.key, content: "summary: Repair the failed scenario\nevidence: index.html:1" });
  await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "development.code-review", content: "summary: Fresh review\nevidence: index.html:1" }); await command({ type: "phase.complete" });
  const receipt = await app.invoke({ actor: { ...owner, kind: "daemon" }, action: "receipt", payload: { id: "check", sequence: 1, command: "fixture-check", cwd: repository, status: "completed", exit_code: 0 } });
  if (!("captured" in receipt)) throw new Error("Expected receipt");
  await command({ type: "check.record", key: "fixture", receipt_id: receipt.captured, summary: "Current fixture check" }); await command({ type: "phase.complete" });
  if (change) { git("add", "."); git("commit", "-qm", `Implement attempt ${round}`); }
  if (emptyCommit) git("commit", "--allow-empty", "-qm", "Metadata-only retry");
  await command({ type: "phase.complete", confirmation: "Commit checked" }); await command({ type: "phase.complete", confirmation: "Evidence checked" });
  return state;
}
async function verify(round: number, verdict: "passed" | "failed", failureKind = "implementation") {
  const { owner, state: initial } = await start(verifier, round); let state = initial;
  const command = async (command: unknown) => { state = await invoke(owner, "command", { expected_sequence: state.draft!.sequence, command }); };
  if (round === 0) {
    await command({ type: "phase.complete" });
    await command({ type: "artifact.put", ref: "verification.scenarios", key: "s1", content: "channel: frontend\ntitle: Heading\nsetup: Open fixture\nsteps: Observe heading\nexpected: Ready\ncoverageRefs: [ac1]" }); await command({ type: "phase.complete" });
  } else {
    expect(state.draft?.phase).toBe("execute");
    await expect(command({type:"phase.rewind",to:"plan",reason:"Weaken the failed plan"})).rejects.toThrow(/new human contract/);
    expect(state.draft?.artifacts.filter(item => ["verification.results", "verification.evidence-review"].includes(item.ref))).toEqual([]);
    await expect(command({ type: "artifact.put", ref: "verification.scenarios", key: "s1", content: "changed oracle" })).rejects.toThrow(/frozen/);
    expect(state.contract.sources).toEqual(sources);
  }
  await command({ type: "artifact.put", ref: "verification.results", key: "s1", content: `status: ${verdict}\nevidence: Independent fixture observation\nactualBehavior: Heading mismatch${verdict === "failed" ? `\nfailureKind: ${failureKind}` : ""}` }); await command({ type: "phase.complete" });
  await command({ type: "artifact.put", ref: "verification.evidence-review", content: "summary: Compared actual observation and frozen oracle" }); await command({ type: "phase.complete" }); await command({ type: "phase.complete" });
  return state;
}

it("creates a fresh development generation and rechecks every frozen scenario without inheriting pass evidence", async () => {
  await configure(); await develop(0); const failed = await verify(0, "failed");
  expect(failed.conclusion).toMatchObject({ verdict: "failed" });
  expect(await pending()).toEqual([expect.objectContaining({ expected_revision: 2, agent_id: developer, reason: "verification_rework" })]);
  await expect(app.invoke({ actor: actor(verifier, 0), action: "start" })).rejects.toThrow(/not handed off/);
  await expect(app.invoke({ actor: { kind: "host", workspaceId: human.workspaceId, issueId: human.issueId }, action: "completion" })).rejects.toThrow(/not handed off/);
  app.close(); reopen();
  const overview = await app.invoke({ actor: human, action: "overview" });
  expect(overview).toMatchObject({ revision: 2, chain: "development", rework: { round: 1, limit: 3, history: [{ draft_id: failed.draft!.id, conclusion: { verdict: "failed" } }] } });
  const dev = await develop(1); expect(dev.contract.sources.some(source => source.kind === "recovery" && source.sourceRef.includes(failed.draft!.id))).toBe(true);
  const passed = await verify(1, "passed"); expect(passed.conclusion).toMatchObject({ verdict: "passed" });
  expect(await pending()).toEqual([]);
  expect(await app.invoke({ actor: { kind: "host", workspaceId: human.workspaceId, issueId: human.issueId }, action: "completion" })).toMatchObject({ allowed: true });
  expect(passed.rework.history[0]!.conclusion).toMatchObject({ verdict: "failed" });
});

it("stops repeated unchanged failure even when an empty commit changes the commit ID", async () => {
  await configure(); await develop(0); await verify(0, "failed"); const oldCommit = git("rev-parse", "HEAD");
  await develop(1, false, true); expect(git("rev-parse", "HEAD")).not.toBe(oldCommit);
  const failure = await verify(1, "failed"); expect(failure.rework).toMatchObject({ round: 1, stop_reason: "stagnant" }); expect(await pending()).toEqual([]);
});

it("stops at the authorized rework cap despite new code", async () => {
  await configure(1); await develop(0); await verify(0, "failed"); await develop(1); const exhausted = await verify(1, "failed");
  expect(exhausted.rework.stop_reason).toBe("budget"); expect(await pending()).toEqual([]);
});

it("keeps specification failures out of automatic development", async () => {
  await configure(); await develop(0); const failed = await verify(0, "failed", "specification");
  expect(failed.rework.stop_reason).toBe("analysis"); expect(failed.rework.round).toBe(0); expect(await pending()).toEqual([]);
});

it("settles a persisted terminal draft after a crash before the host transition was recorded", async () => {
  await configure(); await develop(0); const failed = await verify(0, "failed"); app.close();
  const db = new DatabaseSync(database);
  const row = db.prepare("SELECT payload FROM engineering_contract WHERE revision=1").get()!; const prior = JSON.parse(String(row.payload)); delete prior.failure;
  db.prepare("DELETE FROM engineering_contract WHERE revision=2").run(); db.prepare("UPDATE engineering_contract SET payload=? WHERE revision=1").run(JSON.stringify(prior)); db.close(); reopen();
  expect(await pending()).toEqual([expect.objectContaining({ expected_revision: 2, reason: "verification_rework" })]);
  expect(await app.invoke({ actor: human, action: "overview" })).toMatchObject({ rework: { history: [{ draft_id: failed.draft!.id }] } });
});

it.each([-1, 11, 1.5])("rejects an invalid rework budget %s", async limit => { await expect(configure(limit)).rejects.toThrow(); });
it("requires explicit continuation and a developer before authorizing rework", async () => {
  await expect(invoke(human, "configure", { expected_revision: 0, agent_id: verifier, repository_path: repository, sources, max_reworks: 1 })).rejects.toThrow(/requires automatic continuation/);
});

it("selects the failed delivery commit for worktree rework while the registered checkout stays at its original head", async () => {
  await configure(1); const registered = repository, original = git("rev-parse", "HEAD"), worktree = join(directory,"delivery");
  git("worktree","add","-qb","rework-delivery",worktree); repository=worktree; mode="worktree";
  await develop(0); const failedCommit=git("rev-parse","HEAD"); await verify(0,"failed");
  expect(execFileSync("git",["-C",registered,"rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(original);
  expect(await app.invoke({actor:actor(developer,1),action:"selection"})).toMatchObject({configured:true,chain:"development",code_version:failedCommit});
});

it("does not settle legacy manual failures during background continuation after their checkout is gone", async () => {
  await configure(0); await develop(0); await verify(0,"failed"); app.close();
  const db=new DatabaseSync(database); const row=db.prepare("SELECT payload FROM engineering_contract WHERE revision=1").get()!;
  const prior=JSON.parse(String(row.payload));delete prior.failure;db.prepare("UPDATE engineering_contract SET payload=? WHERE revision=1").run(JSON.stringify(prior));db.close();
  await rm(repository,{recursive:true,force:true});reopen();expect(await pending()).toEqual([]);
});
