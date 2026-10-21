import { z } from "zod";
import { ISSUE_STATUSES, SEVERITIES } from "../db/schema.js";
import { PageQuerySchema } from "../pagination.js";

export const ISSUE_SORTS = ["last_seen", "first_seen", "event_count", "user_count"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export const ListIssuesQuerySchema = PageQuerySchema.extend({
  sort: z.enum(ISSUE_SORTS).default("last_seen"),
  status: z.enum(ISSUE_STATUSES).optional(),
});

const changes = {
  status: z.enum(ISSUE_STATUSES),
  severity: z.enum(SEVERITIES),
  assigneeId: z.uuid().nullable(), // null = unassign
};

const atLeastOne = (body: object) => Object.keys(body).filter((key) => key !== "ids").length > 0;

export const UpdateIssueSchema = z
  .object(changes)
  .partial()
  .refine(atLeastOne, "Send at least one field to update");

export const BulkUpdateIssuesSchema = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)]),
    ...changes,
  })
  .partial({ status: true, severity: true, assigneeId: true })
  .refine(atLeastOne, "Send at least one field to update");

export type IssueChanges = z.infer<typeof UpdateIssueSchema>;
