import { z } from "zod";

export const teamWorkflowRoles = {
  direct: ["executor"],
  business_analysis: ["intent", "business_design", "specification", "review"],
  end_to_end: ["intent", "business_design", "specification", "review", "context", "planner", "analyst", "developer", "verifier", "reviewer"],
  develop: ["context", "planner", "analyst", "developer", "verifier", "reviewer"],
  bug_fix: ["reproducer", "context", "planner", "analyst", "developer", "verifier", "reviewer"],
} as const;
export const teamFeedbackRoles = ["triager", "verifier", "planner", "reproducer"] as const;
export const teamFeedbackSchema = z.strictObject({triager:z.uuid(),verifier:z.uuid(),planner:z.uuid(),reproducer:z.uuid()});
export function supportsTeamFeedback(workflow:string){return ["end_to_end","develop","bug_fix"].includes(workflow);}
export const teamDefinitionSchema = z.strictObject({
  workflow: z.enum(["direct", "business_analysis", "end_to_end", "develop", "bug_fix"]),
  roles: z.record(z.string(), z.uuid()),
  decision_mode: z.enum(["conservative", "balanced", "autonomous", "fully_autonomous"]),
  max_reworks: z.number().int().min(0).max(10),
  feedback: teamFeedbackSchema.optional(),
}).superRefine((definition, context) => {
  const required: readonly string[] = teamWorkflowRoles[definition.workflow];
  if (Object.keys(definition.roles).length !== required.length || required.some(role => !definition.roles[role])) {
    context.addIssue({code:"custom", path:["roles"], message:"Choose an Agent for every workflow role, without extra roles"});
  }
  if (new Set(Object.values(definition.roles)).size !== required.length) {
    context.addIssue({code:"custom", path:["roles"], message:"Workflow roles require independent Agents"});
  }
  if(definition.feedback){
    const feedback=definition.feedback,delivery=[definition.roles.analyst,definition.roles.developer,definition.roles.verifier];
    if(!supportsTeamFeedback(definition.workflow))context.addIssue({code:"custom",path:["feedback"],message:"Feedback requires a delivery workflow"});
    if(Object.values(feedback).some(id=>delivery.includes(id)) || feedback.verifier===definition.roles.reviewer || feedback.triager===feedback.verifier || feedback.planner===feedback.verifier || feedback.reproducer===feedback.verifier || feedback.planner===feedback.reproducer){
      context.addIssue({code:"custom",path:["feedback"],message:"Feedback verification must be independent of delivery, report review, triage and forward work; planning and reproduction need separate Agents"});
    }
  }
}).transform(definition => ({...definition,roles:Object.fromEntries(Object.entries(definition.roles).sort(([a],[b])=>a.localeCompare(b)))}));
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;
