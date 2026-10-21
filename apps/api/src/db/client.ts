import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle({ client: pool });

// The `tx` object inside db.transaction(async (tx) => ...)
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
