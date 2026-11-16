"use client";
import {useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {historyAvailabilityOptions,historyKeys,supplementOptions,supplementDownloadOptions} from "@multica/core/history/queries";
import {Button} from "@multica/ui/components/ui/button";
import {Input} from "@multica/ui/components/ui/input";
import {ArrowLeft,History} from "@multica/ui/icons";
import {PageHeader} from "../layout/page-header";
import {useNavigation} from "../navigation";
import {useT} from "../i18n";
import {useDebouncedValue} from "../common/use-debounced-value";

export function SupplementHistory({wsId,userId}:{wsId:string;userId:string}){
 const {t}=useT("layout"),nav=useNavigation(),client=useQueryClient(),[search,setSearch]=useState(""),settled=useDebouncedValue(search,250);
 const availability=useQuery({...historyAvailabilityOptions(wsId,userId),enabled:!!wsId&&!!userId});
 const enabled=availability.data?.enabled===true&&availability.data.supplement?.enabled===true,hash=availability.data?.supplement?.hash??"";
 const catalog=useQuery({...supplementOptions(wsId,userId,hash,{action:"catalog"}),enabled});
 const data=catalog.data&&"databases" in catalog.data?catalog.data:null;
 const filesMode=nav.searchParams.get("view")==="files",databaseID=nav.searchParams.get("database")??data?.databases.find(row=>row.available)?.id??"",taskID=nav.searchParams.get("task")??"",documentID=nav.searchParams.get("document")??"",fileID=nav.searchParams.get("file")??"";
 const offset=Math.max(0,Number(nav.searchParams.get("offset"))||0),database=data?.databases.find(row=>row.id===databaseID),file=data?.files.find(row=>row.id===fileID);
 const navigate=(fields:Record<string,string>)=>{const params=new URLSearchParams({archive:"supplement",...fields});nav.push(`${nav.pathname}?${params}`);};
 const list=useQuery({...supplementOptions(wsId,userId,hash,{action:"tasks",databaseId:databaseID,search:settled||undefined,offset}),enabled:enabled&&!!database?.available&&!filesMode&&!taskID});
 const task=useQuery({...supplementOptions(wsId,userId,hash,{action:"task",databaseId:databaseID,taskId:taskID}),enabled:enabled&&!!database?.available&&!filesMode&&!!taskID});
 const documentQuery=useQuery({...supplementOptions(wsId,userId,hash,{action:"document",databaseId:databaseID,taskId:taskID,documentId:documentID}),enabled:enabled&&!!database?.available&&!filesMode&&!!taskID&&!!documentID});
 const preview=useQuery({...supplementOptions(wsId,userId,hash,{action:"file",fileId:fileID,offset:0,length:65536}),enabled:enabled&&filesMode&&!!file});
 const download=useMutation({...supplementDownloadOptions(wsId,hash),onSuccess:(bytes,fileID)=>{
  const source=data?.files.find(row=>row.id===fileID);if(!source)return;
  const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"})),link=document.createElement("a");link.href=url;link.download=source.path.split(/[\\/]/).at(-1)??"history.bin";document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }});
 const rows=list.data&&"tasks" in list.data?list.data:null,detail=task.data&&"task" in task.data?task.data:null,doc=documentQuery.data&&"document" in documentQuery.data?documentQuery.data:null,chunk=preview.data&&"file" in preview.data?preview.data:null;
 const errors=availability.isError||catalog.isError||list.isError||task.isError||documentQuery.isError||preview.isError||download.isError;
 const loading=availability.isPending||enabled&&catalog.isPending;
 let content="";if(chunk){try{content=new TextDecoder().decode(Uint8Array.from(atob(chunk.data_base64),c=>c.charCodeAt(0)));}catch{content="";}}
 const back=()=>{download.reset();if(filesMode)navigate({view:"files"});else if(documentID)navigate({database:databaseID,task:taskID});else navigate({database:databaseID});};
 return <div data-testid="supplement-history" className="flex h-full min-h-0 flex-col bg-background">
  <PageHeader><History className="mr-2 size-4"/><h1 className="text-body font-medium">{t($=>$.history.supplement.title)}</h1></PageHeader>
  <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6"><div className="mx-auto flex max-w-6xl flex-col gap-4">
   <Button variant="ghost" size="sm" className="w-fit" onClick={()=>nav.push(nav.pathname)}><ArrowLeft/>{t($=>$.history.supplement.primary)}</Button>
   <p className="text-body text-muted-foreground">{t($=>$.history.supplement.boundary)}</p>
   {loading&&<p role="status">{t($=>$.history.loading)}</p>}
   {!loading&&!enabled&&<p>{t($=>$.history.supplement.unavailable)}</p>}
   {errors&&<div role="alert"><p>{t($=>$.history.error)}</p><Button variant="outline" onClick={()=>{download.reset();void client.invalidateQueries({queryKey:historyKeys.all(wsId,userId)});}}>{t($=>$.history.retry)}</Button></div>}
   {data&&enabled&&<>
    <div className="flex flex-wrap gap-2"><Button aria-pressed={!filesMode} variant={filesMode?"outline":"secondary"} onClick={()=>{setSearch("");navigate({});}}>{t($=>$.history.supplement.databases)}</Button><Button aria-pressed={filesMode} variant={filesMode?"secondary":"outline"} onClick={()=>{setSearch("");navigate({view:"files"});}}>{t($=>$.history.supplement.files)} ({data.files.length})</Button></div>
    {!filesMode&&<label className="flex min-w-0 flex-col gap-1 text-caption"><span>{t($=>$.history.supplement.database)}</span><select className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-body" value={databaseID} onChange={event=>{setSearch("");navigate({database:event.target.value});}}>{data.databases.map(row=><option key={row.id} value={row.id} disabled={!row.available}>{row.path} · {row.available?row.task_count:t($=>$.history.supplement.excluded)}</option>)}</select></label>}
    {!taskID&&!fileID&&<label className="flex min-w-0 flex-col gap-1 text-caption"><span>{t($=>$.history.search)}</span><Input maxLength={200} value={search} onChange={event=>{setSearch(event.target.value);if(!filesMode&&offset)navigate({database:databaseID});}}/></label>}
    {!filesMode&&!taskID&&rows&&<>
     <p className="text-caption text-muted-foreground">{t($=>$.history.count,{count:rows.total})}</p>
     {rows.tasks.map(row=><Button key={row.id} variant="outline" className="h-auto w-full justify-start p-3 text-left" onClick={()=>navigate({database:databaseID,task:row.id})}><span className="flex min-w-0 flex-col gap-1"><span className="whitespace-normal break-words">{row.title}</span><span className="break-all text-caption text-muted-foreground">{row.id}{row.additional?` · ${t($=>$.history.supplement.additional)}`:""}</span></span></Button>)}
     {!rows.tasks.length&&<p>{t($=>$.history.empty)}</p>}
     {rows.total>50&&<div className="flex justify-end gap-2"><Button variant="outline" disabled={!offset} onClick={()=>navigate({database:databaseID,offset:String(Math.max(0,offset-50))})}>{t($=>$.history.previous)}</Button><Button variant="outline" disabled={offset+50>=rows.total} onClick={()=>navigate({database:databaseID,offset:String(offset+50)})}>{t($=>$.history.next)}</Button></div>}
    </>}
    {!filesMode&&taskID&&<>
     <Button variant="ghost" size="sm" className="w-fit" onClick={back}><ArrowLeft/>{documentID?t($=>$.history.back_task):t($=>$.history.back_list)}</Button>
     {(task.isPending||!!documentID&&documentQuery.isPending)&&<p role="status">{t($=>$.history.loading)}</p>}
     {!documentID&&detail?.task&&<section className="flex min-w-0 flex-col gap-4"><p className="break-all text-caption">{detail.task.id}</p><h2 className="break-words text-title-lg font-semibold">{detail.task.title}</h2><p>{detail.task.status}</p><pre className="whitespace-pre-wrap break-words text-body">{detail.task.description}</pre><details><summary>{t($=>$.history.original_source)}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-caption">{JSON.stringify(detail.task.raw,null,2)}</pre></details><h3>{t($=>$.history.documents)}</h3>{detail.documents.map(row=><Button key={row.id} variant="outline" className="h-auto justify-start whitespace-normal break-words py-3 text-left" onClick={()=>navigate({database:databaseID,task:taskID,document:row.id})}>{row.title}</Button>)}{!detail.documents.length&&<p>{t($=>$.history.no_documents)}</p>}</section>}
     {documentID&&doc?.document&&<article><h2 className="mb-4 break-words text-title-lg font-semibold">{doc.document.title}</h2><pre className="whitespace-pre-wrap break-words text-body">{doc.document.content}</pre><details className="mt-4"><summary>{t($=>$.history.original_source)}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-caption">{JSON.stringify(doc.document.raw,null,2)}</pre></details></article>}
     {(detail?.task===null||doc?.document===null)&&<p>{t($=>$.history.missing)}</p>}
    </>}
    {filesMode&&!fileID&&data.files.filter(row=>!settled||row.path.toLocaleLowerCase().includes(settled.toLocaleLowerCase())).map(row=><Button key={row.id} variant="outline" className="h-auto w-full justify-start p-3 text-left" onClick={()=>navigate({view:"files",file:row.id})}><span className="min-w-0 whitespace-normal break-all">{row.path}<span className="ml-2 text-caption text-muted-foreground">{row.bytes} B</span></span></Button>)}
    {filesMode&&fileID&&file&&<section className="flex min-w-0 flex-col gap-3"><Button variant="ghost" className="w-fit" onClick={back}><ArrowLeft/>{t($=>$.history.supplement.files)}</Button><h2 className="break-all text-title-lg font-semibold">{file.path}</h2><details><summary className="cursor-pointer text-caption">{t($=>$.history.supplement.fingerprint)}</summary><p className="mt-2 break-all font-mono text-caption">{file.sha256}</p></details><Button variant="outline" className="w-fit" disabled={download.isPending} aria-busy={download.isPending} onClick={()=>download.mutate(fileID)}>{t($=>$.history.supplement.download)}</Button>{preview.isPending&&<p role="status">{t($=>$.history.loading)}</p>}{chunk&&<><p className="text-caption text-muted-foreground">{t($=>$.history.supplement.preview,{count:chunk.byte_length,total:chunk.file.bytes})}</p><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-caption">{content||t($=>$.history.supplement.empty)}</pre></>}</section>}
    {(filesMode&&fileID&&!file||!filesMode&&!database)&&<p>{t($=>$.history.missing)}</p>}
   </>}
  </div></div>
 </div>;
}
