"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@multica/core/types";
import { engineeringOverviewOptions, useEngineeringActions, type EngineeringOverview } from "@multica/core/issues";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Label } from "@multica/ui/components/ui/label";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Check, RefreshCw } from "@multica/ui/icons";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@multica/ui/components/ui/alert-dialog";
import { useT } from "../../i18n";
import { EngineeringConfigure } from "./engineering-configure";

function EngineeringQuestion({ question, sequence, pending, onAnswer }: {
  question: EngineeringOverview["questions"][number]; sequence: number; pending: boolean;
  onAnswer: (input: { expectedSequence: number; requestId: string; answer: string }) => Promise<void>;
}) {
  const { t } = useT("issues");
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  return <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={async event => {
    event.preventDefault(); if (!answer.trim() || pending) return; setError("");
    try { await onAnswer({ expectedSequence: sequence, requestId: question.id, answer: answer.trim() }); }
    catch (error) { setError(error instanceof Error ? error.message : t($ => $.engineering.save_error)); }
  }}>
    <div><h4 className="text-label font-medium">{question.title}</h4><p className="mt-1 whitespace-pre-wrap break-words text-body">{question.question}</p></div>
    {question.why && <p className="text-caption text-muted-foreground whitespace-pre-wrap">{question.why}</p>}
    {question.recommendation && <div className="text-caption"><span className="text-muted-foreground">{t($ => $.engineering.recommendation)} </span><span className="whitespace-pre-wrap">{question.recommendation}</span></div>}
    <Label htmlFor={id}>{t($ => $.engineering.answer)}</Label><Textarea id={id} value={answer} onChange={event => setAnswer(event.target.value)} rows={3} maxLength={20000} disabled={pending} required />
    {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={!answer.trim() || pending} aria-busy={pending}>{pending && <Spinner />}{t($ => $.engineering.submit_answer)}</Button>
      {question.recommendation && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setAnswer(question.recommendation)}>{t($ => $.engineering.use_recommendation)}</Button>}
    </div>
  </form>;
}

function EngineeringAbandon({ sequence, pending, disabled, onAbandon }: { sequence: number; pending: boolean; disabled: boolean; onAbandon: (input: { expectedSequence: number; reason: string }) => Promise<void> }) {
  const { t } = useT("issues");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  return <AlertDialog open={open} onOpenChange={value => { if (!pending) setOpen(value); }}>
    <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={disabled} />}>{t($ => $.engineering.abandon)}</AlertDialogTrigger>
    <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t($ => $.engineering.abandon)}</AlertDialogTitle><AlertDialogDescription>{t($ => $.engineering.abandon_notice)}</AlertDialogDescription></AlertDialogHeader>
      <form className="space-y-4" onSubmit={async event => {
        event.preventDefault(); if (!reason.trim() || pending) return; setError("");
        try { await onAbandon({ expectedSequence: sequence, reason: reason.trim() }); setOpen(false); }
        catch (error) { setError(error instanceof Error ? error.message : t($ => $.engineering.save_error)); }
      }}>
        <div className="space-y-1.5"><Label htmlFor={id}>{t($ => $.engineering.reason)}</Label><Textarea id={id} value={reason} onChange={event => setReason(event.target.value)} disabled={pending} required /></div>
        {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>{t($ => $.engineering.cancel)}</AlertDialogCancel><Button type="submit" variant="destructive" disabled={!reason.trim() || pending} aria-busy={pending}>{pending && <Spinner />}{t($ => $.engineering.confirm_abandon)}</Button></AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}

export function EngineeringPanel({ issue, closed = false }: { issue: Issue; closed?: boolean }) {
  const { t } = useT("issues");
  const id = useId();
  const workspaceId = useWorkspaceId();
  const query = useQuery(engineeringOverviewOptions(workspaceId, issue.id));
  const actions = useEngineeringActions(workspaceId, issue.id);
  const state = query.data;
  const agents = useQuery({ ...agentListOptions(workspaceId), enabled: !!workspaceId && !!state?.configured });
  const [runError, setRunError] = useState("");
  if (!state && !query.isError || state && (!state.enabled || !state.configured && closed)) return null;
  const pending = actions.answer.isPending || actions.abandon.isPending || actions.run.isPending || actions.configure.isPending;
  const knownChain = state?.chain === "development" || state?.chain === "verification";
  const questions = knownChain && state?.status === "waiting_for_answers" ? state.questions.filter(input => input.active && !input.answer) : [];
  const history = state?.questions.filter(input => !input.active || input.answer || state.status === "abandoned") ?? [];
  const canRun = !!state?.configured && !query.isError && knownChain && state.revision !== null && state.sequence !== null && !closed && state.hasActiveRun === false && questions.length === 0 &&
    (["unstarted", "editing", "waiting_for_answers"].includes(state.status) || state.chain === "development" && state.status === "completed");
  const statusLabels: Record<string, string> = { unstarted: t($ => $.engineering.unstarted), editing: t($ => $.engineering.editing), waiting_for_answers: t($ => $.engineering.waiting), completed: t($ => $.engineering.completed), abandoned: t($ => $.engineering.abandoned) };
  const phaseLabels: Record<string, string> = {
    delivery_spec: t($ => $.engineering.phase_scope), implement: t($ => $.engineering.phase_implement), review: t($ => $.engineering.phase_review), developer_verify: t($ => $.engineering.phase_checks), commit: t($ => $.engineering.phase_commit),
    inputs: t($ => $.engineering.phase_inputs), plan: t($ => $.engineering.phase_plan), execute: t($ => $.engineering.phase_execute), evidence_review: t($ => $.engineering.phase_evidence), finalize: t($ => $.engineering.phase_finalize),
  };
  return <section aria-labelledby={id} className="mt-6 space-y-4 rounded-lg border border-border bg-card/30 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 id={id} className="text-label font-semibold">{t($ => $.engineering.title)}</h3><div className="flex items-center gap-2">
      {state?.configured && <span className="text-caption text-muted-foreground">{state.status === "waiting_for_answers" && state.questions.every(question => !question.active || question.answer !== null) ? t($ => $.engineering.ready_to_resume) : statusLabels[state.status] ?? t($ => $.engineering.unknown)}</span>}
      <Button variant="ghost" size="icon-sm" aria-label={t($ => $.engineering.refresh)} onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className="size-3.5" /></Button>
    </div></div>
    {query.isError && <p role="alert" className="text-caption text-destructive">{t($ => $.engineering.load_error)}</p>}
    {state?.enabled && (!state.configured || knownChain && ["completed", "abandoned"].includes(state.status)) && !closed &&
      <EngineeringConfigure key={state.revision ?? 0} workspaceId={workspaceId} issue={issue} revision={state.revision ?? 0} repositoryPath={state.repositoryPath} pending={actions.configure.isPending || query.isError} onSave={input => actions.configure.mutateAsync(input)} />}
    {state?.configured && <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption"><span>{state.chain === "development" ? t($ => $.engineering.development) : state.chain === "verification" ? t($ => $.engineering.verification) : state.chain}</span><span className="text-muted-foreground">{t($ => $.engineering.revision, { revision: state.revision })}</span><span>{agents.data?.find(agent => agent.id === state.agentId)?.name}</span></div>
      {state.autoContinue && <p className="text-caption text-muted-foreground">{t($ => $.engineering.auto_continue_notice)}</p>}
      <ol className="flex flex-wrap gap-x-4 gap-y-2" aria-label={t($ => $.engineering.progress)}>{state.phases.map(phase => <li key={phase.id} aria-current={phase.status === "current" ? "step" : undefined} className={`flex items-center gap-1.5 text-caption ${phase.status === "current" ? "font-medium text-foreground" : "text-muted-foreground"}`}>
        {phase.status === "completed" && <Check className="size-3.5" aria-hidden="true" />}{phaseLabels[phase.id] ?? phase.id}
      </li>)}</ol>
      {questions.length > 0 && <div className="space-y-3"><h4 className="text-label font-medium">{t($ => $.engineering.pending_questions)}</h4>{questions.map(question => <EngineeringQuestion key={question.id} question={question} sequence={state.sequence ?? 0} pending={pending || query.isError} onAnswer={input => actions.answer.mutateAsync(input)} />)}</div>}
      {history.length > 0 && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($ => $.engineering.answer_history)}</summary><ul className="mt-2 space-y-3">{history.map(question => <li key={question.id} className="text-caption"><p className="font-medium">{question.title}</p><p className="whitespace-pre-wrap break-words text-muted-foreground">{question.answer?.text ?? (state.status === "abandoned" ? t($ => $.engineering.abandoned) : t($ => $.engineering.superseded))}</p></li>)}</ul></details>}
      <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($ => $.engineering.frozen_scope)}</summary><div className="mt-3 space-y-3">{state.sources.map(source => <div key={source.key} className="text-caption"><p className="font-medium whitespace-pre-wrap break-words">{source.description}</p><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{source.oracle}</p></div>)}<p className="break-all font-mono text-micro text-muted-foreground">{state.codeVersion}</p></div></details>
      {state.artifacts.length > 0 && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($ => $.engineering.artifacts)}</summary><div className="mt-3 space-y-3">{state.artifacts.map(artifact => <div key={`${artifact.ref}:${artifact.key}`}><h4 className="text-caption font-medium">{artifact.title || artifact.ref}{artifact.key && ` · ${artifact.key}`}</h4><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-caption">{artifact.content}</pre></div>)}</div></details>}
      {state.result?.verdict && <p className="text-label font-medium">{state.result.verdict === "passed" ? t($ => $.engineering.passed) : state.result.verdict === "failed" ? t($ => $.engineering.failed) : state.result.verdict}</p>}
      {state.hasActiveRun === true && <p className="text-caption text-muted-foreground">{t($ => $.engineering.active_run)}</p>}
      {runError && <p role="alert" className="text-caption text-destructive break-words">{runError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canRun && <Button size="sm" disabled={pending} aria-busy={actions.run.isPending} onClick={async () => {
          if (state.revision === null || state.sequence === null) return; setRunError("");
          try { await actions.run.mutateAsync({ expectedRevision: state.revision, expectedSequence: state.sequence }); }
          catch (error) { setRunError(error instanceof Error ? error.message : t($ => $.engineering.run_error)); }
        }}>{actions.run.isPending && <Spinner />}{state.status === "unstarted" ? t($ => $.engineering.start_run) : t($ => $.engineering.resume_run)}</Button>}
        {knownChain && state.draftId && state.sequence !== null && ["editing", "waiting_for_answers"].includes(state.status) && <EngineeringAbandon sequence={state.sequence} pending={actions.abandon.isPending} disabled={pending || query.isError || state.hasActiveRun !== false} onAbandon={input => actions.abandon.mutateAsync(input)} />}
      </div>
    </>}
  </section>;
}
