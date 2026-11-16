import { z } from "zod";

export const teamWorkflowRoles = {
  direct: ["executor"],
  business_analysis: ["intent", "business_design", "specification", "review"],
  end_to_end: ["intent", "business_design", "specification", "review", "context", "planner", "analyst", "developer", "verifier", "reviewer"],
  develop: ["context", "planner", "analyst", "developer", "verifier", "reviewer"],
  bug_fix: ["reproducer", "context", "planner", "analyst", "developer", "verifier", "reviewer"],
} as const;
export const teamDefinitionSchema = z.strictObject({
  workflow: z.enum(["direct", "business_analysis", "end_to_end", "develop", "bug_fix"]),
  roles: z.record(z.string(), z.uuid()),
  decision_mode: z.enum(["conservative", "balanced", "autonomous", "fully_autonomous"]),
  max_reworks: z.number().int().min(0).max(10),
}).superRefine((definition, context) => {
  const required: readonly string[] = teamWorkflowRoles[definition.workflow];
  if (Object.keys(definition.roles).length !== required.length || required.some(role => !definition.roles[role])) {
    context.addIssue({code:"custom", path:["roles"], message:"Choose an Agent for every workflow role, without extra roles"});
  }
  if (new Set(Object.values(definition.roles)).size !== required.length) {
    context.addIssue({code:"custom", path:["roles"], message:"Workflow roles require independent Agents"});
  }
}).transform(definition => ({...definition,roles:Object.fromEntries(Object.entries(definition.roles).sort(([a],[b])=>a.localeCompare(b)))}));
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;
