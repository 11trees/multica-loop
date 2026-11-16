"use client";

import {useId,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {api} from "@multica/core/api";
import {teamWorkflowRoles,type TeamDefinition,type EngineeringTeamProfile} from "@multica/core/squads";
import type {Agent,SquadMember} from "@multica/core/types";
import {Button} from "@multica/ui/components/ui/button";
import {Input} from "@multica/ui/components/ui/input";
import {Label} from "@multica/ui/components/ui/label";
import {Spinner} from "@multica/ui/components/ui/spinner";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@multica/ui/components/ui/select";
import {ObjectSection} from "../../layout/object-page";
import {useT} from "../../i18n";

export function TeamWorkflowSection({workspaceId,teamId,leaderId,members,agents,canManage}:{workspaceId:string;teamId:string;leaderId:string;members:SquadMember[];agents:Agent[];canManage:boolean}){
 const {t}=useT("squads"),client=useQueryClient();
 const key=["engineering-team",workspaceId,teamId];
 const query=useQuery({queryKey:key,queryFn:()=>api.getEngineeringTeam(teamId),enabled:!!workspaceId && !!teamId});
 const save=useMutation({mutationFn:(input:{revision:number;definition:TeamDefinition})=>api.saveEngineeringTeam(teamId,input.revision,input.definition),onSuccess:result=>{client.setQueryData(key,result)}});
 if(query.data?.enabled===false)return null;
 return <ObjectSection title={t($=>$.engineering.title)}>
  {query.isPending ? <Spinner /> : query.isError ? <div role="alert">{t($=>$.engineering.load_error)} <Button variant="ghost" size="sm" onClick={()=>{void query.refetch()}}>{t($=>$.engineering.retry)}</Button></div> : query.data && <TeamWorkflowEditor key={`${teamId}:${query.data.profile?.revision??0}`} profile={query.data.profile} leaderId={leaderId} members={members} agents={agents} canManage={canManage} pending={save.isPending} onSave={definition=>save.mutateAsync({revision:query.data.profile?.revision??0,definition})} />}
 </ObjectSection>;
}
function TeamWorkflowEditor({profile,leaderId,members,agents,canManage,pending,onSave}:{profile:EngineeringTeamProfile|null;leaderId:string;members:SquadMember[];agents:Agent[];canManage:boolean;pending:boolean;onSave:(definition:TeamDefinition)=>Promise<unknown>}){
 const {t}=useT("squads"),{t:e}=useT("issues"),id=useId();
 const [editing,setEditing]=useState(false),[error,setError]=useState("");
 const [draft,setDraft]=useState<TeamDefinition>(profile?.definition??{workflow:"direct",roles:{executor:leaderId},decision_mode:"balanced",max_reworks:2});
 const roster=new Set([leaderId,...members.filter(member=>member.member_type==="agent").map(member=>member.member_id)]);
 const available=agents.filter(agent=>!agent.archived_at && roster.has(agent.id));
 const required=teamWorkflowRoles[draft.workflow],selected=required.map(role=>draft.roles[role]);
 const duplicate=selected.filter(Boolean).length!==new Set(selected.filter(Boolean)).size;
 const valid=required.every(role=>available.some(agent=>agent.id===draft.roles[role])) && !duplicate && Number.isInteger(draft.max_reworks) && draft.max_reworks>=0 && draft.max_reworks<=10;
 const roleLabels:Record<string,string>={executor:e($=>$.engineering.direct_agent),intent:e($=>$.engineering.intent_agent),business_design:e($=>$.engineering.design_agent),specification:e($=>$.engineering.spec_agent),review:e($=>$.engineering.spec_review_agent),context:e($=>$.engineering.context_agent),planner:e($=>$.engineering.planner_agent),analyst:e($=>$.engineering.analyst),developer:e($=>$.engineering.developer),verifier:e($=>$.engineering.verifier),reviewer:e($=>$.engineering.reviewer),reproducer:e($=>$.engineering.reproduction_agent)};
 const workflows=Object.keys(teamWorkflowRoles).map(key=>({value:key,label:t($=>$.engineering.workflows[key as TeamDefinition["workflow"]])}));
 const policies=[{value:"conservative",label:e($=>$.engineering.mode_conservative)},{value:"balanced",label:e($=>$.engineering.mode_balanced)},{value:"autonomous",label:e($=>$.engineering.mode_autonomous)},{value:"fully_autonomous",label:e($=>$.engineering.mode_fully_autonomous)}];
 if(!editing)return <div className="space-y-3">{profile && <><p className="text-body font-medium">{t($=>$.engineering.workflows[profile.definition.workflow])}</p><dl className="grid gap-2 text-body sm:grid-cols-2">{teamWorkflowRoles[profile.definition.workflow].map(role=><div key={role}><dt className="text-caption text-muted-foreground">{roleLabels[role]}</dt><dd>{agents.find(agent=>agent.id===profile.definition.roles[role])?.name??profile.definition.roles[role]}</dd></div>)}</dl></>}{canManage && <Button size="sm" variant="outline" onClick={()=>setEditing(true)}>{profile?t($=>$.engineering.edit):t($=>$.engineering.setup)}</Button>}</div>;
 return <form className="space-y-4" onSubmit={async event=>{event.preventDefault();if(!valid || pending)return;setError("");try{await onSave(draft);setEditing(false)}catch(cause){setError(cause instanceof Error?cause.message:t($=>$.engineering.save_error))}}}>
  <fieldset disabled={pending} className="space-y-4">
   <div className="space-y-1.5"><Label>{t($=>$.engineering.workflow)}</Label><Select items={workflows} value={draft.workflow} onValueChange={value=>{if(value && value in teamWorkflowRoles){const workflow=value as TeamDefinition["workflow"];setDraft({...draft,workflow,roles:Object.fromEntries(teamWorkflowRoles[workflow].map(role=>[role,draft.roles[role]??(role==="executor"?leaderId:"")]))})}}}><SelectTrigger aria-label={t($=>$.engineering.workflow)}><SelectValue /></SelectTrigger><SelectContent>{workflows.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
   <div className="grid gap-4 sm:grid-cols-2">{required.map(role=><div className="space-y-1.5" key={role}><Label>{roleLabels[role]}</Label><Select items={available.map(agent=>({value:agent.id,label:agent.name}))} value={draft.roles[role]??""} onValueChange={value=>setDraft({...draft,roles:{...draft.roles,[role]:value??""}})}><SelectTrigger aria-label={roleLabels[role]}><SelectValue placeholder={e($=>$.engineering.select_agent)} /></SelectTrigger><SelectContent>{available.map(agent=><SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent></Select></div>)}</div>
   {draft.workflow!=="direct" && <><div className="space-y-1.5"><Label>{e($=>$.engineering.decision_mode)}</Label><Select items={policies} value={draft.decision_mode} onValueChange={value=>{if(policies.some(policy=>policy.value===value))setDraft({...draft,decision_mode:value as TeamDefinition["decision_mode"]})}}><SelectTrigger aria-label={e($=>$.engineering.decision_mode)}><SelectValue /></SelectTrigger><SelectContent>{policies.map(policy=><SelectItem key={policy.value} value={policy.value}>{policy.label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`${id}-reworks`}>{e($=>$.engineering.max_reworks)}</Label><Input id={`${id}-reworks`} type="number" min={0} max={10} value={draft.max_reworks} onChange={event=>setDraft({...draft,max_reworks:Number(event.target.value)})} /></div></>}
   {duplicate && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.independent_roles)}</p>}
   {available.length<required.length && <p className="text-caption text-muted-foreground">{t($=>$.engineering.missing_members)}</p>}
  </fieldset>
  {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
  <div className="flex gap-2"><Button type="submit" size="sm" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.save)}</Button><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={()=>{setDraft(profile?.definition??{workflow:"direct",roles:{executor:leaderId},decision_mode:"balanced",max_reworks:2});setEditing(false)}}>{t($=>$.engineering.cancel)}</Button></div>
 </form>;
}
