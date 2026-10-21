// Every request goes to "/backend/..." (forwarded to the API by Vite's proxy)
export const API_BASE = import.meta.env.VITE_API_URL ?? "/backend";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type Options = { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown };

// fetch + JSON + our API's error shape { error: { code, message } } → ApiError
export async function api<T>(path: string, { method = "GET", body }: Options = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include", // send the session cookie
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? "UNKNOWN",
      data?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}
