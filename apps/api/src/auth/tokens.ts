import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { type AuthTokenPurpose, authTokens } from "../db/schema.js";
import { hashToken } from "./session.js";

const HOUR_MS = 60 * 60 * 1000;

export const TOKEN_LIFETIME: Record<AuthTokenPurpose, number> = {
  password_reset: 1 * HOUR_MS, // short: whoever has it can take over the account
  email_verify: 24 * HOUR_MS,
};

// A new link replaces the older ones of the same kind, so only the latest email works
export async function createAuthToken(
  userId: string,
  purpose: AuthTokenPurpose,
  tx: Tx | typeof db = db,
) {
  const token = randomBytes(32).toString("base64url");
  await tx
    .delete(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose)));
  await tx.insert(authTokens).values({
    id: hashToken(token),
    userId,
    purpose,
    expiresAt: new Date(Date.now() + TOKEN_LIFETIME[purpose]),
  });
  return token;
}

// Uses the token up: one DELETE ... RETURNING, so two clicks at the same moment can't both
// succeed. Returns whose token it was, or null (wrong, expired, used, or another purpose).
export async function consumeAuthToken(token: string, purpose: AuthTokenPurpose, tx: Tx) {
  const [row] = await tx
    .delete(authTokens)
    .where(
      and(
        eq(authTokens.id, hashToken(token)),
        eq(authTokens.purpose, purpose),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: authTokens.userId });
  return row?.userId ?? null;
}
