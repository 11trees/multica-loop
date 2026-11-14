"use client";

import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BusinessConfiguration, EngineeringOverview, SpecificationComment, SpecificationReading } from "@multica/core/issues";
import type { Issue } from "@multica/core/types";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogFooter } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Switch } from "@multica/ui/components/ui/switch";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { useT } from "../../i18n";
import { AgentChoice } from "./engineering-configure";

type Business = NonNullable<EngineeringOverview["business"]>;
export function BusinessConfigure({workspaceId,issue,pending,onSave,endToEnd=false}:{endToEnd?:boolean;workspaceId:string;issue:Issue;pending:boolean;onSave:(input:BusinessConfiguration)=>Promise<void>}){
  const {t}=useT("issues"),id=useId();
  const [open,setOpen]=useState(false),[repository,setRepository]=useState(""),[input,setInput]=useState(issue.title),[maxReworks,setMaxReworks]=useState(2),[roles,setRoles]=useState({intent:"",businessDesign:"",specification:"",review:"",context:"",planner:"",analyst:"",developer:"",verifier:"",reviewer:""}),[mode,setMode]=useState<BusinessConfiguration["decisionMode"]>("balanced"),[autoContinue,setAutoContinue]=useState(true),[error,setError]=useState("");
  const query=useQuery({...agentListOptions(workspaceId),enabled:open && !!workspaceId}),available=(query.data ?? []).filter(agent=>!agent.archived_at);
  const choices=[{key:"intent" as const,label:t($=>$.engineering.intent_agent)},{key:"businessDesign" as const,label:t($=>$.engineering.design_agent)},{key:"specification" as const,label:t($=>$.engineering.spec_agent)},{key:"review" as const,label:t($=>$.engineering.spec_review_agent)},...(endToEnd ? [{key:"context" as const,label:t($=>$.engineering.context_agent)},{key:"planner" as const,label:t($=>$.engineering.planner_agent)},{key:"analyst" as const,label:t($=>$.engineering.analyst)},{key:"developer" as const,label:t($=>$.engineering.developer)},{key:"verifier" as const,label:t($=>$.engineering.verifier)},{key:"reviewer" as const,label:t($=>$.engineering.reviewer)}] : [])];
  const modes=[{value:"conservative",label:t($=>$.engineering.mode_conservative)},{value:"balanced",label:t($=>$.engineering.mode_balanced)},{value:"autonomous",label:t($=>$.engineering.mode_autonomous)},{value:"fully_autonomous",label:t($=>$.engineering.mode_fully_autonomous)}];
  const valid=!!repository.trim() && !!input.trim() && input.length<=40000 && choices.every(choice=>available.some(agent=>agent.id === roles[choice.key])) && new Set(choices.map(choice=>roles[choice.key])).size === choices.length && maxReworks>=0 && maxReworks<=10;
  return <Dialog open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}>
    <DialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>{endToEnd ? t($=>$.engineering.end_to_end) : t($=>$.engineering.analyze_idea)}</DialogTrigger>
    <DialogContent className="min-w-0 sm:max-w-2xl"><DialogHeader><DialogTitle>{endToEnd ? t($=>$.engineering.end_to_end) : t($=>$.engineering.business_analysis)}</DialogTitle><DialogDescription>{endToEnd ? t($=>$.engineering.end_to_end_notice) : t($=>$.engineering.business_analysis_notice)}</DialogDescription></DialogHeader>
      <form className="min-w-0 space-y-4" onSubmit={async event=>{event.preventDefault();if(!valid || pending)return;setError("");try{await onSave({expectedRevision:0,repositoryPath:repository.trim(),input:input.trim(),roles:{intent:roles.intent,businessDesign:roles.businessDesign,specification:roles.specification,review:roles.review},...(endToEnd ? {delivery:{roles:{context:roles.context,planner:roles.planner,analyst:roles.analyst,developer:roles.developer,verifier:roles.verifier,reviewer:roles.reviewer},maxReworks}} : {}),decisionMode:mode,autoContinue:endToEnd || autoContinue});setOpen(false);}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>
        <fieldset disabled={pending} className="max-h-[60vh] min-w-0 space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5"><Label htmlFor={`${id}-repository`}>{t($=>$.engineering.repository)}</Label><Input id={`${id}-repository`} value={repository} onChange={event=>setRepository(event.target.value)} required /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-idea`}>{t($=>$.engineering.business_input)}</Label><Textarea id={`${id}-idea`} value={input} onChange={event=>setInput(event.target.value)} rows={4} maxLength={40000} required /></div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">{choices.map(choice=><div key={choice.key} className="min-w-0 space-y-1.5"><Label htmlFor={`${id}-${choice.key}`}>{choice.label}</Label><AgentChoice id={`${id}-${choice.key}`} value={roles[choice.key]} agents={available.filter(agent=>agent.id === roles[choice.key] || !Object.values(roles).includes(agent.id))} onChange={value=>setRoles(current=>({...current,[choice.key]:value}))} placeholder={t($=>$.engineering.select_agent)} /></div>)}</div>
          {!query.isLoading && !query.isError && available.length<choices.length && <p role="status" className="text-caption">{endToEnd ? t($=>$.engineering.end_to_end_roles_required) : t($=>$.engineering.business_roles_required)}</p>}{query.isError && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.agents_error)}</p>}
          <div className="space-y-1.5"><Label htmlFor={`${id}-mode`}>{t($=>$.engineering.decision_mode)}</Label><Select value={mode} items={modes} onValueChange={value=>{if(value === "conservative" || value === "balanced" || value === "autonomous" || value === "fully_autonomous")setMode(value);}}><SelectTrigger id={`${id}-mode`}><SelectValue /></SelectTrigger><SelectContent>{modes.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>{mode === "fully_autonomous" && <p className="text-caption text-muted-foreground">{t($=>$.engineering.decision_mode_notice)}</p>}</div>
          {endToEnd ? <div className="space-y-1.5"><Label htmlFor={`${id}-budget`}>{t($=>$.engineering.max_reworks)}</Label><Input id={`${id}-budget`} type="number" min={0} max={10} value={maxReworks} onChange={event=>setMaxReworks(Number(event.target.value))} /></div> : <div className="flex items-center gap-2"><Switch id={`${id}-auto`} checked={autoContinue} onCheckedChange={setAutoContinue} /><Label htmlFor={`${id}-auto`}>{t($=>$.engineering.auto_continue)}</Label></div>}
        </fieldset>
        {error && <p role="alert" className="break-words text-caption text-destructive">{error}</p>}<DialogFooter><Button type="submit" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{endToEnd ? t($=>$.engineering.start_end_to_end) : t($=>$.engineering.freeze_business)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function SpecificationFeedback({specification,pending,disabled,onSubmit}:{specification:NonNullable<Business["specification"]>;pending:boolean;disabled:boolean;onSubmit:(input:SpecificationComment)=>Promise<unknown>}){
  const {t}=useT("issues"),id=useId(),requestId=useRef<string|null>(null);
  const [content,setContent]=useState(""),[quote,setQuote]=useState(""),[intent,setIntent]=useState<NonNullable<SpecificationComment["intent"]>>("change_request"),[error,setError]=useState("");
  const kinds=[{value:"change_request",label:t($=>$.engineering.spec_change_request)},{value:"question",label:t($=>$.engineering.spec_question)},{value:"note",label:t($=>$.engineering.spec_note)}];
  const edit=()=>{requestId.current=null;setError("");};
  return <details className="min-w-0"><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.specification_comment)}</summary>
    <form className="mt-3 min-w-0 space-y-3" onSubmit={async event=>{event.preventDefault();if(!content.trim() || pending || disabled)return;setError("");requestId.current ??= crypto.randomUUID();try{await onSubmit({requestId:requestId.current,draftId:specification.draftId,specificationHash:specification.hash,content:content.trim(),anchorType:quote.trim() ? "selection" : "file",quotedText:quote.trim() || null,intent});setContent("");setQuote("");requestId.current=null;}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>
      <fieldset disabled={pending || disabled} className="min-w-0 space-y-3"><div className="space-y-1.5"><Label htmlFor={`${id}-feedback`}>{t($=>$.engineering.specification_feedback)}</Label><Textarea id={`${id}-feedback`} value={content} onChange={event=>{edit();setContent(event.target.value);}} rows={3} maxLength={4000} required /></div>
        <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.specification_quote)}</summary><div className="mt-2 space-y-3"><div className="space-y-1.5"><Label htmlFor={`${id}-quote`}>{t($=>$.engineering.specification_quote)}</Label><Textarea id={`${id}-quote`} value={quote} onChange={event=>{edit();setQuote(event.target.value);}} rows={2} maxLength={4000} /></div><div className="space-y-1.5"><Label htmlFor={`${id}-intent`}>{t($=>$.engineering.specification_feedback_kind)}</Label><Select items={kinds} value={intent} onValueChange={value=>{if(value === "change_request" || value === "question" || value === "note"){edit();setIntent(value);}}}><SelectTrigger id={`${id}-intent`}><SelectValue /></SelectTrigger><SelectContent>{kinds.map(kind=><SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>)}</SelectContent></Select></div></div></details>
      </fieldset>
      <p className="text-caption text-muted-foreground">{t($=>$.engineering.specification_comment_notice)}</p>{error && <p role="alert" className="break-words text-caption text-destructive">{error}</p>}
      <Button type="submit" variant="outline" size="sm" disabled={!content.trim() || disabled || pending} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.specification_submit)}</Button>
    </form>
  </details>;
}

export function BusinessAnalysisPanel({business,pending,disabled,closed,onRead,onComment}:{business:Business;pending:boolean;disabled:boolean;closed:boolean;onRead:(input:SpecificationReading)=>Promise<void>;onComment:(input:SpecificationComment)=>Promise<unknown>}){
  const {t}=useT("issues"),[error,setError]=useState("");
  const stageLabels={intent:t($=>$.engineering.stage_intent),business_design:t($=>$.engineering.stage_design),specification:t($=>$.engineering.stage_specification),review:t($=>$.engineering.stage_spec_review)};
  const specification=business.specification;
  const unavailable=disabled || business.comments.some(comment=>comment.status === "unknown");
  return <div className="min-w-0 space-y-4">
    <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.business_input)}</summary><p className="mt-2 whitespace-pre-wrap break-words text-caption">{business.input}</p></details>
    {specification && <div className="min-w-0 space-y-3" aria-label={t($=>$.engineering.stage_specification)}>
      <h4 className="text-label font-medium">{t($=>$.engineering.specification_version,{generation:specification.generation})}</h4><Markdown mode="full" className="min-w-0 break-words">{specification.content}</Markdown>
      <p role="status" className="text-caption">{business.endToEnd ? t($=>$.engineering.specification_handoff) : specification.acknowledgement ? t($=>$.engineering.specification_read) : specification.ready ? t($=>$.engineering.specification_ready) : t($=>$.engineering.specification_pending)}</p>
      {!specification.acknowledgement && business.readingEnabled && <>
        <Button size="sm" disabled={unavailable || pending || closed || !specification.ready} aria-busy={pending} onClick={async()=>{setError("");try{await onRead({expectedVersion:business.version,draftId:specification.draftId,specificationHash:specification.hash});}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>{pending && <Spinner />}{t($=>$.engineering.read_specification)}</Button>
        {!closed && <SpecificationFeedback key={specification.draftId} specification={specification} pending={pending} disabled={unavailable} onSubmit={onComment} />}
      </>}
      {error && <p role="alert" className="break-words text-caption text-destructive">{error}</p>}
    </div>}
    {business.comments.length>0 && <div className="space-y-3"><h4 className="text-caption font-medium">{t($=>$.engineering.specification_feedback)}</h4>{business.comments.map(comment=><div key={comment.id} className="min-w-0 space-y-1 rounded-md border p-3 text-caption">{comment.quotedText && <blockquote className="border-l-2 pl-3 whitespace-pre-wrap break-words text-muted-foreground">{comment.quotedText}</blockquote>}<p className="whitespace-pre-wrap break-words">{comment.content}</p><p className="text-muted-foreground">{comment.status === "unknown" ? t($=>$.engineering.unknown) : comment.status === "resolved" ? t($=>$.engineering.spec_feedback_resolved) : comment.status === "publishing" ? t($=>$.engineering.spec_feedback_publishing) : t($=>$.engineering.specification_pending)}</p></div>)}</div>}
    <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.business_history)}</summary><div className="mt-3 space-y-3">{business.history.filter(entry=>entry.result).map(entry=><details key={entry.draftId} className="rounded-md border p-3"><summary className="cursor-pointer text-caption">{stageLabels[entry.stage]} · {t($=>$.engineering.revision,{revision:entry.generation})}{entry.superseded ? ` · ${t($=>$.engineering.superseded)}` : ""}</summary><div className="mt-3 min-w-0"><Markdown mode="full" className="min-w-0 break-words">{entry.result!.artifact.content}</Markdown></div></details>)}</div></details>
  </div>;
}
