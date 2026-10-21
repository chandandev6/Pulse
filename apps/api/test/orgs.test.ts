import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "orgtest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;

// Small wrapper so each test reads like "who does what"
function as(
  user: TestUser,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: object,
) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  admin = await createTestUser(email("admin"), "Admin");
  member = await createTestUser(email("member"), "Member");
  outsider = await createTestUser(email("outsider"), "Outsider");

  // owner's org: admin is an admin, member is a member, outsider is not in it
  const orgUrl = `/orgs/${owner.org.id}/members`;
  await as(owner, "POST", orgUrl, { email: admin.user.email, role: "admin" });
  await as(owner, "POST", orgUrl, { email: member.user.email });
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("organizations", () => {
  it("requires login", async () => {
    const res = await app.inject({ method: "GET", url: "/orgs" });
    expect(res.statusCode).toBe(401);
  });

  it("lists only the orgs you belong to, with your role", async () => {
    const res = await as(member, "GET", "/orgs");

    expect(res.statusCode).toBe(200);
    const orgs = res.json().organizations as { id: string; role: string }[];
    expect(orgs.map((o) => o.id).sort()).toEqual([member.org.id, owner.org.id].sort());
    expect(orgs.find((o) => o.id === owner.org.id)?.role).toBe("member");
    expect(orgs.some((o) => o.id === outsider.org.id)).toBe(false);
  });

  it("creates an org with the creator as owner", async () => {
    const res = await as(member, "POST", "/orgs", { name: `Side Project ${run}` });

    expect(res.statusCode).toBe(201);
    expect(res.json().organization.slug).toBe(`side-project-${run}`);
    expect(res.json().organization.role).toBe("owner");
  });

  it("adds a suffix when a generated slug is taken, but rejects a taken chosen slug", async () => {
    const name = `Clash ${run}`;
    const first = await as(member, "POST", "/orgs", { name });
    const second = await as(member, "POST", "/orgs", { name });
    expect(second.statusCode).toBe(201);
    expect(second.json().organization.slug).toMatch(new RegExp(`^clash-${run}-[a-f0-9]{6}$`));

    const chosen = await as(member, "POST", "/orgs", {
      name: "Copy",
      slug: first.json().organization.slug,
    });
    expect(chosen.statusCode).toBe(409);
    expect(chosen.json().error.code).toBe("SLUG_TAKEN");
  });

  it("hides other people's orgs with 404, even for made-up ids", async () => {
    for (const url of [`/orgs/${owner.org.id}`, `/orgs/${owner.org.id}/members`, "/orgs/nope"]) {
      const res = await as(outsider, "GET", url);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("ORG_NOT_FOUND");
    }
  });

  it("lets admins rename the org, but not members", async () => {
    const url = `/orgs/${owner.org.id}`;

    const denied = await as(member, "PATCH", url, { name: "Hacked" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");

    const ok = await as(admin, "PATCH", url, { name: "Renamed" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().organization.name).toBe("Renamed");
  });
});

describe("members", () => {
  const membersUrl = () => `/orgs/${owner.org.id}/members`;

  it("lists members with their roles", async () => {
    const res = await as(member, "GET", membersUrl());

    expect(res.statusCode).toBe(200);
    const roles = Object.fromEntries(
      (res.json().members as { email: string; role: string }[]).map((m) => [m.email, m.role]),
    );
    expect(roles).toEqual({
      [owner.user.email]: "owner",
      [admin.user.email]: "admin",
      [member.user.email]: "member",
    });
  });

  it("checks who can add whom", async () => {
    const byMember = await as(member, "POST", membersUrl(), { email: outsider.user.email });
    expect(byMember.statusCode).toBe(403);

    const ownerByAdmin = await as(admin, "POST", membersUrl(), {
      email: outsider.user.email,
      role: "owner",
    });
    expect(ownerByAdmin.statusCode).toBe(403);

    const unknown = await as(admin, "POST", membersUrl(), { email: email("nobody") });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("USER_NOT_FOUND");

    const twice = await as(admin, "POST", membersUrl(), { email: member.user.email });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("ALREADY_MEMBER");
  });

  it("only lets owners change an owner's role", async () => {
    const res = await as(admin, "PATCH", `${membersUrl()}/${owner.user.id}`, { role: "member" });
    expect(res.statusCode).toBe(403);
  });

  it("never leaves an org without an owner", async () => {
    const self = `${membersUrl()}/${owner.user.id}`;

    const demote = await as(owner, "PATCH", self, { role: "admin" });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("LAST_OWNER");

    const leave = await as(owner, "DELETE", self);
    expect(leave.statusCode).toBe(409);

    // With a second owner, stepping down works
    const promote = await as(owner, "PATCH", `${membersUrl()}/${admin.user.id}`, {
      role: "owner",
    });
    expect(promote.statusCode).toBe(200);
    expect((await as(owner, "PATCH", self, { role: "admin" })).statusCode).toBe(200);

    // Put things back for the other tests
    await as(admin, "PATCH", self, { role: "owner" });
    await as(owner, "PATCH", `${membersUrl()}/${admin.user.id}`, { role: "admin" });
  });

  it("lets a member leave, but not remove others", async () => {
    const extra = await createTestUser(email("leaver"), "Leaver");
    await as(owner, "POST", membersUrl(), { email: extra.user.email });

    const removeOther = await as(extra, "DELETE", `${membersUrl()}/${member.user.id}`);
    expect(removeOther.statusCode).toBe(403);

    const leave = await as(extra, "DELETE", `${membersUrl()}/${extra.user.id}`);
    expect(leave.statusCode).toBe(204);

    // Gone: the org is now invisible to them
    expect((await as(extra, "GET", `/orgs/${owner.org.id}`)).statusCode).toBe(404);
  });
});
