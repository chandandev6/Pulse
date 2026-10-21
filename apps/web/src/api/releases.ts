import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { Issue } from "./types";

// F9: releases, environments and release comparison

export type Environment = { name: string; firstSeen: string; lastSeen: string; eventCount: number };

export type Release = {
  version: string;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  newIssues: number;
};

export type ReleaseDetail = {
  release: Release & { affectedUsers: number };
  newIssues: Issue[];
  issues: { issue: Issue; events: number }[];
};

export type ComparedIssue = { issue: Issue; countA: number; countB: number };

export type Comparison = {
  a: string;
  b: string;
  onlyInA: ComparedIssue[];
  onlyInB: ComparedIssue[];
  inBoth: ComparedIssue[];
};

const withEnvironment = (environment: string) =>
  environment ? `?environment=${encodeURIComponent(environment)}` : "";

export function useEnvironments(projectId: string) {
  return useQuery({
    queryKey: ["environments", projectId],
    queryFn: async () =>
      (await api<{ environments: Environment[] }>(`/projects/${projectId}/environments`))
        .environments,
  });
}

export function useReleases(projectId: string) {
  return useQuery({
    queryKey: ["releases", projectId],
    queryFn: async () =>
      (await api<{ releases: Release[] }>(`/projects/${projectId}/releases`)).releases,
  });
}

export function useRelease(projectId: string, version: string, environment: string) {
  return useQuery({
    queryKey: ["releases", projectId, version, environment],
    queryFn: () =>
      api<ReleaseDetail>(
        `/projects/${projectId}/releases/${encodeURIComponent(version)}${withEnvironment(environment)}`,
      ),
  });
}

export function useCompare(projectId: string, a: string, b: string, environment: string) {
  return useQuery({
    queryKey: ["releases", projectId, "compare", a, b, environment],
    queryFn: () => {
      const params = new URLSearchParams({ a, b });
      if (environment) params.set("environment", environment);
      return api<Comparison>(`/projects/${projectId}/releases/compare?${params}`);
    },
    enabled: Boolean(a && b && a !== b),
  });
}
