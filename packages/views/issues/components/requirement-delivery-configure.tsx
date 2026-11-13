"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RequirementDeliveryConfiguration } from "@multica/core/issues";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AgentChoice } from "./engineering-configure";

export function RequirementDeliveryConfigure({ workspaceId, revision, sequence, pending, onSave }: {
  workspaceId:string;revision:number;sequence:number;pending:boolean;onSave:(input:RequirementDeliveryConfiguration)=>Promise<void>;
}) {
  const { t }=useT("issues"), id=useId();
  const [open,setOpen]=useState(false),[analyst,setAnalyst]=useState(""),[developer,setDeveloper]=useState(""),[verifier,setVerifier]=useState(""),[budget,setBudget]=useState("3"),[error,setError]=useState("");
  const agents=useQuery({...agentListOptions(workspaceId),enabled:open && !!workspaceId});
  const available=(agents.data ?? []).filter(agent=>!agent.archived_at);
  const valid=analyst && developer && verifier && new Set([analyst,developer,verifier]).size === 3 && /^\d+$/.test(budget) && Number(budget)<=10;
  return <Dialog open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}>
    <DialogTrigger render={<Button size="sm" disabled={pending} />}>{t($=>$.engineering.start_deliveries)}</DialogTrigger>
    <DialogContent className="min-w-0 sm:max-w-lg"><DialogHeader><DialogTitle>{t($=>$.engineering.start_deliveries)}</DialogTitle><DialogDescription>{t($=>$.engineering.delivery_policy_notice)}</DialogDescription></DialogHeader>
      <form className="min-w-0 space-y-4" onSubmit={async event=>{
        event.preventDefault();if(!valid || pending)return;setError("");
        try {await onSave({expectedRevision:revision,expectedSequence:sequence,analystId:analyst,developerId:developer,verifierId:verifier,maxReworks:Number(budget)});setOpen(false);}
        catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}
      }}>
        <fieldset disabled={pending} className="min-w-0 max-h-[60vh] space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5"><Label htmlFor={`${id}-analyst`}>{t($=>$.engineering.analyst)}</Label><AgentChoice id={`${id}-analyst`} value={analyst} onChange={setAnalyst} agents={available} placeholder={t($=>$.engineering.select_agent)} /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-developer`}>{t($=>$.engineering.developer)}</Label><AgentChoice id={`${id}-developer`} value={developer} onChange={setDeveloper} agents={available} placeholder={t($=>$.engineering.select_agent)} /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-verifier`}>{t($=>$.engineering.verifier)}</Label><AgentChoice id={`${id}-verifier`} value={verifier} onChange={setVerifier} agents={available} placeholder={t($=>$.engineering.select_agent)} /></div>
          {analyst && developer && verifier && new Set([analyst,developer,verifier]).size<3 && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.separate_analysis_agents)}</p>}
          {agents.isError && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.agents_error)}</p>}
          <div className="space-y-1.5"><Label htmlFor={`${id}-budget`}>{t($=>$.engineering.unit_rework_limit)}</Label><Input id={`${id}-budget`} type="number" min={0} max={10} step={1} value={budget} onChange={event=>setBudget(event.target.value)} required /></div>
        </fieldset>
        {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
        <DialogFooter><Button type="submit" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.authorize_deliveries)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
