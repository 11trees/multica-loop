import {_electron, expect, test} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {createDesktopSandbox, useEnglishDesktop} from "./desktop-fixture";
import {TestApiClient} from "./fixtures";

test("packaged local Desktop retains the Development Team and drafts without starting a provider", async ({}, testInfo) => {
  test.setTimeout(180000);
  const executable = process.env.MULTICA_ENGINEERING_DESKTOP_EXECUTABLE;
  const directory = process.env.MULTICA_ENGINEERING_DESKTOP_PROFILE_NEW;
  test.skip(!executable || !directory || process.env.MULTICA_LOCAL_AUTH !== "true", "Explicit packaged executable and a new isolated profile are required");
  const sandbox = await createDesktopSandbox(executable!, directory!);
  const api = new TestApiClient();
  await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(item => item.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const teams = await api.builtinEngineeringTeams();
  expect(teams.map(team => team.builtin_workflow)).toEqual(["develop"]);
  const develop = teams.find(team => team.builtin_workflow === "develop")!;
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let currentPage: Awaited<ReturnType<Awaited<ReturnType<typeof _electron.launch>>["firstWindow"]>> | undefined;
  try {
    const project = await api.createProject(`Desktop Team smoke ${randomUUID()}`);
    application = await sandbox.launch();
    let page = await useEnglishDesktop(application, sandbox.profile.directory);
    currentPage = page;
    await page.getByRole("link", {name: "Team", exact: true}).click();
    await expect(page.getByRole("link", {name: "Teams", exact: true})).toBeVisible({timeout: 25000});
    await page.getByRole("link", {name: "Teams", exact: true}).click();
    for (const team of teams) await expect(page.getByText(team.name, {exact: true}).first()).toBeVisible();
    await page.screenshot({path: testInfo.outputPath("desktop-development-team.png")});
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
    application = await sandbox.launch();
    page = await application.firstWindow(); page.setDefaultTimeout(25000);
    currentPage = page;
    await expect(page.getByTestId("content").getByRole("button", {name: title, exact: true})).toBeVisible({timeout: 25000});
    await page.getByRole("link", {name: "Team", exact: true}).click();
    await expect(page.getByRole("link", {name: "Teams", exact: true})).toBeVisible({timeout: 25000});
    expect(await page.evaluate(() => window.daemonAPI.getStatus())).toMatchObject({state: "stopped"});
    await sandbox.expectStopped(page);
    expect((await api.builtinEngineeringTeams())).toEqual(teams);
    await testInfo.attach("Desktop profile", {body: JSON.stringify({directory: sandbox.profile.directory, native_profile: sandbox.name, daemon_started: false, provider_commands: 0}), contentType: "application/json"});
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({path: testInfo.outputPath("desktop-failure.png")});
      await testInfo.attach("Desktop failure text", {body: await currentPage.locator("body").innerText(), contentType: "text/plain"});
      await testInfo.attach("Desktop renderer errors", {body: JSON.stringify(sandbox.rendererErrors), contentType: "application/json"});
      if (application) await testInfo.attach("Desktop window state", {body: JSON.stringify(await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(window => ({url: window.webContents.getURL(), loading: window.webContents.isLoading()})))), contentType: "application/json"});
    }
    throw error;
  } finally {
    try {if (application) await application.close();}
    finally {await api.cleanup();}
  }
});
