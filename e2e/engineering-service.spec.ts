import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TestApiClient } from "./fixtures";

test("the native CLI executes a host-owned verification contract and resumes after a human API answer", async () => {
  test.skip(process.env.MULTICA_ENGINEERING_ENABLED !== "true" || !process.env.MULTICA_ENGINEERING_CLI, "Requires the managed engineering service and a test-built CLI");
  const api = new TestApiClient();
  await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(value => value.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const dir = await mkdtemp(join(tmpdir(), "engineering-service-"));
  const repository = join(dir, "repository");
  execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Engineering test"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "README.md"), "Fixture repository\n");
  git("add", "."); git("commit", "-qm", "Initialize fixture");
  try {
    const run = await api.seedEngineeringRun();
    const configured = await api.engineeringVerification(run.issueId, "configure", {
      expected_revision: 0, agent_id: run.agentId, repository_path: repository,
      sources: [{ key: "ac1", kind: "acceptance", description: "Fixture survives reload", oracle: "Title remains visible", sourceRef: "FIXTURE:ac1:r1" }],
    });
    expect(configured.contract.binding.codeVersion).toBe(git("rev-parse", "HEAD"));
    await api.bindEngineeringRepository(run.taskId, repository);
    let token = run.taskToken;
    const cli = (name: string, payload?: unknown) => JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!), ["engineering", name, ...(payload ? ["--payload", JSON.stringify(payload)] : [])], {
      encoding: "utf8", cwd: dir, timeout: 20000,
      env: { ...process.env, MULTICA_SERVER_URL: run.apiBase, MULTICA_WORKSPACE_ID: workspace.id, MULTICA_TOKEN: token, MULTICA_TASK_ID: run.taskId, MULTICA_AGENT_ID: run.agentId },
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let state = cli("start");
    const edit = (command: unknown) => { state = cli("command", { expected_sequence: state.draft.sequence, command }); };
    expect(cli("start").draft.id).toBe(state.draft.id);
    edit({ type: "phase.complete" });
    edit({ type: "runtime-input.put", key: "fixture", title: "Fixture entry", question: "Which fixture?", why: "Need isolated data", recommendation: "Use local fixture" });
    edit({ type: "phase.complete" });
    expect(state.draft.status).toBe("waiting_for_answers");
    const rejection = await fetch(`${run.apiBase}/api/issues/${run.issueId}/engineering/verification/answers`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expected_sequence: state.draft.sequence, request_id: state.draft.runtimeInputs[0].id, answer: "Agent self-answer" }),
    });
    expect(rejection.status).toBe(403);
    await api.engineeringVerification(run.issueId, "answer", { expected_sequence: state.draft.sequence, request_id: state.draft.runtimeInputs[0].id, answer: "Use the isolated fixture" });
    token = await api.reclaimEngineeringRun(run.taskId);
    await api.bindEngineeringRepository(run.taskId, repository);
    state = cli("start");
    expect(state.draft.phase).toBe("plan");
    expect(state.draft.runtimeInputs[0].answer.userId).toBe(run.userId);
    edit({ type: "artifact.put", ref: "verification.scenarios", key: "s1", content: "channel: frontend\ntitle: Fixture\nsetup: Ready\nsteps: Observe\nexpected: Title visible\ncoverageRefs: [ac1]" });
    edit({ type: "phase.complete" });
    edit({ type: "artifact.put", ref: "verification.results", key: "s1", content: "status: passed\nevidence: Fixture observation" });
    edit({ type: "phase.complete" });
    edit({ type: "artifact.put", ref: "verification.evidence-review", content: "summary: Fixture observation is consistent" });
    edit({ type: "phase.complete" }); edit({ type: "phase.complete" });
    expect(state.conclusion.verdict).toBe("passed");
    expect((await api.engineeringVerification(run.issueId, "inspect")).draft.id).toBe(state.draft.id);
    await writeFile(join(repository, "README.md"), "Changed after verification\n");
    expect(() => cli("status")).toThrow();
  } finally {
    await api.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
