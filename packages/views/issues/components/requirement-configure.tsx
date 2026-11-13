"use client";
import { useId,useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RequirementConfiguration } from "@multica/core/issues";
import type { Issue } from "@multica/core/types";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogTrigger,DialogFooter } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Label } from "@multica/ui/components/ui/label";
import { Select,SelectTrigger,SelectValue,SelectItem,SelectContent } from "@multica/ui/components/ui/select";
import { Switch } from "@multica/ui/components/ui/switch";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AgentChoice } from "./engineering-configure";

export function RequirementConfigure({workspaceId,issue,revision,repositoryPath,pending,onSave}:{workspaceId:string;issue:Issue;revision:number;repositoryPath:string;pending:boolean;onSave:(input:RequirementConfiguration)=>Promise<void>}){
  const {t}=useT("issues"),id=useId();
  const [open,setOpen]=useState(false),[repository,setRepository]=useState(repositoryPath),[input,setInput]=useState(issue.title),[contextAgent,setContextAgent]=useState(""),[planner,setPlanner]=useState(""),[kind,setKind]=useState<"requirement"|"bug">("requirement"),[autoContinue,setAutoContinue]=useState(true),[mode,setMode]=useState<RequirementConfiguration["decisionMode"]>("balanced"),[error,setError]=useState("");
  const agents=useQuery({...agentListOptions(workspaceId),enabled:open && !!workspaceId}),available=(agents.data ?? []).filter(agent=>!agent.archived_at);
  const modes=[{value:"conservative",label:t($=>$.engineering.mode_conservative)},{value:"balanced",label:t($=>$.engineering.mode_balanced)},{value:"autonomous",label:t($=>$.engineering.mode_autonomous)},{value:"fully_autonomous",label:t($=>$.engineering.mode_fully_autonomous)}];
  const valid=repository.trim() && input.trim() && input.length<=40000 && contextAgent && planner && contextAgent !== planner;
  return <Dialog open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}>
    <DialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>{revision ? t($=>$.engineering.new_revision) : t($=>$.engineering.plan_requirement)}</DialogTrigger>
    <DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{t($=>$.engineering.plan_requirement)}</DialogTitle><DialogDescription>{t($=>$.engineering.requirement_notice)}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async event=>{event.preventDefault();if(!valid || pending)return;setError("");try{await onSave({expectedRevision:revision,repositoryPath:repository.trim(),contextAgentId:contextAgent,plannerAgentId:planner,input:input.trim(),kind,decisionMode:mode,autoContinue});setOpen(false);}catch(error){setError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>
        <fieldset disabled={pending} className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5"><Label htmlFor={`${id}-repository`}>{t($=>$.engineering.repository)}</Label><Input id={`${id}-repository`} value={repository} onChange={event=>setRepository(event.target.value)} required /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-input`}>{t($=>$.engineering.requirement_input)}</Label><Textarea id={`${id}-input`} value={input} onChange={event=>setInput(event.target.value)} rows={5} maxLength={40000} required /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-kind`}>{t($=>$.engineering.requirement_kind)}</Label><Select value={kind} items={[{value:"requirement",label:t($=>$.engineering.kind_requirement)},{value:"bug",label:t($=>$.engineering.kind_bug)}]} onValueChange={value=>{if(value === "requirement" || value === "bug")setKind(value);}}><SelectTrigger id={`${id}-kind`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="requirement">{t($=>$.engineering.kind_requirement)}</SelectItem><SelectItem value="bug">{t($=>$.engineering.kind_bug)}</SelectItem></SelectContent></Select></div>
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor={`${id}-context`}>{t($=>$.engineering.context_agent)}</Label><AgentChoice id={`${id}-context`} value={contextAgent} onChange={setContextAgent} agents={available} placeholder={t($=>$.engineering.select_agent)} /></div><div className="space-y-1.5"><Label htmlFor={`${id}-planner`}>{t($=>$.engineering.planner_agent)}</Label><AgentChoice id={`${id}-planner`} value={planner} onChange={setPlanner} agents={available} placeholder={t($=>$.engineering.select_agent)} /></div></div>
          {contextAgent && contextAgent === planner && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.separate_planning_agents)}</p>}
          {agents.isError && <p role="alert" className="text-caption text-destructive">{t($=>$.engineering.agents_error)}</p>}
          <div className="space-y-1.5"><Label htmlFor={`${id}-mode`}>{t($=>$.engineering.decision_mode)}</Label><Select value={mode} items={modes} onValueChange={value=>{if(value === "balanced" || value === "conservative" || value === "autonomous" || value === "fully_autonomous")setMode(value);}}><SelectTrigger id={`${id}-mode`}><SelectValue /></SelectTrigger><SelectContent>{modes.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>{mode === "fully_autonomous" && <p className="text-caption text-muted-foreground">{t($=>$.engineering.decision_mode_notice)}</p>}</div>
          <div className="flex items-center gap-2"><Switch id={`${id}-auto`} checked={autoContinue} onCheckedChange={setAutoContinue} /><Label htmlFor={`${id}-auto`}>{t($=>$.engineering.auto_continue)}</Label></div>
        </fieldset>
        {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
        <DialogFooter><Button type="submit" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($=>$.engineering.freeze_requirement)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
