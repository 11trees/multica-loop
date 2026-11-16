import {queryOptions} from "@tanstack/react-query";
import {api} from "../api";
import {projectKeys} from "../projects/queries";
import type {QueryClient} from "@tanstack/react-query";
export const historyKeys={all:(wsId:string,userId:string)=>["history",wsId,userId] as const};
export function historyAvailabilityOptions(wsId:string,userId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"availability"],queryFn:()=>api.historyAvailability(wsId),staleTime:30000});}
export function historyListOptions(wsId:string,userId:string,filter:{projectId?:string;search?:string;offset?:number}){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"list",filter],queryFn:()=>api.listHistory(wsId,filter),staleTime:30000});}
export function historyTaskOptions(wsId:string,userId:string,id:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"task",id],queryFn:()=>api.historyTask(wsId,id),staleTime:30000});}
export function historyDocumentOptions(wsId:string,userId:string,taskId:string,documentId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"document",taskId,documentId],queryFn:()=>api.historyDocument(wsId,taskId,documentId),staleTime:30000});}
export function historyPacketOptions(wsId:string,userId:string,taskId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"packet",taskId],queryFn:()=>api.historyPacket(wsId,taskId),staleTime:30000});}
export function historyPreparationOptions(wsId:string,userId:string,taskId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"preparation",taskId],queryFn:()=>api.historyPreparation(wsId,taskId),staleTime:0});}
export function historyPreparationMutationOptions(client:QueryClient,wsId:string,userId:string,taskId:string){return {mutationFn:(input:Parameters<typeof api.prepareHistoryTask>[2])=>api.prepareHistoryTask(wsId,taskId,input),onSuccess:async()=>{await Promise.all([client.invalidateQueries({queryKey:historyKeys.all(wsId,userId)}),client.invalidateQueries({queryKey:projectKeys.all(wsId)})]);}};}

export function supplementOptions(wsId:string,userId:string,hash:string,input:Parameters<typeof api.historySupplement>[2]){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"supplement",hash,input],queryFn:()=>api.historySupplement(wsId,hash,input),staleTime:30000});}
export function supplementDownloadOptions(wsId:string,hash:string){return {mutationFn:(fileId:string)=>api.downloadHistorySupplementFile(wsId,hash,fileId)};}
