import { test, expect, chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { TestApiClient } from "./fixtures";
// Native queue claims and role conclusions are controlled; the API, Git,
// browser observations, publication, independent verification and Done are real.
for (const mode of ["in_place", "worktree"] as const) test(`Bug Fix Team ${mode} advances a native task from human reproduction facts through verified repair and report reading`, async ({ baseURL }, testInfo) => {
  test.setTimeout(600000);
  test.skip(process.env.MULTICA_ENGINEERING_ENABLED !== "true" || !process.env.MULTICA_ENGINEERING_CLI || !process.env.MULTICA_ENGINEERING_BROWSER, "Requires managed engineering, a test-built CLI and an explicit browser");
  const api = new TestApiClient();
  await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(item => item.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id);
  api.setWorkspaceSlug(workspace.slug);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "team-bug-fix-"))), registeredRepository = join(directory, "repository");
  let repository = registeredRepository;
  execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Bug Fix Team fixture");
  git("config", "user.email", "fixture@example.invalid");
  const broken = "<!doctype html><button onclick=\"if(location.hash!=='#saved')document.querySelector('output').textContent='Continued'\">Continue</button><output></output>";
  const fixed = "<!doctype html><button onclick=\"document.querySelector('output').textContent='Continued'\">Continue</button><output></output>";
  await writeFile(join(repository, "index.html"), broken);
  git("add", ".");
  git("commit", "-qm", "Initialize saved-state regression");
  const originalCommit = git("rev-parse", "HEAD");
  const registeredGit = (...args: string[]) => execFileSync("git", ["-C", registeredRepository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const browser = await chromium.launch({ executablePath: process.env.MULTICA_ENGINEERING_BROWSER });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => localStorage.setItem("multica:chat:isOpen", "false"));
  try {
    const seed = await api.seedEngineeringRun(), runs = [seed];
    for (let i = 0; i < 6; i++)
      runs.push(await api.seedEngineeringRun(seed.issueId));
    const [backlog, reproducer, planner, analyst, developer, verifier, reviewer] = runs as [
      typeof seed,
      typeof seed,
      typeof seed,
      typeof seed,
      typeof seed,
      typeof seed,
      typeof seed
    ];
    const project = await api.createProject(`Bug Fix Team ${seed.issueId}`), team = await api.createWorkflowTeamFixture(backlog.agentId);
    for (const run of runs) {
      await api.finishEngineeringRun(run.taskId);
      await api.attachEngineeringProject(run.taskId, project.id, registeredRepository, mode);
      if (run.agentId !== backlog.agentId)
        await api.addWorkflowTeamAgentFixture(team.id, run.agentId);
    }
    await api.configureWorkflowTeamDefinitionFixture(team.id, { workflow: "bug_fix", roles: { context: backlog.agentId, reproducer: reproducer.agentId, planner: planner.agentId, analyst: analyst.agentId, developer: developer.agentId, verifier: verifier.agentId, reviewer: reviewer.agentId }, decision_mode: "balanced", max_reworks: 1 });
    const page = await context.newPage();
    await page.goto(`${baseURL}/`);
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues`));
    await page.getByRole("button", { name: "New Issue", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task goal", { exact: true }).fill("Restore Continue in the saved reader state");
    for (const [label, name] of [["Project", project.title], ["Team", team.name]]) {
      await dialog.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
    }
    await expect(dialog.getByRole("combobox")).toHaveCount(2);
    const created = page.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Create and start", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const issue = await response.json();
    await api.trackWorkflowTeamIssueFixture(team.id, project.id, issue.id);
    await expect(dialog).toHaveCount(0);
    const panel = page.getByRole("region", { name: "Engineering delivery" });
    await expect(panel.getByRole("button", { name: /Configure delivery|Plan requirement|Start deliveries/ })).toHaveCount(0);
    let owner: Awaited<ReturnType<TestApiClient["claimEngineeringRun"]>> = seed, state: any;
    const cli = (name: string, payload?: unknown) => JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!), ["engineering", name, ...(payload ? ["--payload", JSON.stringify(payload)] : [])], { cwd: directory, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MULTICA_SERVER_URL: owner.apiBase, MULTICA_WORKSPACE_ID: workspace.id, MULTICA_TOKEN: owner.taskToken, MULTICA_TASK_ID: owner.taskId, MULTICA_AGENT_ID: owner.agentId } }));
    const next = async (issueId: string, agentId: string) => { try {
      await expect.poll(() => api.queuedEngineeringRun(issueId, agentId), { timeout: 70000 }).not.toBeNull();
    }
    catch (error) {
      const checkpoint = await api.engineeringOverview(issueId);
      console.info("Native queue checkpoint", JSON.stringify({ requestedAgent: agentId, runs: await api.engineeringRunStates(issueId), chain: checkpoint.chain, status: checkpoint.status, active: checkpoint.has_active_run, review: checkpoint.requirement?.review?.agent_id }));
      throw error;
    } const id = (await api.queuedEngineeringRun(issueId, agentId))!; return api.claimEngineeringRun(id); };
    const begin = async (issueId: string, agentId: string, commit = originalCommit) => { console.info("Bug Fix Team awaiting native role", Object.entries({ context: backlog.agentId, reproducer: reproducer.agentId, planner: planner.agentId, analyst: analyst.agentId, developer: developer.agentId, verifier: verifier.agentId, reviewer: reviewer.agentId }).find(([, id]) => id === agentId)?.[0]); owner = await next(issueId, agentId);
      if (mode === "worktree") {
        repository = join(directory, owner.taskId);
        registeredGit("worktree", "add", "-qb", `team-${owner.taskId}`, repository, commit);
      }
      await api.bindEngineeringRepository(owner.taskId, repository, mode);
      state = cli("start");
      expect(state.contract.binding.codeVersion).toBe(commit);
    };
    const command = (command: unknown) => state = cli("command", { expected_sequence: state.draft.sequence, command });
    const put = (ref: string, value: unknown, key?: string) => command({ type: "artifact.put", ref, content: typeof value === "string" ? value : JSON.stringify(value), ...(key ? { key } : {}) });
    const finish = async () => {
      await api.finishEngineeringRun(owner.taskId);
      if (mode === "worktree") {
        expect(git("status", "--porcelain")).toBe("");
        registeredGit("worktree", "remove", repository);
        repository = registeredRepository;
        expect(registeredGit("rev-parse", "HEAD")).toBe(originalCommit);
      }
    };
    const expected = "Continue activation displays Continued";
    const observe = async (saved: boolean, result: string, screenshot?: string) => { const view = await context.newPage(); try {
      await view.goto(pathToFileURL(join(repository, "index.html")).href + (saved ? "#saved" : ""));
      await view.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(view.locator("output")).toHaveText(result);
      if (screenshot)
        await view.screenshot({ path: testInfo.outputPath(screenshot) });
      return (await view.locator("output").textContent())!;
    }
    finally {
      await view.close();
    } };
    await begin(issue.id, backlog.agentId);
    expect(state.chain).toBe("context");
    put("requirement-context.intent", "Restore the existing Continue behavior");
    put("requirement-context.assertions", { perspective: "actual", statement: "Continue sometimes produces no output", evidence: "reported", source: "Original bug report" }, "actual");
    put("requirement-context.assertions", { perspective: "expected", statement: expected, evidence: "reported", source: "Existing reader contract" }, "expected");
    for (let i = 0; i < 3; i++)
      command({ type: "phase.complete" });
    put("requirement-context.answer-review", "Expected is fixed; affected conditions require reproduction");
    command({ type: "phase.complete" });
    put("requirement-context.assertions", { perspective: "target", statement: expected, evidence: "decided", source: "Existing reader contract" }, "target");
    command({ type: "phase.complete" });
    put("requirement-context.change-summary", "Restore Continue under its existing conditions");
    put("requirement-context.impacts", { statement: expected, disposition: "change", rationale: "Reported mismatch", source: "Original report" }, "continue");
    command({ type: "phase.complete" });
    put("requirement-context.scope", { direction: "included", content: "Existing Continue behavior" }, "continue");
    command({ type: "phase.complete" });
    command({ type: "acceptance.put", acceptance: { key: "continue", statement: expected, oracle: expected, source: "Existing reader contract" } });
    command({ type: "phase.complete" });
    command({ type: "phase.complete" });
    await finish();
    console.info("Bug Fix Team: native context handed off");
    await begin(issue.id, reproducer.agentId);
    expect(state.chain).toBe("reproduction");
    expect(state.contract.expectedBehavior).toBe(expected);
    const reproductionDraft = state.draft.id;
    const record = (reproduced: boolean, actual: string) => { put("reproduction.verdict", { status: reproduced ? "reproduced" : "not_reproduced", expectedBehavior: expected, actualBehavior: actual || "Empty output after Continue", environment: reproduced ? "Saved state #saved" : "Fresh state", stability: "Explicit Chromium activation", impactScope: "Continue control" }); put("reproduction.steps", { action: "Activate Continue", expected: "Continued", actual: actual || "Empty output" }, "activate"); put("reproduction.evidence", { kind: "observation", content: `Chromium output: ${JSON.stringify(actual)}`, source: `index.html${reproduced ? "#saved" : ""}` }, "browser"); };
    record(false, await observe(false, "Continued"));
    command({ type: "phase.complete" });
    command({ type: "decision.propose", decision: { key: "state", type: "technical", title: "Affected reader state", question: "Which state triggers this failure?", impact: "Changes reproduction conditions", options: [{ id: "saved", label: "Saved state", consequence: "Open saved reader state" }, { id: "fresh", label: "Fresh state", consequence: "Open fresh reader state" }], recommendation: { option: "saved", reason: "Fresh state works", authority: "user" }, dependencies: [] } });
    command({ type: "phase.complete" });
    command({ type: "decision.ask", key: "state" });
    command({ type: "phase.complete" });
    expect(state.draft.status).toBe("waiting_for_answers");
    await finish();
    expect(await api.queuedEngineeringRun(issue.id, planner.agentId)).toBeNull();
    await panel.getByRole("button", { name: "Refresh engineering delivery" }).click();
    await expect(panel.getByText("Not reproduced under the recorded conditions. Delivery planning remains blocked.", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1200 });
    await expect(panel.getByRole("combobox", { name: "Your choice", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("team-bug-awaiting-human-390.png") });
    await panel.getByRole("combobox", { name: "Your choice", exact: true }).click();
    await page.getByRole("option", { name: /Saved state.*Open saved/ }).click();
    await panel.getByRole("button", { name: "Submit answer", exact: true }).click();
    await begin(issue.id, reproducer.agentId);
    expect(state.draft.id).toBe(reproductionDraft);
    expect(state.draft.runtimeInputs[0].answer.userId).toBe(seed.userId);
    command({ type: "decision.resolve", key: "state", option: "saved", authority: "user", decision: "Use saved state", rationale: "Authenticated human fact", evidence: state.draft.runtimeInputs[0].id });
    command({ type: "phase.complete" });
    put("reproduction.answer-review", "Changed conditions require a fresh observation");
    command({ type: "phase.complete" });
    command({ type: "phase.rewind", to: "investigation", reason: "Observe saved-state condition" });
    record(true, await observe(true, "", "team-bug-reproduced.png"));
    for (let i = 0; i < 3; i++)
      command({ type: "phase.complete" });
    put("reproduction.answer-review", "Saved-state browser observation reproduces failure against unchanged Expected");
    command({ type: "phase.complete" });
    command({ type: "phase.complete" });
    expect(state.conclusion.history).toHaveLength(1);
    expect(git("rev-parse", "HEAD")).toBe(originalCommit);
    expect(git("status", "--porcelain")).toBe("");
    await finish();
    console.info("Bug Fix Team: authenticated facts and renewed reproduction retained");
    await begin(issue.id, planner.agentId);
    expect(state.chain).toBe("planning");
    expect(state.contract.reproduction.report).toContain("Prior investigation observations");
    expect(state.contract.sources.find((source: any) => source.key === "acceptance:continue").oracle).toBe(expected);
    command({ type: "phase.complete" });
    put("delivery-plan.rationale", "Restore Continue against the original Expected");
    command({ type: "phase.complete" });
    put("delivery-plan.units", { title: "Restore saved-state Continue", actor: "Reader", trigger: "Activate Continue in saved state", observableOutcome: "Continued", acceptance: expected, sourceRefs: state.contract.sources.map((source: any) => source.key), dependsOn: [] }, "continue");
    command({ type: "phase.complete" });
    put("delivery-plan.coverage", "Original obligation and every reproduction source are covered");
    command({ type: "phase.complete" });
    command({ type: "phase.complete" });
    await finish();
    await expect.poll(() => api.publishedEngineeringIssues(issue.id).then(items => items.length), { timeout: 70000 }).toBe(1);
    const child = (await api.publishedEngineeringIssues(issue.id))[0]!;
    await expect(api.updateIssue(issue.id, { status: "done", suppress_run: true })).rejects.toThrow(/409/);
    expect(await api.queuedEngineeringRun(issue.id, reviewer.agentId)).toBeNull();
    await begin(child.id, analyst.agentId);
    expect(state.chain).toBe("analysis");
    command({ type: "phase.complete" });
    put("delivery-analysis.impacts", { area: "Continue", finding: "Remove the saved-state exclusion without changing the existing result", disposition: "change", evidence: "index.html:1" }, "scope");
    for (let i = 0; i < 3; i++)
      command({ type: "phase.complete" });
    put("delivery-analysis.answer-review", "Original Expected and frozen unit agree");
    command({ type: "phase.complete" });
    put("delivery-analysis.summary", "Restore Continue in saved state");
    put("delivery-analysis.contract", "Keep the existing Continued output in both states");
    command({ type: "phase.complete" });
    command({ type: "phase.complete", confirmation: "Frozen scope reviewed" });
    await finish();
    await begin(child.id, developer.agentId);
    expect(state.chain).toBe("development");
    command({ type: "phase.complete" });
    await writeFile(join(repository, "index.html"), fixed);
    for (const source of state.contract.sources.filter((source: any) => source.kind === "acceptance"))
      command({ type: "acceptance.assess", key: source.key, evidence: "index.html:1 restores the original Continue result" });
    command({ type: "phase.complete" });
    put("development.code-review", { summary: "Only the saved-state exclusion was removed", evidence: "index.html:1" });
    command({ type: "phase.complete" });
    const script = "const s=require('node:fs').readFileSync('index.html','utf8');if(s.includes('location.hash')||!s.includes(\"textContent='Continued'\"))process.exit(1)";
    const check = spawnSync(process.execPath, ["-e", script], { cwd: repository, encoding: "utf8" });
    expect(check.status).toBe(0);
    const receipt = await api.captureEngineeringReceipt(owner.taskId, { id: "continue-check", sequence: 1, result: { command: `node -e ${JSON.stringify(script)}`, cwd: repository, status: "completed", exit_code: check.status } });
    command({ type: "check.record", key: "continue", receipt_id: receipt.captured, summary: "Actual source assertion exited successfully" });
    command({ type: "phase.complete" });
    git("add", "index.html");
    git("commit", "-qm", "Restore Continue in saved state");
    const repairedCommit = git("rev-parse", "HEAD"), deliveryBranch = git("symbolic-ref", "HEAD");
    command({ type: "phase.complete", confirmation: "Scoped commit checked" });
    command({ type: "phase.complete", confirmation: "Implementation and captured check align" });
    await finish();
    await expect(api.updateIssue(child.id, { status: "done", suppress_run: true })).rejects.toThrow(/409/);
    await begin(child.id, verifier.agentId, repairedCommit);
    expect(state.chain).toBe("verification");
    expect(state.contract.binding.codeVersion).toBe(repairedCommit);
    command({ type: "phase.complete" });
    put("verification.scenarios", { channel: "frontend", title: "Existing Continue behavior in fresh and saved states", setup: "Open committed index.html with and without #saved", steps: "Activate Continue in each state", expected: "Continued in both states", coverageRefs: state.contract.sources.map((source: any) => source.key) }, "continue");
    command({ type: "phase.complete" });
    await observe(false, "Continued");
    await observe(true, "Continued", "team-bug-independent-verification.png");
    put("verification.results", { status: "passed", evidence: `Chromium observed Continued after Continue in fresh and #saved states at ${repairedCommit}` }, "continue");
    command({ type: "phase.complete" });
    put("verification.evidence-review", { summary: "Actual browser results cover original oracle and frozen unit" });
    command({ type: "phase.complete" });
    command({ type: "phase.complete" });
    await finish();
    await expect.poll(() => api.publishedEngineeringIssues(issue.id).then(items => items[0]?.status), { timeout: 70000 }).toBe("done");
    console.info("Bug Fix Team: native unit accepted against real commit and browser observations");
    const beforeReview = await api.engineeringOverview(issue.id);
    console.info("Bug Fix Team review checkpoint", JSON.stringify({ chain: beforeReview.chain, status: beforeReview.status, accepted: Object.keys(beforeReview.requirement.accepted), review: !!beforeReview.requirement.review, active: beforeReview.has_active_run }));
    // Review creation and native enqueue are separate persisted scheduler turns.
    await expect.poll(() => api.engineeringOverview(issue.id).then(value => value.requirement.review?.agent_id), { timeout: 70000 }).toBe(reviewer.agentId);
    await begin(issue.id, reviewer.agentId, repairedCommit);
    expect(state.chain).toBe("review");
    expect(state.contract.binding.codeVersion).toBe(repairedCommit);
    expect(state.contract.subjects).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "expected", content: expected })]));
    expect(state.contract.evidence.some((item: any) => item.kind === "reproduction")).toBe(true);
    const reviewContract = state.contract;
    command({ type: "phase.complete" });
    for (const [index, subject] of reviewContract.subjects.entries())
      put("review.reconciliations", { subjectRef: subject.key, result: "Original obligation supported by frozen independent browser evidence", evidenceRefs: subject.requiredEvidenceRefs }, `subject-${index}`);
    command({ type: "phase.complete" });
    put("review.assessment", { summary: "Original saved-state defect is repaired", evidenceBoundary: "Exact local commit and independent Chromium observations; model conclusions are controlled", residualRisk: "No real-provider or packaged-client acceptance" });
    command({ type: "phase.complete" });
    for (const kind of ["outcome", "scope", "implementation", "verification", "risks"])
      put("review.report-sections", { kind, content: `Bug Fix ${kind}: the original Continue result is preserved in fresh and saved states at ${repairedCommit}. Authenticated human conditions and earlier observations remain retained.` }, kind);
    command({ type: "phase.complete" });
    command({ type: "phase.complete" });
    expect(state.conclusion.verdict).toBe("report_ready");
    await finish();
    await expect(api.updateIssue(issue.id, { status: "done", suppress_run: true })).rejects.toThrow(/409.*acknowledge/i);
    await expect.poll(() => api.engineeringOverview(issue.id).then(value => value.has_active_run), { timeout: 70000 }).toBe(false);
    await page.reload();
    await expect(panel.getByRole("heading", { name: "Requirement closure report", exact: true })).toBeVisible();
    const refreshed = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/issues/${issue.id}/engineering`);
    await panel.getByRole("button", { name: "Refresh engineering delivery" }).click();
    const fresh = await (await refreshed).json();
    console.info("Bug Fix Team reading checkpoint", JSON.stringify({ active: fresh.has_active_run, report: !!fresh.requirement.review?.report_hash, intervention: !!fresh.intervention }));
    await expect(panel.getByRole("heading", { name: "Requirement closure report", exact: true })).toBeVisible();
    const reading = panel.getByRole("button", { name: "I have read it; close requirement", exact: true });
    await expect(reading).toBeEnabled({ timeout: 15000 });
    await page.setViewportSize({ width: 1280, height: 1200 });
    await expect(reading).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("team-bug-report-1280.png") });
    await page.setViewportSize({ width: 390, height: 1200 });
    await page.mouse.move(195, 600);
    await expect.poll(async () => { const box = await reading.boundingBox(); if (!box)
      return false; const visible = box.y >= 60 && box.y + box.height <= 1050; if (!visible)
      await page.mouse.wheel(0, box.y - 600); return visible; }).toBe(true);
    await expect(reading).toBeInViewport();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("team-bug-report-reading-390.png") });
    await reading.click();
    await expect(panel.getByText("Reading confirmed for this report.", { exact: true })).toBeVisible();
    expect(await api.getOwnedEngineeringIssue(issue.id)).toMatchObject({ status: "done", assignee_type: "squad", assignee_id: team.id });
    expect(registeredGit("rev-parse", "HEAD")).toBe(mode === "worktree" ? originalCommit : repairedCommit);
    expect(registeredGit("rev-parse", deliveryBranch)).toBe(repairedCommit);
    expect(registeredGit("show", `${repairedCommit}:index.html`)).toBe(fixed);
    expect(git("status", "--porcelain")).toBe("");
    expect((await api.engineeringRunStates(issue.id)).map(run => run.agent_id).sort()).toEqual([backlog.agentId, reproducer.agentId, reproducer.agentId, planner.agentId, reviewer.agentId].sort());
  }
  finally {
    await context.close();
    await browser.close();
    await api.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
