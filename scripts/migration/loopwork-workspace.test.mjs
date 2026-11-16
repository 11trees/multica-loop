import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWorkspace } from "./loopwork-workspace.mjs";

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "multica-workspace-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/file.md"), "Original tracked content\n");
  await writeFile(join(root, ".gitignore"), ".env\n");
  git("add", "."); git("-c", "user.name=Workspace fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Baseline");
  return { root, git };
}

test("workspace baseline includes dirty, staged, deleted and .tmp contents without writing the index", async t => {
  const { root, git } = await repository(t), indexPath = join(root, ".git/index");
  const clean = await captureWorkspace(root);
  assert.equal(clean.dirty, false);
  await writeFile(join(root, "nested/file.md"), "Staged new content\n"); git("add", ".");
  await writeFile(join(root, "nested/file.md"), "Working content after staging\n");
  await mkdir(join(root, ".tmp")); await writeFile(join(root, ".tmp/new\nfile"), "Untracked temporary work\n");
  await writeFile(join(root, ".env"), "do-not-export-secret");
  const before = await readFile(indexPath), saved = await captureWorkspace(root);
  assert.deepEqual(await readFile(indexPath), before);
  assert.equal(saved.head, clean.head); assert.equal(saved.dirty, true); assert.equal(saved.untracked_count, 1);
  assert.notEqual(saved.index.find(row => row.path === "nested/file.md").oid, saved.files.find(row => row.path === "nested/file.md").git_oid);
  assert.ok(saved.files.some(row => row.path === ".tmp/new\nfile"));
  assert.equal(JSON.stringify(saved).includes("Working content"), false);
  assert.equal(JSON.stringify(saved).includes("do-not-export-secret"), false);
  assert.equal(saved.execution_authorized, false);
  assert.deepEqual(await captureWorkspace(root), saved);
  await rm(join(root, "nested"), { recursive: true });
  const removed = await captureWorkspace(root);
  assert.equal(removed.deleted_count, 1);
  assert.equal(removed.files.find(row => row.path === "nested/file.md").kind, "deleted");
});

test("same HEAD and index cannot hide changed untracked bytes or file modes", async t => {
  const { root } = await repository(t);
  await writeFile(join(root, "new"), "one"); const first = await captureWorkspace(root);
  await writeFile(join(root, "new"), "two"); const second = await captureWorkspace(root);
  assert.equal(first.head, second.head); assert.deepEqual(first.index, second.index);
  assert.notDeepEqual(first.files, second.files);
  await chmod(join(root, "nested/file.md"), 0o755); const third = await captureWorkspace(root);
  assert.notDeepEqual(second.files, third.files);
});

test("staged deletion retains remaining bytes and symlinks retain only link identity", async t => {
  const { root, git } = await repository(t);
  git("rm", "--cached", "nested/file.md");
  await symlink("/missing-external-target", join(root, "link"));
  const result = await captureWorkspace(root);
  assert.ok(result.files.some(row => row.path === "nested/file.md" && row.kind === "file"));
  assert.ok(result.files.some(row => row.path === "link" && row.kind === "symlink"));
  assert.equal(result.dirty, true);
});

test("baseline disables repository fsmonitor commands and inherited alternate Git roots", async t => {
  const { root, git } = await repository(t);
  git("config", "core.fsmonitor", "definitely-not-a-real-agent-command");
  const prior = process.env.GIT_DIR;
  process.env.GIT_DIR = join(root, "not-the-index");
  try { assert.equal((await captureWorkspace(root)).dirty, false); }
  finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; }
  await assert.rejects(captureWorkspace(join(root, "nested")), /working tree root/);
});

test("readonly workspace inspection refuses lazy fetch even when the repository enables an external transport",async t=>{
 const {root,git}=await repository(t),tree=git('rev-parse','HEAD^{tree}').toString().trim(),marker=join(root,'unexpected-fetch'),transport=join(root,'fixture-transport');
 await writeFile(transport,`#!/bin/sh\ntouch '${marker}'\nexit 1\n`);await chmod(transport,0o700);
 git('config','core.repositoryformatversion','1');git('config','extensions.partialClone','fixture');git('config','remote.fixture.promisor','true');git('config','remote.fixture.url',`ext::${transport}`);git('config','protocol.ext.allow','always');
 await rm(join(root,'.git/objects',tree.slice(0,2),tree.slice(2)));
 await assert.rejects(captureWorkspace(root),/Git inspection failed/);await assert.rejects(readFile(marker),/ENOENT/);
 const controlEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};delete controlEnv.GIT_ALLOW_PROTOCOL;delete controlEnv.GIT_NO_LAZY_FETCH;
 assert.throws(()=>execFileSync('git',['-C',root,'ls-tree','-r','HEAD'],{env:controlEnv,stdio:['ignore','pipe','pipe']}));assert.equal((await readFile(marker)).length,0);
});
