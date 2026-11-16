"use client";

import {useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {api} from "@multica/core/api";
import {useWorkspacePaths} from "@multica/core/paths";
import {AppLink} from "../../navigation";
import {useAuthStore} from "@multica/core/auth";
import {runtimeListOptions} from "@multica/core/runtimes/queries";
import {memberListOptions,workspaceKeys} from "@multica/core/workspace/queries";
import type {EngineeringTeamProfile} from "@multica/core/squads";
import type {Agent} from "@multica/core/types";
import {Button} from "@multica/ui/components/ui/button";
import {Spinner} from "@multica/ui/components/ui/spinner";
import {RuntimePicker} from "../../agents/components/runtime-picker";
import {useT} from "../../i18n";

export function TeamRuntimeSettings({workspaceId,profile,agents,canManage}:{workspaceId:string;profile:EngineeringTeamProfile;agents:Agent[];canManage:boolean}){
 const {t}=useT("squads"),client=useQueryClient(),paths=useWorkspacePaths();
 const userId=useAuthStore(state=>state.user?.id??null);
 const runtimes=useQuery(runtimeListOptions(workspaceId)),members=useQuery(memberListOptions(workspaceId));
 const ids=[...new Set([...Object.values(profile.definition.roles),...Object.values(profile.definition.feedback??{})])];
 const roleAgents=ids.map(id=>agents.find(agent=>agent.id===id && !agent.archived_at));
 const saved=roleAgents.every(agent=>agent?.runtime_id && agent.runtime_id===roleAgents[0]?.runtime_id) ? roleAgents[0]?.runtime_id??"" : "";
 const [runtimeId,setRuntimeId]=useState(saved);
 const [completed,setCompleted]=useState(0);
 const save=useMutation({mutationFn:async()=>{
  setCompleted(0);
  if(roleAgents.some(agent=>!agent))throw new Error(t($=>$.engineering.missing_members));
  let count=0;
  for(const agent of roleAgents){
   if(agent!.runtime_id!==runtimeId)await api.updateAgent(agent!.id,{runtime_id:runtimeId});
   setCompleted(++count);
  }
 },onSettled:()=>client.invalidateQueries({queryKey:workspaceKeys.agents(workspaceId)})});
 return <div className="mt-4 min-w-0 space-y-3 border-t pt-4">
  <p className="text-caption text-muted-foreground">{t($=>$.engineering.runtime_scope)}</p>
  {canManage ? <>
   <RuntimePicker runtimes={runtimes.data??[]} runtimesLoading={runtimes.isPending} members={members.data??[]} currentUserId={userId} selectedRuntimeId={runtimeId} onSelect={id=>{setRuntimeId(id);save.reset()}} autoSelect={false} disabled={save.isPending} />
   {runtimes.isSuccess && !runtimes.data.length && <p className="text-caption"><AppLink className="underline" href={paths.runtimes()}>{t($=>$.engineering.connect_runtime)}</AppLink></p>}
   <Button size="sm" variant="outline" disabled={!runtimeId || runtimes.isPending || runtimes.isError || save.isPending || !!saved && saved===runtimeId} aria-busy={save.isPending} onClick={()=>save.mutate()}>{save.isPending && <Spinner />}{t($=>$.engineering.apply_runtime)}</Button>
  </> : !saved && <p className="text-caption">{t($=>$.engineering.runtime_required)}</p>}
  {runtimes.isError && <p role="alert">{t($=>$.engineering.load_error)} <Button size="sm" variant="ghost" onClick={()=>{void runtimes.refetch()}}>{t($=>$.engineering.retry)}</Button></p>}
  {save.isError && <p role="alert" className="text-caption text-destructive break-words">{t($=>$.engineering.runtime_partial,{count:completed,total:ids.length})} {save.error.message}</p>}
  {save.isSuccess && <p role="status" className="text-caption">{t($=>$.engineering.runtime_saved)}</p>}
 </div>;
}
