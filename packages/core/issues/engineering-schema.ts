import { z } from "zod";

const source = z.object({ key: z.string(), kind: z.string(), description: z.string(), oracle: z.string(), source_ref: z.string().optional().default("") })
  .transform(value => ({ key: value.key, kind: value.kind, description: value.description, oracle: value.oracle, sourceRef: value.source_ref }));
export type EngineeringDeliveryUnit={key:string;title:string;actor:string;trigger:string;observableOutcome:string;acceptance:string;sourceRefs:{key:string;kind:"change"|"preserve"|"technical"|"acceptance";content:string;sourceRef:string}[];dependsOn:string[]};
const unit=z.object({key:z.string(),title:z.string(),actor:z.string(),trigger:z.string(),observableOutcome:z.string(),acceptance:z.string(),sourceRefs:z.array(z.object({key:z.string(),kind:z.string(),content:z.string(),sourceRef:z.string()})),dependsOn:z.array(z.string())});
const question = z.object({ id: z.string().min(1), title: z.string(), question: z.string(), why: z.string().optional().default(""), recommendation: z.string().optional().default(""), active: z.boolean(), phase: z.string(),
  decision_key:z.string().optional(), options:z.array(z.object({id:z.string().min(1),label:z.string(),consequence:z.string()})).optional().default([]), recommendation_option:z.string().optional().default(""),
  answer: z.object({ selected_option:z.string().optional(), text: z.string(), user_id: z.string(), sequence: z.number().int() }).nullable(),
}).superRefine((value,ctx)=>{if(value.decision_key && (value.options.length<2 || new Set(value.options.map(option=>option.id)).size !== value.options.length))ctx.addIssue({code:"custom",message:"Invalid published decision options"});})
  .transform(value => ({id:value.id,title:value.title,question:value.question,why:value.why,recommendation:value.recommendation,active:value.active,phase:value.phase,...(value.decision_key ? {decisionKey:value.decision_key} : {}),options:value.options,recommendationOption:value.recommendation_option,
    answer: value.answer ? {text:value.answer.text,userId:value.answer.user_id,sequence:value.answer.sequence,...(value.answer.selected_option ? {selectedOption:value.answer.selected_option} : {})} : null}));
const publication=z.object({requested_by:z.string().min(1),units:z.array(z.object({issueId:z.string().min(1),published:z.boolean(),unit:z.object({key:z.string().min(1),title:z.string()})})).min(1).max(50)}).transform(value=>({requestedBy:value.requested_by,units:value.units}));
const managedUnit=z.object({parentIssueId:z.string().min(1),parentRevision:z.number().int().positive(),planDraftId:z.string().min(1),unit,sources:z.array(z.object({key:z.string(),kind:z.string(),description:z.string(),oracle:z.string(),sourceRef:z.string()})),published:z.boolean()});
const requirement=z.object({publication:publication.nullable().optional().default(null),kind:z.string(),input:z.string(),context:z.object({intent:z.string(),changeSummary:z.string(),acceptances:z.array(z.object({id:z.string(),key:z.string(),statement:z.string(),oracle:z.string(),sourceRef:z.string(),revision:z.number().int().positive()}))}).nullable(),plan:z.object({rationale:z.string(),coverage:z.string(),units:z.array(unit)}).nullable()});
const state = z.object({
  managed_unit:managedUnit.nullable().optional().default(null),
  requirement:requirement.nullable().optional().default(null),
  auto_continue: z.boolean().optional().default(false), enabled: z.boolean(), configured: z.boolean(), chain: z.string().optional().default(""), agent_id: z.string().optional().default(""),
  revision: z.number().int().positive().nullable().optional().default(null), sequence: z.number().int().nonnegative().nullable().optional().default(null),
  code_version: z.string().optional().default(""), repository_path: z.string().optional().default(""), draft_id: z.string().nullable().optional().default(null),
  status: z.string().optional().default("unknown"), current_phase: z.string().nullable().optional().default(null), has_active_run: z.boolean().nullable().optional().default(null),
  phases: z.array(z.object({ id: z.string(), status: z.string() })).optional().default([]),
  sources: z.array(source).optional().default([]), questions: z.array(question).optional(),
  artifacts: z.array(z.object({ ref: z.string(), key: z.string(), title: z.string().optional().default(""), content: z.string() })).optional().default([]),
  decisions:z.array(z.object({key:z.string(),title:z.string(),status:z.string(),question:z.string(),resolution:z.object({option:z.string(),authority:z.string(),decision:z.string(),rationale:z.string(),evidence:z.string(),userId:z.string().optional()}).optional()})).optional().default([]),
  analysis:z.object({unit,decision_mode:z.string(),handoff:z.boolean(),spec:z.object({summary:z.string(),handoff:z.object({implementationGuidance:z.string()})}).nullable().optional().default(null)}).nullable().optional().default(null),
  rework: z.object({ root_revision: z.number().int().positive(), round: z.number().int().nonnegative(), limit: z.number().int().nonnegative(), stop_reason: z.string().nullable(),
    history: z.array(z.object({ revision: z.number().int().positive(), draft_id: z.string(), code_version: z.string(), decision: z.string(), artifacts: z.array(z.object({ ref:z.string(),key:z.string(),content:z.string() })) })),
  }).nullable().optional().default(null),
  result: z.object({ verdict: z.string().optional(), commit: z.string().optional() }).nullable().optional().default(null),
}).superRefine((value, ctx) => {
  if (value.configured && (!value.enabled || !value.agent_id || value.revision === null || value.sequence === null)) ctx.addIssue({ code: "custom", message: "Incomplete engineering identity" });
  if(value.configured && ["context","planning"].includes(value.chain) && !value.requirement)ctx.addIssue({code:"custom",message:"Missing frozen requirement input"});
  if(value.configured && value.chain === "analysis" && !value.analysis)ctx.addIssue({code:"custom",message:"Missing frozen analysis unit"});
  if (value.configured && value.status === "waiting_for_answers" && !value.questions) ctx.addIssue({ code: "custom", message: "Missing human checkpoint questions" });
});
export const EngineeringOverviewSchema = state.transform(value => ({
  autoContinue: value.auto_continue, enabled: value.enabled, configured: value.configured, chain: value.chain, agentId: value.agent_id,
  revision: value.revision, sequence: value.sequence, codeVersion: value.code_version, repositoryPath: value.repository_path,
  draftId: value.draft_id, status: value.status, currentPhase: value.current_phase, hasActiveRun: value.has_active_run,
  managedUnit:value.managed_unit,requirement:value.requirement,decisions:value.decisions,analysis:value.analysis ? {unit:value.analysis.unit,decisionMode:value.analysis.decision_mode,handoff:value.analysis.handoff,spec:value.analysis.spec} : null,
  rework: value.rework ? { rootRevision: value.rework.root_revision, round: value.rework.round, limit: value.rework.limit, stopReason: value.rework.stop_reason,
    history: value.rework.history.map(item => ({ revision:item.revision,draftId:item.draft_id,codeVersion:item.code_version,decision:item.decision,artifacts:item.artifacts })) } : null,
  phases: value.phases, sources: value.sources, questions: value.questions ?? [], artifacts: value.artifacts, result: value.result,
}));
export type EngineeringOverview = z.infer<typeof EngineeringOverviewSchema>;
export const EngineeringWriteSchema = z.object({ contract: z.object({ binding: z.object({ revision: z.number().int().positive(), issueId: z.string().min(1) }) }), draft: z.object({ sequence: z.number().int().nonnegative(), status: z.string() }).nullable() });

export type EngineeringCheckpoint = { expectedRevision: number; expectedSequence: number };
export type EngineeringConfiguration = {
  analystId?:string; unit?:EngineeringDeliveryUnit; decisionMode?:"conservative"|"balanced"|"autonomous"|"fully_autonomous"; dependencyIssues?:{key:string;issueId:string}[];
  maxReworks?: number; autoContinue?: boolean; expectedRevision: number; verifierId: string; developerId?: string; repositoryPath: string; implementationGuidance?: string;
  sources: { key: string; kind: "acceptance" | "focus" | "guardrail" | "recovery"; description: string; oracle: string; sourceRef: string }[];
};

export type RequirementConfiguration={expectedRevision:number;contextAgentId:string;plannerAgentId:string;repositoryPath:string;input:string;kind:"requirement"|"bug";decisionMode:"conservative"|"balanced"|"autonomous"|"fully_autonomous";autoContinue:boolean};

export const EngineeringPublicationSchema=z.object({published:z.literal(true)});
