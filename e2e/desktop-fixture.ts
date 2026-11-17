import {_electron, expect, type Page} from "@playwright/test";
import {createHash} from "node:crypto";
import {access, mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {homedir} from "node:os";
import {isAbsolute, join} from "node:path";
import {createLocalDesktopProfile} from "../apps/desktop/scripts/local-profile.mjs";

export async function createDesktopSandbox(executable: string, directory: string) {
  expect(isAbsolute(executable)).toBe(true);
  expect(isAbsolute(directory)).toBe(true);
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
  const rendererErrors: string[] = [];
  return {
    profile, name, rendererErrors,
    async launch() {
      const application = await _electron.launch({executablePath: executable, env, timeout: 45000});
      const observe = (page: Page) => page.on("pageerror", error => rendererErrors.push(error.stack ?? error.message));
      application.context().on("page", observe);
      for (const page of application.context().pages()) observe(page);
      return application;
    },
    async expectStopped(page: Page) {
      expect(await page.evaluate(() => window.daemonAPI.getStatus())).toMatchObject({state: "stopped"});
      await expect(access(attempts)).rejects.toMatchObject({code: "ENOENT"});
      for (const file of ["daemon.pid", "daemon.port"]) await expect(access(join(nativeProfile, file))).rejects.toMatchObject({code: "ENOENT"});
      expect((await stat(join(nativeProfile, "config.json"))).mode & 0o777).toBe(0o600);
    },
  };
}

export async function useEnglishDesktop(application: Awaited<ReturnType<typeof _electron.launch>>, directory: string) {
  expect(await application.evaluate(({app}) => app.getPath("userData"))).toBe(join(directory, "electron"));
  const page = await application.firstWindow();
  page.setDefaultTimeout(25000);
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => localStorage.setItem("multica-locale", "en"));
  await page.reload();
  return page;
}
