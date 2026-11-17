import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function desktopProfileDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MULTICA_DESKTOP_PROFILE_DIR;
  if (raw === undefined) return null;
  if (!raw.trim() || !isAbsolute(raw.trim())) {
    throw new Error("MULTICA_DESKTOP_PROFILE_DIR must be an absolute directory");
  }
  return resolve(raw.trim());
}

export function desktopProfileSuffix(): string {
  const directory = desktopProfileDirectory();
  return directory
    ? `-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`
    : "";
}

export function desktopRuntimeConfigPath(home: string): string {
  return join(desktopProfileDirectory() ?? join(home, ".multica"), "desktop.json");
}

export function desktopDaemonPreferencesPath(): string {
  const directory = desktopProfileDirectory();
  return directory
    ? join(directory, "daemon-prefs.json")
    : join(homedir(), ".multica", "desktop_prefs.json");
}

export function desktopDaemonDefaultPreferences() {
  return { autoStart: desktopProfileDirectory() === null, autoStop: false };
}
