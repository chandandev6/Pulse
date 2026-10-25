import { z } from "zod";

export const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100),
});

export type SignupInput = z.infer<typeof SignupSchema>;

// Login only checks the shape. Password rules belong to signup:
// if they change later, old users must still be able to log in.
export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof LoginSchema>;

const token = z.string().min(20).max(200);

export const ForgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

// Same password rules as signup
export const ResetPasswordSchema = z.object({ token, password: SignupSchema.shape.password });

export const TokenSchema = z.object({ token });
