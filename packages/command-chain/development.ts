import { z } from "zod";
import { parse } from "yaml";
import { verificationContractSchema } from "./verification";
import { PhaseValidationError, type ChainDraft, type BuiltinHandlers, type ChainCommand } from "./runtime";

export const developmentContractSchema = verificationContractSchema.safeExtend({ implementationGuidance: z.string().trim().min(1) });
export type DevelopmentContract = z.infer<typeof developmentContractSchema>;
const text = z.string().trim().min(1);
export const commandReceiptSchema = z.strictObject({
  id: text, attemptId: text, sequence: z.number().int().nonnegative(),
  command: text, commandHash: text, cwd: text,
  status: text, exitCode: z.number().int().nullable(), fingerprint: text,
});
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type DevelopmentRuntime = {
  receipts: () => readonly CommandReceipt[];
  fingerprint: () => string;
};

function evidenceErrors(draft: Readonly<ChainDraft>, contract: DevelopmentContract): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(contract.binding) as (keyof DevelopmentContract["binding"])[]) {
    if (draft.binding[key] !== contract.binding[key]) errors.push(`Development binding ${key} changed`);
  }
  const acceptances = contract.sources.filter(source => source.kind === "acceptance");
  for (const acceptance of acceptances) {
    if (!draft.development?.claims.some(claim => claim.key === acceptance.key)) errors.push(`Acceptance ${acceptance.key} has no implementation claim`);
  }
  for (const claim of draft.development?.claims ?? []) {
    if (!acceptances.some(acceptance => acceptance.key === claim.key)) errors.push(`Unknown implementation claim ${claim.key}`);
  }
  for (const recovery of contract.sources.filter(source => source.kind === "recovery")) {
    if (!draft.artifacts.some(item => item.ref === "development.recovery-resolutions" && item.key === recovery.key)) errors.push(`Recovery ${recovery.key} has no resolution`);
  }
  return errors;
}

function checkErrors(draft: Readonly<ChainDraft>, runtime: DevelopmentRuntime): string[] {
  const errors: string[] = [];
  const checks = draft.development?.checks ?? [];
  if (!checks.length) errors.push("At least one current successful captured command is required");
  const receipts = runtime.receipts();
  const fingerprint = runtime.fingerprint();
  for (const check of checks) {
    const receipt = receipts.find(receipt => receipt.id === check.receiptId);
    if (!receipt || receipt.attemptId !== draft.attemptId) { errors.push(`Check ${check.key} is not from the current run`); continue; }
    if (receipt.status !== "completed" || receipt.exitCode !== 0) errors.push(`Check ${check.key} did not explicitly succeed`);
    if (receipt.fingerprint !== fingerprint) errors.push(`Check ${check.key} belongs to an earlier repository snapshot`);
    if (receipts.some(later => later.attemptId === draft.attemptId && later.commandHash === receipt.commandHash && later.sequence > receipt.sequence)) errors.push(`Check ${check.key} was superseded by a later execution of the same command`);
  }
  return errors;
}

export function createDevelopmentHandlers(input: DevelopmentContract, runtime: DevelopmentRuntime): BuiltinHandlers {
  const contract = developmentContractSchema.parse(input);
  return {
    "delivery-spec": draft => ({ errors: Object.keys(contract.binding).some(key => draft.binding[key as keyof typeof draft.binding] !== contract.binding[key as keyof typeof contract.binding]) ? ["Frozen development binding changed"] : [] }),
    "implementation-evidence": Object.assign((draft: Readonly<ChainDraft>) => ({ errors: evidenceErrors(draft, contract) }), {
      runtimeInputs: true,
      command: (draft: ChainDraft, command: ChainCommand) => {
        if (command.type !== "acceptance.assess") throw new Error("Only implementation claims are allowed in this phase");
        if (!contract.sources.some(source => source.kind === "acceptance" && source.key === command.key)) throw new Error(`Unknown acceptance ${command.key}`);
        const state = draft.development ??= { claims: [], checks: [] };
        const item = { key: command.key, evidence: command.evidence, attemptId: draft.attemptId };
        const index = state.claims.findIndex(claim => claim.key === command.key);
        if (index < 0) state.claims.push(item); else state.claims[index] = item;
      },
      rewind: (draft: ChainDraft, target: string) => {
        if (!draft.development) return;
        const phases = Object.keys(draft.definition.phases);
        const index = (builtin: string) => phases.findIndex(key => { const phase = draft.definition.phases[key]; return phase?.type === "builtin" && phase.builtin === builtin; });
        if (phases.indexOf(target) <= index("command-verification")) draft.development.checks = [];
        if (phases.indexOf(target) < index("implementation-evidence")) draft.development.claims = [];
        const review = phases.findIndex(key => { const phase = draft.definition.phases[key]; return (phase?.type === "artifact" || phase?.type === "builtin") && phase.artifacts.includes("development.code-review"); });
        if (phases.indexOf(target) <= review) delete draft.development.reviewFingerprint;
      },
    }),
    "command-verification": Object.assign((draft: Readonly<ChainDraft>) => ({
      errors: [...evidenceErrors(draft, contract), ...checkErrors(draft, runtime),
        ...(!draft.artifacts.some(item => item.ref === "development.code-review") ? ["Code review is missing"] : [])],
    }), {
      runtimeInputs: true,
      beforeComplete: (draft: ChainDraft) => {
        const phases = Object.keys(draft.definition.phases);
        const review = phases.findIndex(key => { const phase = draft.definition.phases[key]; return (phase?.type === "artifact" || phase?.type === "builtin") && phase.artifacts.includes("development.code-review"); });
        const current = phases.indexOf(draft.phase!);
        if (review < 0) throw new Error("Code review phase is missing");
        if (current === review) (draft.development ??= { claims: [], checks: [] }).reviewFingerprint = runtime.fingerprint();
        if (current > review && draft.development?.reviewFingerprint !== runtime.fingerprint()) throw new Error("Code changed after review; rewind and review the current repository snapshot");
      },
      finalize: (draft: Readonly<ChainDraft>) => [...evidenceErrors(draft, contract), ...checkErrors(draft, runtime)],
      command: (draft: ChainDraft, command: ChainCommand) => {
        const state = draft.development ??= { claims: [], checks: [] };
        if (command.type === "check.remove") {
          const index = state.checks.findIndex(check => check.key === command.key);
          if (index < 0) throw new Error("Check does not exist");
          state.checks.splice(index, 1); return;
        }
        if (command.type !== "check.record") throw new Error("Only captured checks are allowed in this phase");
        const receipt = runtime.receipts().find(receipt => receipt.id === command.receipt_id);
        if (!receipt || receipt.attemptId !== draft.attemptId) throw new Error("Receipt is not from the current run");
        if (receipt.status !== "completed" || receipt.exitCode !== 0) throw new Error("Receipt did not explicitly succeed");
        const item = { key: command.key, receiptId: receipt.id, summary: command.summary };
        const index = state.checks.findIndex(check => check.key === item.key);
        if (index < 0) state.checks.push(item); else state.checks[index] = item;
      },
    }),
  };
}

export function compileDevelopmentConclusion(draft: Readonly<ChainDraft>, input: DevelopmentContract, runtime: DevelopmentRuntime) {
  const contract = developmentContractSchema.parse(input);
  const errors = [...evidenceErrors(draft, contract), ...checkErrors(draft, runtime)];
  if (draft.development?.reviewFingerprint !== runtime.fingerprint()) errors.push("Code review belongs to an earlier repository snapshot");
  if (draft.definition.id !== "development" || draft.status !== "completed" || draft.phase !== null) errors.push("Development draft is not completed");
  const review = draft.artifacts.find(item => item.ref === "development.code-review");
  if (!review) errors.push("Code review is missing");
  if (errors.length) throw new PhaseValidationError(errors);
  return {
    kind: "development" as const, draftId: draft.id, sequence: draft.sequence, attemptId: draft.attemptId,
    binding: structuredClone(draft.binding), claims: structuredClone(draft.development!.claims),
    checks: draft.development!.checks.map(check => ({ ...check, receipt: runtime.receipts().find(receipt => receipt.id === check.receiptId)! })),
    review: parse(review!.content) as unknown,
  };
}
