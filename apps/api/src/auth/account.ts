import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createOrgWithOwner } from "../orgs/service.js";
import { hashPassword } from "./password.js";
import type { SignupInput } from "./schemas.js";

// Every user starts with their own org, so the app is usable right after signup.
// One transaction: if creating the org fails, the user isn't saved either.
export async function createAccount(input: SignupInput) {
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: input.email, passwordHash, name: input.name })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      });

    const organization = await createOrgWithOwner(tx, {
      name: `${input.name}'s org`,
      ownerId: user.id,
    });

    return { user, organization };
  });
}
