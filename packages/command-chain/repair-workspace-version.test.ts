// @vitest-environment node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { readRepairWorkspaceVersion } from "./repair-workspace-version";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "repair-version-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture() {
  const root = join(directory, randomUUID(), "owned project's source");
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "Independent version test"]);
  git(["config", "user.email", "version@example.invalid"]);
  writeFileSync(join(root, "feature.txt"), "fixed");
  writeFileSync(join(root, ".gitignore"), ".env*\n.tmp/\n");
  git(["add", "--", "feature.txt", ".gitignore"]);
  git(["commit", "-qm", "Original source"]);
  return { root, git };
}

test('workspace identity is stable and read-only but detects tracked, untracked and staged content without a new commit', async () => {
  const h = fixture();
  const beforeIndex = readFileSync(join(h.root, '.git', 'index'));
  const original = await readRepairWorkspaceVersion(h.root);
  assert.match(original, /^workspace-content-v1:[0-9a-f]{40,64}:[0-9a-f]{64}$/);
  assert.equal(await readRepairWorkspaceVersion(h.root), original);
  assert.deepEqual(readFileSync(join(h.root, '.git', 'index')), beforeIndex, 'No git add/temp index/write-tree during identity reads');
  writeFileSync(join(h.root, 'feature.txt'), 'different content');
  const dirty = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(dirty, original);
  h.git(['add', '--', 'feature.txt']);
  assert.equal(await readRepairWorkspaceVersion(h.root), dirty, 'Index staging alone does not change the executed source');
  const path = process.platform === 'win32' ? '-untracked source.txt' : '-untracked\nsource.txt';
  writeFileSync(join(h.root, path), 'actual new source');
  const added = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(added, dirty);
  writeFileSync(join(h.root, path), 'different new source');
  assert.notEqual(await readRepairWorkspaceVersion(h.root), added, 'Untracked path names are NUL-delimited, not split on lines');
  assert.equal(h.git(['rev-parse', 'HEAD']), original.split(':')[1]);
});

test('assume-unchanged source and ignored runtime configuration cannot hide an actual version change', async () => {
  const h = fixture();
  h.git(['update-index', '--assume-unchanged', 'feature.txt']);
  const original = await readRepairWorkspaceVersion(h.root);
  writeFileSync(join(h.root, 'feature.txt'), 'changed although git status is clean');
  assert.equal(h.git(['status', '--porcelain']), '');
  const changed = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(changed, original);
  const secret = `fixture-secret-${randomUUID()}`;
  writeFileSync(join(h.root, '.env.local'), `API_KEY=${secret}`);
  const configured = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(configured, changed);
  assert.equal(configured.includes(secret), false);
  writeFileSync(join(h.root, '.env.test'), 'TEST_ENDPOINT=actual-test-service');
  const withTestConfiguration = await readRepairWorkspaceVersion(h.root);
  assert.notEqual(withTestConfiguration, configured, 'Capture all root .env variants, not only production or local names');
  mkdirSync(join(h.root, '.tmp'), { recursive: true });
  writeFileSync(join(h.root, '.tmp', 'agent-generated-check.mjs'), 'Temporary test witness');
  assert.equal(await readRepairWorkspaceVersion(h.root), withTestConfiguration, 'Untracked Agent scratch files are not source changes');
  h.git(['add', '-f', '--', '.tmp/agent-generated-check.mjs']);
  assert.notEqual(await readRepairWorkspaceVersion(h.root), withTestConfiguration, 'Tracked files are included even under .tmp');
});

test('unreadable roots, escaping symlinks, cancellation and invalid deadlines never fabricate a version', async () => {
  const h = fixture();
  const plain = join(directory, randomUUID());
  mkdirSync(plain);
  await assert.rejects(readRepairWorkspaceVersion(plain), /git|Git/);
  await assert.rejects(readRepairWorkspaceVersion(h.root, { timeoutMs: 0 }), /positive/);
  const stopped = new AbortController(); stopped.abort(new Error('User stopped'));
  await assert.rejects(readRepairWorkspaceVersion(h.root, { signal: stopped.signal }), /User stopped/);
  await assert.rejects(readRepairWorkspaceVersion(h.root, { extraPaths: ['../outside'] }), /outside/);
  if (process.platform !== 'win32') {
    const outside = join(directory, `${randomUUID()}.txt`);
    writeFileSync(outside, 'External file is not owned');
    symlinkSync(outside, join(h.root, 'escaping-source'));
    await assert.rejects(readRepairWorkspaceVersion(h.root), /escapes/);
  }
});

test('internal directory skill aliases include their entire tree, including ignored content, without modifying the index',
  { skip: process.platform === 'win32' }, async () => {
    const h = fixture();
    mkdirSync(join(h.root, '.ai', 'skills', 'example'), { recursive: true });
    mkdirSync(join(h.root, '.claude'));
    writeFileSync(join(h.root, '.ai', 'skills', 'example', 'SKILL.md'), 'Original skill instructions');
    writeFileSync(join(h.root, '.ai', 'skills', 'example', '.env.local'), 'SECRET=fixture-only');
    symlinkSync('../.ai/skills', join(h.root, '.claude', 'skills'), 'dir');
    const index = readFileSync(join(h.root, '.git', 'index'));
    const original = await readRepairWorkspaceVersion(h.root);
    assert.equal(await readRepairWorkspaceVersion(h.root), original);
    writeFileSync(join(h.root, '.ai', 'skills', 'example', '.env.local'), 'SECRET=changed-fixture-only');
    const changed = await readRepairWorkspaceVersion(h.root);
    assert.notEqual(changed, original, 'Ignored files reached through an owned directory alias still affect actual instructions');
    assert.equal(changed.includes('changed-fixture-only'), false);
    writeFileSync(join(h.root, '.ai', 'skills', 'example', 'SKILL.md'), 'Changed actual skill instructions');
    assert.notEqual(await readRepairWorkspaceVersion(h.root), changed);
    assert.deepEqual(readFileSync(join(h.root, '.git', 'index')), index);
  });

test('recursive directory aliases reject cycles and external nested targets instead of fabricating an empty tree version',
  { skip: process.platform === 'win32' }, async () => {
    const cyclic = fixture();
    mkdirSync(join(cyclic.root, 'actual-tree'));
    symlinkSync('actual-tree', join(cyclic.root, 'alias'), 'dir');
    symlinkSync('.', join(cyclic.root, 'actual-tree', 'self'), 'dir');
    await assert.rejects(readRepairWorkspaceVersion(cyclic.root), /cycle/);
    const escaping = fixture();
    mkdirSync(join(escaping.root, 'actual-tree'));
    symlinkSync('actual-tree', join(escaping.root, 'alias'), 'dir');
    const external = join(directory, randomUUID());
    mkdirSync(external);
    writeFileSync(join(external, 'external.txt'), 'Not owned source');
    symlinkSync(external, join(escaping.root, 'actual-tree', 'external'), 'dir');
    await assert.rejects(readRepairWorkspaceVersion(escaping.root), /escapes/);
  });

test('unsupported actual Git submodule directory entries still fail rather than treating the checkout as empty content', async () => {
  const h = fixture();
  mkdirSync(join(h.root, 'submodule'));
  writeFileSync(join(h.root, 'submodule', 'actual-source.txt'), 'Source tree needs its own Git checkout capability');
  h.git(['update-index', '--add', '--cacheinfo', `160000,${h.git(['rev-parse', 'HEAD'])},submodule`]);
  await assert.rejects(readRepairWorkspaceVersion(h.root), /not a regular file/);
});

test('workspace hashing yields to heartbeat timers while reading actual binary source', async () => {
  const h = fixture();
  writeFileSync(join(h.root, 'large-source.bin'), Buffer.alloc(16 * 1024 * 1024, 123));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    assert.match(await readRepairWorkspaceVersion(h.root), /^workspace-content-v1:/);
    assert.ok(ticks > 0, 'Git identity and hashing must not synchronously starve host renewal');
  } finally { clearInterval(timer); }
});

test('ownership loss cancels an in-flight source read instead of keeping Git or file streams running until the deadline', async () => {
  const h = fixture();
  writeFileSync(join(h.root, 'large-source.bin'), Buffer.alloc(32 * 1024 * 1024, 45));
  let current = true;
  const timer = setTimeout(() => { current = false; }, 10);
  try {
    await assert.rejects(readRepairWorkspaceVersion(h.root, { assertCurrent: () => {
      if (!current) throw new Error('User stopped or ownership changed');
    } }), /User stopped or ownership changed|aborted/i);
  } finally { clearTimeout(timer); }
});

test('an inherited GIT_DIR cannot redirect source identity to a different repository', async () => {
  const h = fixture(); const other = fixture();
  const expected = await readRepairWorkspaceVersion(h.root);
  const prior = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.root, '.git');
  try { assert.equal(await readRepairWorkspaceVersion(h.root), expected); }
  finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; }
});

