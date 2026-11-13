"use client";

import { Markdown } from "@multica/ui/markdown";
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
import { AppLink } from "../../navigation";
import { useWorkspaceSlug } from "@multica/core/paths";
import { useT } from "../../i18n";
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from "@multica/ui/components/ui/select";
import { RequirementReviewConfigure, RequirementReviewPanel } from "./requirement-review";
import { RequirementDeliveryConfigure } from "./requirement-delivery-configure";
import { RequirementConfigure } from "./requirement-configure";
import { EngineeringConfigure } from "./engineering-configure";

function EngineeringQuestion({ question, sequence, pending, onAnswer }: {
  question: EngineeringOverview["questions"][number]; sequence: number; pending: boolean;
  onAnswer: (input: { expectedSequence: number; requestId: string; answer: string; selectedOption?:string }) => Promise<void>;
}) {
  const { t } = useT("issues");
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [selection,setSelection]=useState("");
  const structured=question.options.length>0;
  const valid=structured ? question.options.some(option=>option.id === selection) : !!answer.trim();
  const [error, setError] = useState("");
  return <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={async event => {
    event.preventDefault(); if (!valid || pending) return; setError("");
    try { await onAnswer({ expectedSequence: sequence, requestId: question.id, answer: answer.trim(),...(structured ? {selectedOption:selection} : {}) }); }
    catch (error) { setError(error instanceof Error ? error.message : t($ => $.engineering.save_error)); }
  }}>
    <div><h4 className="text-label font-medium">{question.title}</h4><p className="mt-1 whitespace-pre-wrap break-words text-body">{question.question}</p></div>
    {question.why && <p className="text-caption text-muted-foreground whitespace-pre-wrap">{question.why}</p>}
    {question.recommendation && <div className="text-caption"><span className="text-muted-foreground">{t($ => $.engineering.recommendation)} </span><span className="whitespace-pre-wrap">{structured && question.options.find(option=>option.id === question.recommendationOption)?.label ? `${question.options.find(option=>option.id === question.recommendationOption)!.label} · ` : ""}{question.recommendation}</span></div>}
    {structured && <div className="space-y-1.5"><Label htmlFor={`${id}-option`}>{t($=>$.engineering.choose_option)}</Label><Select items={question.options.map(option=>({value:option.id,label:option.label}))} value={selection} onValueChange={value=>setSelection(value ?? "")} disabled={pending}><SelectTrigger id={`${id}-option`}><SelectValue placeholder={t($=>$.engineering.select_option)} /></SelectTrigger><SelectContent>{question.options.map(option=><SelectItem key={option.id} value={option.id}><span>{option.label}<span className="block text-caption text-muted-foreground">{option.consequence}</span></span></SelectItem>)}</SelectContent></Select></div>}
    <Label htmlFor={id}>{structured ? t($=>$.engineering.answer_note) : t($ => $.engineering.answer)}</Label><Textarea id={id} value={answer} onChange={event => setAnswer(event.target.value)} rows={3} maxLength={20000} disabled={pending} required={!structured} />
    {error && <p role="alert" className="text-caption text-destructive break-words">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={!valid || pending} aria-busy={pending}>{pending && <Spinner />}{t($ => $.engineering.submit_answer)}</Button>
      {question.recommendation && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => {setAnswer(question.recommendation);if(structured && question.options.some(option=>option.id === question.recommendationOption))setSelection(question.recommendationOption);}}>{t($ => $.engineering.use_recommendation)}</Button>}
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
  const workspaceSlug=useWorkspaceSlug();
  const [publicationError,setPublicationError]=useState("");
  const query = useQuery(engineeringOverviewOptions(workspaceId, issue.id));
  const actions = useEngineeringActions(workspaceId, issue.id);
  const state = query.data;
  const agents = useQuery({ ...agentListOptions(workspaceId), enabled: !!workspaceId && !!state?.configured });
  const [runError, setRunError] = useState("");
  if (!state && !query.isError || state && (!state.enabled || !state.configured && closed)) return null;
  const pending = actions.review.isPending || actions.acknowledge.isPending || actions.deliver.isPending || actions.publish.isPending || actions.configureRequirement.isPending || actions.answer.isPending || actions.abandon.isPending || actions.run.isPending || actions.configure.isPending;
  const knownChain = state?.chain === "reproduction" || state?.chain === "review" || state?.chain === "context" || state?.chain === "planning" || state?.chain === "analysis" || state?.chain === "development" || state?.chain === "verification";
  const questions = knownChain && state?.status === "waiting_for_answers" ? state.questions.filter(input => input.active && !input.answer) : [];
  const history = state?.questions.filter(input => !input.active || input.answer || state.status === "abandoned") ?? [];
  const canRun = !!state?.configured && !query.isError && knownChain && state.revision !== null && state.sequence !== null && !closed && state.hasActiveRun === false && questions.length === 0 &&
    (["unstarted", "editing", "waiting_for_answers"].includes(state.status) || ["context","development","analysis"].includes(state.chain) && state.status === "completed");
  const statusLabels: Record<string, string> = { unstarted: t($ => $.engineering.unstarted), editing: t($ => $.engineering.editing), waiting_for_answers: t($ => $.engineering.waiting), completed: t($ => $.engineering.completed), abandoned: t($ => $.engineering.abandoned) };
  const phaseLabels: Record<string, string> = {
    investigation:t($=>$.engineering.phase_investigation),alignment_proposal:t($=>$.engineering.phase_proposal),alignment_resolution:t($=>$.engineering.phase_resolution),
    fact_reconciliation:t($=>$.engineering.phase_fact_reconciliation),closure_assessment:t($=>$.engineering.phase_closure_assessment),closure_output:t($=>$.engineering.phase_closure_output),
    as_is:t($=>$.engineering.phase_as_is),to_be:t($=>$.engineering.phase_to_be),scope:t($=>$.engineering.phase_business_scope),acceptance:t($=>$.engineering.phase_acceptance),planning_basis:t($=>$.engineering.phase_basis),delivery_units:t($=>$.engineering.phase_units),coverage_order:t($=>$.engineering.phase_coverage),
    delivery_unit:t($=>$.engineering.phase_unit),impact_scan:t($=>$.engineering.phase_impacts),decision_proposal:t($=>$.engineering.phase_proposal),decision_resolution:t($=>$.engineering.phase_resolution),answer_review:t($=>$.engineering.phase_answers),delivery_contract:t($=>$.engineering.phase_contract),
    delivery_spec: t($ => $.engineering.phase_scope), implement: t($ => $.engineering.phase_implement), review: t($ => $.engineering.phase_review), developer_verify: t($ => $.engineering.phase_checks), commit: t($ => $.engineering.phase_commit),
    inputs: t($ => $.engineering.phase_inputs), plan: t($ => $.engineering.phase_plan), execute: t($ => $.engineering.phase_execute), evidence_review: t($ => $.engineering.phase_evidence), finalize: t($ => $.engineering.phase_finalize),
  };
  const unitStatus=(key:string)=>{
    const requirement=state?.requirement,progress=requirement?.progress.find(item=>item.key === key);
    if(requirement?.accepted[key])return t($=>$.engineering.unit_accepted);
    if(progress?.stop_reason || progress?.status === "abandoned")return t($=>$.engineering.unit_review_required);
    if(progress?.status === "waiting_for_answers")return t($=>$.engineering.waiting);
    if(!progress?.chain)return t($=>$.engineering.unit_pending);
    const chain=progress.chain === "analysis" ? t($=>$.engineering.analysis) : progress.chain === "development" ? t($=>$.engineering.development) : progress.chain === "verification" ? t($=>$.engineering.verification) : t($=>$.engineering.unknown);
    return `${chain} · ${statusLabels[progress.status] ?? t($=>$.engineering.unknown)}`;
  };
  return <section aria-labelledby={id} className="mt-6 space-y-4 rounded-lg border border-border bg-card/30 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 id={id} className="text-label font-semibold">{t($ => $.engineering.title)}</h3><div className="flex items-center gap-2">
      {state?.configured && <span className="text-caption text-muted-foreground">{state.status === "waiting_for_answers" && state.questions.every(question => !question.active || question.answer !== null) ? t($ => $.engineering.ready_to_resume) : statusLabels[state.status] ?? t($ => $.engineering.unknown)}</span>}
      <Button variant="ghost" size="icon-sm" aria-label={t($ => $.engineering.refresh)} onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className="size-3.5" /></Button>
    </div></div>
    {query.isError && <p role="alert" className="text-caption text-destructive">{t($ => $.engineering.load_error)}</p>}
    {state?.enabled && !state.managedUnit && !state.requirement?.publication && (!state.configured || knownChain && (["completed", "abandoned"].includes(state.status) || state.status === "unstarted" && state.hasActiveRun === false)) && !closed &&
      <div className="flex flex-wrap gap-2">{!state.requirement && <EngineeringConfigure key={state.revision ?? 0} workspaceId={workspaceId} issue={issue} revision={state.revision ?? 0} repositoryPath={state.repositoryPath} pending={actions.configure.isPending || query.isError} onSave={input => actions.configure.mutateAsync(input)} />}{(!state.configured || state.requirement) && <RequirementConfigure key={`requirement-${state.revision ?? 0}`} workspaceId={workspaceId} issue={issue} revision={state.revision ?? 0} repositoryPath={state.repositoryPath} pending={actions.configureRequirement.isPending || query.isError} onSave={input=>actions.configureRequirement.mutateAsync(input)} />}</div>}
    {state?.managedUnit && !state.configured && <div className="space-y-3 text-caption"><p role="status">{t($=>$.engineering.managed_unit_pending)}</p>{workspaceSlug && <AppLink className="underline" href={`/${workspaceSlug}/issues/${state.managedUnit.parentIssueId}`}>{t($=>$.engineering.parent_requirement)}</AppLink>}<p className="font-medium">{state.managedUnit.unit.title}</p><p>{state.managedUnit.unit.actor} · {state.managedUnit.unit.trigger}</p><p className="whitespace-pre-wrap break-words">{state.managedUnit.unit.observableOutcome}</p><p className="whitespace-pre-wrap break-words">{state.managedUnit.unit.acceptance}</p>{state.managedUnit.unit.dependsOn.length>0 && <p>{t($=>$.engineering.depends_on,{keys:state.managedUnit.unit.dependsOn.join(", ")})}</p>}<details><summary>{t($=>$.engineering.frozen_scope)}</summary><div className="mt-2 space-y-2">{state.managedUnit.sources.map(source=><div key={source.key}><p>{source.description}</p>{source.oracle !== source.description && <p className="text-muted-foreground">{source.oracle}</p>}</div>)}</div></details></div>}
    {state?.configured && <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption"><span>{state.chain === "reproduction" ? t($=>$.engineering.reproduction) : state.chain === "review" ? t($=>$.engineering.final_review) : state.chain === "context" ? t($=>$.engineering.requirement_context) : state.chain === "planning" ? t($=>$.engineering.planning) : state.chain === "analysis" ? t($=>$.engineering.analysis) : state.chain === "development" ? t($ => $.engineering.development) : state.chain === "verification" ? t($ => $.engineering.verification) : state.chain}</span><span className="text-muted-foreground">{t($ => $.engineering.revision, { revision: state.revision })}</span><span>{agents.data?.find(agent => agent.id === state.agentId)?.name}</span></div>
      {state.autoContinue && <p className="text-caption text-muted-foreground">{t($ => $.engineering.auto_continue_notice)}</p>}
      {state.requirement && <>
        <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.requirement_input)}</summary><p className="mt-2 whitespace-pre-wrap break-words text-caption">{state.requirement.input}</p></details>
        {state.requirement.context && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.acceptance_entities)}</summary><div className="mt-2 space-y-3 text-caption"><p>{state.requirement.context.intent}</p>{state.requirement.context.acceptances.map(item=><div className="rounded-md border p-3" key={item.id}><p className="font-medium">{item.statement}</p><p className="mt-1 whitespace-pre-wrap break-words">{item.oracle}</p><p className="mt-1 text-muted-foreground">{item.key} · {t($=>$.engineering.revision,{revision:item.revision})}</p></div>)}</div></details>}
        {state.requirement.publication?.units.every(unit=>unit.published) && !state.requirement.delivery_policy && !closed && state.revision !== null && state.sequence !== null && <RequirementDeliveryConfigure workspaceId={workspaceId} revision={state.revision} sequence={state.sequence} pending={pending || query.isError || state.hasActiveRun !== false} onSave={input=>actions.deliver.mutateAsync(input)} />}
        {state.requirement.delivery_policy && !state.requirement.review && <p role="status" className="text-caption">{state.requirement.publication?.units.every(unit=>state.requirement!.accepted[unit.unit.key]) ? t($=>$.engineering.final_review_required) : t($=>$.engineering.deliveries_authorized)}</p>}
        {state.requirement.review_enabled && state.requirement.delivery_policy && state.requirement.publication?.units.every(unit=>unit.published && state.requirement!.accepted[unit.unit.key]) && (!state.requirement.review || state.status === "abandoned") && !closed && state.revision !== null && state.sequence !== null && <RequirementReviewConfigure workspaceId={workspaceId} revision={state.revision} sequence={state.sequence} excludedAgents={[state.requirement.delivery_policy.analystId,state.requirement.delivery_policy.developerId,state.requirement.delivery_policy.verifierId]} pending={pending || query.isError || state.hasActiveRun !== false} onSave={input=>actions.review.mutateAsync(input)} />}
        {state.requirement.review && state.revision !== null && state.sequence !== null && <RequirementReviewPanel review={state.requirement.review} revision={state.revision} sequence={state.sequence} pending={actions.acknowledge.isPending} disabled={pending || query.isError || closed || state.hasActiveRun !== false} onAcknowledge={input=>actions.acknowledge.mutateAsync(input)} />}
        {state.requirement.plan && <div className="space-y-3 text-caption"><p role="status" hidden={!!state.requirement.delivery_policy}>{state.requirement.publication?.units.every(unit=>unit.published) ? t($=>$.engineering.units_published_notice) : t($=>$.engineering.plan_pending_delivery)}</p>{!state.requirement.publication?.units.every(unit=>unit.published) && !closed && <Button type="button" variant="outline" size="sm" disabled={pending || state.hasActiveRun !== false || query.isError} aria-busy={actions.publish.isPending} onClick={async()=>{if(state.revision === null || state.sequence === null)return;setPublicationError("");try{await actions.publish.mutateAsync({expectedRevision:state.revision,expectedSequence:state.sequence});}catch(error){setPublicationError(error instanceof Error ? error.message : t($=>$.engineering.save_error));}}}>{actions.publish.isPending && <Spinner />}{state.requirement.publication ? t($=>$.engineering.retry_publication) : t($=>$.engineering.publish_units)}</Button>}{publicationError && <p role="alert" className="text-destructive">{publicationError}</p>}<p className="whitespace-pre-wrap break-words">{state.requirement.plan.rationale}</p>{(state.requirement.delivery_units.length ? state.requirement.delivery_units : state.requirement.plan.units).map(unit=><div key={unit.key} className="space-y-1 rounded-md border p-3"><p className="font-medium">{workspaceSlug && state.requirement!.publication?.units.some(item=>item.unit.key === unit.key && item.published) ? <AppLink className="underline" href={`/${workspaceSlug}/issues/${state.requirement!.publication!.units.find(item=>item.unit.key === unit.key)!.issueId}`}>{unit.title}</AppLink> : unit.title}</p>{state.requirement!.delivery_policy && <p className="text-muted-foreground">{unitStatus(unit.key)}</p>}<p>{unit.actor} · {unit.trigger}</p><p className="whitespace-pre-wrap break-words">{unit.observableOutcome}</p><p className="whitespace-pre-wrap break-words">{unit.acceptance}</p>{unit.dependsOn.length>0 && <p className="text-muted-foreground">{t($=>$.engineering.depends_on,{keys:unit.dependsOn.join(", ")})}</p>}</div>)}</div>}
      </>}
      {state.analysis && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.delivery_spec)}</summary><div className="mt-2 space-y-2 text-caption"><p>{state.analysis.unit.actor} · {state.analysis.unit.trigger}</p><p className="whitespace-pre-wrap break-words">{state.analysis.unit.observableOutcome}</p>{state.analysis.spec && <><p className="whitespace-pre-wrap break-words">{state.analysis.spec.summary}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-caption">{state.analysis.spec.handoff.implementationGuidance}</pre></>}</div></details>}
      {state.decisions.length>0 && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.decisions)}</summary><div className="mt-2 space-y-3">{state.decisions.map(node=><div key={node.key} className="rounded-md border p-3 text-caption"><p className="font-medium">{node.title}</p><p className="mt-1 whitespace-pre-wrap break-words">{node.resolution?.decision ?? t($=>$.engineering.pending_resolution)}</p>{node.resolution && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{node.resolution.rationale}</p>}</div>)}</div></details>}
      {state.rework && (state.rework.limit > 0 || state.rework.history.length > 0) && <div className="space-y-2">
        <p className="text-caption text-muted-foreground">{t($ => $.engineering.rework_round, { round: state.rework.round, limit: state.rework.limit })}</p>
        {state.rework.stopReason && <p role="status" className="text-caption">{state.rework.stopReason === "analysis" ? t($ => $.engineering.rework_analysis) : state.rework.stopReason === "stagnant" ? t($ => $.engineering.rework_stagnant) : state.rework.stopReason === "budget" ? t($ => $.engineering.rework_budget) : t($ => $.engineering.rework_manual)}</p>}
        {state.rework.history.length > 0 && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($ => $.engineering.rework_history)}</summary><div className="mt-2 space-y-3">{state.rework.history.map(item => <details key={item.draftId} className="rounded-md border p-3"><summary className="cursor-pointer text-caption">{t($ => $.engineering.revision, { revision: item.revision })}</summary><p className="mt-2 break-all font-mono text-micro text-muted-foreground">{item.codeVersion}</p>{item.artifacts.map(artifact => <pre key={`${artifact.ref}:${artifact.key}`} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-caption">{artifact.content}</pre>)}</details>)}</div></details>}
      </div>}
      {state.requirement?.reproduction?.observation?.status === "not_reproduced" && <p role="status" className="text-caption">{t($=>$.engineering.not_reproduced_notice)}</p>}
      {state.requirement?.reproduction?.result && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t($=>$.engineering.reproduction_evidence)}</summary><Markdown mode="full" className="min-w-0 break-words">{state.requirement.reproduction.result.report}</Markdown></details>}
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
