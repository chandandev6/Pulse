import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { authTokens, invitations, memberships, users } from "../src/db/schema.js";
import type { Mail } from "../src/mail/mailer.js";
import { notificationsQueue } from "../src/notifications/queue.js";
import { RATE_LIMIT_NAMESPACE } from "../src/rate-limit.js";
import { redis } from "../src/redis.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "accttest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

function as(user: TestUser | null, method: "GET" | "POST" | "DELETE", url: string, body?: object) {
  return app.inject({ method, url, cookies: user?.cookies, payload: body });
}

// Account emails are queued for the worker: catch them instead, and read the link inside
const sentMail: Mail[] = [];
function lastMailTo(address: string) {
  const mail = sentMail.findLast((m) => m.to === address);
  if (!mail) throw new Error(`no mail to ${address}`);
  const token = /#token=([\w-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error("no link in the mail");
  return { mail, token };
}

beforeAll(async () => {
  await app.ready();
  const keys = await redis.keys(`${RATE_LIMIT_NAMESPACE}*`);
  if (keys.length > 0) await redis.del(...keys);
  vi.spyOn(notificationsQueue, "add").mockImplementation(async (_name, data) => {
    if (data.kind === "mail") sentMail.push(data.mail);
    return {} as never;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("forgot password", () => {
  it("answers the same for unknown emails, and sends nothing", async () => {
    const res = await as(null, "POST", "/auth/forgot-password", { email: email("nobody") });
    expect(res.statusCode).toBe(202);
    expect(sentMail.some((m) => m.to === email("nobody"))).toBe(false);
  });

  it("emails a one-time link that sets a new password and logs out other sessions", async () => {
    const ada = await createTestUser(email("ada"), "Ada");

    const asked = await as(null, "POST", "/auth/forgot-password", { email: ada.user.email });
    expect(asked.statusCode).toBe(202);
    const { mail, token } = lastMailTo(ada.user.email);
    expect(mail.subject).toMatch(/reset/i);
    // Only the hash is stored
    const [stored] = await db.select().from(authTokens).where(eq(authTokens.userId, ada.user.id));
    expect(stored?.id).not.toBe(token);

    const reset = await as(null, "POST", "/auth/reset-password", {
      token,
      password: "a-brand-new-password",
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().user).toMatchObject({ email: ada.user.email, emailVerified: true });
    expect(reset.cookies.find((c) => c.name === "pulse_session")?.value).toBeTruthy();

    // The old session is gone, the old password too
    expect((await as(ada, "GET", "/auth/me")).statusCode).toBe(401);
    const oldLogin = await as(null, "POST", "/auth/login", {
      email: ada.user.email,
      password: "test-password",
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await as(null, "POST", "/auth/login", {
      email: ada.user.email,
      password: "a-brand-new-password",
    });
    expect(newLogin.statusCode).toBe(200);

    // A link works once
    const again = await as(null, "POST", "/auth/reset-password", {
      token,
      password: "another-one",
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("INVALID_TOKEN");
  });

  it("refuses expired links, and links made for something else", async () => {
    const bob = await createTestUser(email("bob"), "Bob");
    await as(null, "POST", "/auth/forgot-password", { email: bob.user.email });
    const { token } = lastMailTo(bob.user.email);
    await db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.userId, bob.user.id));
    const expired = await as(null, "POST", "/auth/reset-password", {
      token,
      password: "whatever-password",
    });
    expect(expired.statusCode).toBe(400);

    await as(bob, "POST", "/auth/resend-verification");
    const verify = lastMailTo(bob.user.email);
    const wrongPurpose = await as(null, "POST", "/auth/reset-password", {
      token: verify.token,
      password: "whatever-password",
    });
    expect(wrongPurpose.statusCode).toBe(400);
  });
});

describe("email verification", () => {
  afterEach(() => {
    config.REQUIRE_EMAIL_VERIFICATION = false;
  });

  it("signup sends a link; opening it verifies the address", async () => {
    const res = await as(null, "POST", "/auth/signup", {
      email: email("cleo"),
      password: "cleo-password",
      name: "Cleo",
    });
    expect(res.statusCode).toBe(201);
    const { mail, token } = lastMailTo(email("cleo"));
    expect(mail.subject).toMatch(/confirm/i);

    const verified = await as(null, "POST", "/auth/verify-email", { token });
    expect(verified.statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.email, email("cleo")));
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await as(null, "POST", "/auth/verify-email", { token })).statusCode).toBe(400);
  });

  it("when required, unverified accounts can't create projects or channels until they verify", async () => {
    config.REQUIRE_EMAIL_VERIFICATION = true;
    const dan = await createTestUser(email("dan"), "Dan");

    const me = await as(dan, "GET", "/auth/me");
    expect(me.json().user).toMatchObject({ emailVerified: false, mustVerifyEmail: true });

    const project = { name: "Shop", platform: "node" };
    const blocked = await as(dan, "POST", `/orgs/${dan.org.id}/projects`, project);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("EMAIL_NOT_VERIFIED");
    const channel = await as(dan, "POST", `/orgs/${dan.org.id}/notification-channels`, {
      type: "email",
      config: { address: "team@example.com" },
    });
    expect(channel.statusCode).toBe(403);

    await as(dan, "POST", "/auth/resend-verification");
    await as(null, "POST", "/auth/verify-email", { token: lastMailTo(dan.user.email).token });

    expect((await as(dan, "GET", "/auth/me")).json().user.mustVerifyEmail).toBe(false);
    expect((await as(dan, "POST", `/orgs/${dan.org.id}/projects`, project)).statusCode).toBe(201);
  });
});

describe("invitations", () => {
  let owner: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    owner = await createTestUser(email("owner"), "Olive");
    member = await createTestUser(email("member"), "Max");
    await db
      .insert(memberships)
      .values({ userId: member.user.id, orgId: owner.org.id, role: "member" });
  });

  const invitationsUrl = () => `/orgs/${owner.org.id}/invitations`;

  it("only admins invite, and existing members can't be invited", async () => {
    const byMember = await as(member, "POST", invitationsUrl(), { email: email("x") });
    expect(byMember.statusCode).toBe(403);
    const existing = await as(owner, "POST", invitationsUrl(), { email: member.user.email });
    expect(existing.statusCode).toBe(409);
  });

  it("emails a link; whoever opens it and logs in joins with the invited role", async () => {
    const invited = email("newbie");
    const created = await as(owner, "POST", invitationsUrl(), { email: invited, role: "admin" });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toMatch(/token/i);
    const { mail, token } = lastMailTo(invited);
    expect(mail.subject).toContain("Olive");

    const listed = await as(owner, "GET", invitationsUrl());
    expect(listed.json().invitations).toEqual([expect.objectContaining({ email: invited })]);

    // The join page, before logging in
    const preview = await as(null, "POST", "/invitations/preview", { token });
    expect(preview.json().invitation).toMatchObject({
      orgName: "Olive's org",
      inviterName: "Olive",
      email: invited,
      role: "admin",
    });

    // They sign up with the invited address, then accept
    const newbie = await createTestUser(invited, "Nia");
    expect((await as(null, "POST", "/invitations/accept", { token })).statusCode).toBe(401);
    const accepted = await as(newbie, "POST", "/invitations/accept", { token });
    expect(accepted.json()).toEqual({ orgId: owner.org.id, alreadyMember: false });

    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, newbie.user.id));
    expect(membership).toBeDefined();
    const roles = await db.select().from(memberships).where(eq(memberships.orgId, owner.org.id));
    expect(roles.find((m) => m.userId === newbie.user.id)?.role).toBe("admin");
    // The invitation reached their inbox, so their email counts as verified
    const [row] = await db.select().from(users).where(eq(users.id, newbie.user.id));
    expect(row?.emailVerifiedAt).toBeInstanceOf(Date);

    // Used up
    expect((await as(newbie, "POST", "/invitations/accept", { token })).statusCode).toBe(404);
    expect((await as(owner, "GET", invitationsUrl())).json().invitations).toEqual([]);
  });

  it("a revoked invitation stops working", async () => {
    const created = await as(owner, "POST", invitationsUrl(), { email: email("revoked") });
    const { token } = lastMailTo(email("revoked"));
    const del = await as(owner, "DELETE", `${invitationsUrl()}/${created.json().invitation.id}`);
    expect(del.statusCode).toBe(204);
    expect((await as(null, "POST", "/invitations/preview", { token })).statusCode).toBe(404);
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.email, email("revoked")));
    expect(rows).toEqual([]);
  });
});
