import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { addMember, createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "projtest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let admin: TestUser; // owner of the org, so admin rights and more
let member: TestUser;
let outsider: TestUser;
let projectId: string;

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
  admin = await createTestUser(email("admin"), "Admin");
  member = await createTestUser(email("member"), "Member");
  outsider = await createTestUser(email("outsider"), "Outsider");
  await addMember(admin.org.id, member.user.id);
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("projects", () => {
  const projectsUrl = () => `/orgs/${admin.org.id}/projects`;

  it("can't be created by a plain member", async () => {
    const res = await as(member, "POST", projectsUrl(), { name: "Website" });
    expect(res.statusCode).toBe(403);
  });

  it("are created by admins with a working DSN", async () => {
    const res = await as(admin, "POST", projectsUrl(), { name: "Acme Website", platform: "react" });

    expect(res.statusCode).toBe(201);
    const { project } = res.json();
    expect(project.slug).toBe("acme-website");
    expect(project.platform).toBe("react");
    expect(project.dsn).toMatch(new RegExp(`^http://[a-f0-9]{32}@localhost:\\d+/${project.id}$`));
    projectId = project.id;
  });

  it("are listed and readable by members, keys included", async () => {
    const list = await as(member, "GET", projectsUrl());
    expect(list.json().projects.map((p: { id: string }) => p.id)).toEqual([projectId]);

    const res = await as(member, "GET", `/projects/${projectId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toHaveLength(1);
    expect(res.json().keys[0].revokedAt).toBeNull();
  });

  it("are invisible to other orgs", async () => {
    expect((await as(outsider, "GET", `/projects/${projectId}`)).statusCode).toBe(404);
    expect((await as(outsider, "GET", projectsUrl())).statusCode).toBe(404);
    expect((await as(outsider, "POST", projectsUrl(), { name: "Sneaky" })).statusCode).toBe(404);
    expect((await as(outsider, "DELETE", `/projects/${projectId}`)).statusCode).toBe(404);
  });

  it("can be updated by admins, with slugs unique per org", async () => {
    await as(admin, "POST", projectsUrl(), { name: "Mobile" });

    const clash = await as(admin, "PATCH", `/projects/${projectId}`, { slug: "mobile" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("SLUG_TAKEN");

    const denied = await as(member, "PATCH", `/projects/${projectId}`, { name: "Nope" });
    expect(denied.statusCode).toBe(403);

    const ok = await as(admin, "PATCH", `/projects/${projectId}`, { name: "Main Site" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project.name).toBe("Main Site");

    // Another org can reuse the same slug
    const other = await as(outsider, "POST", `/orgs/${outsider.org.id}/projects`, {
      name: "Acme Website",
    });
    expect(other.json().project.slug).toBe("acme-website");
  });
});

describe("project keys", () => {
  const keysOf = async () =>
    (await as(admin, "GET", `/projects/${projectId}`)).json().keys as {
      id: string;
      revokedAt: string | null;
    }[];

  it("rotate revokes the old key and issues a new one", async () => {
    const [oldKey] = await keysOf();

    const denied = await as(member, "POST", `/projects/${projectId}/keys/rotate`);
    expect(denied.statusCode).toBe(403);

    const res = await as(admin, "POST", `/projects/${projectId}/keys/rotate`);
    expect(res.statusCode).toBe(201);
    const newKey = res.json().key;
    expect(newKey.id).not.toBe(oldKey?.id);

    const keys = await keysOf();
    expect(keys.find((k) => k.id === oldKey?.id)?.revokedAt).not.toBeNull();
    expect(keys.find((k) => k.id === newKey.id)?.revokedAt).toBeNull();
  });

  it("revokes a single key, and only keys of this project", async () => {
    const [active] = (await keysOf()).filter((k) => k.revokedAt === null);
    const url = `/projects/${projectId}/keys/${active?.id}/revoke`;

    const res = await as(admin, "POST", url);
    expect(res.statusCode).toBe(200);
    expect(res.json().key.revokedAt).not.toBeNull();

    // Revoking again keeps the first timestamp
    const again = await as(admin, "POST", url);
    expect(again.json().key.revokedAt).toBe(res.json().key.revokedAt);

    for (const keyId of ["not-a-uuid", outsider.user.id]) {
      const missing = await as(admin, "POST", `/projects/${projectId}/keys/${keyId}/revoke`);
      expect(missing.statusCode).toBe(404);
    }
  });
});

describe("deleting a project", () => {
  it("removes it for everyone", async () => {
    expect((await as(member, "DELETE", `/projects/${projectId}`)).statusCode).toBe(403);
    expect((await as(admin, "DELETE", `/projects/${projectId}`)).statusCode).toBe(204);
    expect((await as(admin, "GET", `/projects/${projectId}`)).statusCode).toBe(404);
  });
});
