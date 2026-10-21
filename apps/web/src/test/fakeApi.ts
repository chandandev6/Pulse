import { vi } from "vitest";

type Handler = (body: unknown, url: URL) => { status?: number; body?: unknown };

// A pretend API: "METHOD /path" → handler. Replaces fetch for one test,
// so pages can be tested without a real server.
export function fakeApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];

  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const path = url.pathname.replace(/^\/backend/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const handler = routes[`${method} ${path}`];
    const result = handler
      ? handler(body, url)
      : {
          status: 404,
          body: { error: { code: "NOT_FOUND", message: `No fake for ${method} ${path}` } },
        };
    const status = result.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}
