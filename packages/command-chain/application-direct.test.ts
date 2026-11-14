// @vitest-environment node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EngineeringApplication, type ApplicationRequest } from "./application";
import { directResult } from "./direct";

const human = { kind: "human" as const, workspaceId: randomUUID(), issueId: randomUUID(), userId: randomUUID() };
const projectId = randomUUID(), agentId = randomUUID();
const host = { kind: "host" as const, workspaceId: human.workspaceId, issueId: human.issueId };
const task = () => ({ kind: "task" as const, workspaceId: human.workspaceId, issueId: human.issueId, projectId, agentId, attemptId: `${randomUUID()}:123456` });
let directory: string, repository: string, database: string, app: EngineeringApplication, definition: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
const open = () => new EngineeringApplication(database, definition);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "multica-direct-")); repository = join(directory, "repository"); database = join(directory, "state.sqlite");
  execFileSync("git", ["init", "-q", repository]); git("config", "user.name", "Direct fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "README.md"), "Original input\n"); git("add", "."); git("commit", "-qm", "Fixture");
  definition = await readFile(new URL("./definitions/verification.yaml", import.meta.url), "utf8"); app = open();
});
afterEach(async () => { app.close(); await rm(directory, { recursive: true, force: true }); });
const invoke = (actor: ApplicationRequest["actor"], action: ApplicationRequest["action"], payload?: unknown) => app.invoke({ actor, action, payload });
const configure = (mode: "in_place" | "worktree" = "in_place") => invoke(human, "configure-direct", { expected_revision: 0, agent_id: agentId, project_id: projectId, repository_path: repository,
  input: "Read existing notes and write a summary without changing their meaning", execution_resources: [{ path: repository, mode }] });
const bind = (owner = task(), mode: "in_place" | "worktree" = "in_place", workDir = repository) => invoke({ ...owner, kind: "daemon" }, "bind", { work_dir: workDir, mode, overlays: [] });

it("requires RUN before SUBMIT, saves one immutable result and closes without inventing an independent verification", async () => {
  await configure(); const owner = task();
  expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([expect.objectContaining({ reason: "direct_ready", agent_id: agentId })]);
  await expect(invoke(owner, "direct-run")).rejects.toThrow(/Bind/); await bind(owner);
  await expect(invoke(owner, "direct-submit", { summary: "Premature" })).rejects.toThrow(/RUN before SUBMIT/);
  await expect(invoke(host, "completion")).rejects.toThrow(/explicit submitted result/);
  expect(await invoke(owner, "direct-run")).toMatchObject({ chain: "direct", status: "editing", direct: { attempts: [{ active: true, run_at: expect.any(String) }] } });
  expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([]);
  await writeFile(join(repository, "summary.md"), "# Reader notes\n\nRetained the original meaning.\n");
  expect(await invoke(owner, "direct-submit", { summary: "  Reader summary ready  ", result: "# Reader summary\n\nOriginal meaning retained." })).toMatchObject({ status: "completed", direct: { result: { summary: "Reader summary ready", content: "# Reader summary\n\nOriginal meaning retained." } } });
  const first = await invoke(human, "overview"); app.close(); app = open();
  expect(await invoke(owner, "direct-submit", { summary: "Do not replace this receipt", result: "Different content" })).toEqual(first);
  expect(await invoke(host, "completion")).toMatchObject({ configured: true, allowed: true, direct_scope: { agent_id: agentId, attempt_id: owner.attemptId, result_hash: expect.any(String) } });
  await expect(invoke(host, "verified-binding")).rejects.toThrow(/not independent/);
  const pending = await invoke({ kind: "coordinator" }, "continuations"); expect(pending).toEqual([expect.objectContaining({ reason: "direct_submitted" })]);
  const scope = await invoke(host, "direct-scope") as unknown as { direct_scope: { result_hash: string } };
  await invoke(host, "direct-completed", { result_hash: scope.direct_scope.result_hash });
  expect(await invoke({ kind: "coordinator" }, "continuations")).toEqual([]);
  expect(git("status", "--porcelain")).toContain("summary.md");
});

it("fences old native attempts after interruption and requires the new attempt's own RUN", async () => {
  await configure(); const old = task(), current = task(); await bind(old); await invoke(old, "direct-run");
  await bind(current); await expect(invoke(old, "direct-submit", { summary: "Stale result" })).rejects.toThrow(/current Direct attempt/);
  await expect(bind(old)).rejects.toThrow(/revived/); await expect(invoke(current, "direct-submit", { summary: "No RUN" })).rejects.toThrow(/RUN before SUBMIT/);
  await invoke(current, "direct-run"); await invoke(current, "direct-submit", { summary: "Recovered work" });
  expect(await invoke(human, "overview")).toMatchObject({ direct: { attempts: [{ active: false }, { active: true }], result: { content: "Recovered work" } } });
});

it.each(["in_place", "worktree"] as const)("binds %s scope while allowing actual Direct file changes and commits", async mode => {
  await writeFile(join(repository, "initial-dirty.md"), "Existing user work\n"); await configure(mode);
  const path = mode === "worktree" ? join(directory, "worktree") : repository;
  if (mode === "worktree") git("worktree", "add", "-b", "direct-fixture", path, "HEAD");
  const owner = task(); await bind(owner, mode, path); await invoke(owner, "direct-run");
  await writeFile(join(path, "direct-output.md"), "Actual Direct output\n");
  execFileSync("git", ["-C", path, "add", "direct-output.md"]); execFileSync("git", ["-C", path, "commit", "-qm", "Direct output"]);
  await invoke(owner, "direct-submit", { summary: "Direct output recorded" }); expect(await invoke(host, "completion")).toMatchObject({ allowed: true });
});

it("rejects machine configuration, changed projects/agents, competing workflows and invented YAML/question operations", async () => {
  await expect(invoke(task(), "configure-direct", {})).rejects.toThrow(/Only a human/); await configure(); const owner = task();
  await expect(bind({ ...owner, projectId: randomUUID() })).rejects.toThrow(/project changed/);
  await expect(bind({ ...owner, agentId: randomUUID() })).rejects.toThrow(/agent or original project/);
  expect(await invoke({ ...owner, projectId: undefined }, "selection")).toMatchObject({ configured: true, direct_project_id: projectId });
  await bind(owner); for (const action of ["start", "command", "answer"] as const) await expect(invoke(owner, action, {})).rejects.toThrow(/Direct supports/);
  await expect(invoke(human, "configure", {})).rejects.toThrow(/frozen/); await expect(configure()).rejects.toThrow(/already owns/);
  await expect(invoke(human, "direct-submit", { summary: "Human shortcut" })).rejects.toThrow(/native task credential/);
  await invoke(owner, "direct-run"); await invoke(owner, "direct-submit", { summary: "Finished actual work" });
  const db = new DatabaseSync(database), row = db.prepare("SELECT payload FROM direct_contract").get()!, record = JSON.parse(String(row.payload));
  record.result.content = "Altered after submit"; db.prepare("UPDATE direct_contract SET payload=?").run(JSON.stringify(record)); db.close();
  await expect(invoke(host, "completion")).rejects.toThrow(/result changed/);
});

it("retains the source text limits and summary fallback", () => {
  expect(directResult({ summary: "  Ready  ", result: "   " })).toEqual({ summary: "Ready", content: "Ready" });
  expect(directResult({ summary: "😀".repeat(2000), result: "x".repeat(100000) }).content).toHaveLength(100000);
  expect(() => directResult({ summary: "😀".repeat(2001) })).toThrow(); expect(() => directResult({ summary: "Ready", result: "x".repeat(100001) })).toThrow();
});

it("executes Direct in a plain local directory without fabricating a Git commit",async()=>{
 await rm(join(repository,".git"),{recursive:true,force:true});await configure();const owner=task();
 expect(await invoke({...owner,projectId:undefined},"selection")).toMatchObject({configured:true,code_version:"",chain:"direct"});
 await bind(owner);await invoke(owner,"direct-run");await writeFile(join(repository,"plain-summary.md"),"Actual summary in a non-Git folder\n");await invoke(owner,"direct-submit",{summary:"Plain directory summary ready"});expect(await invoke(host,"completion")).toMatchObject({allowed:true});
});
