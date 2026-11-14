import { test, expect, chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { TestApiClient } from "./fixtures";

for (const gitRepository of [true, false]) test(`Direct ${gitRepository ? "Git" : "plain directory"} saves an explicit result after RUN, recovers a failed attempt and completes the native issue without report reading`, async ({ baseURL }, testInfo) => {
  test.setTimeout(360000);
  test.skip(process.env.MULTICA_ENGINEERING_ENABLED !== "true" || !process.env.MULTICA_ENGINEERING_CLI || !process.env.MULTICA_ENGINEERING_BROWSER, "Requires the managed engineering service, management CLI and explicit browser binary");
  const api = new TestApiClient(); await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(item => item.slug === "loopwork-local")!; api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const directory = await mkdtemp(join(tmpdir(), "direct-native-")), repository = join(directory, "repository");
  await mkdir(repository);
  if (gitRepository) execFileSync("git", ["init", "-q", repository]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  if (gitRepository) { git("config", "user.name", "Direct fixture"); git("config", "user.email", "fixture@example.invalid"); }
  const notes = "- Shipment 6 is waiting for QA.\n- The owner confirmed a Friday review.\n";
  await writeFile(join(repository, "notes.md"), notes);
  if (gitRepository) { git("add", "."); git("commit", "-qm", "Original notes"); }
  const initialCommit = gitRepository ? git("rev-parse", "HEAD") : "";
  await writeFile(join(repository, "existing-user-note.md"), "Keep this uncommitted user note.\n");
  const browser = await chromium.launch({ executablePath: process.env.MULTICA_ENGINEERING_BROWSER }), context = await browser.newContext({ viewport: { width: 1280, height: 1500 } });
  await context.addInitScript(() => { localStorage.setItem("multica:chat:isOpen", "false"); }); context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(30000);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); let failed = false;
  try {
    const fixture = await api.seedEngineeringRun(), project = await api.createProject(`Direct fixture ${fixture.issueId}`);
    await api.finishEngineeringRun(fixture.taskId); await api.attachEngineeringProject(fixture.taskId, project.id, repository);
    const identity = await api.getOwnedEngineeringIssue(fixture.issueId), page = await context.newPage(); await page.goto(`${baseURL}/`); await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/issues$`), { timeout: 30000 }); await page.goto(`${baseURL}/${workspace.slug}/issues/${identity.identifier}`);
    await page.getByRole("region", { name: "Engineering delivery" }).getByRole("button", { name: "Direct", exact: true }).click(); const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Repository path").fill(repository); await dialog.getByLabel("Work to execute").fill("Read notes.md and write summary.md preserving the exact original observations. Keep the existing uncommitted user note.");
    await dialog.getByRole("combobox", { name: "Executing agent" }).click(); await page.getByRole("option", { name: `Engineering fixture ${fixture.agentId}`, exact: true }).click();
    await dialog.screenshot({ path: testInfo.outputPath("direct-configure.png") }); await dialog.getByRole("button", { name: "Start Direct", exact: true }).click(); await expect(dialog).not.toBeVisible();
    const panel = page.getByRole("region", { name: "Direct", exact: true });
    await expect(api.updateIssue(fixture.issueId, { status: "done", suppress_run: true })).rejects.toThrow(/409.*explicit submitted result/i);
    const next = async () => { await expect.poll(() => api.queuedEngineeringRun(fixture.issueId, fixture.agentId), { timeout: 70000 }).not.toBeNull(); return api.claimEngineeringRun((await api.queuedEngineeringRun(fixture.issueId, fixture.agentId))!); };
    let owner = await next();
    const cli = (name: string, args: string[] = []) => JSON.parse(execFileSync(resolve(process.env.MULTICA_ENGINEERING_CLI!), ["engineering", name, ...args], { cwd: repository, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: directory, MULTICA_SERVER_URL: owner.apiBase, MULTICA_TOKEN: owner.taskToken, MULTICA_WORKSPACE_ID: workspace.id, MULTICA_TASK_ID: owner.taskId, MULTICA_AGENT_ID: owner.agentId } }));
    await api.bindEngineeringRepository(owner.taskId, repository); const summaryFile = join(directory, "summary.txt"), resultFile = join(directory, "result.md"); await writeFile(summaryFile, "Notes summarized"); await writeFile(resultFile, "Premature result");
    expect(() => cli("direct-submit", ["--summary-file", summaryFile])).toThrow(); let state = cli("direct-run"); expect(state.chain).toBe("direct"); expect(() => cli("start")).toThrow();
    const old = owner; await api.finishEngineeringRun(owner.taskId, "failed"); await panel.getByRole("button", { name: "Refresh Direct" }).click();
    const request = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/engineering/run")); await panel.getByRole("button", { name: "Continue run", exact: true }).click(); const response = await request; expect(response.status()).toBe(202); owner = await api.claimEngineeringRun((await response.json()).id);
    await api.bindEngineeringRepository(owner.taskId, repository); expect(() => cli("direct-submit", ["--summary-file", summaryFile])).toThrow(); cli("direct-run");
    const current = owner; owner = old; expect(() => cli("direct-submit", ["--summary-file", summaryFile])).toThrow(); owner = current;
    const content = `# Operations summary\n\n${await readFile(join(repository, "notes.md"), "utf8")}`; await writeFile(join(repository, "summary.md"), content); await writeFile(resultFile, content);
    state = cli("direct-submit", ["--summary-file", summaryFile, "--result-file", resultFile]); const result = state.direct.result;
    expect(result.content).toBe(content.trim()); expect(result.summary).toBe("Notes summarized"); expect(state.direct.native_completed).toBe(false);
    await writeFile(summaryFile, "Do not overwrite the accepted result"); expect(cli("direct-submit", ["--summary-file", summaryFile]).direct.result).toEqual(result);
    await expect(api.updateIssue(fixture.issueId, { status: "done", suppress_run: true })).rejects.toThrow(/409.*unfinished|409.*finish/i);
    await api.finishEngineeringRun(owner.taskId); await expect.poll(async () => (await api.getOwnedEngineeringIssue(fixture.issueId)).status, { timeout: 70000 }).toBe("done");
    await panel.getByRole("button", { name: "Refresh Direct" }).click(); await expect(panel.getByRole("heading", { name: "Direct result", exact: true })).toBeVisible(); await expect(panel.getByRole("heading", { name: "Operations summary", exact: true })).toBeVisible(); await expect(panel.getByText("Submitted result saved; Direct is complete.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /read|close|New revision/i })).toHaveCount(0);
    for (const width of [1280, 390]) { await page.setViewportSize({ width, height: 1400 }); await expect(panel.getByRole("heading", { name: "Operations summary", exact: true })).toBeVisible(); expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true); await panel.screenshot({ path: testInfo.outputPath(`direct-result-${width}.png`) }); }
    if (gitRepository) { expect(git("rev-parse", "HEAD")).toBe(initialCommit); expect(git("status", "--porcelain")).toContain("summary.md"); }
    expect(await readFile(join(repository, "summary.md"), "utf8")).toBe(content); expect(await readFile(join(repository, "existing-user-note.md"), "utf8")).toBe("Keep this uncommitted user note.\n");
    expect((await api.engineeringOverview(fixture.issueId)).direct.attempts).toHaveLength(2);
  } catch (error) { failed = true; throw error; }
  finally { await api.cleanup(); await context.tracing.stop(failed ? { path: testInfo.outputPath("failure-trace.zip") } : {}); await context.close(); await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
