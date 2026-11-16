import {z} from "zod";
const text=z.string(),nullable=text.nullable(),id=text.min(1),time=text.nullable();
export const HistoryAvailabilitySchema=z.object({enabled:z.boolean().default(false)});
const source=z.object({hash:text.regex(/^[a-f0-9]{64}$/),commit:text,captured_at:z.iso.datetime(),name:z.literal("LoopWork")});
const task=z.object({id,project_id:id,title:text,item_type:nullable,status:text,run_state:text,closure_status:text,updated_at:time});
export const HistoryListSchema=z.object({historical_only:z.literal(true),source,projects:z.array(z.object({id,name:text,workspace_root:text,deleted_at:time.optional().default(null),task_count:z.number().int().nonnegative(),unfinished_count:z.number().int().nonnegative()})),tasks:z.array(task),total:z.number().int().nonnegative(),offset:z.number().int().nonnegative(),limit:z.number().int().positive()});
const document=z.object({id,title:text,kind:text,source_agent:nullable,revision:z.number().int(),created_at:time,updated_at:time});
export const HistoryTaskSchema=z.object({historical_only:z.literal(true),source,task:task.extend({description:nullable,current_subagent:nullable,next_step:nullable,blocked_reason:nullable,created_at:time,completed_at:time}).nullable(),documents:z.array(document)});
export const HistoryDocumentSchema=z.object({historical_only:z.literal(true),source,document:document.extend({task_id:id,content:text,format:text}).nullable()});
export type HistoryList=z.infer<typeof HistoryListSchema>;
export type HistoryTask=z.infer<typeof HistoryTaskSchema>;
export type HistoryDocument=z.infer<typeof HistoryDocumentSchema>;
const cell=z.union([text,z.number(),z.null(),z.strictObject({sqlite_integer:text.regex(/^-?\d+$/)}),z.strictObject({sqlite_blob:text})]);
export const historyPacketTables=["projects","tasks","acceptances","stories","story_specs","delivery_unit_acceptances","delivery_unit_dependencies","delivery_unit_context_links","task_dependencies","requirement_metadata","agent_work_drafts","command_chain_drafts","command_chain_artifact_blocks","command_chain_decisions","command_chain_acceptance_items","command_chain_runtime_inputs","business_analysis_drafts","business_analysis_module_items","business_analysis_phase_artifacts","questions","runtime_input_requests","documents","document_comments","feedback_batches","feedback_groups","feedback_batch_comments","feedback_group_comments","feedback_group_delivery_units","task_context_chat_sessions","task_context_chat_messages","task_context_chat_change_requests"] as const;
const section=z.object({table:z.enum(historyPacketTables),status:z.enum(["included","unavailable"]),columns:z.array(id),missing_columns:z.array(id),omitted_columns:z.array(id),rows:z.array(z.record(text,cell))});
const packet=z.object({format:z.literal("loopwork-task-handoff-v1"),hash:text.regex(/^[a-f0-9]{64}$/),source,source_task_id:id,source_project:z.object({id,name:text,workspace_root:text,deleted_at:time}),source_task_terminal:z.boolean(),schema_complete:z.boolean(),sections:z.array(section).length(historyPacketTables.length),ownership:z.object({source_owner:z.literal("LoopWork"),native_execution_authorized:z.literal(false)}),exclusions:z.array(id).min(1)}).superRefine((value,ctx)=>{
 if(value.schema_complete!==value.sections.every(item=>item.status==="included")||new Set(value.sections.map(item=>item.table)).size!==value.sections.length)ctx.addIssue({code:"custom",message:"Invalid packet coverage"});
 for(const item of value.sections){
  if(item.status==="unavailable"&&item.rows.length||item.status==="included"&&item.missing_columns.length||item.rows.some(row=>Object.keys(row).length!==item.columns.length||item.columns.some(column=>!Object.hasOwn(row,column))))ctx.addIssue({code:"custom",message:"Invalid packet section"});
 }
});
export const HistoryPacketSchema=z.object({historical_only:z.literal(true),source,packet:packet.nullable()}).superRefine((value,ctx)=>{
 if(value.packet&&(value.packet.source.hash!==value.source.hash||value.packet.source.commit!==value.source.commit||value.packet.source.captured_at!==value.source.captured_at))ctx.addIssue({code:"custom",message:"Packet source differs from archive"});
});
export type HistoryPacket=z.infer<typeof HistoryPacketSchema>;
