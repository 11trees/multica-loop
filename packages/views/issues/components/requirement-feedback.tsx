"use client";
import {useId,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {feedbackCommentsOptions,type FeedbackCapture,type FeedbackCancellation,type EngineeringOverview} from "@multica/core/issues";
import {agentListOptions} from "@multica/core/workspace/queries";
import {Button} from "@multica/ui/components/ui/button";
import {Checkbox} from "@multica/ui/components/ui/checkbox";
import {Dialog,DialogTrigger,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from "@multica/ui/components/ui/dialog";
import {Label} from "@multica/ui/components/ui/label";
import {Textarea} from "@multica/ui/components/ui/textarea";
import {Spinner} from "@multica/ui/components/ui/spinner";
import {AgentChoice} from "./engineering-configure";
import {useT} from "../../i18n";

export function RequirementFeedbackConfigure({workspaceId,issueId,revision,sequence,batchNumber,excludedAgents,pending,onSave}:{workspaceId:string;issueId:string;revision:number;sequence:number;batchNumber:number;excludedAgents:string[];pending:boolean;onSave:(input:FeedbackCapture)=>Promise<void>}){
 const {t}=useT("issues"),id=useId(),[open,setOpen]=useState(false),[requestId,setRequestId]=useState(""),[selected,setSelected]=useState<string[]>([]),[triager,setTriager]=useState(""),[verifier,setVerifier]=useState(""),[error,setError]=useState("");
 const comments=useQuery({...feedbackCommentsOptions(workspaceId,issueId),enabled:open}),agents=useQuery({...agentListOptions(workspaceId),enabled:open});
 const available=(agents.data ?? []).filter(agent=>!agent.archived_at && !excludedAgents.includes(agent.id)),selectable=(comments.data ?? []).filter(comment=>comment.type === "comment" && !comment.deleted_at && (comment.content.trim() || comment.attachments.length));
 const valid=selected.length>0 && selected.length<=100 && selected.every(id=>selectable.some(c=>c.id === id)) && triager !== verifier && [triager,verifier].every(id=>available.some(a=>a.id === id));
 return <Dialog open={open} onOpenChange={value=>{if(pending)return;if(value && !open){setRequestId(crypto.randomUUID());setSelected([]);setError("");}setOpen(value);}}>
  <DialogTrigger render={<Button size="sm" variant="outline" disabled={pending} />}>{t($=>$.engineering.start_feedback)}</DialogTrigger>
  <DialogContent className="min-w-0 sm:max-w-2xl"><DialogHeader><DialogTitle>{t($=>$.engineering.start_feedback)}</DialogTitle><DialogDescription>{t($=>$.engineering.feedback_notice)}</DialogDescription></DialogHeader>
   <form className="min-w-0 space-y-4" onSubmit={async event=>{event.preventDefault();if(!valid || pending)return;setError("");try{await onSave({requestId,expectedRevision:revision,expectedSequence:sequence,expectedBatchNumber:batchNumber,agentId:triager,verifierId:verifier,commentIds:selected});setOpen(false);}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>
    <fieldset disabled={pending} className="max-h-[60vh] min-w-0 space-y-4 overflow-y-auto px-1">
     <div className="grid gap-4 sm:grid-cols-2"><div className="min-w-0 space-y-1.5"><Label htmlFor={`${id}-triage`}>{t($=>$.engineering.feedback_agent)}</Label><AgentChoice id={`${id}-triage`} value={triager} onChange={setTriager} agents={available.filter(a=>a.id !== verifier)} placeholder={t($=>$.engineering.select_agent)} /></div><div className="min-w-0 space-y-1.5"><Label htmlFor={`${id}-verify`}>{t($=>$.engineering.feedback_verifier)}</Label><AgentChoice id={`${id}-verify`} value={verifier} onChange={setVerifier} agents={available.filter(a=>a.id !== triager)} placeholder={t($=>$.engineering.select_agent)} /></div></div>
     <div className="space-y-2"><p className="text-label font-medium">{t($=>$.engineering.feedback_comments)}</p>{selectable.map((comment,index)=><div key={comment.id} className="flex min-w-0 items-start gap-2 rounded-md border p-3"><Checkbox id={`${id}-${comment.id}`} checked={selected.includes(comment.id)} onCheckedChange={checked=>setSelected(values=>checked ? [...values,comment.id] : values.filter(id=>id !== comment.id))} /><Label htmlFor={`${id}-${comment.id}`} className="min-w-0 flex-1 flex-col items-start gap-1"><span>{t($=>$.engineering.feedback_comment,{number:index+1})}</span><span className="whitespace-pre-wrap break-words text-caption font-normal">{comment.content.slice(0,500) || comment.attachments.map(a=>a.filename).join(", ")}</span></Label></div>)}{comments.isSuccess && !selectable.length && <p className="text-caption">{t($=>$.engineering.feedback_empty)}</p>}</div>
    </fieldset>
    {(comments.isError || agents.isError) && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.feedback_load_error)}</p>}
    {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
    <DialogFooter><Button type="submit" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.start_feedback)}</Button></DialogFooter>
   </form>
  </DialogContent>
 </Dialog>;
}

type Feedback=NonNullable<NonNullable<EngineeringOverview["requirement"]>["feedback"]>;
export function RequirementFeedbackPanel({feedback,pending,onCancel}:{feedback:Feedback;pending:boolean;onCancel:(input:FeedbackCancellation)=>Promise<void>}){
 const {t}=useT("issues"),id=useId(),[reason,setReason]=useState(""),[error,setError]=useState("");
 const types:Record<string,string>={reply:t($=>$.engineering.feedback_reply),historical_correction:t($=>$.engineering.feedback_history),learning_only:t($=>$.engineering.feedback_learning),bug:t($=>$.engineering.kind_bug),behavior_change:t($=>$.engineering.feedback_behavior),scope_addition:t($=>$.engineering.feedback_scope),technical_change:t($=>$.engineering.feedback_technical),report_correction:t($=>$.engineering.feedback_report)};
 const statuses:Record<string,string>={completed:t($=>$.engineering.completed),cancelled:t($=>$.engineering.feedback_cancelled),reopened:t($=>$.engineering.feedback_reopened),verifying:t($=>$.engineering.verification),waiting_for_repro:`${t($=>$.engineering.unit_pending)} · ${t($=>$.engineering.reproduction)}`,waiting_for_plan:`${t($=>$.engineering.unit_pending)} · ${t($=>$.engineering.planning)}`,waiting_for_report:`${t($=>$.engineering.unit_pending)} · ${t($=>$.engineering.feedback_report)}`,triaging:t($=>$.engineering.feedback_triage),executing:t($=>$.engineering.feedback_forward)};
 return <div className="min-w-0 space-y-3">{(feedback.active || feedback.unresolved_count>0) && <p role="status" className="text-caption">{t($=>$.engineering.feedback_pending)}</p>}{feedback.batches.map((batch,index)=><details key={batch.id} open={index === feedback.batches.length-1}><summary className="cursor-pointer text-caption font-medium">{t($=>$.engineering.feedback_batch,{number:batch.number})} · {statuses[batch.status] ?? t($=>$.engineering.unknown)}</summary><div className="mt-3 space-y-3">
  {batch.summary && <p className="whitespace-pre-wrap break-words text-caption">{batch.summary}</p>}
  {batch.groups.map(group=><div key={group.id} className="min-w-0 space-y-1 rounded-md border p-3 text-caption"><p className="font-medium">{group.title || types[group.workType] || t($=>$.engineering.unknown)}</p><p className="text-muted-foreground">{types[group.workType] ?? t($=>$.engineering.unknown)} · {statuses[group.status] ?? t($=>$.engineering.unknown)}</p><p className="whitespace-pre-wrap break-words">{group.reason}</p>{group.response && <p className="whitespace-pre-wrap break-words">{group.response}</p>}{group.acceptance.map((item,i)=><p key={i} className="whitespace-pre-wrap break-words">{item}</p>)}</div>)}
  <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.feedback_comments)}</summary>{batch.comments.map(comment=><div key={comment.id} className="mt-2 text-caption"><p className="break-words whitespace-pre-wrap">{comment.content}</p><p className="font-mono text-micro text-muted-foreground break-all">{comment.sourceRef} · {comment.version}</p></div>)}</details>
  {feedback.active && index === feedback.batches.length-1 && <form className="space-y-2" onSubmit={async event=>{event.preventDefault();if(pending || !reason.trim())return;setError("");try{await onCancel({batchId:batch.id,expectedVersion:batch.version,reason:reason.trim()});setReason("");}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}><Label htmlFor={id}>{t($=>$.engineering.reason)}</Label><Textarea id={id} value={reason} onChange={event=>setReason(event.target.value)} disabled={pending} rows={2} required /><Button size="sm" variant="ghost" disabled={pending || !reason.trim()} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.feedback_cancel)}</Button>{error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}</form>}
 </div></details>)}</div>;
}
