// "http://<public_key>@<host>/<project_id>"
//   → send to "http://<host>/api/<project_id>/events" with header X-Pulse-Key: <public_key>
export type ParsedDsn = { endpoint: string; publicKey: string; projectId: string };

export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`Pulse: invalid DSN "${dsn}"`);
  }

  const publicKey = url.username;
  const projectId = url.pathname.split("/").filter(Boolean).pop();
  if (!publicKey || !projectId) {
    throw new Error(`Pulse: DSN must look like http://<key>@<host>/<project_id>`);
  }

  return { endpoint: `${url.origin}/api/${projectId}/events`, publicKey, projectId };
}
