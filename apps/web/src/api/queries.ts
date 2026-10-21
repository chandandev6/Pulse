import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, api } from "./client";
import type {
  Activity,
  EventWithNeighbors,
  Issue,
  IssueDetail,
  IssueSort,
  IssueStatus,
  Organization,
  Project,
  ProjectKey,
  Severity,
  Stats,
  User,
} from "./types";

// TanStack Query keeps a cache of server data, keyed by these arrays.
// After a change (mutation) we "invalidate" keys, and the affected screens refetch.
export const keys = {
  me: ["me"] as const,
  orgs: ["orgs"] as const,
  projects: (orgId: string) => ["projects", orgId] as const,
  project: (projectId: string) => ["project", projectId] as const,
  stats: (projectId: string) => ["stats", projectId] as const,
  issues: (projectId: string) => ["issues", projectId] as const,
  issue: (issueId: string) => ["issue", issueId] as const,
  event: (eventId: string) => ["event", eventId] as const,
  activity: (issueId: string) => ["activity", issueId] as const,
};

// ---------- Auth ----------

// null = not logged in (a 401 is an answer here, not an error)
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return (await api<{ user: User }>("/auth/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api<{ user: User }>("/auth/login", { method: "POST", body }),
    onSuccess: ({ user }) => queryClient.setQueryData(keys.me, user),
  });
}

// Signup doesn't start a session, so log in right after
export function useSignup() {
  const login = useLogin();
  return useMutation({
    mutationFn: async (body: { name: string; email: string; password: string }) => {
      await api("/auth/signup", { method: "POST", body });
      return login.mutateAsync({ email: body.email, password: body.password });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(keys.me, null);
    },
  });
}

// ---------- Orgs & projects ----------

export function useOrgs() {
  return useQuery({
    queryKey: keys.orgs,
    queryFn: async () => (await api<{ organizations: Organization[] }>("/orgs")).organizations,
  });
}

const fetchProjects = async (orgId: string) =>
  (await api<{ projects: Project[] }>(`/orgs/${orgId}/projects`)).projects;

export function useProjects(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.projects(orgId ?? ""),
    queryFn: () => fetchProjects(orgId ?? ""),
    enabled: Boolean(orgId),
  });
}

// Every org with its projects, for the project switcher
export function useAllProjects() {
  const orgs = useOrgs();
  const projects = useQueries({
    queries: (orgs.data ?? []).map((org) => ({
      queryKey: keys.projects(org.id),
      queryFn: () => fetchProjects(org.id),
    })),
  });
  return {
    isLoading: orgs.isLoading || projects.some((q) => q.isLoading),
    error: orgs.error ?? projects.find((q) => q.error)?.error ?? null,
    groups: (orgs.data ?? []).map((org, i) => ({ org, projects: projects[i]?.data ?? [] })),
  };
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: keys.project(projectId),
    queryFn: () => api<{ project: Project; keys: ProjectKey[] }>(`/projects/${projectId}`),
  });
}

export function useCreateProject(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; platform: string }) =>
      api<{ project: Project & { dsn: string } }>(`/orgs/${orgId}/projects`, {
        method: "POST",
        body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.projects(orgId) }),
  });
}

// ---------- Issues ----------

export function useStats(projectId: string) {
  return useQuery({
    queryKey: keys.stats(projectId),
    queryFn: async () => (await api<{ stats: Stats }>(`/projects/${projectId}/stats`)).stats,
  });
}

type IssueFilters = { sort: IssueSort; status?: IssueStatus; limit?: number };

function issuesUrl(projectId: string, { sort, status, limit = 25 }: IssueFilters, cursor?: string) {
  const params = new URLSearchParams({ sort, limit: String(limit) });
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return `/projects/${projectId}/issues?${params}`;
}

type IssuePage = { issues: Issue[]; nextCursor: string | null };

// A short list, e.g. "5 most frequent" on the overview
export function useTopIssues(projectId: string, filters: IssueFilters) {
  return useQuery({
    queryKey: [...keys.issues(projectId), "top", filters],
    queryFn: async () => (await api<IssuePage>(issuesUrl(projectId, filters))).issues,
  });
}

// The full list, one page at a time ("Load more")
export function useIssueList(projectId: string, filters: IssueFilters) {
  return useInfiniteQuery({
    queryKey: [...keys.issues(projectId), "list", filters],
    queryFn: ({ pageParam }) => api<IssuePage>(issuesUrl(projectId, filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useIssue(issueId: string) {
  return useQuery({
    queryKey: keys.issue(issueId),
    queryFn: () => api<IssueDetail>(`/issues/${issueId}`),
  });
}

export function useEvent(eventId: string | undefined) {
  return useQuery({
    queryKey: keys.event(eventId ?? ""),
    queryFn: () => api<EventWithNeighbors>(`/events/${eventId}`),
    enabled: Boolean(eventId),
  });
}

export function useActivity(issueId: string) {
  return useQuery({
    queryKey: keys.activity(issueId),
    queryFn: async () =>
      (await api<{ activity: Activity[] }>(`/issues/${issueId}/activity`)).activity,
  });
}

export function useUpdateIssue(issue: Pick<Issue, "id" | "projectId">) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: { status?: IssueStatus; severity?: Severity }) =>
      api<{ issue: Issue }>(`/issues/${issue.id}`, { method: "PATCH", body: changes }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.issue(issue.id) }),
        queryClient.invalidateQueries({ queryKey: keys.activity(issue.id) }),
        queryClient.invalidateQueries({ queryKey: keys.issues(issue.projectId) }),
        queryClient.invalidateQueries({ queryKey: keys.stats(issue.projectId) }),
      ]),
  });
}
