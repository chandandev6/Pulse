import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { useOrgs, useProject } from "./queries";
import type { Issue, Role, Severity } from "./types";

// F10: alert rules (the incidents they open are in incidents.ts)

export type AlertCondition =
  | { type: "new_issue" }
  | { type: "regression" }
  | { type: "severity_critical" }
  | { type: "event_frequency"; count: number; minutes: number }
  | { type: "user_count"; count: number };

export type ConditionType = AlertCondition["type"];
export type MatchMode = "all" | "any";

export type RuleInput = {
  name: string;
  enabled: boolean;
  environment: string | null;
  match: MatchMode;
  conditions: AlertCondition[];
  severity: Severity;
  cooldownMinutes: number;
};

export type AlertRule = RuleInput & {
  id: string;
  projectId: string;
  lastTriggeredAt: string | null;
  createdAt: string;
  openIncidents?: number;
};

// "More than 100 events in 60 minutes"
export function describeCondition(condition: AlertCondition): string {
  switch (condition.type) {
    case "new_issue":
      return "A new issue appears";
    case "regression":
      return "A resolved issue comes back";
    case "severity_critical":
      return "The issue is critical";
    case "event_frequency":
      return `More than ${condition.count} events in ${condition.minutes} minutes`;
    case "user_count":
      return `More than ${condition.count} users affected`;
  }
}

const rulesKey = (projectId: string) => ["alert-rules", projectId] as const;

export function useAlertRules(projectId: string) {
  return useQuery({
    queryKey: rulesKey(projectId),
    queryFn: async () =>
      (await api<{ rules: AlertRule[] }>(`/projects/${projectId}/alert-rules`)).rules,
  });
}

export function useAlertRule(projectId: string, ruleId: string | undefined) {
  return useQuery({
    queryKey: [...rulesKey(projectId), ruleId],
    queryFn: async () =>
      (await api<{ rule: AlertRule }>(`/projects/${projectId}/alert-rules/${ruleId}`)).rule,
    enabled: Boolean(ruleId),
  });
}

export function useSaveRule(projectId: string, ruleId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rule: RuleInput) =>
      ruleId
        ? api<{ rule: AlertRule }>(`/projects/${projectId}/alert-rules/${ruleId}`, {
            method: "PATCH",
            body: rule,
          })
        : api<{ rule: AlertRule }>(`/projects/${projectId}/alert-rules`, {
            method: "POST",
            body: rule,
          }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rulesKey(projectId) }),
  });
}

export function useDeleteRule(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      api(`/projects/${projectId}/alert-rules/${ruleId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rulesKey(projectId) }),
  });
}

export function usePreviewRule(projectId: string) {
  return useMutation({
    mutationFn: (rule: Pick<RuleInput, "environment" | "match" | "conditions">) =>
      api<{ matches: Issue[]; total: number }>(`/projects/${projectId}/alert-rules/preview`, {
        method: "POST",
        body: rule,
      }),
  });
}

// Your role in the project's organization (to hide buttons you can't use)
export function useProjectRole(projectId: string): Role | undefined {
  const project = useProject(projectId);
  const orgs = useOrgs();
  return orgs.data?.find((org) => org.id === project.data?.project.orgId)?.role;
}
