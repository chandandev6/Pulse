// Postgres error codes we handle on purpose
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

type PgError = { code?: string; constraint?: string };

// Drizzle wraps the Postgres error, so the details live on `cause`
function pgError(err: unknown): PgError | undefined {
  return (err as { cause?: PgError }).cause;
}

// Pass a constraint name to only match that one, e.g. "users_email_unique"
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const cause = pgError(err);
  return cause?.code === UNIQUE_VIOLATION && (!constraint || cause.constraint === constraint);
}

// A row points at something that doesn't exist (anymore)
export function isForeignKeyViolation(err: unknown): boolean {
  return pgError(err)?.code === FOREIGN_KEY_VIOLATION;
}
