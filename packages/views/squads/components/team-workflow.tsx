"use client";

import {useId,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {api} from "@multica/core/api";
import {teamDefinitionSchema,teamWorkflowRoles,teamFeedbackRoles,supportsTeamFeedback,type TeamDefinition,type EngineeringTeamProfile} from "@multica/core/squads";
import type {Agent,SquadMember} from "@multica/core/types";
import {Button} from "@multica/ui/components/ui/button";
import {Input} from "@multica/ui/components/ui/input";
import {Label} from "@multica/ui/components/ui/label";
import {Spinner} from "@multica/ui/components/ui/spinner";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@multica/ui/components/ui/select";
import {Checkbox} from "@multica/ui/components/ui/checkbox";
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
 const feedbackValid=!draft.feedback || teamFeedbackRoles.every(role=>available.some(agent=>agent.id===draft.feedback![role]));
 const valid=required.every(role=>available.some(agent=>agent.id===draft.roles[role])) && feedbackValid && teamDefinitionSchema.safeParse(draft).success;
 const feedbackLabels={triager:e($=>$.engineering.feedback_agent),verifier:e($=>$.engineering.feedback_verifier),planner:e($=>$.engineering.planner_agent),reproducer:e($=>$.engineering.reproduction_agent)};
 const feedbackChoices=(role:typeof teamFeedbackRoles[number])=>available.filter(agent=>{
  const feedback=draft.feedback!;if([draft.roles.analyst,draft.roles.developer,draft.roles.verifier].includes(agent.id))return false;
  if(role==="verifier")return ![draft.roles.reviewer,feedback.triager,feedback.planner,feedback.reproducer].includes(agent.id);
  return agent.id!==feedback.verifier && (role!=="planner" || agent.id!==feedback.reproducer) && (role!=="reproducer" || agent.id!==feedback.planner);
 });
 const roleLabels:Record<string,string>={executor:e($=>$.engineering.direct_agent),intent:e($=>$.engineering.intent_agent),business_design:e($=>$.engineering.design_agent),specification:e($=>$.engineering.spec_agent),review:e($=>$.engineering.spec_review_agent),context:e($=>$.engineering.context_agent),planner:e($=>$.engineering.planner_agent),analyst:e($=>$.engineering.analyst),developer:e($=>$.engineering.developer),verifier:e($=>$.engineering.verifier),reviewer:e($=>$.engineering.reviewer),reproducer:e($=>$.engineering.reproduction_agent)};
 const workflows=Object.keys(teamWorkflowRoles).map(key=>({value:key,label:t($=>$.engineering.workflows[key as TeamDefinition["workflow"]])}));
 const policies=[{value:"conservative",label:e($=>$.engineering.mode_conservative)},{value:"balanced",label:e($=>$.engineering.mode_balanced)},{value:"autonomous",label:e($=>$.engineering.mode_autonomous)},{value:"fully_autonomous",label:e($=>$.engineering.mode_fully_autonomous)}];
 if(!editing)return <div className="space-y-3">{profile && <><p className="text-body font-medium">{t($=>$.engineering.workflows[profile.definition.workflow])}</p><dl className="grid gap-2 text-body sm:grid-cols-2">{teamWorkflowRoles[profile.definition.workflow].map(role=><div key={role}><dt className="text-caption text-muted-foreground">{roleLabels[role]}</dt><dd>{agents.find(agent=>agent.id===profile.definition.roles[role])?.name??profile.definition.roles[role]}</dd></div>)}</dl>{profile.definition.feedback && <div className="space-y-2"><p className="text-label font-medium">{t($=>$.engineering.feedback)}</p><dl className="grid gap-2 text-body sm:grid-cols-2">{teamFeedbackRoles.map(role=><div key={role}><dt className="text-caption text-muted-foreground">{feedbackLabels[role]}</dt><dd>{agents.find(agent=>agent.id===profile.definition.feedback![role])?.name??profile.definition.feedback![role]}</dd></div>)}</dl></div>}</>}{canManage && <Button size="sm" variant="outline" onClick={()=>setEditing(true)}>{profile?t($=>$.engineering.edit):t($=>$.engineering.setup)}</Button>}</div>;
 return <form className="space-y-4" onSubmit={async event=>{event.preventDefault();if(!valid || pending)return;setError("");try{await onSave(draft);setEditing(false)}catch(cause){setError(cause instanceof Error?cause.message:t($=>$.engineering.save_error))}}}>
  <fieldset disabled={pending} className="space-y-4">
   <div className="space-y-1.5"><Label>{t($=>$.engineering.workflow)}</Label><Select items={workflows} value={draft.workflow} onValueChange={value=>{if(value && value in teamWorkflowRoles){const workflow=value as TeamDefinition["workflow"],{feedback,...definition}=draft;setDraft({...definition,workflow,roles:Object.fromEntries(teamWorkflowRoles[workflow].map(role=>[role,draft.roles[role]??(role==="executor"?leaderId:"")])),...(supportsTeamFeedback(workflow) && feedback ? {feedback} : {})})}}}><SelectTrigger aria-label={t($=>$.engineering.workflow)}><SelectValue /></SelectTrigger><SelectContent>{workflows.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
   <div className="grid gap-4 sm:grid-cols-2">{required.map(role=><div className="space-y-1.5" key={role}><Label>{roleLabels[role]}</Label><Select items={available.map(agent=>({value:agent.id,label:agent.name}))} value={draft.roles[role]??""} onValueChange={value=>setDraft({...draft,roles:{...draft.roles,[role]:value??""}})}><SelectTrigger aria-label={roleLabels[role]}><SelectValue placeholder={e($=>$.engineering.select_agent)} /></SelectTrigger><SelectContent>{available.map(agent=><SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent></Select></div>)}</div>
   {supportsTeamFeedback(draft.workflow) && <div className="space-y-3"><div className="flex items-center gap-2"><Checkbox id={`${id}-feedback`} checked={!!draft.feedback} onCheckedChange={checked=>{const {feedback:_,...definition}=draft;setDraft(checked ? {...definition,feedback:{triager:"",verifier:"",planner:"",reproducer:""}} : definition)}} /><Label htmlFor={`${id}-feedback`}>{t($=>$.engineering.feedback)}</Label></div>{draft.feedback && <><div className="grid gap-4 sm:grid-cols-2">{teamFeedbackRoles.map(role=><div key={role} className="min-w-0 space-y-1.5"><Label>{feedbackLabels[role]}</Label><Select items={feedbackChoices(role).map(agent=>({value:agent.id,label:agent.name}))} value={draft.feedback![role]} onValueChange={value=>setDraft({...draft,feedback:{...draft.feedback!,[role]:value??""}})}><SelectTrigger className="w-full min-w-0" aria-label={`${t($=>$.engineering.feedback)} · ${feedbackLabels[role]}`}><SelectValue className="min-w-0 truncate" placeholder={e($=>$.engineering.select_agent)} /></SelectTrigger><SelectContent>{feedbackChoices(role).map(agent=><SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent></Select></div>)}</div><p className="text-caption text-muted-foreground">{t($=>$.engineering.feedback_independence)}</p></>}</div>}
   {draft.workflow!=="direct" && <><div className="space-y-1.5"><Label>{e($=>$.engineering.decision_mode)}</Label><Select items={policies} value={draft.decision_mode} onValueChange={value=>{if(policies.some(policy=>policy.value===value))setDraft({...draft,decision_mode:value as TeamDefinition["decision_mode"]})}}><SelectTrigger aria-label={e($=>$.engineering.decision_mode)}><SelectValue /></SelectTrigger><SelectContent>{policies.map(policy=><SelectItem key={policy.value} value={policy.value}>{policy.label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor={`${id}-reworks`}>{e($=>$.engineering.max_reworks)}</Label><Input id={`${id}-reworks`} type="number" min={0} max={10} value={draft.max_reworks} onChange={event=>setDraft({...draft,max_reworks:Number(event.target.value)})} /></div></>}
   {duplicate && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.independent_roles)}</p>}
   {available.length<required.length && <p className="text-caption text-muted-foreground">{t($=>$.engineering.missing_members)}</p>}
  </fieldset>
  {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
  <div className="flex gap-2"><Button type="submit" size="sm" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.save)}</Button><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={()=>{setDraft(profile?.definition??{workflow:"direct",roles:{executor:leaderId},decision_mode:"balanced",max_reworks:2});setEditing(false)}}>{t($=>$.engineering.cancel)}</Button></div>
 </form>;
}
