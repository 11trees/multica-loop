import { parse, stringify } from "yaml";
import { z } from "zod";
import { artifactBlock } from "./artifacts";
import { draftSchema, PhaseValidationError, type BuiltinHandler, type BuiltinHandlers, type ChainDraft } from "./runtime";

const text = z.string().trim().min(1);
const sourceSchema = z.strictObject({
  kind: z.enum(["acceptance", "focus", "guardrail", "recovery"]),
  description: text,
  oracle: text,
  sourceRef: text,
});
// Artifact writes enforce declared fields; builtins interpret their semantic subset.
const scenarioSchema = z.object({
  channel: z.enum(["frontend", "api"]),
  title: text,
  setup: text,
  steps: text,
  expected: text,
  coverageRefs: z.array(text).min(1),
});
const resultSchema = z.object({
  status: z.enum(["passed", "failed", "blocked"]),
  failureKind: z.enum(["implementation", "specification", "environment", "inconclusive"]).nullish(),
  evidence: text,
  actualBehavior: text.nullish(),
});
const reviewSchema = z.object({ summary: text, residualRisk: text.nullish() });
const contractSchema = z.strictObject({
  binding: draftSchema.shape.binding,
  sources: z.array(sourceSchema.extend({ key: text.max(120) })).min(1),
}).superRefine((value, ctx) => {
  if (new Set(value.sources.map(source => source.key)).size !== value.sources.length) {
    ctx.addIssue({ code: "custom", message: "Verification source keys must be unique" });
  }
  if (!value.sources.some(source => source.kind === "acceptance")) {
    ctx.addIssue({ code: "custom", message: "Verification contract must include an acceptance" });
  }
});

export type VerificationContract = z.infer<typeof contractSchema>;

function withRuntimeInputs(handler: BuiltinHandler): BuiltinHandler {
  return Object.assign(handler, { runtimeInputs: true });
}

function rows<T>(draft: Readonly<ChainDraft>, ref: string, schema: z.ZodType<T>) {
  return draft.artifacts.filter(item => item.ref === ref).map(item => ({ key: item.key, value: schema.parse(parse(item.content)) }));
}

function bindingErrors(draft: Readonly<ChainDraft>, contract: VerificationContract): string[] {
  const errors: string[] = [];
  if (draft.definition.id !== "verification" || draft.definition.agent !== "test-agent") errors.push("Expected independent verification chain");
  for (const key of Object.keys(contract.binding) as (keyof VerificationContract["binding"])[]) {
    if (draft.binding[key] !== contract.binding[key]) errors.push(`Verification binding ${key} is stale or belongs to another delivery`);
  }
  const block = artifactBlock(draft.definition, "verification.sources");
  if (block.writable || block.cardinality !== "many" || block.format !== "yaml") errors.push("Verification sources must be readonly keyed YAML items");
  return errors;
}

function frozenInputErrors(draft: Readonly<ChainDraft>, contract: VerificationContract): string[] {
  const errors = bindingErrors(draft, contract);
  const sources = rows(draft, "verification.sources", sourceSchema);
  if (sources.length !== contract.sources.length) errors.push("Frozen verification input count differs from the contract");
  for (const source of contract.sources) {
    const stored = sources.find(item => item.key === source.key);
    const { key, ...expected } = source;
    if (!stored || JSON.stringify(stored.value) !== JSON.stringify(expected)) errors.push(`Frozen verification source ${key} differs from the contract`);
  }
  return errors;
}

function planErrors(draft: Readonly<ChainDraft>, contract: VerificationContract): string[] {
  const errors = frozenInputErrors(draft, contract);
  const scenarios = rows(draft, "verification.scenarios", scenarioSchema);
  if (!scenarios.length) errors.push("Verification plan requires at least one scenario");
  const sourceKeys = new Set(contract.sources.map(source => source.key));
  for (const scenario of scenarios) {
    for (const ref of scenario.value.coverageRefs) {
      if (!sourceKeys.has(ref)) errors.push(`Scenario ${scenario.key} refers to unknown verification source ${ref}`);
    }
    if (new Set(scenario.value.coverageRefs).size !== scenario.value.coverageRefs.length) errors.push(`Scenario ${scenario.key} repeats coverage references`);
  }
  for (const source of contract.sources) {
    if (!scenarios.some(scenario => scenario.value.coverageRefs.includes(source.key))) errors.push(`Verification source ${source.key} has no scenario coverage`);
  }
  // Preserve the legacy policy: all sources covered, at least one acceptance via frontend.
  if (!scenarios.some(scenario => scenario.value.channel === "frontend"
    && contract.sources.some(source => source.kind === "acceptance" && scenario.value.coverageRefs.includes(source.key)))) {
    errors.push("At least one acceptance must have a frontend scenario");
  }
  return errors;
}

function executionErrors(draft: Readonly<ChainDraft>, contract: VerificationContract): string[] {
  const errors = planErrors(draft, contract);
  const scenarios = rows(draft, "verification.scenarios", scenarioSchema);
  const results = rows(draft, "verification.results", resultSchema);
  for (const scenario of scenarios) {
    if (!results.some(result => result.key === scenario.key)) errors.push(`Scenario ${scenario.key} has no observed result`);
  }
  for (const result of results) {
    if (!scenarios.some(scenario => scenario.key === result.key)) errors.push(`Result ${result.key} has no matching scenario`);
    const { status, failureKind } = result.value;
    if (status === "passed" && failureKind) errors.push(`Passed result ${result.key} must not declare a failure kind`);
    if (status === "failed" && failureKind !== "implementation" && failureKind !== "specification") errors.push(`Failed result ${result.key} requires implementation or specification attribution`);
    if (status === "blocked" && failureKind !== "environment" && failureKind !== "inconclusive") errors.push(`Blocked result ${result.key} requires environment or inconclusive attribution`);
    if (status === "blocked") errors.push(`Scenario ${result.key} is blocked; resolve runtime input and rerun before completion`);
  }
  return errors;
}

function finalErrors(draft: Readonly<ChainDraft>, contract: VerificationContract): string[] {
  const errors = executionErrors(draft, contract);
  const reviews = rows(draft, "verification.evidence-review", reviewSchema);
  if (reviews.length !== 1) errors.push("Verification requires one evidence-review summary");
  return errors;
}

/** Contract data must come from a trusted frozen host snapshot, never agent arguments. */
export function createVerificationHandlers(input: VerificationContract): BuiltinHandlers {
  const contract = contractSchema.parse(input);
  return {
    "verification-inputs": draft => {
      const errors = bindingErrors(draft, contract);
      const existing = draft.artifacts.some(item => item.ref === "verification.sources");
      if (existing) errors.push(...frozenInputErrors(draft, contract));
      return {
        errors: [...new Set(errors)],
        artifacts: existing ? [] : contract.sources.map(({ key, ...source }) => ({
          ref: "verification.sources", key, content: stringify(source).trim(),
        })),
        freeze: ["verification.sources"],
      };
    },
    "verification-plan": withRuntimeInputs(draft => ({
      errors: [
        ...planErrors(draft, contract),
        ...(draft.artifacts.some(item => item.ref === "verification.results") ? ["Observed results cannot precede the frozen verification plan"] : []),
      ],
      freeze: ["verification.scenarios"],
      writeRules: [{ ref: "verification.scenarios", mode: "append-only" }],
    })),
    "verification-execution": withRuntimeInputs(draft => ({
      errors: executionErrors(draft, contract),
      writeRules: [
        { ref: "verification.scenarios", mode: "sealed" },
        { ref: "verification.results", mode: "sealed" },
      ],
    })),
    "verification-finalize": draft => ({
      errors: finalErrors(draft, contract),
      writeRules: [{ ref: "verification.evidence-review", mode: "sealed" }],
    }),
  };
}

/** Compiles a stored completed draft; this is not a signed host handoff receipt. */
export function compileVerificationConclusion(draft: Readonly<ChainDraft>, input: VerificationContract) {
  const contract = contractSchema.parse(input);
  const errors = finalErrors(draft, contract);
  const order = Object.keys(draft.definition.phases);
  if (draft.status !== "completed" || draft.phase !== null || JSON.stringify(draft.completedPhases) !== JSON.stringify(order)) {
    errors.push("Verification draft has not completed all phases");
  }
  if (errors.length) throw new PhaseValidationError(errors);
  const results = rows(draft, "verification.results", resultSchema);
  const failed = results.filter(result => result.value.status === "failed");
  const failureKind = failed.some(result => result.value.failureKind === "specification") ? "specification" as const : "implementation" as const;
  const review = rows(draft, "verification.evidence-review", reviewSchema)[0]!.value;
  return {
    kind: "verification" as const,
    draftId: draft.id,
    sequence: draft.sequence,
    attemptId: draft.attemptId,
    binding: structuredClone(draft.binding),
    verdict: failed.length ? "failed" as const : "passed" as const,
    ...(failed.length ? { failureKind, rewindTo: failureKind === "specification" ? "analysis" as const : "dev" as const } : {}),
    results: results.map(result => ({ key: result.key, ...result.value })),
    review,
  };
}
