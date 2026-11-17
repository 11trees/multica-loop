import {mkdir, realpath, writeFile, rm} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

function localOrigin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) throw new Error("Use an explicit loopback HTTP origin");
  return url.origin;
}

export async function createLocalDesktopProfile({directory, apiUrl, appUrl}) {
  if (!directory || !isAbsolute(directory)) throw new Error("Use an absolute new Desktop profile directory");
  apiUrl = localOrigin(apiUrl);
  appUrl = localOrigin(appUrl);
  directory = resolve(directory);
  await mkdir(dirname(directory), {recursive: true, mode: 0o700});
  const output = join(await realpath(dirname(directory)), basename(directory));
  await mkdir(output, {mode: 0o700});
  try {
    await mkdir(join(output, "electron"), {mode: 0o700});
    const files = {
      "desktop.json": {schemaVersion: 1, apiUrl, appUrl},
      "daemon-prefs.json": {autoStart: false, autoStop: false},
      "electron/updater-preferences.json": {automaticUpdates: false},
    };
    for (const [path, value] of Object.entries(files)) {
      await writeFile(join(output, path), JSON.stringify(value, null, 2) + "\n", {mode: 0o600, flag: "wx"});
    }
    return {directory: output, api_url: apiUrl, app_url: appUrl, daemon_auto_start: false, automatic_updates: false};
  } catch (error) {
    await rm(output, {recursive: true, force: true});
    throw error;
  }
}

export async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || !args[index + 1] || Object.hasOwn(options, args[index])) {
      throw new Error("Use distinct profile options");
    }
    options[args[index]] = args[index + 1];
  }
  if (Object.keys(options).sort().join() !== ["--directory", "--api-url", "--app-url"].sort().join()) {
    throw new Error("Use --directory /new/private/profile --api-url http://localhost:API_PORT --app-url http://localhost:WEB_PORT");
  }
  return createLocalDesktopProfile({directory: options["--directory"], apiUrl: options["--api-url"], appUrl: options["--app-url"]});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
