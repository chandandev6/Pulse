import { eq, inArray, like } from "drizzle-orm";
import { createAccount } from "../src/auth/account.js";
import { createSession } from "../src/auth/session.js";
import { db } from "../src/db/client.js";
import { memberships, organizations, users } from "../src/db/schema.js";

// Creates a user (plus their first org) without going through /auth/signup,
// so tests don't use up the signup rate limit.
export async function createTestUser(email: string, name: string) {
  const { user, organization } = await createAccount({ email, password: "test-password", name });
  if (!organization) throw new Error("signup should always create an org");
  const { token } = await createSession(user.id);
  return { user, org: organization, cookies: { pulse_session: token } };
}

// Deletes every org a test user belongs to, then the users (memberships and sessions cascade)
export async function deleteTestUsers(prefix: string) {
  const testOrgIds = db
    .select({ id: memberships.orgId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(like(users.email, `${prefix}%`));
  await db.delete(organizations).where(inArray(organizations.id, testOrgIds));
  await db.delete(users).where(like(users.email, `${prefix}%`));
}
