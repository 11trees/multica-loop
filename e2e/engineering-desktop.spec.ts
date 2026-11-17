import {_electron, expect, test} from "@playwright/test";
import {createHash, randomUUID} from "node:crypto";
import {access, mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {homedir} from "node:os";
import {isAbsolute, join} from "node:path";
import {createLocalDesktopProfile} from "../apps/desktop/scripts/local-profile.mjs";
import {TestApiClient} from "./fixtures";

test("packaged local Desktop retains five Teams and drafts without starting a provider", async ({}, testInfo) => {
  test.setTimeout(180000);
  const executable = process.env.MULTICA_ENGINEERING_DESKTOP_EXECUTABLE;
  const directory = process.env.MULTICA_ENGINEERING_DESKTOP_PROFILE_NEW;
  test.skip(!executable || !directory || process.env.MULTICA_LOCAL_AUTH !== "true", "Explicit packaged executable and a new isolated profile are required");
  expect(isAbsolute(executable!)).toBe(true);
  expect(isAbsolute(directory!)).toBe(true);
  const profile = await createLocalDesktopProfile({directory, apiUrl: process.env.NEXT_PUBLIC_API_URL, appUrl: process.env.PLAYWRIGHT_BASE_URL});
  const name = `desktop-${new URL(profile.api_url).host.replace(/:/g, "-").toLowerCase()}-${createHash("sha256").update(profile.directory).digest("hex").slice(0, 12)}`;
  const nativeProfile = join(homedir(), ".multica", "profiles", name);
  await expect(access(nativeProfile)).rejects.toMatchObject({code: "ENOENT"});
  const port = 19515 + [...Buffer.from(name)].reduce((sum, byte) => sum + byte, 0) % 1000;
  const server = createServer();
  await new Promise<void>((resolve, reject) => {server.once("error", reject); server.listen(port, "127.0.0.1", resolve);});
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

  const sentinels = join(profile.directory, "provider-sentinels");
  const attempts = join(profile.directory, "provider-command-attempts");
  await mkdir(sentinels, {mode: 0o700});
  for (const command of (await readFile("scripts/agent-cli-command-names.txt", "utf8")).split(/\r?\n/).filter(line => line && !line.startsWith("#"))) {
    expect(command).toMatch(/^[a-z0-9-]+$/);
    await writeFile(join(sentinels, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$MULTICA_DESKTOP_PROVIDER_ATTEMPTS"\nexit 79\n', {mode: 0o700, flag: "wx"});
  }
  const env = {...process.env, PATH: `${sentinels}:/usr/bin:/bin:/opt/homebrew/bin`, MULTICA_DESKTOP_PROFILE_DIR: profile.directory, MULTICA_DESKTOP_PROVIDER_ATTEMPTS: attempts};
  delete env.ELECTRON_RUN_AS_NODE;
  const api = new TestApiClient();
  await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(item => item.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const teams = await api.builtinEngineeringTeams();
  expect(teams.map(team => team.builtin_workflow).sort()).toEqual(["direct", "business_analysis", "end_to_end", "develop", "bug_fix"].sort());
  const develop = teams.find(team => team.builtin_workflow === "develop")!;
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let currentPage: Awaited<ReturnType<Awaited<ReturnType<typeof _electron.launch>>["firstWindow"]>> | undefined;
  try {
    const project = await api.createProject(`Desktop Team smoke ${randomUUID()}`);
    application = await _electron.launch({executablePath: executable, env, timeout: 45000});
    expect(await application.evaluate(({app}) => app.getPath("userData"))).toBe(join(profile.directory, "electron"));
    let page = await application.firstWindow();
    currentPage = page;
    page.setDefaultTimeout(25000);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => localStorage.setItem("multica-locale", "en"));
    await page.reload();
    await page.getByRole("link", {name: "Team", exact: true}).click();
    await expect(page.getByRole("link", {name: "Teams", exact: true})).toBeVisible({timeout: 25000});
    await page.getByRole("link", {name: "Teams", exact: true}).click();
    for (const team of teams) await expect(page.getByText(team.name, {exact: true}).first()).toBeVisible();
    await page.screenshot({path: testInfo.outputPath("desktop-five-teams.png")});
    await page.getByText(develop.name, {exact: true}).first().click();
    const settings = page.locator("section").filter({has: page.getByRole("heading", {name: "Team settings", exact: true})});
    await expect(settings).toBeVisible();
    await settings.getByRole("button", {name: "Edit", exact: true}).click();
    await expect(settings.getByRole("combobox", {name: "Workflow", exact: true})).toBeDisabled();
    await settings.screenshot({path: testInfo.outputPath("desktop-team-settings.png")});
    await settings.getByRole("button", {name: "Cancel", exact: true}).click();
    await page.getByRole("button", {name: "New Issue", exact: true}).click();
    const dialog = page.getByRole("dialog"), title = `Built-in Team draft Desktop ${randomUUID()}`;
    await dialog.getByLabel("Task goal", {exact: true}).fill(title);
    await dialog.getByRole("combobox", {name: "Project", exact: true}).click();
    await page.getByRole("option", {name: project.title, exact: true}).click();
    await dialog.getByRole("combobox", {name: "Team", exact: true}).click();
    for (const team of teams) await expect(page.getByRole("option", {name: team.name, exact: true})).toBeVisible();
    await page.getByRole("option", {name: develop.name, exact: true}).click();
    await expect(dialog.getByRole("combobox")).toHaveCount(2);
    await expect(dialog.getByRole("button", {name: "Create and start", exact: true})).toBeDisabled();
    await dialog.screenshot({path: testInfo.outputPath("desktop-team-draft.png")});
    const saved = page.waitForResponse(response => response.url().endsWith("/api/issues") && response.request().method() === "POST");
    await dialog.getByRole("button", {name: "Save draft", exact: true}).click();
    const response = await saved; expect(response.status()).toBe(201);
    const issue = await response.json(); await api.trackBuiltinTeamDraft(issue.id);
    expect(issue.assignee_id).toBe(develop.id); expect(issue.status).toBe("backlog");
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.daemonAPI.getStatus())).toMatchObject({state: "stopped"});
    await application.close(); application = undefined;
    application = await _electron.launch({executablePath: executable, env, timeout: 45000});
    page = await application.firstWindow(); page.setDefaultTimeout(25000);
    currentPage = page;
    await expect(page.getByText(new RegExp(title))).toBeVisible({timeout: 25000});
    await page.getByRole("link", {name: "Team", exact: true}).click();
    await expect(page.getByRole("link", {name: "Teams", exact: true})).toBeVisible({timeout: 25000});
    expect(await page.evaluate(() => window.daemonAPI.getStatus())).toMatchObject({state: "stopped"});
    await expect(access(attempts)).rejects.toMatchObject({code: "ENOENT"});
    for (const file of ["daemon.pid", "daemon.port"]) await expect(access(join(nativeProfile, file))).rejects.toMatchObject({code: "ENOENT"});
    expect((await stat(join(nativeProfile, "config.json"))).mode & 0o777).toBe(0o600);
    expect((await api.builtinEngineeringTeams())).toEqual(teams);
    await testInfo.attach("Desktop profile", {body: JSON.stringify({directory: profile.directory, native_profile: name, daemon_started: false, provider_commands: 0}), contentType: "application/json"});
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({path: testInfo.outputPath("desktop-failure.png")});
      await testInfo.attach("Desktop failure text", {body: await currentPage.locator("body").innerText(), contentType: "text/plain"});
    }
    throw error;
  } finally {
    try {if (application) await application.close();}
    finally {await api.cleanup();}
  }
});
