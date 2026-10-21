import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { close, expressErrorHandler, fastifyPlugin, init } from "../src/index.js";
import { safeHeaders } from "../src/integrations.js";
import type { PulseEvent } from "../src/types.js";

let sent: PulseEvent[] = [];

function setup() {
  sent = [];
  init({
    dsn: "http://abc@localhost:3000/p",
    captureUnhandled: false,
    transport: async (event) => {
      sent.push(event);
    },
  });
}

afterEach(async () => {
  await close();
});

describe("fastify plugin", () => {
  it("reports 5xx errors with route and user, but not 4xx", async () => {
    setup();
    const app = Fastify();
    await app.register(fastifyPlugin, {
      getUser: (req: { headers: Record<string, unknown> }) => ({
        id: String(req.headers["x-user"]),
      }),
    });
    app.get("/orders/:id", async () => {
      throw new TypeError("order.total is undefined");
    });
    app.get("/missing", async () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    });

    const res = await app.inject({
      method: "GET",
      url: "/orders/7",
      headers: { "x-user": "42", cookie: "session=secret" },
    });
    expect(res.statusCode).toBe(500);
    await app.inject({ method: "GET", url: "/missing" });
    await app.close();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      exception: { type: "TypeError", value: "order.total is undefined" },
      request: { method: "GET", url: "/orders/7", route: "/orders/:id" },
      user: { id: "42" },
    });
    expect(sent[0]?.request?.headers).not.toHaveProperty("cookie");
  });
});

describe("express error handler", () => {
  it("reports the error and passes it on", () => {
    setup();
    const handler = expressErrorHandler();
    const error = new Error("db down");
    let passedOn: unknown;

    handler(
      error,
      {
        method: "POST",
        originalUrl: "/api/users/7?x=1",
        baseUrl: "/api",
        route: { path: "/users/:id" },
        headers: { "user-agent": "curl" },
      },
      {},
      (err) => {
        passedOn = err;
      },
    );

    expect(passedOn).toBe(error);
    expect(sent[0]?.request).toEqual({
      method: "POST",
      url: "/api/users/7?x=1",
      route: "/api/users/:id",
      headers: { "user-agent": "curl" },
    });
  });
});

describe("safeHeaders", () => {
  it("drops secrets and joins repeated headers", () => {
    expect(
      safeHeaders({
        Authorization: "Bearer x",
        "x-pulse-key": "k",
        accept: ["text/html", "application/json"],
        host: "shop.com",
      }),
    ).toEqual({ accept: "text/html, application/json", host: "shop.com" });
  });
});
