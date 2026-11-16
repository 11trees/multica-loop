import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cutoverFixture } from "./loopwork-cutover-fixture.mjs";
import { changeSourceFence, inspectSourceFence, prepareSourceFence } from "./loopwork-source-fence.mjs";
import { createArchive } from "./loopwork-history-lib.mjs";

const owned = source => ({ id: randomUUID(), archive_hash: source.archive_hash, source_namespace: source.source_namespace, scope_hash: "a".repeat(64), preimages: source.preimages });
async function bytes(root) { return Object.fromEntries(await Promise.all((await readdir(root)).map(async name => [name, await readFile(join(root, name))]))); }

test("inspection leaves original WAL/SHM bytes untouched and only exports configuration digests", async t => {
  const f = await cutoverFixture(t), before = await bytes(f.dataRoot), source = await prepareSourceFence(f.archive, f.hash);
  assert.deepEqual(await bytes(f.dataRoot), before);
  assert.equal(JSON.stringify(source).includes("fixture-secret-must-not-export"), false);
  assert.equal(source.preimages.length, 3);
  assert.equal(source.execution_authorized, false);
  assert.equal(source.physical_quiescence_confirmed, false);
  const record = owned(source);
  assert.equal((await inspectSourceFence(f.archive, record)).state, "unfenced");
  assert.deepEqual(await bytes(f.dataRoot), before);
});

test("fences every original table across reopen, refuses old resume and preserves exact data on rollback", async t => {
  const f = await cutoverFixture(t), source = await prepareSourceFence(f.archive, f.hash), record = owned(source);
  const checks = [];
  const receipt = await changeSourceFence(f.archive, record, "freeze", async (_record, operation) => checks.push(operation));
  assert.equal(receipt.state, "frozen"); assert.equal(checks.length, 3);
  assert.throws(() => f.business.exec("UPDATE loop_lifecycle_state SET desired_intent='running'"), /frozen/);
  assert.throws(() => f.business.exec("UPDATE tasks SET agile_status='in_progress'"), /frozen/);
  assert.throws(() => f.app.exec("UPDATE runtime SET api_key='new'"), /frozen/);
  assert.throws(() => f.admin.exec("UPDATE admin_control SET desired_intent='running'"), /frozen/);
  for (const name of Object.keys(f.dbs)) {
    const reopened = new DatabaseSync(join(f.dataRoot, name));
    try {
      const tables = reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '__multica_cutover_*' AND name NOT LIKE 'sqlite_%'").all();
      for (const { name: table } of tables) {
        if (reopened.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n) assert.throws(() => reopened.exec(`DELETE FROM "${table}"`), /frozen/);
        assert.equal(reopened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name GLOB '__multica_cutover_*'").get(table).n, 3);
      }
    } finally { reopened.close(); }
  }
  assert.equal((await changeSourceFence(f.archive, record, "freeze", async () => {})).state, "frozen");
  assert.equal((await changeSourceFence(f.archive, record, "restore", async () => {})).state, "unfenced");
  const read = f.business.prepare("SELECT content,revision FROM documents"); read.setReadBigInts(true);
  assert.deepEqual(read.get(), Object.assign(Object.create(null), { content: new Uint8Array([255, 0, 1, 2]), revision: 9223372036854775807n }));
  assert.equal(f.admin.prepare("SELECT original_json FROM repair_cases").get().original_json, "Original failure provenance");
  assert.equal((await changeSourceFence(f.archive, record, "restore", async () => {})).state, "unfenced");
  f.business.exec("UPDATE loop_lifecycle_state SET desired_intent='running'");
});

test("partial freeze retries the same identity and never mutates the next database without native hold", async t => {
  const f = await cutoverFixture(t), record = owned(await prepareSourceFence(f.archive, f.hash));
  let calls = 0;
  await assert.rejects(changeSourceFence(f.archive, record, "freeze", async () => { if (++calls === 2) throw new Error("Native barrier unavailable"); }), /Native barrier/);
  assert.equal((await inspectSourceFence(f.archive, record)).state, "partial");
  assert.throws(() => f.app.exec("DELETE FROM runtime"), /frozen/);
  f.business.exec("UPDATE tasks SET title='Changed' WHERE task_id='pending'; UPDATE tasks SET title='Original pending' WHERE task_id='pending'");
  // Restoring source values does not restore its exact original WAL preimage.
  await assert.rejects(changeSourceFence(f.archive, record, "freeze", async () => {}), /changed since preparation/);
  assert.equal((await changeSourceFence(f.archive, record, "restore", async () => {})).state, "unfenced");
});

test("partial freeze and rollback recover after interruption without a new identity", async t => {
  const f = await cutoverFixture(t), record = owned(await prepareSourceFence(f.archive, f.hash));
  let calls = 0;
  await assert.rejects(changeSourceFence(f.archive, record, "freeze", async () => { if (++calls === 2) throw new Error("Interrupted"); }), /Interrupted/);
  assert.equal((await changeSourceFence(f.archive, record, "freeze", async () => {})).state, "frozen");
  calls = 0;
  await assert.rejects(changeSourceFence(f.archive, record, "restore", async () => { if (++calls === 2) throw new Error("Interrupted"); }), /Interrupted/);
  assert.equal((await inspectSourceFence(f.archive, record)).state, "partial");
  assert.equal((await changeSourceFence(f.archive, record, "restore", async () => {})).state, "unfenced");
});

test("foreign ownership, removed guards and source drift retain a blocking error", async t => {
  const f = await cutoverFixture(t), record = owned(await prepareSourceFence(f.archive, f.hash));
  await changeSourceFence(f.archive, record, "freeze", async () => {});
  await assert.rejects(inspectSourceFence(f.archive, { ...record, id: randomUUID() }), /another cutover/);
  const trigger = f.business.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '__multica_cutover_*' LIMIT 1").get().name;
  f.business.exec(`DROP TRIGGER "${trigger}"`);
  await assert.rejects(inspectSourceFence(f.archive, record), /trigger inventory/);
  await assert.rejects(changeSourceFence(f.archive, record, "restore", async () => {}), /trigger inventory/);
});

test("initial capture drift and non-stopped management intent refuse source freezing", async t => {
  const f = await cutoverFixture(t);
  f.admin.exec("UPDATE admin_control SET desired_intent='running'");
  await assert.rejects(prepareSourceFence(f.archive, f.hash), /changed since capture/);
  const next = join(f.root, "running-archive"), captured = await createArchive({ sourceRoot: f.sourceRoot, dataRoot: f.dataRoot, output: next });
  await assert.rejects(prepareSourceFence(next, captured.hash), /management\/admin_control is not stopped/);
});
