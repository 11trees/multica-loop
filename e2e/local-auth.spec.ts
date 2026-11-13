import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test("a fresh local session opens the workspace and creates an issue without an email login", async ({ browser, baseURL }, testInfo) => {
  test.skip(process.env.MULTICA_LOCAL_AUTH !== "true", "Requires the opt-in local single-user environment");
  const api = new TestApiClient();
  await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(value => value.slug === "loopwork-local");
  expect(workspace).toBeDefined();
  api.setWorkspaceId(workspace!.id);
  api.setWorkspaceSlug(workspace!.slug);
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginCalls: string[] = [];
  let createdIssueId: string | undefined;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (["/auth/local", "/auth/send-code", "/auth/verify-code", "/auth/google"].includes(path)) loginCalls.push(path);
  });
  await context.addInitScript(() => {
    localStorage.setItem("multica_create_mode", JSON.stringify({ state: { lastMode: "manual" }, version: 0 }));
    localStorage.setItem("multica:chat:isOpen", "false");
  });
  try {
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/loopwork-local\/issues$/, { timeout: 30000 });
    await page.getByRole("button", { name: "New Issue", exact: true }).first().click();
    const title = `Local access smoke ${Date.now()}`;
    await page.getByRole("textbox", { name: "Issue title" }).fill(title);
    const creation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/issues" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create Issue", exact: true }).click();
    const response = await creation;
    expect(response.status()).toBe(201);
    createdIssueId = (await response.json()).id;
    expect(createdIssueId).toBeTruthy();
    await page.getByRole("button", { name: "View issue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/issues/${createdIssueId}$`));
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    expect(loginCalls).toEqual(["/auth/local"]);
    const screenshot = testInfo.outputPath("local-session.png");
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    await testInfo.attach("Local session and issue creation", { path: screenshot, contentType: "image/png" });
  } finally {
    await context.close();
    if (createdIssueId) await api.deleteIssue(createdIssueId);
  }
});
