"use client";
import {useState} from "react";
import {keepPreviousData,useQuery} from "@tanstack/react-query";
import {useCurrentWorkspace} from "@multica/core/paths";
import {useAuthStore} from "@multica/core/auth";
import {historyAvailabilityOptions,historyListOptions,historyTaskOptions,historyDocumentOptions} from "@multica/core/history/queries";
import {Button} from "@multica/ui/components/ui/button";
import {Input} from "@multica/ui/components/ui/input";
import {Markdown} from "@multica/ui/markdown";
import {ArrowLeft,FileText,History,Loader2} from "@multica/ui/icons";
import {PageHeader} from "../layout/page-header";
import {useT} from "../i18n";
import {useNavigation} from "../navigation";
import {useDebouncedValue} from "../common/use-debounced-value";
import {HistoryPacket} from "./history-packet";

export function HistoryPage(){
 const wsId=useCurrentWorkspace()?.id??"",userId=useAuthStore(s=>s.user?.id)??"";
 return <HistoryContent key={`${wsId}:${userId}`} wsId={wsId} userId={userId}/>;
}
function HistoryContent({wsId,userId}:{wsId:string;userId:string}){
 const {t}=useT("layout"),[project,setProject]=useState(""),[search,setSearch]=useState(""),[offset,setOffset]=useState(0);
 const statusNames=new Map<string,string>([
  ["backlog",t($=>$.history.statuses.backlog)],
  ["in plan",t($=>$.history.statuses.in_plan)],
  ["in repro",t($=>$.history.statuses.in_repro)],
  ["ready for dev",t($=>$.history.statuses.ready_for_dev)],
  ["in dev",t($=>$.history.statuses.in_dev)],
  ["in review",t($=>$.history.statuses.in_review)],
  ["in feedback",t($=>$.history.statuses.in_feedback)],
  ["ready_to_close",t($=>$.history.statuses.ready_to_close)],
  ["done",t($=>$.history.statuses.done)],
  ["cancelled",t($=>$.history.statuses.cancelled)],
  ["blocked",t($=>$.history.statuses.blocked)],
]);
 const nav=useNavigation(),selected=nav.searchParams.get("task")??"",documentId=selected?nav.searchParams.get("document")??"":"";
 const select=(task:string,document="")=>{const params=new URLSearchParams(nav.searchParams);if(task)params.set("task",task);else params.delete("task");if(document)params.set("document",document);else params.delete("document");const query=params.toString();nav.push(`${nav.pathname}${query?`?${query}`:""}`);};
 const settledSearch=useDebouncedValue(search,250);
 const availability=useQuery({...historyAvailabilityOptions(wsId,userId),enabled:!!wsId&&!!userId});
 const list=useQuery({...historyListOptions(wsId,userId,{projectId:project||undefined,search:settledSearch||undefined,offset}),placeholderData:keepPreviousData,enabled:availability.data?.enabled===true});
 const detail=useQuery({...historyTaskOptions(wsId,userId,selected),enabled:availability.data?.enabled===true&&!!selected});
 const document=useQuery({...historyDocumentOptions(wsId,userId,selected,documentId),enabled:availability.data?.enabled===true&&!!selected&&!!documentId});
 const loading=availability.isPending||availability.data?.enabled&&list.isPending;
 const error=availability.isError||list.isError||!!selected&&detail.isError||!!documentId&&document.isError;
 const back=()=>select(documentId?selected:"");
 return <div data-testid="loopwork-history" className="flex h-full min-h-0 flex-col bg-background">
  <PageHeader><History className="mr-2 size-4 text-muted-foreground"/><h1 className="text-body font-medium">{t($=>$.history.title)}</h1></PageHeader>
  <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
   <div className="mx-auto flex max-w-6xl flex-col gap-5">
    <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-body text-muted-foreground">{t($=>$.history.ownership)}</div>
    {loading&&<p role="status" className="flex items-center gap-2 text-body text-muted-foreground"><Loader2 className="size-4 animate-spin"/>{t($=>$.history.loading)}</p>}
    {error&&<div role="alert" className="flex items-center gap-3 text-body"><span>{t($=>$.history.error)}</span><Button variant="outline" size="sm" onClick={()=>{void availability.refetch();void list.refetch();if(selected)void detail.refetch();if(documentId)void document.refetch();}}>{t($=>$.history.retry)}</Button></div>}
    {!loading&&!availability.data?.enabled&&!error&&<p className="text-body text-muted-foreground">{t($=>$.history.unavailable)}</p>}
    {availability.data?.enabled&&list.data&&!selected&&<>
     <div className="flex flex-col gap-3 sm:flex-row">
      <label className="flex min-w-0 flex-col gap-1 text-caption"><span>{t($=>$.history.project)}</span><select className="h-9 rounded-md border border-input bg-background px-3 text-body" value={project} onChange={e=>{setProject(e.target.value);setOffset(0);}}><option value="">{t($=>$.history.all_projects)}</option>{list.data.projects.map(item=><option key={item.id} value={item.id}>{item.name} ({item.task_count}){item.deleted_at?` · ${t($=>$.history.deleted_project)}`:""}</option>)}</select></label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-caption"><span>{t($=>$.history.search)}</span><Input value={search} onChange={e=>{setSearch(e.target.value);setOffset(0);}} placeholder={t($=>$.history.search_placeholder)}/></label>
     </div>
     <div className="flex flex-wrap justify-between gap-2 text-caption text-muted-foreground"><p>{t($=>$.history.count,{count:list.data.total})}</p><p>{t($=>$.history.captured,{date:new Date(list.data.source.captured_at).toLocaleString()})}</p></div>
     <div className="overflow-hidden rounded-lg border border-border">
      {!list.data.tasks.length&&<p className="p-6 text-body text-muted-foreground">{t($=>$.history.empty)}</p>}
      {list.data.tasks.map(task=><Button key={task.id} variant="ghost" className="h-auto w-full justify-start rounded-none border-b border-border px-4 py-3 text-left last:border-b-0" onClick={()=>select(task.id)}><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate text-body font-medium">{task.title}</span><span className="truncate text-caption text-muted-foreground">{list.data.projects.find(p=>p.id===task.project_id)?.name} · {task.id}</span></span><span className="ml-4 shrink-0 text-caption text-muted-foreground">{statusNames.get(task.status)??task.status}</span></Button>)}
     </div>
     {list.data.total>list.data.limit&&<div className="flex items-center justify-end gap-2"><Button variant="outline" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>{t($=>$.history.previous)}</Button><Button variant="outline" disabled={offset+50>=list.data.total} onClick={()=>setOffset(offset+50)}>{t($=>$.history.next)}</Button></div>}
    </>}
    {availability.data?.enabled&&selected&&<><Button variant="ghost" size="sm" className="w-fit" onClick={back}><ArrowLeft/>{documentId?t($=>$.history.back_task):t($=>$.history.back_list)}</Button>
     {detail.isPending&&<p role="status" className="text-body text-muted-foreground">{t($=>$.history.loading)}</p>}
     {detail.data?.task&&!documentId&&<section className="flex min-w-0 flex-col gap-5">
      <div><p className="break-all text-caption text-muted-foreground">{detail.data.task.id}</p><h2 className="mt-1 break-words text-title-lg font-semibold">{detail.data.task.title}</h2><p className="mt-2 text-body text-muted-foreground">{statusNames.get(detail.data.task.status)??detail.data.task.status}</p></div>
      {detail.data.task.blocked_reason&&<p className="whitespace-pre-wrap break-words text-body">{detail.data.task.blocked_reason}</p>}
      {detail.data.task.description&&<Markdown mode="full" renderImage={({alt})=><span className="block rounded-md border border-border px-3 py-2 text-caption text-muted-foreground">{t($=>$.history.image_reference)}{alt?` · ${alt}`:""}</span>}>{detail.data.task.description}</Markdown>}
      <HistoryPacket key={selected} wsId={wsId} userId={userId} taskId={selected}/>
      <div><h3 className="mb-2 text-body font-medium">{t($=>$.history.documents)}</h3><div className="flex flex-col gap-1">{detail.data.documents.map(item=><Button key={item.id} variant="ghost" className="h-auto w-full justify-start py-3 text-left" onClick={()=>select(selected,item.id)}><FileText className="shrink-0"/><span className="min-w-0 flex-1 whitespace-normal break-words">{item.title}</span><span className="ml-2 shrink-0 text-caption text-muted-foreground">{item.kind} · {t($=>$.history.revision,{revision:item.revision})}</span></Button>)}{!detail.data.documents.length&&<p className="text-body text-muted-foreground">{t($=>$.history.no_documents)}</p>}</div></div>
     </section>}
     {documentId&&document.isPending&&<p role="status" className="text-body text-muted-foreground">{t($=>$.history.loading)}</p>}
     {document.data?.document&&documentId&&<article className="min-w-0"><h2 className="mb-1 break-words text-title-lg font-semibold">{document.data.document.title}</h2><p className="mb-5 text-caption text-muted-foreground">{document.data.document.source_agent} · {t($=>$.history.revision,{revision:document.data.document.revision})}</p>{["markdown","md"].includes(document.data.document.format)?<Markdown mode="full" renderImage={({alt})=><span className="block rounded-md border border-border px-3 py-2 text-caption text-muted-foreground">{t($=>$.history.image_reference)}{alt?` · ${alt}`:""}</span>}>{document.data.document.content}</Markdown>:<pre className="whitespace-pre-wrap break-words text-body">{document.data.document.content}</pre>}{["markdown","md"].includes(document.data.document.format)&&<details className="mt-6 rounded-md border border-border p-3"><summary className="cursor-pointer text-caption">{t($=>$.history.original_source)}</summary><pre className="mt-3 whitespace-pre-wrap break-words text-caption">{document.data.document.content}</pre></details>}</article>}
     {(detail.data?.task===null||!!documentId&&document.data?.document===null)&&<p className="text-body text-muted-foreground">{t($=>$.history.missing)}</p>}
    </>}
   </div>
  </div>
 </div>;
}
