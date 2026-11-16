import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().trim().min(1);
export const repairContentVersionSchema = text.regex(/^workspace-content-v1:[a-f0-9]{40,64}:[a-f0-9]{64}$/);
const originalSchema = z.object({ observationId: text, workspaceId: z.uuid(), issueId: z.uuid(), origin: z.literal("business"), evidence: z.object({ original: z.object({ observationId: text, workspaceId: z.uuid(), issueId: z.uuid(), chain: text, snapshotHash: text, receiptHash: text, snapshot: z.record(z.string(), z.unknown()) }).passthrough() }).passthrough() }).passthrough();
export const repairVerificationInputSchema = z.strictObject({
  version: z.literal(1), caseId: text, sourceRepairAttemptId: text, generation: z.number().int().positive(), ownerId: text, supervisionToken: z.number().int().positive(), intentRevision: z.number().int().positive(),
  expectedVersion: repairContentVersionSchema,
  workspaceBinding: z.strictObject({ workspaceId: z.uuid(), issueId: z.uuid(), projectId: z.uuid(), runtimeId: z.uuid(), workspaceRoot: text, executionPath: text, mode: z.enum(["in_place", "worktree"]), sourceAttemptId: text, snapshotHash: text, targetsHash: text.regex(/^[a-f0-9]{64}$/) }),
  originalObservations: z.array(originalSchema).min(1),
  targets: z.array(z.strictObject({ targetRef: text, observationId: text, original: z.unknown() })).min(1),
});
export type RepairVerificationInput = z.infer<typeof repairVerificationInputSchema>;

/** Targets come from the immutable failed input, never repairer-proposed checks. */
export function originalRepairTargets(raw: unknown[]) {
  const originals = z.array(originalSchema).min(1).parse(raw);
  const targets: RepairVerificationInput["targets"] = [];
  for (const [index, observation] of originals.entries()) {
    const source = observation.evidence.original;
    if (source.observationId !== observation.observationId || source.workspaceId !== observation.workspaceId || source.issueId !== observation.issueId) throw new Error("Original observation identity does not match its frozen source");
    if (source.chain === "direct") {
      const direct = z.object({ direct: z.object({ input: text }) }).parse(source.snapshot);
      targets.push({ targetRef: `${observation.observationId}:original-input`, observationId: observation.observationId, original: direct.direct.input });
    } else {
      const contract = z.object({ contract: z.object({ sources: z.array(z.object({ key: text, oracle: text }).passthrough()).min(1) }).passthrough() }).parse(source.snapshot).contract;
      for (const item of contract.sources) targets.push({ targetRef: `${observation.observationId}:source:${item.key}`, observationId: observation.observationId, original: item });
    }
    targets.push({ targetRef: `${observation.observationId}:original-contract`, observationId: observation.observationId, original: { jsonPointer: `/originalObservations/${index}/evidence/original/snapshot` } });
    targets.push({ targetRef: `${observation.observationId}:original-failure`, observationId: observation.observationId, original: { jsonPointer: `/originalObservations/${index}/evidence/original` } });
  }
  if (new Set(targets.map(target => target.targetRef)).size !== targets.length) throw new Error("Original repair verification targets must be unique");
  return targets;
}
export function repairVerificationInputHash(input: RepairVerificationInput) {
  return createHash("sha256").update(JSON.stringify(repairVerificationInputSchema.parse(input))).digest("hex");
}
