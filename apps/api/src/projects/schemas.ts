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
  .object({ name: NameSchema, slug: SlugSchema, platform: z.enum(PLATFORMS) })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");
