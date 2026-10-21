import type { CaptureContext, RequestInfo, User } from "./types.js";

type Capture = (error: unknown, context: CaptureContext) => unknown;

// We only need a few fields, so plain types instead of depending on express/fastify
type HeaderBag = Record<string, string | string[] | undefined>;

export type IntegrationOptions<Req> = {
  // Tell Pulse who was logged in for this request
  getUser?: (request: Req) => User | undefined;
};

// Headers that carry secrets never leave the app
const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-pulse-key",
  "x-api-key",
]);

export function safeHeaders(headers: HeaderBag): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || SECRET_HEADERS.has(name.toLowerCase())) continue;
    safe[name] = (Array.isArray(value) ? value.join(", ") : value).slice(0, 2_000);
  }
  return safe;
}

// 4xx errors are the client's mistake (bad input, not logged in), not bugs worth an issue
function isServerError(error: unknown): boolean {
  const { statusCode, status } = (error ?? {}) as { statusCode?: unknown; status?: unknown };
  const code = typeof statusCode === "number" ? statusCode : status;
  return typeof code !== "number" || code >= 500;
}

// ---------- Express ----------

type ExpressRequest = {
  method: string;
  originalUrl: string;
  baseUrl?: string;
  route?: { path?: string };
  headers: HeaderBag;
};

// Add it AFTER your routes: app.use(Pulse.expressErrorHandler())
// It reports the error and passes it on, so your own error handling still runs.
export function createExpressErrorHandler(
  capture: Capture,
  options: IntegrationOptions<ExpressRequest> = {},
) {
  return (error: unknown, req: ExpressRequest, _res: unknown, next: (err: unknown) => void) => {
    if (isServerError(error)) {
      const route = req.route?.path ? `${req.baseUrl ?? ""}${req.route.path}` : undefined;
      const request: RequestInfo = {
        method: req.method,
        url: req.originalUrl,
        route,
        headers: safeHeaders(req.headers),
      };
      capture(error, { request, user: options.getUser?.(req) });
    }
    next(error);
  };
}

// ---------- Fastify ----------

type FastifyRequest = {
  method: string;
  url: string;
  routeOptions?: { url?: string };
  headers: HeaderBag;
};

type FastifyLike = {
  addHook(
    name: "onError",
    hook: (request: FastifyRequest, reply: unknown, error: unknown) => Promise<void>,
  ): unknown;
};

// app.register(Pulse.fastifyPlugin, { getUser: (req) => ... })
export function createFastifyPlugin(capture: Capture) {
  const plugin = async (app: FastifyLike, options: IntegrationOptions<FastifyRequest> = {}) => {
    app.addHook("onError", async (request, _reply, error) => {
      if (!isServerError(error)) return;
      const info: RequestInfo = {
        method: request.method,
        url: request.url,
        route: request.routeOptions?.url,
        headers: safeHeaders(request.headers),
      };
      capture(error, { request: info, user: options.getUser?.(request) });
    });
  };
  // Same as wrapping with fastify-plugin: the hook applies to the whole app,
  // not just inside this plugin (Fastify encapsulation, see the rate-limit lesson)
  Object.assign(plugin, { [Symbol.for("skip-override")]: true });
  return plugin;
}
