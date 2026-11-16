import {createHash} from "node:crypto";

const fields = (value) => value.split(" ");
const taskScope = "t.task_id=?";
const draftScope = "t.draft_id IN (SELECT draft_id FROM agent_work_drafts WHERE task_id=?)";
const batchScope = "t.batch_id IN (SELECT batch_id FROM feedback_batches WHERE task_id=?)";
const groupScope = "t.group_id IN (SELECT group_id FROM feedback_groups WHERE batch_id IN (SELECT batch_id FROM feedback_batches WHERE task_id=?))";
const sessionScope = "t.session_id IN (SELECT session_id FROM task_context_chat_sessions WHERE task_id=?)";
// Explicit projections keep source execution credentials and runtime state out
// of the handoff contract. JSON text remains original text, never interpreted.
const projections = [
 ["projects", "project_id name workspace_root description created_at updated_at is_default deleted_at", "t.project_id IN (SELECT project_id FROM tasks WHERE task_id=?)", "tasks"],
 ["tasks", "task_id project_id title description item_type priority agile_status run_state closure_status evidence risk link external_id external_status created_at updated_at completed_at", taskScope],
 ["acceptances", "acceptance_id task_id acceptance_key scope_type story_index statement oracle source_ref source_command_chain_draft_id revision lifecycle created_at updated_at", taskScope],
 ["stories", "task_id story_index title directory origin_type origin_feedback_batch_id corrects_story_indexes_json unit_key actor trigger_condition observable_outcome acceptance source_command_chain_draft_id", taskScope],
 ["story_specs", "spec_id task_id story_index revision status spec_json source_result_id created_at resolved_at", taskScope],
 ["delivery_unit_acceptances", "task_id story_index acceptance_id relation created_at", taskScope],
 ["delivery_unit_dependencies", "task_id story_index depends_on_story_index", taskScope],
 ["delivery_unit_context_links", "task_id story_index source_key source_kind content source_ref", taskScope],
 ["task_dependencies", "task_id depends_on_task_id created_at", taskScope],
 ["requirement_metadata", "task_id metadata_key metadata_value created_at updated_at", taskScope],
 ["agent_work_drafts", "draft_id work_key draft_version draft_type task_id story_index agent status change_seq last_execution_id terminal_execution_id terminal_action created_at updated_at submitted_at command_chain_id command_chain_variant", taskScope],
 ["command_chain_drafts", "draft_id command_chain_id definition_version workflow_phase validated_change_seq", draftScope, "agent_work_drafts"],
 ["command_chain_artifact_blocks", "draft_id artifact_id block_id item_key content_format content ordinal updated_at", draftScope, "agent_work_drafts"],
 ["command_chain_decisions", "draft_id tree_id decision_key content status selected_option_id authority decision_text rationale evidence human_requested ordinal updated_at", draftScope, "agent_work_drafts"],
 ["command_chain_acceptance_items", "draft_id acceptance_key statement oracle source ordinal updated_at", draftScope, "agent_work_drafts"],
 ["command_chain_runtime_inputs", "draft_id request_key title question why recommendation ordinal updated_at", draftScope, "agent_work_drafts"],
 ["business_analysis_drafts", "draft_id workflow_phase validated_change_seq research_enabled protocol_version", draftScope, "agent_work_drafts"],
 ["business_analysis_module_items", "draft_id module item_key payload_json ordinal created_at updated_at", draftScope, "agent_work_drafts"],
 ["business_analysis_phase_artifacts", "draft_id phase content updated_at", draftScope, "agent_work_drafts"],
 ["questions", "question_id task_id story_index kind title question why recommendation answer status relative_path source_agent created_at updated_at decision_key alternatives_json recommendation_reason depends_on_json spec_revision resolved_at selected_option_id activation_json status_reason decision_authority intervention_id", taskScope],
 ["runtime_input_requests", "request_id task_id story_index source_agent title question why recommendation answer status source_execution_id resolved_execution_id created_at updated_at resolved_at request_key intervention_id", taskScope],
 ["documents", "document_id task_id story_index kind title content format source_agent revision created_at updated_at", taskScope],
 ["document_comments", "comment_id document_id task_id document_revision agent_id anchor_type quoted_text start_offset end_offset content status resolved_at created_at updated_at intent feedback_status disposition target_agent target_story_index acceptance_json triage_reason resolution_claim_json verification_json triaged_at submitted_at target_stage feedback_batch_id feedback_is_rewind_frontier feedback_needs_rebase", taskScope],
 ["feedback_batches", "batch_id task_id status source_execution_id summary last_error created_at updated_at completed_at batch_number", taskScope],
 ["feedback_groups", "group_id batch_id group_key work_type status title reason acceptance_json affected_story_indexes_json response_text source_execution_id created_at updated_at completed_at group_order", batchScope, "feedback_batches"],
 ["feedback_batch_comments", "batch_id comment_id ordinal created_at", batchScope, "feedback_batches"],
 ["feedback_group_comments", "group_id comment_id", groupScope, "feedback_groups", "feedback_batches"],
 ["feedback_group_delivery_units", "group_id task_id story_index created_at", taskScope],
 ["task_context_chat_sessions", "session_id task_id state created_at updated_at", taskScope],
 ["task_context_chat_messages", "message_id session_id role content created_at", sessionScope, "task_context_chat_sessions"],
 ["task_context_chat_change_requests", "request_id session_id message_id request_key comment_id created_at", sessionScope, "task_context_chat_sessions"],
];
const quote = (name) => `"${name.replaceAll('"','""')}"`;
const encode = (value) => JSON.stringify(value, (_key,item) => typeof item === "bigint" ? {sqlite_integer:String(item)} : item instanceof Uint8Array ? {sqlite_blob:Buffer.from(item).toString("base64")} : item);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
export const packetHash = (body) => createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");

export function taskPacket(db, catalog, taskId) {
 const project = db.prepare("SELECT p.project_id AS id,p.name,p.workspace_root,p.deleted_at FROM projects p JOIN tasks t ON t.project_id=p.project_id WHERE t.task_id=?").get(taskId);
 if (!project) return null;
 const schemas = new Map(catalog.map(table => [table.name,table]));
 const sections = projections.map(([table,projection,where,...dependencies]) => {
  const schema=schemas.get(table), wanted=fields(projection);
  const columns=wanted.filter(column=>schema?.columns.includes(column));
  const missingColumns=wanted.filter(column=>!schema?.columns.includes(column));
  const omittedColumns=(schema?.columns??[]).filter(column=>!wanted.includes(column));
  // A partial schema is visible in coverage, never silently represented as an
  // empty complete contract. SQL below uses only fixed, checked table scopes.
  const available=!!schema && missingColumns.length===0 && dependencies.every(name=>schemas.get(name)?.columns.includes(name==="agent_work_drafts"?"task_id":name==="feedback_groups"?"batch_id":"task_id"));
  if(!available) return {table,status:"unavailable",columns,missing_columns:missingColumns,omitted_columns:omittedColumns,rows:[]};
  if(!schema.primary_key.length) throw new Error(`Packet table has no stable source key: ${table}`);
  const statement=db.prepare(`SELECT ${columns.map(column=>`t.${quote(column)}`).join(",")} FROM ${quote(table)} t WHERE ${where} ORDER BY ${schema.primary_key.map(column=>`t.${quote(column)}`).join(",")}`);
  statement.setReadBigInts(true);
  return {table,status:"included",columns,missing_columns:[],omitted_columns:omittedColumns,rows:statement.all(taskId)};
 });
 const task=db.prepare("SELECT agile_status FROM tasks WHERE task_id=?").get(taskId);
 return JSON.parse(encode({source_task_id:taskId,source_project:project,source_task_terminal:["done","cancelled"].includes(task.agile_status),schema_complete:sections.every(section=>section.status==="included"),sections}));
}

export function sealTaskPacket(material, source) {
 if(!material) return null;
 const body={format:"loopwork-task-handoff-v1",source,...material,ownership:{source_owner:"LoopWork",native_execution_authorized:false},exclusions:["Execution receipts, attempts, process ownership and repair records remain in the full archive; they are not new native evidence or authority.","Closure approvals, reading acknowledgements, leases, runtime configuration and credentials are not imported as native authority.","External file, image and repository references are retained as text only; their target bytes have not been migrated.","Tables outside the named material sections remain in the full archive and require explicit reconciliation before cutover."]};
 return {...body,hash:packetHash(body)};
}
