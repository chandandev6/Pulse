import { randomBytes } from "node:crypto";
import { z } from "zod";

// A slug is the URL-friendly name: "Acme Inc." → "acme-inc"
export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Only lowercase letters, numbers and single dashes");

export function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : fallback;
}

// Tries the slug as-is, then with a random suffix ("acme" → "acme-3f9a1c") until one is free.
// insert() must use onConflictDoNothing and return undefined when the slug is taken.
// (A failed INSERT would abort the whole transaction; ON CONFLICT DO NOTHING doesn't.)
export async function withFreeSlug<T>(
  base: string,
  insert: (slug: string) => Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    const row = await insert(slug);
    if (row) return row;
  }
  throw new Error(`Could not find a free slug for "${base}"`);
}
