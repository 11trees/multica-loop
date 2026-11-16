import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { draftSchema, DraftConflictError } from "./runtime";
import type { InterventionRecord } from "./intervention-store";

const text=z.string().min(1);
/** Validate persisted scope without touching a potentially broken repository. */
export function inspectRepairCheckpoint(db:DatabaseSync,original:InterventionRecord,current:{chain:string;agentId:string;draftId:string;revision:number;repositoryPath:string;contract:unknown;executionPath:string}){
  const frozen=z.object({repositoryPath:text,contract:z.unknown(),draft:draftSchema}).parse(original.snapshot);
  const row=db.prepare("SELECT payload FROM chain_drafts WHERE id=?").get(current.draftId);
  if(current.chain!==original.chain||current.agentId!==original.agentId||current.draftId!==original.draftId||current.revision!==original.revision||current.repositoryPath!==frozen.repositoryPath||JSON.stringify(current.contract)!==JSON.stringify(frozen.contract)||!row||JSON.stringify(draftSchema.parse(JSON.parse(String(row.payload))))!==JSON.stringify(frozen.draft))throw new DraftConflictError("Original workflow checkpoint changed before repair");
  const binding=db.prepare("SELECT payload FROM engineering_process_binding WHERE workspace_id=? AND issue_id=? AND agent_id=? AND attempt_id=?").get(original.workspaceId,original.issueId,original.agentId,original.attemptId);
  if(!binding)throw new DraftConflictError("Original workflow has no physical repository binding");
  const saved=z.object({projectId:z.uuid(),repositoryPath:text,mode:z.enum(["in_place","worktree"])}).parse(JSON.parse(String(binding.payload)));
  if(saved.repositoryPath!==current.executionPath||saved.mode==="in_place"&&saved.repositoryPath!==current.repositoryPath)throw new DraftConflictError("Original workflow execution directory changed");
  return {repositoryPath:current.repositoryPath,execution:{repositoryPath:saved.repositoryPath,mode:saved.mode}};
}
