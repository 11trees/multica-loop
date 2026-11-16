import { inspectSourceFence } from "./loopwork-source-fence.mjs";
import { probeSourceProcesses } from "./loopwork-source-processes.mjs";
import { createHash } from "node:crypto";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export async function inspectNativeSource(archive, input) {
  const record = input.record, payload = record.payload;
  const hash = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  if (record.archive_hash !== input.expected_hash || hash !== record.scope_hash || payload?.format !== "loopwork-cutover-hold-v1" || payload.source?.archive_hash !== record.archive_hash || payload.source?.source_namespace !== record.source_namespace) throw new Error("Native source scope changed");
  const identity = { id: record.id, archive_hash: record.archive_hash, scope_hash: record.scope_hash, source_namespace: record.source_namespace, preimages: payload.source.preimages };
  const fence = await inspectSourceFence(archive, identity);
  if (fence.state !== "frozen") throw new Error("Native staging requires the entire source cohort frozen");
  const processes = await probeSourceProcesses(archive, input.expected_hash, identity);
  if (!processes.registered_writers_quiesced) throw new Error("Source registered writers require reconciliation");
  return { format: "loopwork-native-source-inspection-v1", cutover_id: record.id, archive_hash: record.archive_hash, scope_hash: record.scope_hash, source_namespace: record.source_namespace, source_frozen: true, registered_writers_quiesced: true, physical_quiescence_confirmed: false, execution_authorized: false, processes };
}
