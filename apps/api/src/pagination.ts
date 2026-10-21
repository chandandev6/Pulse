import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AppError } from "./errors.js";

// Cursor ("keyset") pagination, newest/biggest first.
// Instead of "skip 50 rows" (slow on big tables, and rows shift as new errors arrive),
// the cursor remembers the last row we sent: "give me rows that come after this one".
// Ties are broken by id, so rows with the same sort value are never skipped or repeated.

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});

type CursorValue = string | number;

export function encodeCursor(sort: string, value: CursorValue | Date, id: string): string {
  const plain = value instanceof Date ? value.toISOString() : value;
  return Buffer.from(JSON.stringify([sort, plain, id])).toString("base64url");
}

const invalidCursor = () => new AppError(400, "INVALID_CURSOR", "This cursor is not valid");

// A cursor only works with the sort it was made for
export function decodeCursor(cursor: string, sort: string): { value: CursorValue; id: string } {
  try {
    const [cursorSort, value, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (cursorSort === sort && (typeof value === "string" || typeof value === "number")) {
      if (z.uuid().safeParse(id).success) return { value, id };
    }
  } catch {
    // fall through
  }
  throw invalidCursor();
}

// WHERE (sort < value) OR (sort = value AND id < lastId), for ORDER BY sort DESC, id DESC
export function afterCursor(
  column: PgColumn,
  idColumn: PgColumn,
  cursor: { value: CursorValue; id: string },
  isDate: boolean,
): SQL | undefined {
  const value = isDate ? new Date(cursor.value) : cursor.value;
  if (isDate && Number.isNaN((value as Date).getTime())) throw invalidCursor();
  return or(lt(column, value), and(eq(column, value), lt(idColumn, cursor.id)));
}

// Fetch one row more than asked: if it exists, there is a next page
export function pageOf<T>(rows: T[], limit: number, cursorFor: (last: T) => string) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? cursorFor(last) : null };
}
