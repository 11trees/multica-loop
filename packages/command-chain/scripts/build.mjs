import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

await build({
  entryPoints: [new URL("../worker.ts", import.meta.url).pathname],
  outfile: new URL("../dist/worker.mjs", import.meta.url).pathname,
  bundle: true, platform: "node", format: "esm", target: "node22.13",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  define: {
    DEFAULT_IDEA_CONTEXT_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/idea-context.yaml", import.meta.url), "utf8")),
    DEFAULT_BUSINESS_DESIGN_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/business-design.yaml", import.meta.url), "utf8")),
    DEFAULT_REQUIREMENT_SPEC_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/requirement-spec.yaml", import.meta.url), "utf8")),
    DEFAULT_SPEC_REVIEW_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/spec-review.yaml", import.meta.url), "utf8")),
    DEFAULT_VERIFICATION_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/verification.yaml", import.meta.url), "utf8")),
    DEFAULT_CONTEXT_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/context.yaml", import.meta.url), "utf8")),
    DEFAULT_FEEDBACK_TRIAGE_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/feedback-triage.yaml", import.meta.url), "utf8")),
    DEFAULT_FEEDBACK_VERIFY_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/feedback-verify.yaml", import.meta.url), "utf8")),
    DEFAULT_REPRODUCTION_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/reproduction.yaml", import.meta.url), "utf8")),
    DEFAULT_REVIEW_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/review.yaml", import.meta.url), "utf8")),
    DEFAULT_PLANNING_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/planning.yaml", import.meta.url), "utf8")),
    DEFAULT_ANALYSIS_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/analysis.yaml", import.meta.url), "utf8")),
    DEFAULT_DEVELOPMENT_SOURCE: JSON.stringify(readFileSync(new URL("../definitions/development.yaml", import.meta.url), "utf8")),
  },
});
