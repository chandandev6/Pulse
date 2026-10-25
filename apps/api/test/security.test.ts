import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createSession, hashToken } from "../src/auth/session.js";
import { config, parseTrustProxy } from "../src/config.js";
import { db } from "../src/db/client.js";
import { sessions } from "../src/db/schema.js";
import { effectiveLimits } from "../src/events/quota.js";
import { isPublicAddress } from "../src/notifications/ssrf.js";
import { RATE_LIMIT_NAMESPACE } from "../src/rate-limit.js";
import { redis } from "../src/redis.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

// Fixes from SECURITY_AUDIT.md: IP trust, login limits, sessions, /health, ceilings
const app = buildApp();
const PREFIX = "sectest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

beforeAll(async () => {
  await app.ready();
  const keys = await redis.keys(`${RATE_LIMIT_NAMESPACE}*`);
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("client IP behind nginx (TRUST_PROXY=1)", () => {
  // The same trust function app.ts builds for a number
  const trustOneHop = (_address: string, hop: number) => hop < 1;

  it("uses the address nginx put in, not one the client added", async () => {
    const proxied = Fastify({ trustProxy: trustOneHop });
    proxied.get("/ip", async (request) => ({ ip: request.ip }));
    // Our nginx replaces the header with one address; if a client's own value ever got
    // through in front of it, only the right-most (nginx's) entry counts
    const res = await proxied.inject({
      url: "/ip",
      remoteAddress: "172.18.0.5", // nginx
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
    });
    expect(res.json().ip).toBe("203.0.113.9");
    await proxied.close();
  });

  it("reads TRUST_PROXY as a hop count, true/false or proxy addresses", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
  });
});

describe("login limit per account", () => {
  it("stops guessing one account's password from many IPs", async () => {
    const target = email("victim");
    await createTestUser(target, "Victim");

    // A different "IP" each time: the per-IP limit never kicks in
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: `198.51.100.${i + 1}`,
        payload: { email: target, password: `guess-${i}` },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: "198.51.100.200",
      payload: { email: target, password: "test-password" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  }, 30_000);
});

describe("sessions", () => {
  it("'sign out other devices' ends every session but this one", async () => {
    const user = await createTestUser(email("devices"), "Devices");
    const other = await createSession(user.user.id);

    const res = await app.inject({
      method: "POST",
      url: "/auth/sessions/sign-out-others",
      cookies: user.cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signedOut).toBe(1);

    const me = (cookie: string) =>
      app.inject({ method: "GET", url: "/auth/me", cookies: { pulse_session: cookie } });
    expect((await me(user.cookies.pulse_session)).statusCode).toBe(200);
    expect((await me(other.token)).statusCode).toBe(401);
  });

  it("ends after 7 idle days, and use pushes that forward (up to 30 days)", async () => {
    const user = await createTestUser(email("idle"), "Idle");
    const { token, expiresAt } = await createSession(user.user.id);
    const days = (ms: number) => Math.round(ms / (24 * 60 * 60 * 1000));
    expect(days(expiresAt.getTime() - Date.now())).toBe(7);

    // Pretend it was last extended 3 days ago: using it slides the deadline forward again
    const id = hashToken(token);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000) })
      .where(eq(sessions.id, id));
    await app.inject({ method: "GET", url: "/auth/me", cookies: { pulse_session: token } });
    const [slid] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(days((slid?.expiresAt.getTime() ?? 0) - Date.now())).toBe(7);

    // A 28-day-old session only gets the 2 days left of its 30
    await db
      .update(sessions)
      .set({
        createdAt: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(eq(sessions.id, id));
    await app.inject({ method: "GET", url: "/auth/me", cookies: { pulse_session: token } });
    const [capped] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(days((capped?.expiresAt.getTime() ?? 0) - Date.now())).toBe(2);
  });
});

describe("/health", () => {
  it("tells the internet only up or down, and Docker the details", async () => {
    const outside = await app.inject({ url: "/health", remoteAddress: "8.8.8.8" });
    expect(outside.json()).toEqual({ status: "ok" });

    const inside = await app.inject({ url: "/health", remoteAddress: "127.0.0.1" });
    expect(inside.json()).toMatchObject({ status: "ok", db: "ok", redis: "ok" });
  });
});

describe("server ceilings on project limits", () => {
  const project = { id: "p", rateLimitPerMinute: 100_000, monthlyQuota: null };

  it("holds a project's own settings under MAX_EVENTS_PER_MINUTE / MAX_MONTHLY_QUOTA", () => {
    const capped = effectiveLimits(project, {
      ...config,
      MAX_EVENTS_PER_MINUTE: 1000,
      MAX_MONTHLY_QUOTA: 50_000,
    });
    expect(capped).toEqual({ id: "p", rateLimitPerMinute: 1000, monthlyQuota: 50_000 });
  });

  it("changes nothing when no ceiling is set", () => {
    const free = effectiveLimits(project, {
      ...config,
      MAX_EVENTS_PER_MINUTE: undefined,
      MAX_MONTHLY_QUOTA: undefined,
    });
    expect(free).toEqual(project);
  });
});

describe("webhook address filter", () => {
  it("blocks IPv4 addresses wrapped in old IPv6 forms", () => {
    for (const address of ["::10.0.0.1", "::7f00:1", "2002:a00:1::1", "2002:7f00:1::"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true); // a real public IPv6
  });
});
