import { z } from "zod";
import { analysisContractSchema } from "./analysis";
import { businessContractSchema } from "./business";
import { contextContractSchema } from "./context";
import { developmentContractSchema } from "./development";
import { feedbackTriageContractSchema, feedbackVerifyContractSchema } from "./feedback";
import { planningContractSchema } from "./planning";
import { reproductionContractSchema } from "./reproduction";
import { reviewContractSchema } from "./review";
import { draftSchema, DraftConflictError, type ChainBinding, type ChainDraft } from "./runtime";
import { verificationContractSchema } from "./verification";

const contracts: Readonly<Record<string, z.ZodType<{ binding: ChainBinding }>>> = {
  "delivery-analysis": analysisContractSchema,
  development: developmentContractSchema,
  verification: verificationContractSchema,
  reproduction: reproductionContractSchema,
  review: reviewContractSchema,
  "feedback-triage": feedbackTriageContractSchema,
  "feedback-verify": feedbackVerifyContractSchema,
  "requirement-context": contextContractSchema,
  "delivery-plan": planningContractSchema,
  "idea-context": businessContractSchema,
  "business-design": businessContractSchema,
  "requirement-spec": businessContractSchema,
  "spec-review": businessContractSchema,
};

/** A repaired source needs new conclusions, not a new identity on old results. */
export function prepareRepairSuccessor(previous: ChainDraft, rawContract: Record<string, unknown>, binding: ChainBinding, id: string, attemptId: string) {
  const schema = contracts[previous.definition.id];
  if (!schema) throw new DraftConflictError("Unsupported repair successor workflow");
  const original = schema.parse(rawContract);
  if (JSON.stringify(original.binding) !== JSON.stringify(previous.binding)) throw new DraftConflictError("Repair successor must preserve the original contract binding");
  if (["review", "feedback-verify"].includes(previous.definition.id) && binding.codeVersion !== previous.binding.codeVersion) {
    throw new DraftConflictError("Accepted work changed; normal independent verification and evidence reconciliation are required before handoff");
  }
  const contract = z.record(z.string(), z.unknown()).parse(schema.parse({ ...rawContract, binding }));
  const phase = Object.keys(previous.definition.phases)[0];
  if (!phase || previous.status !== "editing" || previous.runtimeInputs.some(input => input.active && !input.answer)) {
    throw new DraftConflictError("Repair successor requires an editable checkpoint without unanswered input");
  }
  // Scenarios describe Expected. Results and reviews describe the old Actual.
  const retained = previous.definition.id === "verification" ? new Set(["verification.sources", "verification.scenarios"]) : new Set<string>();
  const draft = draftSchema.parse({
    ...structuredClone(previous), id, binding, attemptId, sequence: previous.sequence + 1,
    status: "editing", phase, completedPhases: [],
    artifacts: previous.artifacts.filter(item => retained.has(item.ref)), frozen: [], writeRules: [],
    runtimeInputs: previous.runtimeInputs.map(input => ({ ...input, active: false })),
    decisions: previous.decisions?.map(node => node.resolution?.authority === "user" ? node : { ...node, status: "proposed", resolution: undefined }),
    development: previous.definition.id === "development" ? { claims: [], checks: [] } : undefined,
    reproduction: undefined,
    events: [...previous.events, { sequence: previous.sequence + 1, attemptId, command: "host.repair.prepare", phase, reason: `Recheck obligations from surrendered draft ${previous.id}` }],
  });
  return { draft, contract };
}
