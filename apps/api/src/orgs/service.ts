import type { Tx } from "../db/client.js";
import { memberships, organizations } from "../db/schema.js";
import { slugify, withFreeSlug } from "../slug.js";

// Must run inside a transaction: an org without an owner should never exist
export async function createOrgWithOwner(
  tx: Tx,
  input: { name: string; slug?: string; ownerId: string },
) {
  const insertOrg = (slug: string) =>
    tx
      .insert(organizations)
      .values({ name: input.name, slug })
      .onConflictDoNothing({ target: organizations.slug })
      .returning()
      .then(([org]) => org);

  // A slug the user typed must be used exactly; a generated one can get a suffix
  const org = input.slug
    ? await insertOrg(input.slug)
    : await withFreeSlug(slugify(input.name, "org"), insertOrg);
  if (!org) return null; // the chosen slug is taken

  await tx.insert(memberships).values({ userId: input.ownerId, orgId: org.id, role: "owner" });
  return { ...org, role: "owner" as const };
}
