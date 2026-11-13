import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

await build({
  entryPoints: [new URL("../worker.ts", import.meta.url).pathname],
  outfile: new URL("../dist/worker.mjs", import.meta.url).pathname,
  bundle: true, platform: "node", format: "esm", target: "node22.13",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  define: { DEFAULT_VERIFICATION_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/verification.yaml", import.meta.url), "utf8")) },
});
