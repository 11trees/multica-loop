import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { teamDefinitionSchema } from "./team";
import { DraftConflictError } from "./runtime";

const profileSchema=z.strictObject({workspaceId:z.uuid(),teamId:z.uuid(),revision:z.number().int().positive(),configuredBy:z.uuid(),definition:teamDefinitionSchema,createdAt:z.iso.datetime()});
export const teamBindingSchema=z.strictObject({id:z.uuid(),workspaceId:z.uuid(),issueId:z.uuid(),projectId:z.uuid(),startedBy:z.uuid(),input:z.string().trim().min(1).max(40000),profile:profileSchema,createdAt:z.iso.datetime()});

export type EngineeringTeamBinding=z.infer<typeof teamBindingSchema>;

/** Team definitions are versioned; starting a task freezes its own copy. */
export class EngineeringTeamStore {
 constructor(private readonly db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS engineering_team_profile(workspace_id TEXT NOT NULL,team_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,team_id,revision));
 CREATE TABLE IF NOT EXISTS engineering_team_binding(workspace_id TEXT NOT NULL,issue_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,issue_id));`);}
 current(workspaceId:string,teamId:string){const row=this.db.prepare("SELECT payload FROM engineering_team_profile WHERE workspace_id=? AND team_id=? ORDER BY revision DESC LIMIT 1").get(workspaceId,teamId);return row ? profileSchema.parse(JSON.parse(String(row.payload))) : null;}
 appliesToCreatedTask(workspaceId:string,teamId:string,createdAt?:string){
  const row=this.db.prepare("SELECT payload FROM engineering_team_profile WHERE workspace_id=? AND team_id=? ORDER BY revision LIMIT 1").get(workspaceId,teamId);
  if(!row)return false;return !createdAt || Date.parse(createdAt)>=Date.parse(profileSchema.parse(JSON.parse(String(row.payload))).createdAt);
 }
 private transaction<T>(operation:()=>T){this.db.exec("BEGIN IMMEDIATE");try{const result=operation();this.db.exec("COMMIT");return result;}catch(error){this.db.exec("ROLLBACK");throw error;}}
 configure(workspaceId:string,teamId:string,userId:string,input:unknown){
  const value=z.strictObject({expected_revision:z.number().int().nonnegative(),definition:teamDefinitionSchema}).parse(input);
  return this.transaction(()=>{const prior=this.current(workspaceId,teamId);if((prior?.revision??0)!==value.expected_revision)throw new DraftConflictError("Team definition changed; reload before saving");
   const profile=profileSchema.parse({workspaceId,teamId,configuredBy:userId,revision:value.expected_revision+1,definition:value.definition,createdAt:new Date().toISOString()});
   this.db.prepare("INSERT INTO engineering_team_profile VALUES(?,?,?,?)").run(workspaceId,teamId,profile.revision,JSON.stringify(profile));return profile;
  });
 }
 binding(workspaceId:string,issueId:string){const row=this.db.prepare("SELECT payload FROM engineering_team_binding WHERE workspace_id=? AND issue_id=?").get(workspaceId,issueId);return row ? teamBindingSchema.parse(JSON.parse(String(row.payload))) : null;}
 bind(workspaceId:string,issueId:string,userId:string,input:unknown){
  const value=z.strictObject({team_id:z.uuid(),team_revision:z.number().int().positive(),project_id:z.uuid(),input:z.string().trim().min(1).max(40000)}).parse(input);
  return this.transaction(()=>{
   const prior=this.binding(workspaceId,issueId);
   if(prior){if(prior.profile.teamId!==value.team_id || prior.profile.revision!==value.team_revision || prior.projectId!==value.project_id || prior.input!==value.input || prior.startedBy!==userId)throw new DraftConflictError("Started task retains its original Team, input and project");return prior;}
   const profile=this.current(workspaceId,value.team_id);if(!profile || profile.revision!==value.team_revision)throw new DraftConflictError("Team definition changed before task start");
   const binding=teamBindingSchema.parse({id:randomUUID(),workspaceId,issueId,projectId:value.project_id,startedBy:userId,input:value.input,profile,createdAt:new Date().toISOString()});
   this.db.prepare("INSERT INTO engineering_team_binding VALUES(?,?,?)").run(workspaceId,issueId,JSON.stringify(binding));return binding;
  });
 }
}
