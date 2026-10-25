import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { keys } from "./queries";
import type { Role, User } from "./types";

// ---------- Password reset & email verification ----------

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) =>
      api("/auth/forgot-password", { method: "POST", body: { email } }),
  });
}

// Logs this browser in on success
export function useResetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      api<{ user: User }>("/auth/reset-password", { method: "POST", body }),
    onSuccess: ({ user }) => {
      queryClient.clear();
      queryClient.setQueryData(keys.me, user);
    },
  });
}

export function useVerifyEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api("/auth/verify-email", { method: "POST", body: { token } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: () => api("/auth/resend-verification", { method: "POST" }),
  });
}

// The token sits after "#" in links from emails, so it never reaches any server log
export function tokenFromHash(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token");
}

// ---------- Members & invitations ----------

export type Member = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
};

export type Invitation = {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
};

export type InvitationPreview = {
  orgName: string;
  inviterName: string | null;
  email: string;
  role: Role;
};

const membersKey = (orgId: string) => ["members", orgId] as const;
const invitationsKey = (orgId: string) => ["invitations", orgId] as const;

export function useMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: membersKey(orgId ?? ""),
    queryFn: async () => (await api<{ members: Member[] }>(`/orgs/${orgId}/members`)).members,
    enabled: Boolean(orgId),
  });
}

export function useInvitations(orgId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: invitationsKey(orgId ?? ""),
    queryFn: async () =>
      (await api<{ invitations: Invitation[] }>(`/orgs/${orgId}/invitations`)).invitations,
    enabled: Boolean(orgId) && enabled,
  });
}

export function useInvitationActions(orgId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationsKey(orgId) });
  return {
    invite: useMutation({
      mutationFn: (body: { email: string; role: Role }) =>
        api<{ invitation: Invitation }>(`/orgs/${orgId}/invitations`, { method: "POST", body }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api(`/orgs/${orgId}/invitations/${id}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}

export function useInvitationPreview(token: string | null) {
  return useQuery({
    queryKey: ["invitation-preview", token],
    queryFn: async () =>
      (
        await api<{ invitation: InvitationPreview }>("/invitations/preview", {
          method: "POST",
          body: { token },
        })
      ).invitation,
    enabled: Boolean(token),
    retry: false,
  });
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api<{ orgId: string; alreadyMember: boolean }>("/invitations/accept", {
        method: "POST",
        body: { token },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.orgs });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: keys.me });
    },
  });
}

// ---------- Source maps ----------

export type UploadToken = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
};
export type SourceMapRelease = {
  release: string;
  files: number;
  bytes: number;
  uploadedAt: string;
};

const tokensKey = (projectId: string) => ["upload-tokens", projectId] as const;
const mapsKey = (projectId: string) => ["sourcemaps", projectId] as const;

export function useUploadTokens(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: tokensKey(projectId),
    queryFn: async () =>
      (await api<{ tokens: UploadToken[] }>(`/projects/${projectId}/upload-tokens`)).tokens,
    enabled,
  });
}

export function useSourceMapReleases(projectId: string) {
  return useQuery({
    queryKey: mapsKey(projectId),
    queryFn: async () =>
      (await api<{ releases: SourceMapRelease[] }>(`/projects/${projectId}/sourcemaps`)).releases,
  });
}

export function useUploadTokenActions(projectId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: tokensKey(projectId) });
  return {
    create: useMutation({
      mutationFn: (name: string) =>
        api<{ token: UploadToken; secret: string }>(`/projects/${projectId}/upload-tokens`, {
          method: "POST",
          body: { name },
        }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) =>
        api(`/projects/${projectId}/upload-tokens/${id}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}
