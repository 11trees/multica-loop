// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captureRepositoryOverlays, repositoryFingerprint, repositorySnapshot } from "./repository";

let root: string, repo: string;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function git(...args: string[]) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "engineering-repository-")); repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]); git("config", "user.name", "Repository fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "AGENTS.md"), "User instructions\n"); await writeFile(join(repo, "index.js"), "export const ready = true;\n"); git("add", "."); git("commit", "-qm", "Initialize");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("normalizes only exact runtime-generated files, preserving business fingerprint and clean commit semantics", async () => {
  const original = repositoryFingerprint(repo);
  const agents = "User instructions\n\nRuntime fixture\n", marker = "owned task marker";
  await writeFile(join(repo, "AGENTS.md"), agents); await mkdir(join(repo, ".multica")); await writeFile(join(repo, ".multica/task.json"), marker);
  const overlays = captureRepositoryOverlays(repo, [{ path: join(repo, "AGENTS.md"), hash: digest(agents) }, { path: join(repo, ".multica/task.json"), hash: digest(marker) }]);
  expect(() => repositorySnapshot(repo)).toThrow(/uncommitted/);
  expect(repositorySnapshot(repo, true, overlays).codeVersion).toBe(git("rev-parse", "HEAD"));
  expect(repositoryFingerprint(repo, overlays)).toBe(original);
  await writeFile(join(repo, "index.js"), "export const ready = false;\n");
  expect(repositoryFingerprint(repo, overlays)).not.toBe(original);
  expect(() => repositorySnapshot(repo, true, overlays)).toThrow(/uncommitted/);
  git("add", "index.js"); git("commit", "-qm", "Business change");
  expect(() => repositorySnapshot(repo, true, overlays)).not.toThrow();
  git("add", "AGENTS.md", ".multica"); git("commit", "-qm", "Accidentally commit runtime context");
  expect(() => repositorySnapshot(repo, true, overlays)).toThrow(/Do not commit runtime-owned/);
});

it("rejects altered runtime files, mismatched digests, outside paths, and dirty business files at binding", async () => {
  const file = join(repo, ".runtime-context"), content = "owned context";
  await writeFile(file, content);
  expect(() => captureRepositoryOverlays(repo, [{ path: file, hash: digest("invented") }])).toThrow(/changed before/);
  await writeFile(join(root, "outside"), content);
  expect(() => captureRepositoryOverlays(repo, [{ path: join(root, "outside"), hash: digest(content) }])).toThrow(/outside/);
  const overlays = captureRepositoryOverlays(repo, [{ path: file, hash: digest(content) }]);
  await writeFile(file, "Agent edit");
  expect(() => repositoryFingerprint(repo, overlays)).toThrow(/Runtime-owned file/);
  await writeFile(file, content); await writeFile(join(repo, "index.js"), "Unrelated dirty business code");
  expect(() => captureRepositoryOverlays(repo, [{ path: file, hash: digest(content) }])).toThrow(/uncommitted/);
});

it("keeps the same business fingerprint after the runtime restores its original files", async () => {
  const original = repositoryFingerprint(repo), originalAgents = await readFile(join(repo, "AGENTS.md"), "utf8");
  await writeFile(join(repo, "AGENTS.md"), "Injected");
  const overlays = captureRepositoryOverlays(repo, [{ path: join(repo, "AGENTS.md"), hash: digest("Injected") }]);
  await writeFile(join(repo, "AGENTS.md"), originalAgents);
  expect(repositoryFingerprint(repo, overlays)).toBe(original);
  expect(() => repositorySnapshot(repo, true, overlays)).not.toThrow();
});
