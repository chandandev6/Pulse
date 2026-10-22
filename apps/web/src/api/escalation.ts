import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// F14: escalation policies. Who to wake up, in what order, when nobody acknowledges.

export type TargetType = "user" | "schedule";
export type PolicyTarget = { type: TargetType; id: string; name: string };
export type PolicyLevel = {
  id: string;
  position: number;
  timeoutMinutes: number;
  targets: PolicyTarget[];
};

export type Policy = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  repeatCount: number;
  levels: PolicyLevel[];
  ruleCount?: number;
};

// What the editor sends: the whole list of levels, in order
export type LevelInput = { timeoutMinutes: number; targets: { type: TargetType; id: string }[] };
export type PolicyInput = {
  name: string;
  description: string | null;
  repeatCount: number;
  levels: LevelInput[];
};

const keys = {
  list: (orgId: string) => ["escalation-policies", orgId] as const,
  detail: (id: string) => ["escalation-policy", id] as const,
};

export function usePolicies(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.list(orgId ?? ""),
    queryFn: async () =>
      (await api<{ policies: Policy[] }>(`/orgs/${orgId}/escalation-policies`)).policies,
    enabled: Boolean(orgId),
  });
}

export function usePolicy(policyId: string) {
  return useQuery({
    queryKey: keys.detail(policyId),
    queryFn: () =>
      api<{
        policy: Policy;
        rules: { id: string; name: string; project: { id: string; name: string } }[];
      }>(`/escalation-policies/${policyId}`),
    enabled: Boolean(policyId), // "" = a new policy, nothing to load
  });
}

export function useSavePolicy(orgId: string, policyId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: PolicyInput) =>
      policyId
        ? api<{ policy: Policy }>(`/escalation-policies/${policyId}`, {
            method: "PATCH",
            body: policy,
          })
        : api<{ policy: Policy }>(`/orgs/${orgId}/escalation-policies`, {
            method: "POST",
            body: policy,
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["escalation-policies"] });
      queryClient.invalidateQueries({ queryKey: ["escalation-policy"] });
    },
  });
}

export function useDeletePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) => api(`/escalation-policies/${policyId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["escalation-policies"] }),
  });
}

// "5 min", "1 h 30 min"
export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
