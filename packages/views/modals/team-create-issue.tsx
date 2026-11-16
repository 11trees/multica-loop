"use client";

import {useId,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {api} from "@multica/core/api";
import {useWorkspaceId} from "@multica/core/hooks";
import {useWorkspacePaths} from "@multica/core/paths";
import {projectListOptions} from "@multica/core/projects/queries";
import {useEngineeringTeams} from "@multica/core/squads";
import {useIssueStatuses} from "@multica/core/issue-statuses/hooks";
import {issueWorkflowListOptions,resolveProjectWorkflow,workflowAllowsStatus} from "@multica/core/issue-workflows";
import {useCreateCommentSubIssue,useCreateIssue} from "@multica/core/issues/mutations";
import {useIssueDraftStore} from "@multica/core/issues/stores/draft-store";
import {contentReferencesAttachment,type Issue,type SourceContextPreview} from "@multica/core/types";
import {DialogTitle} from "@multica/ui/components/ui/dialog";
import {Button} from "@multica/ui/components/ui/button";
import {Input} from "@multica/ui/components/ui/input";
import {Label} from "@multica/ui/components/ui/label";
import {Spinner} from "@multica/ui/components/ui/spinner";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@multica/ui/components/ui/select";
import {FileUploadButton} from "@multica/ui/components/common/file-upload-button";
import {ContentEditor,type ContentEditorRef,useUploadGate} from "../editor";
import {AppLink,useNavigation} from "../navigation";
import {useT} from "../i18n";
import {useIssueCreateUploads} from "./use-issue-create-uploads";
import {SourceContextPreviewCard} from "./source-context-preview";

export function TeamCreatePanel({onClose,onPendingChange,data}:{onClose:()=>void;onPendingChange?:(pending:boolean)=>void;data?:Record<string,unknown>|null}){
 const {t}=useT("issues"),{t:s}=useT("squads"),id=useId(),workspaceId=useWorkspaceId(),paths=useWorkspacePaths(),navigation=useNavigation();
 const draft=useIssueDraftStore(store=>store.draft),setManual=useIssueDraftStore(store=>store.setManual),setShared=useIssueDraftStore(store=>store.setShared);
 const [title,setTitle]=useState(()=>typeof data?.title==="string" ? data.title : draft.manual.title);
 const [projectId,setProjectId]=useState(()=>typeof data?.project_id==="string" ? data.project_id : draft.shared.projectId??"");
 const [teamId,setTeamId]=useState(()=>data?.assignee_type==="squad" && typeof data.assignee_id==="string" ? data.assignee_id : draft.manual.assigneeType==="squad" ? draft.manual.assigneeId??"" : "");
 const [error,setError]=useState(""),[pending,setPending]=useState(false),[created,setCreated]=useState<Issue|null>(null),submitting=useRef(false);
 const editor=useRef<ContentEditorRef>(null),editorGate=useUploadGate(editor),uploads=useIssueCreateUploads("manual",editorGate,editor);
 const projects=useQuery(projectListOptions(workspaceId)),teamQuery=useEngineeringTeams(workspaceId),workflows=useQuery(issueWorkflowListOptions(workspaceId)),statuses=useIssueStatuses(workspaceId);
 const available=teamQuery.teams;
 const selected=available.find(team=>team.id===teamId),project=projects.data?.find(item=>item.id===projectId);
 const workflow=resolveProjectWorkflow(workflows.data,project);
 const openStatuses=statuses.activeStatuses.filter(status=>status.key!=="backlog" && ["unstarted","started"].includes(status.category) && workflowAllowsStatus(workflow,status.key));
 const startStatus=openStatuses.find(status=>status.key==="todo")?.key??openStatuses[0]?.key;
 const draftAllowed=statuses.activeStatuses.some(status=>status.key==="backlog") && workflowAllowsStatus(workflow,"backlog");
 const loading=projects.isPending || teamQuery.isPending || workflows.isPending || statuses.isPending;
 const failed=projects.isError || teamQuery.isError || workflows.isError || statuses.isError;
 const create=useCreateIssue(),createChild=useCreateCommentSubIssue();
 const anchor=typeof data?.anchor_comment_id==="string" ? data.anchor_comment_id : null,source=data?.source_context_preview as SourceContextPreview|undefined;
 const valid=!!title.trim() && !!selected && !!project && !loading && !failed && (!anchor || !!source && !data?.source_context_loading && !data?.source_context_failed);
 const submit=async(start:boolean)=>{
  if(start && selected?.runtimeReady===false || submitting.current || uploads.gate.isBlocked() || !created && (!valid || start && !startStatus || !start && !draftAllowed))return;
  submitting.current=true;setPending(true);onPendingChange?.(true);setError("");
  try{
   let issue=created;
   if(!issue){
    const description=editor.current?.getMarkdown()?.trim()??draft.manual.description.trim();
    setManual({description});
    const input={title:title.trim(),description,status:start?startStatus!:"backlog",assignee_type:"squad" as const,assignee_id:teamId,project_id:projectId,parent_issue_id:typeof data?.parent_issue_id==="string"?data.parent_issue_id:undefined,attachment_ids:uploads.attachments.filter(attachment=>contentReferencesAttachment(description,attachment)).map(attachment=>attachment.id)};
    issue=anchor && source ? await createChild.mutateAsync({anchorCommentId:anchor,data:{mode:"manual",capture_token:source.capture_token,issue:input}}) : await create.mutateAsync(input);
    setCreated(issue);useIssueDraftStore.getState().clearDraft();
   }
   if(start)await api.startEngineeringTeam(issue.id);
   useIssueDraftStore.getState().clearDraft();onClose();navigation.push(paths.issueDetail(issue.id));
  }catch(cause){setError(cause instanceof Error?cause.message:t($=>$.engineering.save_error))}
  finally{submitting.current=false;setPending(false);onPendingChange?.(false)}
 };
 return <form className="flex min-h-0 min-w-0 w-full flex-col" onSubmit={event=>{event.preventDefault();void submit(true)}}>
  <div className="px-5 pt-5"><DialogTitle>{t($=>$.engineering.new_task)}</DialogTitle></div>
  <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto p-5" inert={pending?true:undefined}>
   {created ? <p className="text-body"><AppLink className="underline" href={paths.issueDetail(created.id)}>{created.title}</AppLink> · {t($=>$.engineering.task_saved)}</p> : <>
    <div className="min-w-0 space-y-1.5"><Label htmlFor={`${id}-goal`}>{t($=>$.engineering.task_goal)}</Label><Input id={`${id}-goal`} autoFocus value={title} disabled={pending} onChange={event=>{setTitle(event.target.value);setManual({title:event.target.value})}} required /></div>
    <div className="grid gap-4 sm:grid-cols-2">
     <div className="min-w-0 space-y-1.5"><Label htmlFor={`${id}-project`}>{t($=>$.engineering.task_project)}</Label><Select items={(projects.data??[]).map(item=>({value:item.id,label:item.title}))} value={projectId} disabled={pending || projects.isPending} onValueChange={value=>{setProjectId(value??"");setShared({projectId:value??undefined})}}><SelectTrigger className="w-full min-w-0" id={`${id}-project`}><SelectValue className="min-w-0 truncate" placeholder={t($=>$.engineering.select_project)} /></SelectTrigger><SelectContent>{(projects.data??[]).map(item=><SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select></div>
     <div className="min-w-0 space-y-1.5"><Label htmlFor={`${id}-team`}>{t($=>$.engineering.team)}</Label><Select items={available.map(team=>({value:team.id,label:team.name}))} value={teamId} disabled={pending || loading} onValueChange={value=>{setTeamId(value??"");setManual({assigneeType:"squad",assigneeId:value??undefined})}}><SelectTrigger className="w-full min-w-0" id={`${id}-team`}><SelectValue className="min-w-0 truncate" placeholder={t($=>$.engineering.select_team)} /></SelectTrigger><SelectContent>{available.map(team=><SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></div>
    </div>
    {selected && <p className="text-caption text-muted-foreground">{s($=>$.engineering.workflows[selected.profile.definition.workflow])} · {t($=>$.engineering.team_version,{revision:selected.profile.revision})}</p>}
    {selected?.runtimeReady===false && <p className="text-caption"><AppLink className="underline" href={paths.squadDetail(selected.id)}>{s($=>$.engineering.runtime_required)}</AppLink></p>}
    {!loading && !failed && !available.length && <p className="text-caption"><AppLink className="underline" href={paths.squads()}>{t($=>$.engineering.team_setup_required)}</AppLink></p>}
    <div className="min-w-0 space-y-1.5"><Label>{t($=>$.engineering.task_materials)}</Label><div className="min-h-40 rounded-md border p-3"><ContentEditor ref={editor} ariaLabel={t($=>$.engineering.task_materials)} defaultValue={typeof data?.description==="string"?data.description:draft.manual.description} onUpdate={description=>setManual({description})} onUploadFile={uploads.handleUpload} onUploadingChange={editorGate.onUploadingChange} attachments={uploads.attachments} /></div><FileUploadButton multiple disabled={pending} onSelect={file=>editor.current?.uploadFile(file)} /></div>
    {anchor && <SourceContextPreviewCard preview={source} loading={!!data?.source_context_loading} failed={!!data?.source_context_failed} error={data?.source_context_error} onRetry={data?.source_context_refetch as (()=>void)|undefined} />}
   </>}
   {loading && <Spinner />}
   {failed && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.load_error)}</p>}
   {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
  </div>
  <div className="flex flex-wrap justify-end gap-2 border-t p-4"><Button type="button" variant="ghost" disabled={pending} onClick={onClose}>{t($=>$.engineering.cancel)}</Button>{!created && <Button type="button" variant="outline" disabled={!valid || pending || uploads.gate.uploading || !draftAllowed} onClick={()=>{void submit(false)}}>{t($=>$.engineering.save_task_draft)}</Button>}<Button type="submit" disabled={pending || uploads.gate.uploading || !created && (!valid || !startStatus || selected?.runtimeReady===false)} aria-busy={pending}>{pending && <Spinner />}{created?t($=>$.engineering.team_start):t($=>$.engineering.create_start)}</Button></div>
 </form>;
}
