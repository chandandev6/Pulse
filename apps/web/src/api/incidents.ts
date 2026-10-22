import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { ChannelType, DeliveryStatus } from "./notifications";
import type { IssueStatus, Severity } from "./types";

// F13: incidents, acknowledging and resolving them, and their timeline

export type IncidentStatus = "triggered" | "acknowledged" | "resolved";
type PersonRef = { id: string; name: string } | null;

export type Incident = {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  issueId: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  rule: { id: string; name: string } | null;
  responder: PersonRef;
  acknowledgedBy: PersonRef;
  resolvedBy: PersonRef;
};

export type TimelineEntry =
  | { kind: "triggered"; data: { ruleId: string | null; ruleName: string } }
  | {
      kind: "notified";
      data: {
        responder: { id: string; name: string; source: "layer" | "override" } | null;
        everyone: boolean;
        channels: number;
      };
    }
  | { kind: "acknowledged"; data: { via: "dashboard" | "link" } }
  | { kind: "resolved"; data: { resolvedIssue: boolean } };

export type TimelineStep = TimelineEntry & { id: string; createdAt: string; actor: PersonRef };

export type IncidentDelivery = {
  id: string;
  channelType: ChannelType;
  recipient: string;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type IncidentDetail = {
  incident: Incident & {
    project: { id: string; name: string };
    issue: {
      id: string;
      title: string;
      culprit: string | null;
      status: IssueStatus;
      eventCount: number;
      userCount: number;
      lastSeen: string;
    };
  };
  timeline: TimelineStep[];
  deliveries: IncidentDelivery[];
};

// What the public acknowledge page shows (no login needed)
export type LinkView = {
  incident: Pick<
    Incident,
    "id" | "title" | "severity" | "status" | "triggeredAt" | "acknowledgedAt" | "resolvedAt"
  >;
  project: { id: string; name: string };
  acknowledgedBy: PersonRef;
  user: PersonRef; // who the link was sent to (or who is logged in, for team links)
  needsLogin: boolean;
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  triggered: "Triggered",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

const keys = {
  all: ["incidents"] as const,
  list: (projectId: string, status: string) => ["incidents", "list", projectId, status] as const,
  detail: (id: string) => ["incidents", "detail", id] as const,
  link: (id: string, token: string) => ["incidents", "link", id, token] as const,
};

export function useIncidents(projectId: string, status: IncidentStatus | "" = "") {
  return useQuery({
    queryKey: keys.list(projectId, status),
    queryFn: async () => {
      const query = status ? `?status=${status}` : "";
      return (await api<{ incidents: Incident[] }>(`/projects/${projectId}/incidents${query}`))
        .incidents;
    },
  });
}

export function useIncident(incidentId: string) {
  return useQuery({
    queryKey: keys.detail(incidentId),
    queryFn: () => api<IncidentDetail>(`/incidents/${incidentId}`),
    refetchInterval: 30_000, // someone else may acknowledge it while you look
  });
}

// After acknowledging or resolving, every list and detail could be out of date
export function useIncidentActions(incidentId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.all });
  return {
    acknowledge: useMutation({
      mutationFn: () => api(`/incidents/${incidentId}/acknowledge`, { method: "POST" }),
      onSettled: refresh, // a 409 also means "it changed": show who took it
    }),
    resolve: useMutation({
      mutationFn: (resolveIssue: boolean) =>
        api(`/incidents/${incidentId}/resolve`, { method: "POST", body: { resolveIssue } }),
      onSettled: () => {
        refresh();
        queryClient.invalidateQueries({ queryKey: ["issue"] });
      },
    }),
  };
}

export function useIncidentLink(incidentId: string, token: string) {
  return useQuery({
    queryKey: keys.link(incidentId, token),
    queryFn: () =>
      api<LinkView>(`/incidents/${incidentId}/link?token=${encodeURIComponent(token)}`),
    retry: false, // an invalid link stays invalid
  });
}

export function useAcknowledgeLink(incidentId: string, token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api(`/incidents/${incidentId}/link/acknowledge`, { method: "POST", body: { token } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.link(incidentId, token) }),
  });
}
