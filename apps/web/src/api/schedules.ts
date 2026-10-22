import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Role } from "./types";

export type RotationType = "daily" | "weekly" | "custom";
export type Person = { id: string; name: string; email: string };
export type Restriction = { days: number[]; start: string; end: string };

export type OnCall = {
  user: Person;
  source: "layer" | "override";
  layer: { id: string; name: string } | null;
  overrideId: string | null;
};

export type Schedule = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  timezone: string;
  createdAt: string;
  onCall: OnCall | null;
  onCallUntil: string | null;
};

export type Layer = {
  id: string;
  name: string;
  position: number;
  rotationType: RotationType;
  shiftLengthHours: number | null;
  handoffTime: string;
  startDate: string;
  restriction: Restriction | null;
  participants: Person[];
};

export type Override = { id: string; startsAt: string; endsAt: string; user: Person };

export type ScheduleDetail = { schedule: Schedule; layers: Layer[]; overrides: Override[] };

export type Shift = { start: string; end: string; onCall: OnCall | null };

export type OnCallNow = {
  schedule: { id: string; name: string; timezone: string };
  onCall: OnCall | null;
  until: string | null;
};

export type Member = { userId: string; email: string; name: string; role: Role };

export type LayerInput = {
  name: string;
  rotationType: RotationType;
  shiftLengthHours: number | null;
  handoffTime: string;
  startDate: string;
  restriction: Restriction | null;
  participants: string[];
};

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // index + 1 = ISO day

// "Every day at 09:00", "Every week (Mon 09:00)", "Every 12 hours"
export function describeRotation(layer: Layer): string {
  if (layer.rotationType === "custom") return `Every ${layer.shiftLengthHours} hours`;
  if (layer.rotationType === "daily") return `Every day at ${layer.handoffTime}`;
  const weekday = new Date(`${layer.startDate}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return `Every week (${DAY_NAMES[(weekday + 6) % 7]} ${layer.handoffTime})`;
}

export function describeRestriction(r: Restriction): string {
  const days = r.days.length === 7 ? "Every day" : r.days.map((d) => DAY_NAMES[d - 1]).join(", ");
  return r.start === r.end ? `${days}, all day` : `${days}, ${r.start}–${r.end}`;
}

const keys = {
  schedules: (orgId: string) => ["schedules", orgId] as const,
  oncall: (orgId: string) => ["oncall", orgId] as const,
  schedule: (id: string) => ["schedule", id] as const,
  shifts: (id: string, from: string, to: string) => ["shifts", id, from, to] as const,
};

export function useSchedules(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.schedules(orgId ?? ""),
    queryFn: async () =>
      (await api<{ schedules: Schedule[] }>(`/orgs/${orgId}/schedules`)).schedules,
    enabled: Boolean(orgId),
  });
}

export function useOnCallNow(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.oncall(orgId ?? ""),
    queryFn: async () => (await api<{ oncall: OnCallNow[] }>(`/orgs/${orgId}/oncall`)).oncall,
    enabled: Boolean(orgId),
    refetchInterval: 60_000, // shifts change while the page is open
  });
}

export function useSchedule(scheduleId: string) {
  return useQuery({
    queryKey: keys.schedule(scheduleId),
    queryFn: () => api<ScheduleDetail>(`/schedules/${scheduleId}`),
  });
}

export function useShifts(scheduleId: string, from: string, to: string) {
  return useQuery({
    queryKey: keys.shifts(scheduleId, from, to),
    queryFn: async () => {
      const query = new URLSearchParams({ from, to });
      return (await api<{ shifts: Shift[] }>(`/schedules/${scheduleId}/shifts?${query}`)).shifts;
    },
  });
}

export function useMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: ["members", orgId],
    queryFn: async () => (await api<{ members: Member[] }>(`/orgs/${orgId}/members`)).members,
    enabled: Boolean(orgId),
  });
}

export function useCreateSchedule(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; timezone: string; description?: string }) =>
      api<{ schedule: Schedule }>(`/orgs/${orgId}/schedules`, { method: "POST", body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["schedules"] }),
  });
}

// Everything you can change on one schedule. Any change can move shifts,
// so each one refreshes the schedule, its timeline and the on-call widgets.
export function useScheduleActions(scheduleId: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    for (const key of ["schedule", "shifts", "schedules", "oncall"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  const base = `/schedules/${scheduleId}`;

  return {
    remove: useMutation({
      mutationFn: () => api(base, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    addLayer: useMutation({
      mutationFn: (layer: LayerInput) => api(`${base}/layers`, { method: "POST", body: layer }),
      onSuccess: refresh,
    }),
    removeLayer: useMutation({
      mutationFn: (layerId: string) => api(`${base}/layers/${layerId}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    addOverride: useMutation({
      mutationFn: (body: { userId?: string; startsAt: string; endsAt: string }) =>
        api(`${base}/overrides`, { method: "POST", body }),
      onSuccess: refresh,
    }),
    removeOverride: useMutation({
      mutationFn: (overrideId: string) =>
        api(`${base}/overrides/${overrideId}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}
