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
const publication=z.object({requested_by:z.string().min(1),units:z.array(z.object({issueId:z.string().min(1),published:z.boolean(),unit:z.object({key:z.string().min(1),title:z.string()})})).min(1)}).transform(value=>({requestedBy:value.requested_by,units:value.units}));
const managedUnit=z.object({parentIssueId:z.string().min(1),parentRevision:z.number().int().positive(),planDraftId:z.string().min(1),unit,sources:z.array(z.object({key:z.string(),kind:z.string(),description:z.string(),oracle:z.string(),sourceRef:z.string()})),published:z.boolean()});
const deliveryPolicy=z.object({analystId:z.string().min(1),developerId:z.string().min(1),verifierId:z.string().min(1),maxReworks:z.number().int().min(0).max(10),mode:z.enum(["in_place","worktree"]),userId:z.string().min(1)});
const acceptedBinding=z.object({workspaceId:z.string().min(1),issueId:z.string().min(1),revision:z.number().int().positive(),contractVersion:z.string().min(1),codeVersion:z.string().min(1)});
const reviewResult=z.object({verdict:z.string(),report:z.string().nullable(),gaps:z.array(z.object({key:z.string(),subjectRef:z.string(),kind:z.string(),reason:z.string(),boundary:z.string()})),units:z.array(z.object({key:z.string(),title:z.string(),actor:z.string(),trigger:z.string(),observableOutcome:z.string(),acceptance:z.string(),gapKeys:z.array(z.string()),dependsOn:z.array(z.string())}))});
const requirementReview=z.object({current:z.boolean().optional().default(true),generation:z.number().int().positive(),draft_id:z.string().min(1),agent_id:z.string().min(1),report_hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),acknowledgement:z.object({userId:z.string().min(1),reportHash:z.string().regex(/^[a-f0-9]{64}$/),sequence:z.number().int().nonnegative(),acknowledgedAt:z.iso.datetime()}).nullable(),result:reviewResult.nullable(),history:z.array(z.object({generation:z.number().int().positive(),draft_id:z.string().min(1),code_version:z.string(),result:reviewResult.nullable()}))}).superRefine((value,ctx)=>{if(value.acknowledgement && (value.result?.verdict !== "report_ready" || !value.report_hash || value.acknowledgement.reportHash !== value.report_hash))ctx.addIssue({code:"custom",message:"Invalid report reading acknowledgement"});if(value.result?.verdict === "report_ready" && (!value.result.report || !value.report_hash || value.result.gaps.length))ctx.addIssue({code:"custom",message:"Incomplete published closure report"});});
const feedback=z.object({capture_ready:z.boolean().optional().default(true),enabled:z.boolean(),active:z.boolean(),unresolved_count:z.number().int().nonnegative().optional().default(0),expected_batch_number:z.number().int().nonnegative(),batches:z.array(z.object({id:z.string().min(1),number:z.number().int().positive(),version:z.number().int().nonnegative(),status:z.string(),agent_id:z.string().nullable(),verifier_id:z.string().nullable().optional().default(null),forward_work:z.object({planner_id:z.string().min(1),reproducer_id:z.string().nullable(),appended:z.boolean(),unit_ids:z.array(z.string().min(1))}).nullable().optional().default(null),summary:z.string().nullable(),comments:z.array(z.object({id:z.string(),version:z.string(),content:z.string(),sourceRef:z.string(),authorId:z.string()})),groups:z.array(z.object({verifications:z.array(z.object({comment_id:z.string().min(1),draft_id:z.string().min(1),code_version:z.string().min(1),work_version:z.string().min(1),result:z.object({verdict:z.string().min(1),reason:z.string().min(1),evidence:z.array(z.object({key:z.string().min(1),content:z.string().min(1)})).min(1)}).nullable()})).optional().default([]),id:z.string(),key:z.string(),workType:z.string(),status:z.string(),title:z.string(),reason:z.string(),response:z.string(),commentIds:z.array(z.string()),affectedDeliveryUnits:z.array(z.number()),acceptance:z.array(z.string())}))}))});
const requirement=z.object({feedback:feedback.nullable().optional().default(null),reproduction:z.object({agent_id:z.string().min(1),draft_id:z.string().min(1),status:z.string(),observation:z.object({status:z.enum(["reproduced","not_reproduced"]),expectedBehavior:z.string().min(1),actualBehavior:z.string().min(1),environment:z.string().min(1),stability:z.string().min(1),impactScope:z.string().min(1)}).nullable(),result:z.object({verdict:z.literal("reproduced"),report:z.string().min(1),code_version:z.string().min(1)}).nullable()}).nullable().optional().default(null),review_enabled:z.boolean().optional().default(false),review:requirementReview.nullable().optional().default(null),delivery_units:z.array(unit).optional().default([]),delivery_policy:deliveryPolicy.nullable().optional().default(null),accepted:z.record(z.string(),acceptedBinding).optional().default({}),progress:z.array(z.object({key:z.string(),chain:z.string().nullable(),status:z.string(),stop_reason:z.string().nullable()})).optional().default([]),publication:publication.nullable().optional().default(null),kind:z.string(),input:z.string(),context:z.object({intent:z.string(),changeSummary:z.string(),acceptances:z.array(z.object({id:z.string(),key:z.string(),statement:z.string(),oracle:z.string(),sourceRef:z.string(),revision:z.number().int().positive()}))}).nullable(),plan:z.object({rationale:z.string(),coverage:z.string(),units:z.array(unit)}).nullable()});
const state = z.object({
  managed_unit:managedUnit.nullable().optional().default(null),
  requirement:requirement.nullable().optional().default(null),
  feedback_allowed:z.boolean().optional().default(false),
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
  if(value.configured && ["context","planning","reproduction"].includes(value.chain) && !value.requirement)ctx.addIssue({code:"custom",message:"Missing frozen requirement input"});
  if(value.configured && value.chain === "reproduction" && !value.requirement?.reproduction)ctx.addIssue({code:"custom",message:"Missing frozen reproduction input"});
  if(value.configured && ["feedback-triage","feedback-verify"].includes(value.chain) && (!value.requirement?.feedback?.active || !value.requirement.feedback.batches.length))ctx.addIssue({code:"custom",message:"Missing active frozen feedback batch"});
  if(value.configured && value.chain === "feedback-verify" && !value.requirement?.feedback?.batches.at(-1)?.groups.some(group=>group.verifications.some(entry=>!entry.result)))ctx.addIssue({code:"custom",message:"Missing frozen single-comment verification"});
  if(value.configured && value.chain === "analysis" && !value.analysis)ctx.addIssue({code:"custom",message:"Missing frozen analysis unit"});
  if (value.configured && value.status === "waiting_for_answers" && !value.questions) ctx.addIssue({ code: "custom", message: "Missing human checkpoint questions" });
});
export const EngineeringOverviewSchema = state.transform(value => ({
  feedbackAllowed:value.feedback_allowed,autoContinue: value.auto_continue, enabled: value.enabled, configured: value.configured, chain: value.chain, agentId: value.agent_id,
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

export type RequirementConfiguration={expectedRevision:number;contextAgentId:string;plannerAgentId:string;reproductionAgentId?:string;repositoryPath:string;input:string;kind:"requirement"|"bug";decisionMode:"conservative"|"balanced"|"autonomous"|"fully_autonomous";autoContinue:boolean};

export const EngineeringPublicationSchema=z.object({published:z.literal(true)});

export type RequirementDeliveryConfiguration=EngineeringCheckpoint & {analystId:string;developerId:string;verifierId:string;maxReworks:number};
export const EngineeringDeliveryAuthorizationSchema=z.object({authorized:z.literal(true)});

export type RequirementReviewConfiguration=EngineeringCheckpoint & {reviewerId:string};
export type RequirementReviewAcknowledgement=EngineeringCheckpoint & {reportHash:string};
export const RequirementReviewConfiguredSchema=z.object({configured:z.literal(true)});
export const RequirementReviewAcknowledgedSchema=z.object({acknowledged:z.literal(true)});

export type FeedbackCapture=EngineeringCheckpoint & {requestId:string;expectedBatchNumber:number;agentId:string;verifierId:string;commentIds:string[]};
export type FeedbackCancellation={batchId:string;expectedVersion:number;reason:string};
export const FeedbackCaptureSchema=z.object({configured:z.literal(true),batch_id:z.string().uuid(),reopen_required:z.boolean()});
export const FeedbackCancelledSchema=z.object({cancelled:z.literal(true)});

export type FeedbackWorkAuthorization={batchId:string;expectedVersion:number;plannerId:string;reproducerId?:string};
