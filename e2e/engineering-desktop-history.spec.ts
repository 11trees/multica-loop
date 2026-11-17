import {expect, test, type ElectronApplication, type Page} from "@playwright/test";
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
  HistoryDocumentSchema, HistoryListSchema, HistoryPacketSchema, HistoryPreparationSchema,
  HistoryTaskSchema, SupplementCatalogSchema, SupplementTasksSchema, SupplementTaskSchema,
} from "../packages/core/history/schema";
import {createDesktopSandbox, useEnglishDesktop} from "./desktop-fixture";
import {TestApiClient} from "./fixtures";

type NativeDownloadState = {state: string; filename: string};

async function saveNextDownload(application: ElectronApplication, destination: string) {
  await application.evaluate(({BrowserWindow}, path) => {
    const state = {state: "waiting", filename: ""};
    (globalThis as unknown as {historyDownload: NativeDownloadState}).historyDownload = state;
    BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_event, item) => {
      state.filename = item.getFilename();
      item.setSavePath(path);
      item.once("done", (_event, result) => {state.state = result;});
    });
  }, destination);
}

async function completedDownload(application: ElectronApplication) {
  await expect.poll(() => application.evaluate(() =>
    (globalThis as unknown as {historyDownload: NativeDownloadState}).historyDownload.state,
  ), {timeout: 30000}).toBe("completed");
  return application.evaluate(() =>
    (globalThis as unknown as {historyDownload: NativeDownloadState}).historyDownload.filename,
  );
}

test("packaged Desktop preserves pinned historical material and original file downloads", async ({}, testInfo) => {
  test.setTimeout(180000);
  const executable = process.env.MULTICA_ENGINEERING_DESKTOP_EXECUTABLE;
  const directory = process.env.MULTICA_ENGINEERING_DESKTOP_PROFILE_NEW;
  const primaryHash = process.env.MULTICA_LOOPWORK_HISTORY_HASH;
  const supplementHash = process.env.MULTICA_LOOPWORK_HISTORY_SUPPLEMENT_HASH;
  test.skip(!executable || !directory || !primaryHash || !supplementHash || process.env.MULTICA_LOCAL_AUTH !== "true", "Explicit packaged executable, new profile and pinned native archives are required");
  const sandbox = await createDesktopSandbox(executable!, `${directory!}-history`);
  const api = new TestApiClient(), login = await api.loginLocally();
  const workspace = (await api.getWorkspaces()).find(item => item.slug === "loopwork-local")!;
  api.setWorkspaceId(workspace.id); api.setWorkspaceSlug(workspace.slug);
  const headers = {Authorization: `Bearer ${login.token}`, "X-Workspace-ID": workspace.id};
  const read = async (path: string): Promise<unknown> => {
    const response = await fetch(`${sandbox.profile.api_url}${path}`, {headers});
    expect(response.status, path).toBe(200); return response.json();
  };
  const snapshot = HistoryListSchema.parse(await read("/api/engineering/history"));
  expect(snapshot.source.hash).toBe(primaryHash);
  expect(snapshot.total).toBeGreaterThan(0);
  let selected: {task: NonNullable<ReturnType<typeof HistoryTaskSchema.parse>["task"]>; document: NonNullable<ReturnType<typeof HistoryDocumentSchema.parse>["document"]>; preparation: ReturnType<typeof HistoryPreparationSchema.parse>} | undefined;
  for (const task of snapshot.tasks) {
    if (["done", "cancelled"].includes(task.status) || snapshot.projects.find(project => project.id === task.project_id)?.deleted_at) continue;
    const detail = HistoryTaskSchema.parse(await read(`/api/engineering/history/tasks/${encodeURIComponent(task.id)}`));
    if (!detail.task || !detail.documents.length) continue;
    const preparation = HistoryPreparationSchema.parse(await read(`/api/engineering/history/tasks/${encodeURIComponent(task.id)}/preparation`));
    if (!preparation.adoptions.some(item => item.phase === "staged")) continue;
    const document = HistoryDocumentSchema.parse(await read(`/api/engineering/history/tasks/${encodeURIComponent(task.id)}/documents/${encodeURIComponent(detail.documents[0].id)}`)).document;
    if (document) {selected = {task: detail.task, document, preparation}; break;}
  }
  expect(selected, "A staged historical task with original documents is required").toBeDefined();
  const {task, document, preparation} = selected!;
  const taskPath = `/api/engineering/history/tasks/${encodeURIComponent(task.id)}`;
  const material = HistoryPacketSchema.parse(await read(`${taskPath}/packet`));
  expect(material.source.hash).toBe(primaryHash);
  expect(material.packet?.source_task_id).toBe(task.id);
  expect(material.packet?.schema_complete).toBe(true);
  expect(material.packet?.ownership.native_execution_authorized).toBe(false);
  const catalog = SupplementCatalogSchema.parse(await read("/api/engineering/history/supplement"));
  expect(catalog.hash).toBe(supplementHash); expect(catalog.archive_hash).toBe(primaryHash);
  const database = catalog.databases.find(row => row.available && row.additional_task_count > 0)!;
  expect(database).toBeDefined();
  const extraTasks = SupplementTasksSchema.parse(await read(`/api/engineering/history/supplement/databases/${database.id}/tasks`));
  const extra = extraTasks.tasks.find(row => row.additional)!;
  expect(extra).toBeDefined();
  const extraDetail = SupplementTaskSchema.parse(await read(`/api/engineering/history/supplement/databases/${database.id}/tasks/${encodeURIComponent(extra.id)}`));
  const file = catalog.files.find(row => row.path.startsWith("reference-inventory/"))!;
  expect(file).toBeDefined();
  let application: ElectronApplication | undefined, page: Page | undefined;
  try {
    application = await sandbox.launch();
    page = await useEnglishDesktop(application, sandbox.profile.directory);
    await page.getByRole("link", {name: "Work", exact: true}).click();
    await page.getByRole("link", {name: "LoopWork history", exact: true}).click();
    const content = page.getByTestId("loopwork-history");
    await expect(content.getByText(`Archived tasks: ${snapshot.total}`, {exact: true})).toBeVisible();
    await content.getByRole("textbox", {name: "Search", exact: true}).fill(task.id);
    await content.getByRole("button").filter({hasText: task.id}).click();
    await expect(content.getByRole("heading", {name: task.title, exact: true})).toBeVisible();
    await content.getByRole("button").filter({hasText: document.title}).click();
    await expect(content.locator("article > h2")).toHaveText(document.title);
    await expect(content.locator("img")).toHaveCount(0);
    if (["markdown", "md"].includes(document.format)) {
      await content.getByText("Original source", {exact: true}).click();
      expect(await content.locator("article details pre").textContent()).toBe(document.content);
    } else expect(await content.locator("article > pre").textContent()).toBe(document.content);
    await page.reload();
    await expect(content.locator("article > h2")).toHaveText(document.title);
    await content.getByRole("button", {name: "Back to task", exact: true}).click();
    await content.getByRole("button", {name: "View material", exact: true}).click();
    const prepared = content.getByRole("region", {name: "Migration preparation"});
    await expect(prepared.getByText("Native task created; migration confirmation pending.", {exact: true})).toBeVisible();
    for (const adoption of preparation.adoptions) {
      await expect(prepared.getByRole("link", {name: adoption.identifier, exact: true})).toHaveAttribute("href", `${sandbox.profile.app_url}/${workspace.slug}/issues/${adoption.issueId}`);
    }
    await expect(prepared.getByRole("button", {name: /start|run|done|save/i})).toHaveCount(0);
    const packetPath = join(sandbox.profile.directory, "historical-handoff.json");
    await saveNextDownload(application, packetPath);
    await content.getByRole("button", {name: "Download JSON", exact: true}).click();
    expect(await completedDownload(application)).toBe(`loopwork-${task.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-handoff.json`);
    expect(JSON.parse(await readFile(packetPath, "utf8"))).toEqual(material);
    const adoption = preparation.adoptions.find(item => item.phase === "staged")!;
    await prepared.getByRole("link", {name: adoption.identifier, exact: true}).click();
    await expect(page.getByTestId("content").getByRole("button", {name: task.title, exact: true})).toBeVisible();
    await expect(page.getByText("Migration pending. Confirm the original task and materials before starting.", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Go back", exact: true}).click();
    await expect(content.getByRole("heading", {name: task.title, exact: true})).toBeVisible();
    await content.getByRole("button", {name: "Supplementary history", exact: true}).click();
    const supplement = page.getByTestId("supplement-history");
    await supplement.getByRole("combobox", {name: "Source database", exact: true}).selectOption(database.id);
    await supplement.getByRole("textbox", {name: "Search", exact: true}).fill(extra.id);
    await supplement.getByRole("button").filter({hasText: extra.id}).click();
    await expect(supplement.getByRole("heading", {name: extra.title, exact: true})).toBeVisible();
    expect(await supplement.locator("section > pre").textContent()).toBe(extraDetail.task?.description ?? "");
    await expect(supplement.getByRole("region", {name: "Migration preparation"})).toHaveCount(0);
    await page.reload();
    await expect(supplement.getByRole("heading", {name: extra.title, exact: true})).toBeVisible();
    await supplement.getByRole("button", {name: `Historical files (${catalog.files.length})`, exact: true}).click();
    await supplement.getByRole("textbox", {name: "Search", exact: true}).fill(file.path);
    await supplement.getByRole("button").filter({hasText: file.path}).click();
    await expect(supplement.getByRole("heading", {name: file.path, exact: true})).toBeVisible();
    const originalPath = join(sandbox.profile.directory, "historical-reference-inventory.json");
    await saveNextDownload(application, originalPath);
    await supplement.getByRole("button", {name: "Download original file", exact: true}).click();
    expect(await completedDownload(application)).toBe(file.path.split("/").at(-1));
    const bytes = await readFile(originalPath);
    expect(bytes.length).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    expect(JSON.parse(bytes.toString("utf8")).execution_authorized).toBe(false);
    await sandbox.expectStopped(page);
    expect(HistoryPreparationSchema.parse(await read(`${taskPath}/preparation`))).toEqual(preparation);
    const receipt = {
      app_version: await application.evaluate(({app}) => app.getVersion()),
      archive_hash: primaryHash, primary_tasks: snapshot.total, task_id: task.id,
      document_id: document.id, packet_hash: material.packet?.hash, supplement_hash: supplementHash,
      supplementary_databases: catalog.databases.filter(row => row.available).length,
      supplementary_files: catalog.files.length, file_hash: file.sha256,
      native_downloads_completed: 2, save_dialog: "destination supplied by test harness",
      source_ownership: "LoopWork", native_execution_authorized: false, daemon_started: false,
    };
    await writeFile(join(sandbox.profile.directory, "history-acceptance.json"), JSON.stringify(receipt, null, 2) + "\n", {mode: 0o600, flag: "wx"});
    await testInfo.attach("Packaged history receipt", {contentType: "application/json", body: JSON.stringify(receipt)});
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({path: testInfo.outputPath("desktop-history-failure.png")});
      await testInfo.attach("Desktop history failure text", {body: await page.locator("body").innerText(), contentType: "text/plain"});
      await testInfo.attach("Desktop history renderer errors", {body: JSON.stringify(sandbox.rendererErrors), contentType: "application/json"});
    }
    throw error;
  } finally {
    try {if (application) await application.close();}
    finally {await api.cleanup();}
  }
});
