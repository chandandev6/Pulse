import { z } from "zod";
import { ISSUE_STATUSES, SEVERITIES } from "../db/schema.js";
import { PageQuerySchema } from "../pagination.js";

export const ISSUE_SORTS = ["last_seen", "first_seen", "event_count", "user_count"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

// "?severity=high,critical" → ["high", "critical"]. Comma lists keep URLs short and shareable.
const commaList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1).max(20));

// "2026-10-01" or a full ISO time like "2026-10-01T12:00:00Z"
const DateSchema = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => new Date(value));

const name = z.string().trim().min(1).max(200);

export const IssueFiltersSchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(), // search text
    status: commaList(z.enum(ISSUE_STATUSES)).optional(),
    severity: commaList(z.enum(SEVERITIES)).optional(),
    environment: commaList(name).optional(),
    release: commaList(name).optional(),
    since: DateSchema.optional(), // issues seen at or after this time...
    until: DateSchema.optional(), // ...and first seen at or before this one
  })
  .refine((f) => !f.since || !f.until || f.since <= f.until, "since must be before until");

export type IssueFilters = z.infer<typeof IssueFiltersSchema>;

export const ListIssuesQuerySchema = z.object({
  ...PageQuerySchema.shape,
  sort: z.enum(ISSUE_SORTS).default("last_seen"),
});

// Org-wide list: the same filters, plus which projects to include (default: all of them)
export const OrgIssuesQuerySchema = z.object({
  ...ListIssuesQuerySchema.shape,
  project: commaList(z.uuid()).optional(),
});

// "?tag=browser:Chrome" (repeat ?tag= to require several tags)
const TagSchema = z
  .string()
  .regex(/^[^:]+:.+$/, "Use key:value, e.g. browser:Chrome")
  .transform((value) => {
    const at = value.indexOf(":");
    return { key: value.slice(0, at), value: value.slice(at + 1) };
  });

export const ListEventsQuerySchema = z.object({
  ...PageQuerySchema.shape,
  user: z.string().trim().min(1).max(200).optional(), // matches user id, email, username or ip
  environment: name.optional(),
  release: name.optional(),
  tag: z
    .union([TagSchema, z.array(TagSchema).max(10)])
    .transform((tags) => (Array.isArray(tags) ? tags : [tags]))
    .optional(),
});

export const PERIODS = { "24h": 1, "7d": 7, "14d": 14, "30d": 30, "90d": 90 } as const;
export const INTERVALS = ["hour", "day"] as const;

export const TimeseriesQuerySchema = z.object({
  period: z.enum(Object.keys(PERIODS) as [keyof typeof PERIODS]).default("24h"),
  interval: z.enum(INTERVALS).optional(), // default: hours for up to 7 days, days after that
  environment: name.optional(),
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
