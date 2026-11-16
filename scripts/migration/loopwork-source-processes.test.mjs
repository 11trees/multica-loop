import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import { cutoverFixture } from "./loopwork-cutover-fixture.mjs";
import { changeSourceFence, prepareSourceFence } from "./loopwork-source-fence.mjs";
import { assessSourceProcesses, observeSourceHost, parseHostProcesses, probeSourceProcesses } from "./loopwork-source-processes.mjs";

const sourceTestHost = () => ({ platform: "darwin", boot: { id: "fixture-boot", started_at: Date.parse("2020-01-01T00:00:00Z") }, observed_at: "2026-01-01T00:00:00Z", processes: [{ pid: 424242, parent_pid: 1, group_id: 424242, marker: "Thu Jan 1 00:00:00 2026" }], database_holders: [] });
const writer = () => ({ table: "loop_managed_processes", id: "original", pid: 424242, marker: "Sat Jan 1 00:00:00 2000", registered_at: "2000-01-01 00:00:00", group_id: null });

test("later boot proves the recorded writer exited even when its PID is now reused", () => {
  const proof = assessSourceProcesses([writer()], [{ id: "run", started_at: "2000-01-01T00:00:00Z", status: "stopped" }], sourceTestHost());
  assert.equal(proof.registered_writers_quiesced, true);
  assert.equal(proof.writers[0].state, "exited_before_host_boot");
  assert.equal(proof.execution_authorized, false);
  assert.equal(proof.scope, "local_loopwork_registered_writers");
});

test("a missing PID, null identity or stopped database status cannot prove a same-boot writer retired", () => {
  const current = { ...writer(), marker: "Thu Jan 1 00:00:00 2026", registered_at: "2026-01-01 00:00:00", status: "exited" };
  assert.equal(assessSourceProcesses([current], [], sourceTestHost()).blockers[0].code, "recorded_writer_alive");
  const host = sourceTestHost(); host.processes = [];
  assert.equal(assessSourceProcesses([current], [], host).blockers[0].code, "recorded_writer_unconfirmed");
  assert.equal(assessSourceProcesses([{ ...writer(), pid: null, marker: null }], [], host).registered_writers_quiesced, false);
  assert.equal(assessSourceProcesses([{ ...writer(), registered_at: null }], [], host).registered_writers_quiesced, false);
  assert.equal(assessSourceProcesses([{ ...writer(), registered_at: "1" }], [], host).registered_writers_quiesced, false);
  assert.equal(assessSourceProcesses([writer()], [{ id: "run", status: "stopped", started_at: "invalid" }], host).registered_writers_quiesced, false);
  host.database_holders = [{ pid: 12, path: "/source/database.db" }];
  assert.equal(assessSourceProcesses([writer()], [], host).blockers[0].code, "source_database_open");
});

test("host process parsing rejects truncated or empty snapshots", () => {
  assert.deepEqual(parseHostProcesses("42 1 42 Sat Jan  1 00:00:00 2000\n"), [{ pid: 42, parent_pid: 1, group_id: 42, marker: "Sat Jan 1 00:00:00 2000" }]);
  for (const output of ["", "42 1 42", "42 1 42 invalid", "42 1 42 Sat Jan 1 00:00:00 2000\n42 1 42 Sat Jan 1 00:00:00 2000"]) assert.throws(() => parseHostProcesses(output), /incomplete/);
});

test("source observations bind all named writer tables and require frozen records before persistent observation", async t => {
  const f = await cutoverFixture(t), inspectHost = async () => sourceTestHost();
  const first = await probeSourceProcesses(f.archive, f.hash, null, inspectHost);
  assert.equal(first.source_frozen, false); assert.equal(first.registered_writers_quiesced, true);
  assert.equal(first.physical_quiescence_confirmed, false);
  const source = await prepareSourceFence(f.archive, f.hash), record = { id: randomUUID(), archive_hash: f.hash, source_namespace: source.source_namespace, scope_hash: "a".repeat(64), preimages: source.preimages };
  await assert.rejects(probeSourceProcesses(f.archive, f.hash, record, inspectHost), /entire cohort frozen/);
  await changeSourceFence(f.archive, record, "freeze", async () => {});
  const frozen = await probeSourceProcesses(f.archive, f.hash, record, inspectHost);
  assert.equal(frozen.source_frozen, true); assert.equal(frozen.registered_writers_quiesced, true);
  assert.deepEqual(frozen.writers, first.writers);
});

test("a changing source during host observation refuses the receipt", async t => {
  const f = await cutoverFixture(t);
  await assert.rejects(probeSourceProcesses(f.archive, f.hash, null, async () => { f.business.exec("UPDATE tasks SET title='Changed'"); return sourceTestHost(); }), /changed since capture/);
});

test("real OS observation finds open fixture databases without invoking a provider", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  if (!await access(process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof").then(() => true, () => false)) { t.skip("lsof is required for database-holder observation"); return; }
  const f = await cutoverFixture(t);
  const host = await observeSourceHost([f.dataRoot + "/loop-ui.db"]);
  assert.equal(host.platform, process.platform);
  assert.ok(host.processes.some(row => row.pid === process.pid));
  assert.ok(host.database_holders.some(row => row.pid === process.pid));
  assert.equal(typeof host.boot.id, "string");
});
