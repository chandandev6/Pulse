import { like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { RATE_LIMIT_NAMESPACE } from "../src/rate-limit.js";
import { redis } from "../src/redis.js";

const app = buildApp();

// Every user made here starts with this prefix, so afterAll can delete them all
const PREFIX = "authtest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;
const PASSWORD = "correct-horse-battery";

function signup(body: object) {
  return app.inject({ method: "POST", url: "/auth/signup", payload: body });
}

function login(body: object) {
  return app.inject({ method: "POST", url: "/auth/login", payload: body });
}

// Pulls the session token out of the Set-Cookie header
function sessionToken(res: Awaited<ReturnType<typeof login>>) {
  return res.cookies.find((c) => c.name === "pulse_session")?.value;
}

beforeAll(async () => {
  await app.ready();
  // Start with clean rate-limit counters so earlier test runs don't block this one
  const keys = await redis.keys(`${RATE_LIMIT_NAMESPACE}*`);
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await db.delete(users).where(like(users.email, `${PREFIX}%`)); // sessions cascade
  await app.close();
});

describe("POST /auth/signup", () => {
  it("creates a user and never returns the password hash", async () => {
    const res = await signup({
      email: `  ${email("new").toUpperCase()} `,
      password: PASSWORD,
      name: "Ada",
    });

    expect(res.statusCode).toBe(201);
    const { user } = res.json();
    expect(user.email).toBe(email("new")); // trimmed + lowercased
    expect(user.name).toBe("Ada");
    expect(user).not.toHaveProperty("passwordHash");
    expect(res.body).not.toContain("argon2");
  });

  it("rejects a duplicate email with 409", async () => {
    await signup({ email: email("dup"), password: PASSWORD, name: "One" });
    const res = await signup({ email: email("dup"), password: PASSWORD, name: "Two" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects invalid input with 400", async () => {
    const res = await signup({ email: "not-an-email", password: "short" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("login → me → logout", () => {
  const userEmail = email("flow");

  beforeAll(async () => {
    await signup({ email: userEmail, password: PASSWORD, name: "Flow" });
  });

  it("rejects a wrong password with 401", async () => {
    const res = await login({ email: userEmail, password: "wrong-password" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(sessionToken(res)).toBeUndefined();
  });

  it("gives the same error for an unknown email", async () => {
    const res = await login({ email: email("ghost"), password: PASSWORD });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("logs in, reaches the protected route, then logs out", async () => {
    // Login sets a secure-looking session cookie
    const loginRes = await login({ email: userEmail, password: PASSWORD });
    expect(loginRes.statusCode).toBe(200);
    const cookie = loginRes.cookies.find((c) => c.name === "pulse_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    const token = sessionToken(loginRes) ?? "";
    expect(token).not.toBe("");

    // The cookie unlocks /auth/me
    const meRes = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { pulse_session: token },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.email).toBe(userEmail);

    // Logout deletes the session...
    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { pulse_session: token },
    });
    expect(logoutRes.statusCode).toBe(204);

    // ...so even a copied token stops working
    const afterRes = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { pulse_session: token },
    });
    expect(afterRes.statusCode).toBe(401);
  });
});

describe("protected routes", () => {
  it("return 401 without a cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("return 401 with a made-up token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { pulse_session: "fake" },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("rate limiting", () => {
  it("blocks the 6th login attempt for the same email", async () => {
    const target = email("brute");
    await signup({ email: target, password: PASSWORD, name: "Target" });

    for (let i = 0; i < 5; i++) {
      const res = await login({ email: target, password: `guess-${i}` });
      expect(res.statusCode).toBe(401);
    }

    // Even the right password is refused once the limit is hit
    const blocked = await login({ email: target, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  });
});
