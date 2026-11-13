import { z } from "zod";

const text = z.string().trim().min(1);
export const decisionOptionSchema = z.strictObject({ id: text.max(100), label: text.max(240), consequence: text.max(1000) });
export const decisionAuthoritySchema = z.enum(["upstream", "user", "project_evidence", "agent_authority"]);
export const decisionProposalSchema = z.strictObject({
  key: text.max(240), type: z.enum(["business", "technical"]), title: text.max(500), question: text.max(4000), impact: text.max(4000),
  options: z.array(decisionOptionSchema).min(2).max(20),
  recommendation: z.strictObject({ option: text, reason: text.max(4000), authority: decisionAuthoritySchema }),
  dependencies: z.array(z.strictObject({ decision: text, option: text })).max(50).default([]),
}).superRefine((value,ctx) => {
  if(new Set(value.options.map(option=>option.id)).size !== value.options.length) ctx.addIssue({code:"custom",message:"Decision options must have unique IDs"});
  if(!value.options.some(option=>option.id === value.recommendation.option)) ctx.addIssue({code:"custom",message:"Recommended option is missing"});
});
export const decisionStateSchema = decisionProposalSchema.safeExtend({
  status: z.enum(["proposed","needs_user_input","resolved"]), humanRequested: z.boolean().default(false),
  resolution: z.strictObject({option:text,authority:decisionAuthoritySchema,decision:text.max(4000),rationale:text.max(4000),evidence:text.max(4000),userId:text.optional(),questionId:text.optional()}).optional(),
});
export type DecisionState = z.infer<typeof decisionStateSchema>;
export function decisionGraphErrors(decisions: readonly DecisionState[]):string[] {
  const errors:string[]=[];const byKey=new Map(decisions.map(node=>[node.key,node]));
  if(byKey.size !== decisions.length) errors.push("Decision keys must be unique");
  for(const node of decisions) for(const dependency of node.dependencies) {
    const parent=byKey.get(dependency.decision);
    if(!parent) errors.push(`Decision ${node.key} refers to missing dependency ${dependency.decision}`);
    else if(!parent.options.some(option=>option.id === dependency.option)) errors.push(`Decision ${node.key} refers to missing dependency option`);
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(key:string):boolean=>{
    if(visiting.has(key)) return true;if(visited.has(key))return false;visiting.add(key);
    const cyclic=Boolean(byKey.get(key)?.dependencies.some(item=>visit(item.decision)));visiting.delete(key);visited.add(key);return cyclic;
  };
  if(decisions.some(node=>visit(node.key)))errors.push("Decision graph must be acyclic");return errors;
}
