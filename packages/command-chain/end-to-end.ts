import { z } from "zod";
import { draftSchema } from "./runtime";

const text = z.string().trim().min(1);
export const endToEndRolesSchema = z.strictObject({
  context: z.uuid(), planner: z.uuid(), analyst: z.uuid(), developer: z.uuid(), verifier: z.uuid(), reviewer: z.uuid(),
});
export const endToEndPolicySchema = z.strictObject({ roles: endToEndRolesSchema, maxReworks: z.number().int().min(0).max(10) });
export const businessSourceSchema = z.strictObject({
  projectId: z.uuid(), reviewDraftId: z.uuid(), reviewHash: text.regex(/^[a-f0-9]{64}$/), specification: text,
  stages: z.array(z.strictObject({ stage: z.enum(["intent", "business_design", "specification", "review"]), draftId: z.uuid(),
    hash: text.regex(/^[a-f0-9]{64}$/), binding: draftSchema.shape.binding, conclusion: text })).length(4),
});
export type BusinessSource = z.infer<typeof businessSourceSchema>;
export type EndToEndPolicy = z.infer<typeof endToEndPolicySchema>;
