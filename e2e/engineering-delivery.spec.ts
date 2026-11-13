import { test, expect, chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TestApiClient } from "./fixtures";

test("a development commit is handed to independent browser verification with captured checks", async ({}, testInfo) => {
  test.skip(!process.env.MULTICA_ENGINEERING_BROWSER || !process.env.MULTICA_ENGINEERING_CLI || process.env.MULTICA_ENGINEERING_ENABLED !== "true", "Requires the local engineering service, test-built CLI, and explicit browser binary");
  const api = new TestApiClient(); await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(value => value.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const directory = await mkdtemp(join(tmpdir(), "engineering-delivery-"));
  const repository = join(directory, "repository");
  execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Delivery fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "index.html"), "<!doctype html><h1>Not ready</h1>");
  git("add", "."); git("commit", "-qm", "Initialize fixture");
  try {
    const dev = await api.seedEngineeringRun(); const verifier = await api.seedEngineeringRun(dev.issueId);
    await api.engineeringVerification(dev.issueId, "configure", {
      expected_revision: 0, agent_id: verifier.agentId, developer_agent_id: dev.agentId, repository_path: repository,
      implementation_guidance: "Show the required Ready heading in the page. Keep the acceptance oracle unchanged.",
      sources: [{ key: "ac1", kind: "acceptance", description: "The page displays Ready", oracle: "A browser sees an h1 with exact text Ready", sourceRef: "FIXTURE:heading:r1" }],
    });
    let owner = dev;
    const cli = (name: string, payload?: unknown) => JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!), ["engineering", name, ...(payload ? ["--payload", JSON.stringify(payload)] : [])], {
      cwd: directory, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MULTICA_SERVER_URL: owner.apiBase, MULTICA_TOKEN: owner.taskToken, MULTICA_WORKSPACE_ID: workspace.id, MULTICA_TASK_ID: owner.taskId, MULTICA_AGENT_ID: owner.agentId },
    }));
    let state = cli("start");
    const command = (value: unknown) => { state = cli("command", { expected_sequence: state.draft.sequence, command: value }); };
    expect(state.chain).toBe("development");
    await expect(api.updateIssue(dev.issueId, { status: "done", suppress_run: true })).rejects.toThrow(/409.*not handed off/);
    command({ type: "phase.complete" });
    await writeFile(join(repository, "index.html"), "<!doctype html><h1>Ready</h1>");
    command({ type: "acceptance.assess", key: "ac1", evidence: "index.html:1 implements the heading" });
    command({ type: "phase.complete" });
    command({ type: "artifact.put", ref: "development.code-review", content: "summary: Minimal heading implementation reviewed\nevidence: index.html:1" });
    command({ type: "phase.complete" });
    const script = "const fs=require('node:fs');if(!fs.readFileSync('index.html','utf8').includes('<h1>Ready</h1>'))process.exit(1)";
    const check = spawnSync(process.execPath, ["-e", script], { cwd: repository, encoding: "utf8" });
    expect(check.status).toBe(0);
    const receipt = await api.captureEngineeringReceipt(dev.taskId, { id: "heading-check", sequence: 1, result: {
      command: `node -e ${JSON.stringify(script)}`, cwd: repository, status: check.status === 0 ? "completed" : "failed", exit_code: check.status,
    } });
    command({ type: "check.record", key: "heading", receipt_id: receipt.captured, summary: "Real fixture content assertion exited successfully" });
    command({ type: "phase.complete" });
    git("add", "index.html"); git("commit", "-qm", "Implement Ready heading");
    const commit = git("rev-parse", "HEAD");
    command({ type: "phase.complete", confirmation: "Scoped commit created" });
    command({ type: "phase.complete", confirmation: "Implementation, review, checks, and commit align" });
    expect(state.conclusion.commit).toBe(commit);
    await expect(api.updateIssue(dev.issueId, { status: "done", suppress_run: true })).rejects.toThrow(/409.*Complete independent verification/);
    owner = verifier; state = cli("start");
    expect(state.chain).toBe("verification"); expect(state.contract.binding.codeVersion).toBe(commit);
    command({ type: "phase.complete" });
    command({ type: "artifact.put", ref: "verification.scenarios", key: "s1", content: "channel: frontend\ntitle: Heading visible\nsetup: Open the committed fixture page\nsteps: Observe the h1 in a browser\nexpected: Exact text Ready\ncoverageRefs: [ac1]" });
    command({ type: "phase.complete" });
    const browser = await chromium.launch({ executablePath: process.env.MULTICA_ENGINEERING_BROWSER });
    try {
      const page = await browser.newPage(); await page.goto(pathToFileURL(join(repository, "index.html")).href);
      await expect(page.getByRole("heading", { name: "Ready", exact: true })).toBeVisible();
      const screenshot = testInfo.outputPath("independent-verification.png"); await page.screenshot({ path: screenshot });
      await testInfo.attach("Independent browser observation", { path: screenshot, contentType: "image/png" });
      command({ type: "artifact.put", ref: "verification.results", key: "s1", content: `status: passed\nevidence: ${screenshot}\nactualBehavior: Browser h1 has exact text Ready` });
    } finally { await browser.close(); }
    command({ type: "phase.complete" });
    command({ type: "artifact.put", ref: "verification.evidence-review", content: "summary: Browser evidence matches the frozen oracle and committed source" });
    command({ type: "phase.complete" }); command({ type: "phase.complete" });
    expect(state.conclusion.verdict).toBe("passed"); expect(state.conclusion.binding.codeVersion).toBe(commit);
    expect((await api.updateIssue(dev.issueId, { status: "done", suppress_run: true })).status).toBe("done");
    await writeFile(join(repository, "index.html"), "<!doctype html><h1>Changed after verification</h1>");
    await expect(api.updateIssue(dev.issueId, { status: "done", suppress_run: true })).rejects.toThrow(/409.*uncommitted changes/);
  } finally { await api.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
