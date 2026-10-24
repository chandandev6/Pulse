import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./client";

export type AuditEntry = {
  id: string;
  action: string; // "member.added", "key.rotated"...
  targetType: string;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actor: { id: string; name: string; email: string } | null; // null = deleted account
};

type AuditPage = { entries: AuditEntry[]; nextCursor: string | null };

// Admins only: the API answers 403 to members
export function useAuditLog(orgId: string | undefined, action: string) {
  return useInfiniteQuery({
    queryKey: ["audit-log", orgId, action],
    enabled: Boolean(orgId),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (action) params.set("action", action);
      if (pageParam) params.set("cursor", pageParam);
      return api<AuditPage>(`/orgs/${orgId}/audit-log?${params}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
