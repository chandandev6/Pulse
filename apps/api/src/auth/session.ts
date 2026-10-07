import { createHash, randomBytes } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "pulse_session";

const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const sessionCookieOptions: CookieSerializeOptions = {
  httpOnly: true, // JavaScript in the browser cannot read it
  secure: config.NODE_ENV === "production", // HTTPS only in production
  sameSite: "lax", // not sent on cross-site POSTs (CSRF protection)
  path: "/",
  maxAge: SESSION_DAYS * 24 * 60 * 60, // seconds
};

// The browser gets the token; the database only stores its SHA-256 hash.
// If the sessions table ever leaks, the hashes can't be used as cookies.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);

  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });

  return { token, expiresAt };
}

export async function validateSession(token: string) {
  const id = hashToken(token);

  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      user: { id: users.id, email: users.email, name: users.name, createdAt: users.createdAt },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id));

  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  return row.user;
}

export async function deleteSession(token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}
