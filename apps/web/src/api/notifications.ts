import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Severity } from "./types";

export type ChannelType = "email" | "sms" | "push" | "webhook" | "slack" | "discord";
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type Channel = {
  id: string;
  userId: string | null;
  orgId: string | null;
  type: ChannelType;
  name: string;
  target: string; // address, masked phone, browser or webhook URL
  enabled: boolean;
  minSeverity: Severity;
  createdAt: string;
};

export type Delivery = {
  id: string;
  channelId: string | null;
  channelType: ChannelType;
  recipient: string;
  trigger: "incident_triggered" | "test";
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  incident: { id: string; title: string; projectId: string } | null;
};

export type MyChannels = {
  channels: Channel[];
  available: { email: boolean; sms: boolean; push: boolean };
  pushPublicKey: string | null;
};

export type NewChannel = {
  type: ChannelType;
  name?: string;
  minSeverity?: Severity;
  config: Record<string, unknown>;
};

export type ChannelChanges = Partial<Pick<Channel, "name" | "enabled" | "minSeverity">>;

// "Which incidents should reach me?" in words
export const SEVERITY_CHOICES: { value: Severity; label: string }[] = [
  { value: "low", label: "All incidents" },
  { value: "medium", label: "Medium and above" },
  { value: "high", label: "High and above" },
  { value: "critical", label: "Critical only" },
];

// Personal channels live at /me/..., team channels at /orgs/:orgId/...
const base = (orgId: string | null) =>
  orgId ? `/orgs/${orgId}/notification-channels` : "/me/notification-channels";

const channelsKey = (orgId: string | null) => ["notification-channels", orgId ?? "me"] as const;
const deliveriesKey = ["notification-log"] as const;

export function useMyChannels() {
  return useQuery({
    queryKey: channelsKey(null),
    queryFn: () => api<MyChannels>(base(null)),
  });
}

export function useOrgChannels(orgId: string | undefined) {
  return useQuery({
    queryKey: channelsKey(orgId ?? ""),
    queryFn: async () => (await api<{ channels: Channel[] }>(base(orgId ?? ""))).channels,
    enabled: Boolean(orgId),
  });
}

export function useDeliveries(orgId: string | undefined) {
  return useQuery({
    queryKey: [...deliveriesKey, orgId],
    queryFn: async () =>
      (await api<{ deliveries: Delivery[] }>(`/orgs/${orgId}/notifications`)).deliveries,
    enabled: Boolean(orgId),
    refetchInterval: 10_000, // pending deliveries turn into sent/failed by themselves
  });
}

// One set of mutations for both kinds: orgId = null means "my own channels"
export function useChannelActions(orgId: string | null) {
  const queryClient = useQueryClient();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: channelsKey(orgId) });
    queryClient.invalidateQueries({ queryKey: deliveriesKey });
  };

  return {
    create: useMutation({
      mutationFn: (channel: NewChannel) =>
        api<{ channel: Channel; secret?: string | null }>(base(orgId), {
          method: "POST",
          body: channel,
        }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...changes }: ChannelChanges & { id: string }) =>
        api<{ channel: Channel }>(`${base(orgId)}/${id}`, { method: "PATCH", body: changes }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`${base(orgId)}/${id}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: (id: string) =>
        api<{ delivery: Delivery }>(`${base(orgId)}/${id}/test`, { method: "POST" }),
      onSuccess: refresh,
    }),
  };
}
