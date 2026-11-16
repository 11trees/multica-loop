import {useQueries,useQuery} from "@tanstack/react-query";
import {api} from "../api";
import {agentListOptions,squadListOptions} from "../workspace/queries";

export function useEngineeringTeams(workspaceId:string){
 const squads=useQuery(squadListOptions(workspaceId));
 const agents=useQuery(agentListOptions(workspaceId));
 const active=(squads.data??[]).filter(team=>!team.archived_at);
 const definitions=useQueries({queries:active.map(team=>({queryKey:["engineering-team",workspaceId,team.id],queryFn:()=>api.getEngineeringTeam(team.id)}))});
 return {teams:active.flatMap((team,index)=>{const profile=definitions[index]?.data?.profile;return profile?[{...team,profile,runtimeReady:agents.isSuccess ? [...Object.values(profile.definition.roles),...Object.values(profile.definition.feedback??{})].every(id=>agents.data.some(agent=>agent.id===id && !agent.archived_at && !!agent.runtime_id)) : undefined}]:[]}),isPending:squads.isPending || agents.isPending || definitions.some(query=>query.isPending),isError:squads.isError || agents.isError || definitions.some(query=>query.isError),retry:()=>Promise.all([squads.refetch(),agents.refetch(),...definitions.map(query=>query.refetch())])};
}
