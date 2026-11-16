"use client";
import {useId,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {historyPreparationOptions,historyPreparationMutationOptions} from "@multica/core/history/queries";
import {Button} from "@multica/ui/components/ui/button";
import {useT} from "../i18n";
import {useWorkspacePaths} from "@multica/core/paths";
import type {HistoryAdoption} from "@multica/core/history/schema";
import {AppLink} from "../navigation";

function NativeAdoptionLinks({adoptions}:{adoptions:HistoryAdoption[]}){
 const paths=useWorkspacePaths(),{t}=useT("layout");
 return <div className="flex flex-col gap-2">{adoptions.map(item=><div key={item.cutoverId} className="flex flex-col gap-1"><p>{item.phase==="activated"?t($=>$.history.preparation.native_activated):item.phase==="staged"?t($=>$.history.preparation.native_pending):item.phase==="withdrawn"?t($=>$.history.preparation.native_withdrawn):t($=>$.history.preparation.native_retained)}</p>{item.nativeAvailable?<AppLink className="w-fit underline underline-offset-4" href={paths.issueDetail(item.issueId)}>{item.identifier||t($=>$.history.preparation.open_native)}</AppLink>:<p className="text-muted-foreground">{t($=>$.history.preparation.native_unavailable)}</p>}</div>)}</div>;
}

export function HistoryPreparation({wsId,userId,taskId,packetHash}:{wsId:string;userId:string;taskId:string;packetHash:string}){
 const {t}=useT("layout"),client=useQueryClient(),[project,setProject]=useState<string|null>(null),[team,setTeam]=useState<string|null>(null);
 const teamRevisionId=useId();
 const query=useQuery(historyPreparationOptions(wsId,userId,taskId)),save=useMutation(historyPreparationMutationOptions(client,wsId,userId,taskId)),state=query.data;
 const latest=state?.preparations[0],projectId=state?.mappedProjectId||project||"create",preferredTeam=team??latest?.teamId??"",teamId=state?.teams.some(item=>item.id===preferredTeam)?preferredTeam:state?.teams[0]?.id??"",selectedTeam=state?.teams.find(item=>item.id===teamId);
 const dirty=!!latest&&(teamId!==latest.teamId||selectedTeam?.revision!==latest.teamRevision||projectId!==latest.projectId);
 const reasons:Record<string,string>={source_project_deleted:t($=>$.history.preparation.deleted),source_task_terminal:t($=>$.history.preparation.terminal),incomplete_material:t($=>$.history.preparation.incomplete),unsupported_task_kind:t($=>$.history.preparation.unsupported),no_compatible_team:t($=>$.history.preparation.no_team),mapped_project_unavailable:t($=>$.history.preparation.project_unavailable)};
 const stale=!!state&&state.packetHash!==packetHash;
 return <section aria-label={t($=>$.history.preparation.title)} className="mt-2 flex flex-col gap-3 border-t border-border pt-4">
  <h4 className="font-medium">{t($=>$.history.preparation.title)}</h4>{!state?.adoptions?.length&&<p className="text-muted-foreground">{t($=>$.history.preparation.boundary)}</p>}
  {query.isPending&&<p role="status">{t($=>$.history.loading)}</p>}
  {(query.isError||save.isError||stale)&&<div role="alert"><p>{t($=>$.history.preparation.error)}</p><Button variant="outline" size="sm" onClick={()=>{save.reset();void client.invalidateQueries({queryKey:["history",wsId,userId]});}}>{t($=>$.history.retry)}</Button></div>}
  {state&&<>
   {!!state.adoptions?.length&&<NativeAdoptionLinks adoptions={state.adoptions}/>}
   {!!latest&&<p role="status">{t($=>$.history.preparation.saved,{revision:latest.revision})}{dirty?` · ${t($=>$.history.preparation.unsaved)}`:""}{!latest.current?` · ${t($=>$.history.preparation.stale)}`:""}</p>}
   {!!state.blockers.length&&<ul className="list-disc pl-5 text-muted-foreground">{state.blockers.map(reason=><li key={reason}>{reasons[reason]??t($=>$.history.preparation.unsupported)}</li>)}</ul>}
   {!state.blockers.length&&!state.adoptions?.some(item=>item.phase!=="withdrawn")&&<>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
     <label className="flex min-w-0 flex-col gap-1 text-caption"><span>{t($=>$.history.preparation.project)}</span><select className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-body" value={projectId} disabled={!!state.mappedProjectId||save.isPending} onChange={event=>setProject(event.target.value)}><option value="create">{t($=>$.history.preparation.create_project)}</option>{state.projects.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
     <div className="flex min-w-0 flex-col gap-1"><label className="flex min-w-0 flex-col gap-1 text-caption"><span>{t($=>$.history.preparation.team)}</span><select aria-describedby={selectedTeam?teamRevisionId:undefined} className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-body" value={teamId} disabled={save.isPending} onChange={event=>setTeam(event.target.value)}>{state.teams.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{selectedTeam&&<p id={teamRevisionId} className="text-caption text-muted-foreground">{t($=>$.history.preparation.team_revision,{revision:selectedTeam.revision})}</p>}</div>
    </div>
    <Button className="w-fit" disabled={save.isPending||stale||!selectedTeam} aria-busy={save.isPending} onClick={()=>{if(selectedTeam)save.mutate({expectedRevision:latest?.revision??0,expectedPacketHash:state.packetHash,teamId:selectedTeam.id,expectedTeamRevision:selectedTeam.revision,createProject:projectId==="create",...(projectId!=="create"?{projectId}:{})});}}>{save.isPending?t($=>$.history.preparation.saving):t($=>$.history.preparation.save)}</Button>
   </>}
  </>}
 </section>;
}
