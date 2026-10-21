import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import type { Tx } from "../db/client.js";
import { projectKeys } from "../db/schema.js";

type ProjectKey = typeof projectKeys.$inferSelect;

// The DSN tells an SDK where to send errors and which project they belong to:
//   http://<public_key>@<host>/<project_id>
// The key is "public": it ships inside apps' code, so it only allows sending events,
// never reading data. That's why revoking it is the fix if it gets abused.
export function buildDsn(publicKey: string, projectId: string): string {
  const url = new URL(config.API_PUBLIC_URL);
  url.username = publicKey;
  url.pathname = `/${projectId}`;
  return url.toString();
}

export function toKeyResponse(key: ProjectKey) {
  return {
    id: key.id,
    publicKey: key.publicKey,
    dsn: buildDsn(key.publicKey, key.projectId),
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
  };
}

export async function createProjectKey(tx: Tx, projectId: string) {
  const [key] = await tx
    .insert(projectKeys)
    .values({ projectId, publicKey: randomBytes(16).toString("hex") })
    .returning();
  return key;
}
