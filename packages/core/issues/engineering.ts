import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "./queries";
import type { FeedbackWorkAuthorization, FeedbackCapture, FeedbackCancellation, RequirementReviewConfiguration, RequirementReviewAcknowledgement, RequirementDeliveryConfiguration, EngineeringCheckpoint, RequirementConfiguration, EngineeringConfiguration } from "./engineering-schema";
export type { FeedbackWorkAuthorization, FeedbackCapture, FeedbackCancellation, EngineeringOverview, RequirementReviewConfiguration, RequirementReviewAcknowledgement, RequirementDeliveryConfiguration, RequirementConfiguration, EngineeringCheckpoint, EngineeringConfiguration, EngineeringDeliveryUnit } from "./engineering-schema";

export function engineeringOverviewOptions(workspaceId: string, issueId: string) {
  return queryOptions({
    queryKey: ["engineering", workspaceId, issueId], queryFn: () => api.getEngineeringOverview(issueId),
    enabled: !!workspaceId && !!issueId, retry: false, staleTime: 5000,
    refetchInterval: query => {const state=query.state.data,review=state?.requirement?.review;return state?.configured && (state.hasActiveRun === true || !["completed", "abandoned"].includes(state.status) || state.requirement?.feedback?.active === true || review?.result?.verdict === "closure_gap" || state.requirement?.delivery_policy && state.requirement.publication?.units.some(unit=>!state.requirement!.accepted[unit.unit.key])) ? 5000 : false;},
  });
}

export function useEngineeringActions(workspaceId: string, issueId: string) {
  const client = useQueryClient();
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: engineeringOverviewOptions(workspaceId, issueId).queryKey }),
    client.invalidateQueries({ queryKey: issueKeys.tasks(issueId) }),
  ]);
  const beginFeedback=useMutation({mutationFn:(input:FeedbackCapture)=>api.beginEngineeringFeedback(issueId,input),onSettled:()=>Promise.all([refresh(),client.invalidateQueries({queryKey:issueKeys.all(workspaceId)})])});
  const authorizeFeedbackWork=useMutation({mutationFn:(input:FeedbackWorkAuthorization)=>api.authorizeEngineeringFeedbackWork(issueId,input),onSettled:refresh});
  const cancelFeedback=useMutation({mutationFn:(input:FeedbackCancellation)=>api.cancelEngineeringFeedback(issueId,input),onSettled:refresh});
  const configure = useMutation({ mutationFn: (input: EngineeringConfiguration) => api.configureEngineering(issueId, input), onSettled: refresh });
  const configureRequirement=useMutation({mutationFn:(input:RequirementConfiguration)=>api.configureRequirementEngineering(issueId,input),onSettled:refresh});
  const publish=useMutation({mutationFn:(input:EngineeringCheckpoint)=>api.publishEngineeringUnits(issueId,input),onSettled:()=>Promise.all([refresh(),client.invalidateQueries({queryKey:issueKeys.children(workspaceId,issueId)}),client.invalidateQueries({queryKey:issueKeys.detail(workspaceId,issueId)}),client.invalidateQueries({queryKey:issueKeys.childrenByParentsAll(workspaceId)})])});
  const deliver=useMutation({mutationFn:(input:RequirementDeliveryConfiguration)=>api.authorizeEngineeringDelivery(issueId,input),onSettled:refresh});
  const review=useMutation({mutationFn:(input:RequirementReviewConfiguration)=>api.configureRequirementReview(issueId,input),onSettled:refresh});
  const acknowledge=useMutation({mutationFn:(input:RequirementReviewAcknowledgement)=>api.acknowledgeRequirementReview(issueId,input),onSettled:()=>Promise.all([refresh(),client.invalidateQueries({queryKey:issueKeys.all(workspaceId)})])});
  const answer = useMutation({ mutationFn: (input: { expectedSequence: number; requestId: string; answer: string; selectedOption?:string }) => api.answerEngineering(issueId, input), onSettled: refresh });
  const abandon = useMutation({ mutationFn: (input: { expectedSequence: number; reason: string }) => api.abandonEngineering(issueId, input), onSettled: refresh });
  const run = useMutation({ mutationFn: (input: EngineeringCheckpoint) => api.runEngineering(issueId, input), onSettled: refresh });
  return { authorizeFeedbackWork,beginFeedback,cancelFeedback,configure, configureRequirement, publish, deliver, review, acknowledge, answer, abandon, run };
}

export function feedbackCommentsOptions(workspaceId:string,issueId:string){return queryOptions({queryKey:["engineering-feedback-comments",workspaceId,issueId],queryFn:()=>api.listComments(issueId),enabled:!!workspaceId && !!issueId,staleTime:0});}
