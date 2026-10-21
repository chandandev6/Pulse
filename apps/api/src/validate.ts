import { z } from "zod";
import { AppError } from "./errors.js";

// Never trust the client: check data against a schema, or fail with a 400
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", z.prettifyError(parsed.error));
  }
  return parsed.data;
}
