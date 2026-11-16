"use client";

import {useEngineeringTeams} from "@multica/core/squads";
import {useWorkspaceId} from "@multica/core/hooks";
import type {UpdateIssueRequest} from "@multica/core/types";
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from "@multica/ui/components/ui/select";
import {useT} from "../../i18n";

export function TeamAssignment({teamId,onUpdate}:{teamId:string|null;onUpdate:(input:Partial<UpdateIssueRequest>)=>void}){
 const {t}=useT("issues"),workspaceId=useWorkspaceId(),query=useEngineeringTeams(workspaceId);
 return <Select items={query.teams.map(team=>({value:team.id,label:team.name}))} value={teamId??""} disabled={query.isPending || query.isError} onValueChange={value=>{if(value)onUpdate({assignee_type:"squad",assignee_id:value})}}><SelectTrigger aria-label={t($=>$.engineering.team)}><SelectValue placeholder={t($=>$.engineering.select_team)} /></SelectTrigger><SelectContent>{query.teams.map(team=><SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select>;
}
