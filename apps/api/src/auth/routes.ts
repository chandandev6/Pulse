import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { hashPassword } from "./password.js";
import { SignupSchema } from "./schemas.js";

// Postgres error code for "unique constraint violated"
const UNIQUE_VIOLATION = "23505";

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (request, reply) => {
    // 1. Validate the body (never trust the client)
    const parsed = SignupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", z.prettifyError(parsed.error));
    }
    const { email, password, name } = parsed.data;

    // 2. Friendly early check for an existing account
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
    }

    // 3. Hash and insert. Only return safe columns (never password_hash)
    const passwordHash = await hashPassword(password);
    try {
      const [user] = await db.insert(users).values({ email, passwordHash, name }).returning({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      });
      return reply.code(201).send({ user });
    } catch (err) {
      // Two signups with the same email at the same moment: the DB's unique index catches it
      if ((err as { cause?: { code?: string } }).cause?.code === UNIQUE_VIOLATION) {
        throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
      }
      throw err;
    }
  });
}
