import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./db/client.js";

// Applies the SQL files in drizzle/ that the database hasn't seen yet, then exits.
// Production runs this (`node dist/migrate.js`) instead of drizzle-kit, a dev tool.
// It uses the same bookkeeping table, so both can be used on the same database.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

try {
  await migrate(db, { migrationsFolder });
  console.log("✅ Migrations applied");
} catch (err) {
  console.error("❌ Migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
