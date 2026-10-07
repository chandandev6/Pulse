import { z } from "zod";

export const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100),
});

export type SignupInput = z.infer<typeof SignupSchema>;
