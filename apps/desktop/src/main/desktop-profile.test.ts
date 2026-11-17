// @vitest-environment node
import {afterEach, expect, it, vi} from "vitest";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  desktopDaemonDefaultPreferences,
  desktopDaemonPreferencesPath,
  desktopProfileDirectory,
  desktopRuntimeConfigPath,
} from "./desktop-profile";
import {deriveProfileName} from "./daemon-profile";
afterEach(() => vi.unstubAllEnvs());

it("isolates configuration/preferences and daemon identity without changing global defaults", () => {
  vi.stubEnv("MULTICA_DESKTOP_PROFILE_DIR", undefined);
  expect(desktopDaemonDefaultPreferences()).toEqual({autoStart: true, autoStop: false});
  expect(deriveProfileName("http://localhost:18729")).toBe("desktop-localhost-18729");
  const directory = join(tmpdir(), "local-profile");
  vi.stubEnv("MULTICA_DESKTOP_PROFILE_DIR", directory);
  expect(desktopProfileDirectory()).toBe(directory);
  expect(desktopRuntimeConfigPath("/unused-home")).toBe(join(directory, "desktop.json"));
  expect(desktopDaemonPreferencesPath()).toBe(join(directory, "daemon-prefs.json"));
  expect(desktopDaemonDefaultPreferences()).toEqual({autoStart: false, autoStop: false});
  const first = deriveProfileName("http://localhost:18729");
  expect(first).toMatch(/^desktop-localhost-18729-[a-f0-9]{12}$/);
  vi.stubEnv("MULTICA_DESKTOP_PROFILE_DIR", join(tmpdir(), "other-profile"));
  expect(deriveProfileName("http://localhost:18729")).not.toBe(first);
  vi.stubEnv("MULTICA_DESKTOP_PROFILE_DIR", "relative");
  expect(() => desktopProfileDirectory()).toThrow(/absolute/);
  expect(() => deriveProfileName("http://localhost:18729")).toThrow(/absolute/);
});
