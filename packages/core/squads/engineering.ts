import {useQueries,useQuery} from "@tanstack/react-query";
import {api} from "../api";
import {squadListOptions} from "../workspace/queries";

export function useEngineeringTeams(workspaceId:string){
 const squads=useQuery(squadListOptions(workspaceId));
 const active=(squads.data??[]).filter(team=>!team.archived_at);
 const definitions=useQueries({queries:active.map(team=>({queryKey:["engineering-team",workspaceId,team.id],queryFn:()=>api.getEngineeringTeam(team.id)}))});
 return {teams:active.flatMap((team,index)=>{const profile=definitions[index]?.data?.profile;return profile?[{...team,profile}]:[]}),isPending:squads.isPending || definitions.some(query=>query.isPending),isError:squads.isError || definitions.some(query=>query.isError),retry:()=>Promise.all([squads.refetch(),...definitions.map(query=>query.refetch())])};
}
