"use client";

import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@multica/core/types";
import type { EngineeringConfiguration } from "@multica/core/issues";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Label } from "@multica/ui/components/ui/label";
import { Switch } from "@multica/ui/components/ui/switch";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@multica/ui/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";

const kinds = ["acceptance", "focus", "guardrail", "recovery"] as const;
type Scope = { id: number; kind: typeof kinds[number]; description: string; oracle: string };

function AgentChoice({ id, value, onChange, agents, placeholder }: { id: string; value: string; onChange: (value: string) => void; agents: Agent[]; placeholder: string }) {
  return <Select items={agents.map(agent => ({ value: agent.id, label: agent.name }))} value={value || null} onValueChange={value => onChange(value ?? "")}>
    <SelectTrigger id={id} className="w-full"><SelectValue>{agents.find(agent => agent.id === value)?.name ?? placeholder}</SelectValue></SelectTrigger>
    <SelectContent>{agents.map(agent => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent>
  </Select>;
}

export function EngineeringConfigure({ workspaceId, issue, revision, repositoryPath, pending, onSave }: {
  workspaceId: string; issue: Issue; revision: number; repositoryPath: string; pending: boolean; onSave: (input: EngineeringConfiguration) => Promise<void>;
}) {
  const { t } = useT("issues");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState(repositoryPath);
  const [includeDevelopment, setIncludeDevelopment] = useState(true);
  const [developer, setDeveloper] = useState("");
  const [verifier, setVerifier] = useState("");
  const [guidance, setGuidance] = useState("");
  const [scope, setScope] = useState<Scope[]>([{ id: 0, kind: "acceptance", description: "", oracle: "" }]);
  const nextId = useRef(1);
  const [error, setError] = useState("");
  const agents = useQuery({ ...agentListOptions(workspaceId), enabled: open && !!workspaceId });
  const available = (agents.data ?? []).filter(agent => !agent.archived_at);
  const kindLabels = { acceptance: t($ => $.engineering.acceptance), focus: t($ => $.engineering.focus), guardrail: t($ => $.engineering.guardrail), recovery: t($ => $.engineering.recovery) };
  const sameAgent = includeDevelopment && !!developer && developer === verifier;
  const valid = repository.trim() && verifier && (!includeDevelopment || developer && guidance.trim()) && !sameAgent && scope.some(row => row.kind === "acceptance") && scope.every(row => row.description.trim() && row.oracle.trim());
  const update = (key: number, patch: Partial<Scope>) => setScope(rows => rows.map(row => row.id === key ? { ...row, ...patch } : row));

  return <Dialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }}>
    <DialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>{revision ? t($ => $.engineering.new_revision) : t($ => $.engineering.configure)}</DialogTrigger>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader><DialogTitle>{t($ => $.engineering.configure)}</DialogTitle><DialogDescription>{t($ => $.engineering.freeze_notice)}</DialogDescription></DialogHeader>
      <form onSubmit={async event => {
        event.preventDefault(); if (!valid || pending) return; setError("");
        try {
          await onSave({ expectedRevision: revision, verifierId: verifier, developerId: includeDevelopment ? developer : undefined, repositoryPath: repository.trim(), implementationGuidance: includeDevelopment ? guidance.trim() : undefined,
            sources: scope.map(row => ({ key: `scope-${row.id + 1}`, kind: row.kind, description: row.description.trim(), oracle: row.oracle.trim(), sourceRef: `ISSUE:${issue.id}${issue.revision ? `:r${issue.revision}` : ""}:scope-${row.id + 1}` })) });
          setOpen(false);
        } catch (error) { setError(error instanceof Error ? error.message : t($ => $.engineering.save_error)); }
      }} className="space-y-4">
        <fieldset disabled={pending} className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5"><Label htmlFor={`${id}-repository`}>{t($ => $.engineering.repository)}</Label><Input id={`${id}-repository`} value={repository} onChange={event => setRepository(event.target.value)} required autoComplete="off" /></div>
          <div className="flex items-center gap-2"><Switch id={`${id}-development`} checked={includeDevelopment} onCheckedChange={setIncludeDevelopment} /><Label htmlFor={`${id}-development`}>{t($ => $.engineering.include_development)}</Label></div>
          <div className="grid gap-4 sm:grid-cols-2">
            {includeDevelopment && <div className="space-y-1.5"><Label htmlFor={`${id}-developer`}>{t($ => $.engineering.developer)}</Label><AgentChoice id={`${id}-developer`} value={developer} onChange={setDeveloper} agents={available} placeholder={t($ => $.engineering.select_agent)} /></div>}
            <div className="space-y-1.5"><Label htmlFor={`${id}-verifier`}>{t($ => $.engineering.verifier)}</Label><AgentChoice id={`${id}-verifier`} value={verifier} onChange={setVerifier} agents={available} placeholder={t($ => $.engineering.select_agent)} /></div>
          </div>
          {agents.isError && <p role="alert" className="text-caption text-destructive">{t($ => $.engineering.agents_error)}</p>}
          {agents.isSuccess && available.length === 0 && <p className="text-caption text-muted-foreground">{t($ => $.engineering.no_agents)}</p>}
          {includeDevelopment && <p className="text-caption text-muted-foreground">{t($ => $.engineering.developer_runtime_notice)}</p>}
          {sameAgent && <p role="alert" className="text-caption text-destructive">{t($ => $.engineering.separate_agents)}</p>}
          {includeDevelopment && <div className="space-y-1.5"><Label htmlFor={`${id}-guidance`}>{t($ => $.engineering.guidance)}</Label><Textarea id={`${id}-guidance`} value={guidance} onChange={event => setGuidance(event.target.value)} required rows={2} /></div>}
          {scope.map((row, index) => <fieldset key={row.id} className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-label">{t($ => $.engineering.scope_item, { number: index + 1 })}</legend>
            <div className="flex items-center gap-2"><Select items={kinds.map(kind => ({ value: kind, label: kindLabels[kind] }))} value={row.kind} onValueChange={value => update(row.id, { kind: kinds.find(kind => kind === value) ?? "acceptance" })}><SelectTrigger aria-label={t($ => $.engineering.scope_kind, { number: index + 1 })}><SelectValue>{kindLabels[row.kind]}</SelectValue></SelectTrigger><SelectContent>{kinds.map(kind => <SelectItem value={kind} key={kind}>{kindLabels[kind]}</SelectItem>)}</SelectContent></Select>
              {scope.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setScope(rows => rows.filter(item => item.id !== row.id))}>{t($ => $.engineering.remove)}</Button>}
            </div>
            <div className="space-y-1.5"><Label htmlFor={`${id}-description-${row.id}`}>{t($ => $.engineering.scope_description)}</Label><Textarea id={`${id}-description-${row.id}`} value={row.description} onChange={event => update(row.id, { description: event.target.value })} rows={2} required /></div>
            <div className="space-y-1.5"><Label htmlFor={`${id}-oracle-${row.id}`}>{t($ => $.engineering.oracle)}</Label><Textarea id={`${id}-oracle-${row.id}`} value={row.oracle} onChange={event => update(row.id, { oracle: event.target.value })} rows={2} required /></div>
          </fieldset>)}
          <Button variant="outline" size="sm" type="button" onClick={() => setScope(rows => [...rows, { id: nextId.current++, kind: "acceptance", description: "", oracle: "" }])}>{t($ => $.engineering.add_scope)}</Button>
          {!scope.some(row => row.kind === "acceptance") && <p role="alert" className="text-caption text-destructive">{t($ => $.engineering.acceptance_required)}</p>}
        </fieldset>
        {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
        <DialogFooter><Button type="submit" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($ => $.engineering.freeze)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
