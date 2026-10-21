// Postgres error code for "unique constraint violated"
const UNIQUE_VIOLATION = "23505";

// Drizzle wraps the Postgres error, so the details live on `cause`.
// Pass a constraint name to only match that one, e.g. "users_email_unique".
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === UNIQUE_VIOLATION && (!constraint || cause.constraint === constraint);
}
