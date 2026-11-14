"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DirectConfiguration, EngineeringOverview } from "@multica/core/issues";
import type { Issue } from "@multica/core/types";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogFooter } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { useT } from "../../i18n";
import { AgentChoice } from "./engineering-configure";

export function DirectConfigure({ workspaceId, issue, pending, onSave }: { workspaceId: string; issue: Issue; pending: boolean; onSave: (input: DirectConfiguration) => Promise<void> }) {
  const { t } = useT("issues"), id = useId();
  const [open, setOpen] = useState(false), [repository, setRepository] = useState(""), [input, setInput] = useState([issue.title, issue.description].filter(Boolean).join("\n\n")), [agent, setAgent] = useState(""), [error, setError] = useState("");
  const query = useQuery({ ...agentListOptions(workspaceId), enabled: open && !!workspaceId });
  const available = (query.data ?? []).filter(value => !value.archived_at);
  const valid = !!repository.trim() && !!input.trim() && available.some(value => value.id === agent);
  return <Dialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }}>
    <DialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>{t($ => $.engineering.direct)}</DialogTrigger>
    <DialogContent className="min-w-0 sm:max-w-2xl">
      <DialogHeader><DialogTitle>{t($ => $.engineering.direct)}</DialogTitle><DialogDescription>{t($ => $.engineering.direct_notice)}</DialogDescription></DialogHeader>
      <form className="min-w-0 space-y-4" onSubmit={async event => {
        event.preventDefault(); if (!valid || pending) return; setError("");
        try { await onSave({ expectedRevision: 0, agentId: agent, repositoryPath: repository.trim(), input }); setOpen(false); }
        catch (error) { setError(error instanceof Error ? error.message : t($ => $.engineering.save_error)); }
      }}>
        <fieldset disabled={pending} className="max-h-[60vh] min-w-0 space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5"><Label htmlFor={`${id}-repository`}>{t($ => $.engineering.repository)}</Label><Input id={`${id}-repository`} value={repository} onChange={event => setRepository(event.target.value)} required /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-input`}>{t($ => $.engineering.direct_input)}</Label><Textarea id={`${id}-input`} value={input} onChange={event => setInput(event.target.value)} rows={6} required /></div>
          <div className="space-y-1.5"><Label htmlFor={`${id}-agent`}>{t($ => $.engineering.direct_agent)}</Label><AgentChoice id={`${id}-agent`} agents={available} value={agent} onChange={setAgent} placeholder={t($ => $.engineering.select_agent)} /></div>
          {query.isError && <p role="alert" className="text-caption text-destructive">{t($ => $.engineering.agents_error)}</p>}
        </fieldset>
        {error && <p role="alert" className="break-words text-caption text-destructive">{error}</p>}
        <DialogFooter><Button type="submit" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($ => $.engineering.start_direct)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function DirectPanel({ direct }: { direct: NonNullable<EngineeringOverview["direct"]> }) {
  const { t } = useT("issues");
  return <div className="min-w-0 space-y-4">
    <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($ => $.engineering.direct_input)}</summary><p className="mt-2 whitespace-pre-wrap break-words text-caption">{direct.input}</p></details>
    {direct.result && <div className="min-w-0 space-y-3">
      <h4 className="text-label font-medium">{t($ => $.engineering.direct_result)}</h4>
      <p className="whitespace-pre-wrap break-words font-medium">{direct.result.summary}</p>
      {direct.result.content !== direct.result.summary && <Markdown mode="full" className="min-w-0 break-words">{direct.result.content}</Markdown>}
      <p role="status" className="text-caption text-muted-foreground">{direct.nativeCompleted ? t($ => $.engineering.direct_completed) : t($ => $.engineering.direct_submitted)}</p>
    </div>}
  </div>;
}
