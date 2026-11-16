"use client";
import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {historyPacketOptions} from "@multica/core/history/queries";
import {Button} from "@multica/ui/components/ui/button";
import {useT} from "../i18n";

export function HistoryPacket({wsId,userId,taskId}:{wsId:string;userId:string;taskId:string}){
 const {t}=useT("layout"),[opened,setOpened]=useState(false),[downloadFailed,setDownloadFailed]=useState(false);
 const result=useQuery({...historyPacketOptions(wsId,userId,taskId),enabled:opened});
 const packet=result.data?.packet;
 const download=()=>{
  if(!packet)return;
  setDownloadFailed(false);
  let url:string|undefined;
  try{url=URL.createObjectURL(new Blob([JSON.stringify(result.data,null,2)+"\n"],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=`loopwork-${taskId.replace(/[^a-zA-Z0-9_-]/g,"_")}-handoff.json`;document.body.appendChild(link);link.click();link.remove();const pending=url;setTimeout(()=>URL.revokeObjectURL(pending),1000);}catch{if(url)URL.revokeObjectURL(url);setDownloadFailed(true);}
 };
 const groups=[
  {label:t($=>$.history.packet.goal),tables:["projects","tasks","requirement_metadata"]},
  {label:t($=>$.history.packet.acceptance),tables:["acceptances","command_chain_acceptance_items","delivery_unit_acceptances"]},
  {label:t($=>$.history.packet.delivery),tables:["stories","story_specs","delivery_unit_dependencies","delivery_unit_context_links","task_dependencies"]},
  {label:t($=>$.history.packet.decisions),tables:["questions","runtime_input_requests","command_chain_decisions","command_chain_runtime_inputs"]},
  {label:t($=>$.history.packet.materials),tables:["agent_work_drafts","command_chain_drafts","command_chain_artifact_blocks","business_analysis_drafts","business_analysis_module_items","business_analysis_phase_artifacts","documents"]},
  {label:t($=>$.history.packet.feedback),tables:["document_comments","feedback_batches","feedback_groups","feedback_batch_comments","feedback_group_comments","feedback_group_delivery_units","task_context_chat_sessions","task_context_chat_messages","task_context_chat_change_requests"]},
 ];
 return <section className="rounded-lg border border-border p-4" aria-label={t($=>$.history.packet.title)}>
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-body font-medium">{t($=>$.history.packet.title)}</h3><Button variant="outline" size="sm" aria-expanded={opened} onClick={()=>setOpened(!opened)}>{opened?t($=>$.history.packet.hide):t($=>$.history.packet.show)}</Button></div>
  {opened&&<div className="mt-4 flex min-w-0 flex-col gap-3 text-body">
   <p className="text-muted-foreground">{t($=>$.history.packet.boundary)}</p>
   {result.isPending&&<p role="status">{t($=>$.history.loading)}</p>}
   {result.isError&&<div role="alert"><p>{t($=>$.history.error)}</p><Button variant="outline" size="sm" onClick={()=>void result.refetch()}>{t($=>$.history.retry)}</Button></div>}
   {result.data?.packet===null&&<p>{t($=>$.history.missing)}</p>}
   {packet&&<>
    <p className="break-words">{packet.source_project.name}{packet.source_project.deleted_at?` · ${t($=>$.history.deleted_project)}`:""}</p>
    {packet.source_project.deleted_at&&<p className="text-muted-foreground">{t($=>$.history.packet.deleted)}</p>}
    {!packet.schema_complete&&<p role="status" className="text-muted-foreground">{t($=>$.history.packet.incomplete)}</p>}
    <p className="text-caption text-muted-foreground">{t($=>$.history.packet.counts)}</p>
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{groups.map(group=><div key={group.label} className="flex items-baseline justify-between gap-3 rounded-md bg-muted/30 px-3 py-2"><dt className="min-w-0 break-words">{group.label}</dt><dd className="shrink-0 tabular-nums">{packet.sections.filter(section=>group.tables.includes(section.table)).reduce((count,section)=>count+section.rows.length,0)}</dd></div>)}</dl>
    <p className="text-caption text-muted-foreground">{t($=>$.history.packet.files)}</p>
    <details><summary className="cursor-pointer text-caption">{t($=>$.history.packet.fingerprint)}</summary><p className="mt-2 break-all font-mono text-caption">{packet.hash}</p></details>
    <Button variant="outline" className="w-fit" onClick={download}>{t($=>$.history.packet.download)}</Button>
    {downloadFailed&&<p role="alert">{t($=>$.history.packet.download_failed)}</p>}
   </>}
  </div>}
 </section>;
}
