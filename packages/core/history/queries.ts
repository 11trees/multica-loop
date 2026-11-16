import {queryOptions} from "@tanstack/react-query";
import {api} from "../api";
export const historyKeys={all:(wsId:string,userId:string)=>["history",wsId,userId] as const};
export function historyAvailabilityOptions(wsId:string,userId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"availability"],queryFn:()=>api.historyAvailability(wsId),staleTime:30000});}
export function historyListOptions(wsId:string,userId:string,filter:{projectId?:string;search?:string;offset?:number}){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"list",filter],queryFn:()=>api.listHistory(wsId,filter),staleTime:30000});}
export function historyTaskOptions(wsId:string,userId:string,id:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"task",id],queryFn:()=>api.historyTask(wsId,id),staleTime:30000});}
export function historyDocumentOptions(wsId:string,userId:string,taskId:string,documentId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"document",taskId,documentId],queryFn:()=>api.historyDocument(wsId,taskId,documentId),staleTime:30000});}
export function historyPacketOptions(wsId:string,userId:string,taskId:string){return queryOptions({queryKey:[...historyKeys.all(wsId,userId),"packet",taskId],queryFn:()=>api.historyPacket(wsId,taskId),staleTime:30000});}
