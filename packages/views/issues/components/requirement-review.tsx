"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EngineeringOverview, RequirementReviewConfiguration, RequirementReviewAcknowledgement } from "@multica/core/issues";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@multica/ui/components/ui/dialog";
import { Label } from "@multica/ui/components/ui/label";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { useT } from "../../i18n";
import { AgentChoice } from "./engineering-configure";

type Requirement=NonNullable<EngineeringOverview["requirement"]>;
type Review=NonNullable<Requirement["review"]>;
function ReviewResult({result,historical=false}:{result:Review["result"];historical?:boolean}){
  const {t}=useT("issues");
  if(!result)return null;
  return result.verdict === "report_ready" && result.report ? <Markdown mode="full" className="min-w-0 break-words">{result.report}</Markdown> : result.verdict === "closure_gap" ? <div className="space-y-3"><p role="status">{historical ? t($=>$.engineering.review_historical_gaps) : t($=>$.engineering.review_gaps_notice)}</p>{result.gaps.map(gap=><div key={gap.key} className="space-y-1 rounded-md border p-3 text-caption"><p className="font-medium whitespace-pre-wrap break-words">{gap.reason}</p><p className="whitespace-pre-wrap break-words">{gap.boundary}</p></div>)}</div> : <p>{t($=>$.engineering.unknown)}</p>;
}

export function RequirementReviewConfigure({workspaceId,revision,sequence,excludedAgents,pending,onSave}:{workspaceId:string;revision:number;sequence:number;excludedAgents:string[];pending:boolean;onSave:(input:RequirementReviewConfiguration)=>Promise<void>}){
  const {t}=useT("issues"),id=useId();
  const [open,setOpen]=useState(false),[reviewer,setReviewer]=useState(""),[error,setError]=useState("");
  const agents=useQuery({...agentListOptions(workspaceId),enabled:open && !!workspaceId});
  const available=(agents.data ?? []).filter(agent=>!agent.archived_at && !excludedAgents.includes(agent.id));
  return <Dialog open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}>
    <DialogTrigger render={<Button size="sm" disabled={pending} />}>{t($=>$.engineering.start_final_review)}</DialogTrigger>
    <DialogContent className="min-w-0 sm:max-w-lg"><DialogHeader><DialogTitle>{t($=>$.engineering.final_review)}</DialogTitle><DialogDescription>{t($=>$.engineering.review_policy_notice)}</DialogDescription></DialogHeader>
      <form className="min-w-0 space-y-4" onSubmit={async event=>{event.preventDefault();if(!available.some(agent=>agent.id === reviewer) || pending)return;setError("");try{await onSave({expectedRevision:revision,expectedSequence:sequence,reviewerId:reviewer});setOpen(false);}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>
        <fieldset disabled={pending} className="min-w-0 space-y-1.5"><Label htmlFor={id}>{t($=>$.engineering.reviewer)}</Label><AgentChoice id={id} value={reviewer} onChange={setReviewer} agents={available} placeholder={t($=>$.engineering.select_agent)} /></fieldset>
        {agents.isError && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.agents_error)}</p>}
        {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
        <DialogFooter><Button type="submit" disabled={pending || !available.some(agent=>agent.id === reviewer)} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.start_final_review)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function RequirementReviewPanel({review,revision,sequence,pending,disabled,onAcknowledge}:{review:Review;revision:number;sequence:number;pending:boolean;disabled:boolean;onAcknowledge:(input:RequirementReviewAcknowledgement)=>Promise<void>}){
  const {t}=useT("issues"),[error,setError]=useState("");
  return <div className="min-w-0 space-y-4" aria-label={t($=>$.engineering.final_review)}>
    <p className="text-caption font-medium">{t($=>$.engineering.review_generation,{generation:review.generation})}</p>
    <ReviewResult result={review.result} />
    {review.result?.verdict === "report_ready" && <>
      <p role="status" className="text-caption">{review.acknowledgement ? t($=>$.engineering.report_read_confirmed) : t($=>$.engineering.awaiting_report_read)}</p>
      {!review.acknowledgement && review.report_hash && <Button size="sm" disabled={disabled || pending} aria-busy={pending} onClick={async()=>{setError("");try{await onAcknowledge({expectedRevision:revision,expectedSequence:sequence,reportHash:review.report_hash!});}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>{pending && <Spinner />}{t($=>$.engineering.read_and_close)}</Button>}
    </>}
    {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
    {review.history.length>0 && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.review_history)}</summary><div className="mt-3 space-y-4">{review.history.map(item=><details key={item.draft_id}><summary className="cursor-pointer text-caption">{t($=>$.engineering.review_generation,{generation:item.generation})}</summary><div className="mt-3"><ReviewResult result={item.result} historical /></div></details>)}</div></details>}
  </div>;
}
