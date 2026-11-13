import { z } from "zod";

const source = z.object({ key: z.string(), kind: z.string(), description: z.string(), oracle: z.string(), source_ref: z.string().optional().default("") })
  .transform(value => ({ key: value.key, kind: value.kind, description: value.description, oracle: value.oracle, sourceRef: value.source_ref }));
const question = z.object({ id: z.string().min(1), title: z.string(), question: z.string(), why: z.string().optional().default(""), recommendation: z.string().optional().default(""), active: z.boolean(), phase: z.string(),
  answer: z.object({ text: z.string(), user_id: z.string(), sequence: z.number().int() }).nullable(),
}).transform(value => ({ ...value, answer: value.answer ? { text: value.answer.text, userId: value.answer.user_id, sequence: value.answer.sequence } : null }));
const state = z.object({
  enabled: z.boolean(), configured: z.boolean(), chain: z.string().optional().default(""), agent_id: z.string().optional().default(""),
  revision: z.number().int().positive().nullable().optional().default(null), sequence: z.number().int().nonnegative().nullable().optional().default(null),
  code_version: z.string().optional().default(""), repository_path: z.string().optional().default(""), draft_id: z.string().nullable().optional().default(null),
  status: z.string().optional().default("unknown"), current_phase: z.string().nullable().optional().default(null), has_active_run: z.boolean().nullable().optional().default(null),
  phases: z.array(z.object({ id: z.string(), status: z.string() })).optional().default([]),
  sources: z.array(source).optional().default([]), questions: z.array(question).optional(),
  artifacts: z.array(z.object({ ref: z.string(), key: z.string(), title: z.string().optional().default(""), content: z.string() })).optional().default([]),
  result: z.object({ verdict: z.string().optional(), commit: z.string().optional() }).nullable().optional().default(null),
}).superRefine((value, ctx) => {
  if (value.configured && (!value.enabled || !value.agent_id || value.revision === null || value.sequence === null)) ctx.addIssue({ code: "custom", message: "Incomplete engineering identity" });
  if (value.configured && value.status === "waiting_for_answers" && !value.questions) ctx.addIssue({ code: "custom", message: "Missing human checkpoint questions" });
});
export const EngineeringOverviewSchema = state.transform(value => ({
  enabled: value.enabled, configured: value.configured, chain: value.chain, agentId: value.agent_id,
  revision: value.revision, sequence: value.sequence, codeVersion: value.code_version, repositoryPath: value.repository_path,
  draftId: value.draft_id, status: value.status, currentPhase: value.current_phase, hasActiveRun: value.has_active_run,
  phases: value.phases, sources: value.sources, questions: value.questions ?? [], artifacts: value.artifacts, result: value.result,
}));
export type EngineeringOverview = z.infer<typeof EngineeringOverviewSchema>;
export const EngineeringWriteSchema = z.object({ contract: z.object({ binding: z.object({ revision: z.number().int().positive(), issueId: z.string().min(1) }) }), draft: z.object({ sequence: z.number().int().nonnegative(), status: z.string() }).nullable() });

export type EngineeringCheckpoint = { expectedRevision: number; expectedSequence: number };
export type EngineeringConfiguration = {
  expectedRevision: number; verifierId: string; developerId?: string; repositoryPath: string; implementationGuidance?: string;
  sources: { key: string; kind: "acceptance" | "focus" | "guardrail" | "recovery"; description: string; oracle: string; sourceRef: string }[];
};
