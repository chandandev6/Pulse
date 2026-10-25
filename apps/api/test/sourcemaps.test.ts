import { EventSchema } from "@pulse/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";
import { createDiscordNotifier, discordBody, slackBody } from "../src/notifications/chat.js";
import type { NotificationMessage } from "../src/notifications/message.js";
import { PermanentError } from "../src/notifications/notifier.js";
import {
  cleanSource,
  clearSourceMapCache,
  minifiedName,
  symbolicate,
} from "../src/sourcemaps/symbolicate.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();
const PREFIX = "smtest-";
const run = Date.now();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let projectId: string;

function as(method: "GET" | "POST" | "DELETE", url: string, body?: object) {
  return app.inject({ method, url, cookies: owner.cookies, payload: body });
}

// Source map "mappings" are base64 VLQ numbers. A tiny encoder, so the test can build a map.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(value: number) {
  let n = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = n & 31;
    n >>>= 5;
    if (n > 0) digit |= 32;
    out += B64[digit];
  } while (n > 0);
  return out;
}

// index-abc.js line 1: column 0 → src/cart.ts 1:1, column 10 → src/cart.ts 42:7 in "checkout"
// (each segment is relative to the one before it)
const MAP = JSON.stringify({
  version: 3,
  file: "index-abc.js",
  sources: ["../../src/cart.ts"],
  names: ["checkout"],
  mappings: `${[0, 0, 0, 0].map(vlq).join("")},${[10, 0, 41, 6, 0].map(vlq).join("")}`,
});

function upload(token: string, query: string, body = MAP) {
  return app.inject({
    method: "PUT",
    url: `/api/${projectId}/sourcemaps?${query}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    payload: body,
  });
}

const minifiedEvent = (release: string) =>
  EventSchema.parse({
    release,
    exception: {
      type: "TypeError",
      value: "cart is undefined",
      stacktrace: {
        frames: [
          {
            filename: "https://shop.com/assets/index-abc.js?v=1",
            function: "a",
            lineno: 1,
            colno: 11,
          },
          { filename: "https://shop.com/assets/vendor.js", function: "b", lineno: 3, colno: 4 },
        ],
      },
    },
  });

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(`${PREFIX}owner-${run}@example.com`, "Owner");
  const [project] = await db
    .insert(projects)
    .values({ orgId: owner.org.id, name: "Web", slug: `web-${run}`, platform: "javascript" })
    .returning();
  if (!project) throw new Error("no project");
  projectId = project.id;
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("source maps", () => {
  it("helpers: file names and source paths", () => {
    expect(minifiedName("https://a.com/assets/index-abc.js?v=2#x")).toBe("index-abc.js");
    expect(cleanSource("../../src/App.tsx")).toBe("src/App.tsx");
    expect(cleanSource("webpack://shop/./src/App.tsx")).toBe("src/App.tsx");
  });

  it("uploads need a valid token and a valid map", async () => {
    const created = await as("POST", `/projects/${projectId}/upload-tokens`, { name: "CI" });
    expect(created.statusCode).toBe(201);
    const { secret } = created.json();
    expect(secret).toMatch(/^pulse_ut_/);
    expect(
      JSON.stringify((await as("GET", `/projects/${projectId}/upload-tokens`)).json()),
    ).not.toContain(secret);

    expect((await upload("pulse_ut_wrong", "release=1.0.0&name=index-abc.js.map")).statusCode).toBe(
      401,
    );
    expect((await upload(secret, "release=1.0.0&name=x.js.map", "not json")).statusCode).toBe(400);
    expect(
      (await upload(secret, "release=1.0.0&name=x.js.map", JSON.stringify({ version: 2 })))
        .statusCode,
    ).toBe(400);

    const ok = await upload(secret, "release=1.0.0&name=assets/index-abc.js.map");
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ release: "1.0.0", name: "index-abc.js" });

    const listed = await as("GET", `/projects/${projectId}/sourcemaps`);
    expect(listed.json().releases).toEqual([
      expect.objectContaining({ release: "1.0.0", files: 1 }),
    ]);

    // A revoked token stops working
    await as("DELETE", `/projects/${projectId}/upload-tokens/${created.json().token.id}`);
    expect((await upload(secret, "release=1.0.0&name=index-abc.js.map")).statusCode).toBe(401);
  });

  it("turns minified frames into the real file, line and function", async () => {
    clearSourceMapCache();
    const job = { projectId, receivedAt: new Date().toISOString(), event: minifiedEvent("1.0.0") };
    const { event } = await symbolicate(job);
    const [mapped, untouched] = event.exception?.stacktrace?.frames ?? [];

    expect(mapped).toMatchObject({
      filename: "src/cart.ts",
      function: "checkout",
      lineno: 42,
      colno: 7,
      in_app: true,
      minified: { filename: "https://shop.com/assets/index-abc.js?v=1", lineno: 1, colno: 11 },
    });
    expect(untouched).toMatchObject({ filename: "https://shop.com/assets/vendor.js" }); // no map
  });

  it("leaves events of other releases alone", async () => {
    const job = { projectId, receivedAt: new Date().toISOString(), event: minifiedEvent("9.9.9") };
    expect(await symbolicate(job)).toBe(job);
  });
});

describe("Slack and Discord", () => {
  const message = {
    deliveryId: "d1",
    subject: "[CRITICAL] <!channel> TypeError: cart is undefined @everyone",
    text: "t",
    html: "h",
    short: "214 events, 38 users affected",
    url: "https://pulse.example.com/projects/p/issues/i",
    payload: {
      type: "incident.triggered",
      deliveryId: "d1",
      sentAt: "2026-10-25T03:12:10.000Z",
      incident: {
        id: "i",
        title: "x",
        severity: "critical",
        status: "triggered",
        triggeredAt: "2026-10-25T03:12:10.000Z",
      },
      project: { id: "p", name: "Shop" },
      links: { issue: "https://pulse.example.com/i", acknowledge: "https://pulse.example.com/ack" },
    },
  } satisfies NotificationMessage;

  it("Slack: text from apps can't ping @channel or fake links", () => {
    const body = JSON.stringify(slackBody(message));
    expect(body).not.toContain("<!channel>");
    expect(body).toContain("&lt;!channel&gt;");
    expect(body).toContain("https://pulse.example.com/ack"); // the Acknowledge button
  });

  it("Discord: never pings anyone, and a deleted webhook turns the channel off", async () => {
    expect(discordBody(message).allowed_mentions).toEqual({ parse: [] });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    try {
      const err = await createDiscordNotifier()
        .send({ url: "https://discord.com/api/webhooks/1/abc" }, message)
        .catch((e) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.disableChannel).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("only real Slack/Discord URLs are accepted, and they are never shown back", async () => {
    const url = `/orgs/${owner.org.id}/notification-channels`;
    const slackUrl = "https://hooks.slack.com/services/T000/B000/secretpart";
    const created = await as("POST", url, { type: "slack", config: { url: slackUrl } });
    expect(created.statusCode).toBe(201);
    expect(created.json().channel).toMatchObject({ name: "Slack", target: "hooks.slack.com" });
    expect(JSON.stringify((await as("GET", url)).json())).not.toContain("secretpart");

    const fake = await as("POST", url, {
      type: "slack",
      config: { url: "https://evil.com/services/x" },
    });
    expect(fake.statusCode).toBe(400);
    const wrongService = await as("POST", url, { type: "discord", config: { url: slackUrl } });
    expect(wrongService.statusCode).toBe(400);
  });
});
