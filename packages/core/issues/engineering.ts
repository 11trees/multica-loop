import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "./queries";
import type { EngineeringCheckpoint, EngineeringConfiguration } from "./engineering-schema";
export type { EngineeringOverview, EngineeringCheckpoint, EngineeringConfiguration } from "./engineering-schema";

export function engineeringOverviewOptions(workspaceId: string, issueId: string) {
  return queryOptions({
    queryKey: ["engineering", workspaceId, issueId], queryFn: () => api.getEngineeringOverview(issueId),
    enabled: !!workspaceId && !!issueId, retry: false, staleTime: 5000,
    refetchInterval: query => query.state.data?.configured && !["completed", "abandoned"].includes(query.state.data.status) ? 5000 : false,
  });
}

export function useEngineeringActions(workspaceId: string, issueId: string) {
  const client = useQueryClient();
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: engineeringOverviewOptions(workspaceId, issueId).queryKey }),
    client.invalidateQueries({ queryKey: issueKeys.tasks(issueId) }),
  ]);
  const configure = useMutation({ mutationFn: (input: EngineeringConfiguration) => api.configureEngineering(issueId, input), onSettled: refresh });
  const answer = useMutation({ mutationFn: (input: { expectedSequence: number; requestId: string; answer: string }) => api.answerEngineering(issueId, input), onSettled: refresh });
  const abandon = useMutation({ mutationFn: (input: { expectedSequence: number; reason: string }) => api.abandonEngineering(issueId, input), onSettled: refresh });
  const run = useMutation({ mutationFn: (input: EngineeringCheckpoint) => api.runEngineering(issueId, input), onSettled: refresh });
  return { configure, answer, abandon, run };
}
