import { z } from "zod";
import { SlugSchema } from "../slug.js";

export const PLATFORMS = ["javascript", "node", "react", "other"] as const;

const NameSchema = z.string().trim().min(1).max(100);

export const CreateProjectSchema = z.object({
  name: NameSchema,
  slug: SlugSchema.optional(),
  platform: z.enum(PLATFORMS).default("javascript"),
});

export const UpdateProjectSchema = z
  .object({
    name: NameSchema,
    slug: SlugSchema,
    platform: z.enum(PLATFORMS),
    onCallScheduleId: z.uuid().nullable(), // null = nobody on call: every member is notified
    // F15: limits, retention and scrubbing
    rateLimitPerMinute: z.number().int().min(1).max(100_000),
    monthlyQuota: z.number().int().min(1).max(1_000_000_000).nullable(), // null = no quota
    retentionDays: z.number().int().min(1).max(3_650),
    scrubData: z.boolean(),
    scrubFields: z
      .array(z.string().trim().min(1).max(64))
      .max(50)
      .transform((fields) => [...new Set(fields)]),
    scrubIpAddresses: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");
