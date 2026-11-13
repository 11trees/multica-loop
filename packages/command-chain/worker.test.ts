// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("the bundled worker accepts the private protocol without external runtime dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "engineering-worker-"));
  try {
    const output = execFileSync(process.execPath, [new URL("./dist/worker.mjs", import.meta.url).pathname, join(directory, "store.sqlite")], {
      encoding: "utf8", input: JSON.stringify({ action: "read", actor: {
        kind: "human", userId: "019a0000-0000-7000-8000-000000000001", workspaceId: "019a0000-0000-7000-8000-000000000002", issueId: "019a0000-0000-7000-8000-000000000003",
      } }),
    });
    expect(JSON.parse(output)).toEqual({ error: "No verification contract is configured for this issue", conflict: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
