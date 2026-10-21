import { z } from "zod";
import { ROLES } from "../db/schema.js";
import { SlugSchema } from "../slug.js";

const NameSchema = z.string().trim().min(1).max(100);

export const CreateOrgSchema = z.object({
  name: NameSchema,
  slug: SlugSchema.optional(),
});

export const UpdateOrgSchema = z
  .object({ name: NameSchema, slug: SlugSchema })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

export const AddMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(ROLES).default("member"),
});

export const ChangeRoleSchema = z.object({
  role: z.enum(ROLES),
});
