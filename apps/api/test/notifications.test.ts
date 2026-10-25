import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { EventSchema } from "@pulse/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { alertRules, notificationChannels, notificationLog, projects } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import type { ChannelType } from "../src/notifications/channels.js";
import {
  deliver,
  loadIncidentDetails,
  planIncidentNotifications,
} from "../src/notifications/dispatch.js";
import { createEmailNotifier } from "../src/notifications/email.js";
import { createAckToken, verifyAckToken } from "../src/notifications/links.js";
import { incidentMessage, type NotificationMessage } from "../src/notifications/message.js";
import {
  type Notifier,
  type NotifierRegistry,
  PermanentError,
} from "../src/notifications/notifier.js";
import { createPushNotifier } from "../src/notifications/push.js";
import { createSmsNotifier } from "../src/notifications/sms.js";
import { isPublicAddress, looksPrivate } from "../src/notifications/ssrf.js";
import { createWebhookNotifier, verifyWebhookSignature } from "../src/notifications/webhook.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "notiftest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

function as(
  user: TestUser,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: object,
) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

// A project in the owner's org with one rule, and one event that fires it
async function newIncident(severity: "low" | "medium" | "high" | "critical" = "high") {
  const [project] = await db
    .insert(projects)
    .values({ orgId: owner.org.id, name: "Shop", slug: crypto.randomUUID(), platform: "node" })
    .returning();
  if (!project) throw new Error("project not created");
  await db.insert(alertRules).values({
    projectId: project.id,
    name: "Every new issue",
    conditions: [{ type: "new_issue" }],
    severity,
  });
  const saved = await saveEvent({
    projectId: project.id,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse({
      exception: { type: "TypeError", value: `<b>boom</b> ${crypto.randomUUID()}` },
      release: "2.0.0",
    }),
  });
  const incidentId = saved?.incidentIds[0];
  if (!incidentId) throw new Error("incident not opened");
  return incidentId;
}

// Notifiers that remember what they were asked to send, instead of sending it
function fakeNotifiers(overrides: Partial<NotifierRegistry> = {}) {
  const sent: { type: ChannelType; recipient: unknown; message: NotificationMessage }[] = [];
  const fake = <T extends ChannelType>(type: T): Notifier<T> => ({
    isConfigured: () => true,
    send: async (recipient, message) => {
      sent.push({ type, recipient, message });
    },
  });
  const notifiers: NotifierRegistry = {
    email: fake("email"),
    sms: fake("sms"),
    push: fake("push"),
    webhook: fake("webhook"),
    ...overrides,
  };
  return { notifiers, sent };
}

const logOf = (deliveryId: string) =>
  db
    .select()
    .from(notificationLog)
    .where(eq(notificationLog.id, deliveryId))
    .then((rows) => rows[0]);

async function addOrgWebhook(url = "https://hooks.example.com/pulse") {
  const [channel] = await db
    .insert(notificationChannels)
    .values({
      orgId: owner.org.id,
      type: "webhook",
      name: "Ops webhook",
      config: { url, secret: "whsec_test" },
    })
    .returning();
  if (!channel) throw new Error("channel not created");
  return channel;
}

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  member = await createTestUser(email("member"), "Member");
  outsider = await createTestUser(email("outsider"), "Outsider");
  await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: member.user.email });
});

afterAll(async () => {
  // Test deliveries of personal channels aren't tied to an org, so remove them first
  const testChannels = db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(inArray(notificationChannels.userId, [owner.user.id, member.user.id, outsider.user.id]));
  await db.delete(notificationLog).where(inArray(notificationLog.channelId, testChannels));
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("message templates", () => {
  it("has everything a responder needs, in every format", async () => {
    const incidentId = await newIncident("critical");
    const details = await loadIncidentDetails(incidentId);
    if (!details) throw new Error("no details");
    const message = incidentMessage(details, "delivery-1", owner.user.id);

    expect(message.subject).toMatch(/^\[CRITICAL\] Shop: TypeError/);
    for (const part of [
      "Project: Shop",
      "Severity: critical",
      "Events: 1",
      "Users affected: 0",
      "Release: 2.0.0",
      "Alert rule: Every new issue",
      `${config.WEB_PUBLIC_URL}/projects/${details.project.id}/issues/${details.issue.id}`,
      `${config.WEB_PUBLIC_URL}/incidents/${incidentId}/acknowledge?token=`,
    ]) {
      expect(message.text).toContain(part);
    }
    expect(message.payload).toMatchObject({
      type: "incident.triggered",
      deliveryId: "delivery-1",
      incident: { id: incidentId, severity: "critical", status: "triggered" },
      issue: { eventCount: 1, userCount: 0, release: "2.0.0" },
      project: { name: "Shop" },
      rule: { name: "Every new issue" },
    });
    expect(message.short.length).toBeLessThanOrEqual(300);
  });

  it("escapes HTML coming from the app, so an error message can't inject markup", async () => {
    const details = await loadIncidentDetails(await newIncident());
    if (!details) throw new Error("no details");
    const { html } = incidentMessage(details, "d", null);
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(html).not.toContain("<b>boom</b>");
  });

  it("acknowledge tokens only work for their incident, unchanged and in time", () => {
    const incidentId = crypto.randomUUID();
    const token = createAckToken(incidentId, owner.user.id);

    expect(verifyAckToken(incidentId, token)).toEqual({ userId: owner.user.id });
    expect(verifyAckToken(crypto.randomUUID(), token)).toBeNull(); // another incident
    expect(verifyAckToken(incidentId, token.replace(owner.user.id, member.user.id))).toBeNull();
    expect(verifyAckToken(incidentId, `${token}x`)).toBeNull();
    expect(verifyAckToken(incidentId, token, Date.now() + 8 * 24 * 3600_000)).toBeNull(); // expired
    expect(verifyAckToken(incidentId, createAckToken(incidentId, null))).toEqual({ userId: null });
  });
});

describe("webhook channel", () => {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status).end();
    });
  });
  let url = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const message = {
    deliveryId: "delivery-42",
    subject: "s",
    text: "t",
    html: "h",
    short: "x",
    url: "http://x",
    payload: { type: "test", deliveryId: "delivery-42", sentAt: new Date().toISOString() },
  } satisfies NotificationMessage;

  it("POSTs JSON with a signature the receiver can check with the secret", async () => {
    status = 200;
    await createWebhookNotifier({ allowPrivate: true }).send({ url, secret: "whsec_abc" }, message);

    const request = received.at(-1);
    if (!request) throw new Error("nothing received");
    expect(JSON.parse(request.body)).toMatchObject({ type: "test", deliveryId: "delivery-42" });
    expect(request.headers["x-pulse-delivery"]).toBe("delivery-42");

    const headers = {
      timestamp: request.headers["x-pulse-timestamp"] as string,
      signature: request.headers["x-pulse-signature"] as string,
    };
    expect(verifyWebhookSignature("whsec_abc", headers, request.body)).toBe(true);
    expect(verifyWebhookSignature("whsec_wrong", headers, request.body)).toBe(false);
    expect(verifyWebhookSignature("whsec_abc", headers, `${request.body} `)).toBe(false);
    // replayed 10 minutes later
    expect(verifyWebhookSignature("whsec_abc", headers, request.body, Date.now() + 600_000)).toBe(
      false,
    );
  });

  it("server errors are retried, client errors are not", async () => {
    const webhook = createWebhookNotifier({ allowPrivate: true });
    status = 503;
    const retryable = await webhook.send({ url, secret: "s" }, message).catch((e) => e);
    expect(retryable).toBeInstanceOf(Error);
    expect(retryable).not.toBeInstanceOf(PermanentError);

    status = 404;
    await expect(webhook.send({ url, secret: "s" }, message)).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
});

describe("SSRF protection", () => {
  it("knows which addresses are private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.17.0.2",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "20.197.30.74", "2606:4700::1111", "::ffff:1.1.1.1"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("spots obviously private URLs when they are saved", () => {
    expect(looksPrivate("http://localhost:6379")).toBe(true);
    expect(looksPrivate("http://redis.internal/x")).toBe(true);
    expect(looksPrivate("http://169.254.169.254/metadata")).toBe(true);
    expect(looksPrivate("http://[::1]:3000/")).toBe(true);
    expect(looksPrivate("https://hooks.example.com/x")).toBe(false);
    expect(looksPrivate("https://8.8.8.8/x")).toBe(false);
  });

  it("refuses to send to a private address, even when a hostname resolves to one", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const message = {
      deliveryId: "d",
      subject: "s",
      text: "t",
      html: "h",
      short: "x",
      url: "http://x",
      payload: { type: "test", deliveryId: "d", sentAt: "" },
    } satisfies NotificationMessage;

    try {
      const webhook = createWebhookNotifier({ allowPrivate: false });
      for (const url of [`http://127.0.0.1:${port}/hook`, `http://localhost:${port}/hook`]) {
        await expect(webhook.send({ url, secret: "s" }, message)).rejects.toBeInstanceOf(
          PermanentError,
        );
      }
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("other channels", () => {
  const message = {
    deliveryId: "d",
    subject: "Subject",
    text: "Text",
    html: "<p>Html</p>",
    short: "Short",
    url: "http://x",
    payload: { type: "test", deliveryId: "d", sentAt: "" },
  } satisfies NotificationMessage;

  it("email: hands the message to SMTP", async () => {
    const sendMail = vi.fn(async () => ({}));
    await createEmailNotifier({ sendMail } as never).send({ address: "ada@example.com" }, message);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com", subject: "Subject", html: "<p>Html</p>" }),
    );
  });

  it("SMS and push are off until configured", () => {
    const off = { ...config, TWILIO_ACCOUNT_SID: undefined, VAPID_PUBLIC_KEY: undefined };
    expect(createSmsNotifier(off).isConfigured()).toBe(false);
    expect(createPushNotifier(off).isConfigured()).toBe(false);
  });

  it("SMS: sends the short text through Twilio", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sms = createSmsNotifier({
        ...config,
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "token",
        TWILIO_FROM: "+15550001111",
      });
      await sms.send({ phone: "+919876543210" }, message);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
      expect(String(init.body)).toBe("To=%2B919876543210&From=%2B15550001111&Body=Short");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("choosing channels", () => {
  it("notifies team channels and members' own channels that want this severity", async () => {
    // The member only wants critical incidents by email
    await db
      .update(notificationChannels)
      .set({ minSeverity: "critical" })
      .where(eq(notificationChannels.userId, member.user.id));
    const webhook = await addOrgWebhook();
    const [disabled] = await db
      .insert(notificationChannels)
      .values({
        userId: owner.user.id,
        type: "sms",
        name: "Off",
        config: { phone: "+919876543210" },
        enabled: false,
      })
      .returning();

    const incidentId = await newIncident("high");
    const deliveryIds = await planIncidentNotifications(incidentId);
    const rows = await db
      .select()
      .from(notificationLog)
      .where(inArray(notificationLog.id, deliveryIds));

    expect(rows.map((row) => row.recipient).sort()).toEqual(
      [owner.user.email, "hooks.example.com"].sort(),
    );
    expect(rows.every((row) => row.status === "pending" && row.orgId === owner.org.id)).toBe(true);
    expect(rows.some((row) => row.channelId === disabled?.id)).toBe(false);

    // A retried job doesn't create a second row per channel
    expect((await planIncidentNotifications(incidentId)).sort()).toEqual(deliveryIds.sort());

    // A critical incident reaches the member too
    const critical = await planIncidentNotifications(await newIncident("critical"));
    expect(critical).toHaveLength(3);

    await db
      .delete(notificationChannels)
      .where(inArray(notificationChannels.id, [webhook.id, disabled?.id ?? webhook.id]));
    await db
      .update(notificationChannels)
      .set({ minSeverity: "low" })
      .where(eq(notificationChannels.userId, member.user.id));
  });
});

describe("delivering", () => {
  async function oneDelivery() {
    const webhook = await addOrgWebhook();
    const incidentId = await newIncident();
    await planIncidentNotifications(incidentId);
    const [row] = await db
      .select()
      .from(notificationLog)
      .where(
        and(eq(notificationLog.incidentId, incidentId), eq(notificationLog.channelId, webhook.id)),
      );
    if (!row) throw new Error("no delivery");
    return { deliveryId: row.id, webhook };
  }

  it("records a failed try, then succeeds on the retry", async () => {
    const { deliveryId, webhook } = await oneDelivery();
    let calls = 0;
    const { notifiers, sent } = fakeNotifiers({
      webhook: {
        isConfigured: () => true,
        send: async () => {
          calls += 1;
          if (calls === 1) throw new Error("connect ECONNREFUSED");
        },
      },
    });

    await expect(deliver(deliveryId, { notifiers, isLastAttempt: false })).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(await logOf(deliveryId)).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "connect ECONNREFUSED",
    });

    expect(await deliver(deliveryId, { notifiers, isLastAttempt: false })).toBe("sent");
    expect(await logOf(deliveryId)).toMatchObject({ status: "sent", attempts: 2 });
    expect((await logOf(deliveryId))?.sentAt).toBeInstanceOf(Date);

    // A duplicate job finds it already sent and does nothing
    expect(await deliver(deliveryId, { notifiers, isLastAttempt: false })).toBe("sent");
    expect(calls).toBe(2);
    expect(sent).toHaveLength(0);
    await db.delete(notificationChannels).where(eq(notificationChannels.id, webhook.id));
  });

  it("gives up after the last attempt", async () => {
    const { deliveryId, webhook } = await oneDelivery();
    const { notifiers } = fakeNotifiers({
      webhook: {
        isConfigured: () => true,
        send: async () => {
          throw new Error("503");
        },
      },
    });
    expect(await deliver(deliveryId, { notifiers, isLastAttempt: true })).toBe("failed");
    expect(await logOf(deliveryId)).toMatchObject({ status: "failed", error: "503" });
    await db.delete(notificationChannels).where(eq(notificationChannels.id, webhook.id));
  });

  it("doesn't retry permanent errors, and turns off dead channels", async () => {
    const { deliveryId, webhook } = await oneDelivery();
    const { notifiers } = fakeNotifiers({
      webhook: {
        isConfigured: () => true,
        send: async () => {
          throw new PermanentError("gone", { disableChannel: true });
        },
      },
    });
    expect(await deliver(deliveryId, { notifiers, isLastAttempt: false })).toBe("failed");
    const [channel] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, webhook.id));
    expect(channel?.enabled).toBe(false);
    await db.delete(notificationChannels).where(eq(notificationChannels.id, webhook.id));
  });

  it("skips channels the server can't send to", async () => {
    const { deliveryId, webhook } = await oneDelivery();
    const { notifiers } = fakeNotifiers({
      webhook: { isConfigured: () => false, send: async () => {} },
    });
    expect(await deliver(deliveryId, { notifiers, isLastAttempt: false })).toBe("skipped");
    await db.delete(notificationChannels).where(eq(notificationChannels.id, webhook.id));
  });

  it("sends each person their own acknowledge link", async () => {
    const incidentId = await newIncident();
    const deliveryIds = await planIncidentNotifications(incidentId);
    const { notifiers, sent } = fakeNotifiers();
    for (const id of deliveryIds) await deliver(id, { notifiers, isLastAttempt: false });

    const toOwner = sent.find(
      (s) => (s.recipient as { address?: string }).address === owner.user.email,
    );
    const link = toOwner?.message.payload.links?.acknowledge;
    const token = new URL(link ?? "http://x").searchParams.get("token") ?? "";
    expect(verifyAckToken(incidentId, token)).toEqual({ userId: owner.user.id });
  });
});

describe("routes", () => {
  it("signup gives you your account email as a contact method", async () => {
    const res = await as(owner, "GET", "/me/notification-channels");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.channels).toEqual([
      expect.objectContaining({ type: "email", target: owner.user.email, minSeverity: "low" }),
    ]);
    expect(body.available.email).toBe(true);
  });

  it("add, change and remove your own channels; others' channels look missing", async () => {
    const bad = await as(owner, "POST", "/me/notification-channels", {
      type: "sms",
      config: { phone: "98765" },
    });
    expect(bad.statusCode).toBe(400);

    const created = await as(owner, "POST", "/me/notification-channels", {
      type: "sms",
      config: { phone: "+919876543210" },
      minSeverity: "critical",
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json().channel;
    expect(channel).toMatchObject({ type: "sms", name: "+919876543210", target: "+91•••••210" });

    const changed = await as(owner, "PATCH", `/me/notification-channels/${channel.id}`, {
      minSeverity: "high",
      enabled: false,
    });
    expect(changed.json().channel).toMatchObject({ minSeverity: "high", enabled: false });

    expect(
      (await as(member, "PATCH", `/me/notification-channels/${channel.id}`, { enabled: true }))
        .statusCode,
    ).toBe(404);
    expect((await as(member, "DELETE", `/me/notification-channels/${channel.id}`)).statusCode).toBe(
      404,
    );
    expect((await as(owner, "DELETE", `/me/notification-channels/${channel.id}`)).statusCode).toBe(
      204,
    );
  });

  it("the same browser subscribing twice keeps one push channel", async () => {
    const subscription = {
      type: "push",
      config: { endpoint: `https://push.example.com/${run}`, keys: { p256dh: "a", auth: "b" } },
    };
    const first = await as(member, "POST", "/me/notification-channels", subscription);
    const second = await as(member, "POST", "/me/notification-channels", subscription);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().channel.id).toBe(first.json().channel.id);
    expect(JSON.stringify(second.json())).not.toContain('"p256dh"'); // keys never go back out

    for (const endpoint of ["http://push.example.com/x", "https://127.0.0.1/x"]) {
      const bad = { ...subscription, config: { ...subscription.config, endpoint } };
      const res = await as(member, "POST", "/me/notification-channels", bad);
      expect(res.statusCode, endpoint).toBe(400);
    }
  });

  it("only admins add team webhooks, and the secret is shown once", async () => {
    const url = `/orgs/${owner.org.id}/notification-channels`;
    const body = { type: "webhook", config: { url: "https://hooks.example.com/x" } };

    expect((await as(member, "POST", url, body)).statusCode).toBe(403);
    expect((await as(outsider, "GET", url)).statusCode).toBe(404);

    const created = await as(owner, "POST", url, body);
    expect(created.statusCode).toBe(201);
    expect(created.json().secret).toMatch(/^whsec_/);
    expect(created.json().channel).toMatchObject({ name: "hooks.example.com" });

    const listed = await as(member, "GET", url);
    expect(listed.json().channels).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toContain(created.json().secret);

    const notHttp = await as(owner, "POST", url, {
      type: "webhook",
      config: { url: "ftp://example.com" },
    });
    expect(notHttp.statusCode).toBe(400);

    for (const internal of ["http://localhost:6379", "http://169.254.169.254/metadata"]) {
      const res = await as(owner, "POST", url, { type: "webhook", config: { url: internal } });
      expect(res.statusCode, internal).toBe(400);
    }

    await as(owner, "DELETE", `${url}/${created.json().channel.id}`);
  });

  it("'Send test' queues a delivery that shows up in the log", async () => {
    const created = await as(owner, "POST", `/orgs/${owner.org.id}/notification-channels`, {
      type: "email",
      name: "On-call inbox",
      config: { address: "oncall@example.com" },
    });
    const channelId = created.json().channel.id;

    const test = await as(
      owner,
      "POST",
      `/orgs/${owner.org.id}/notification-channels/${channelId}/test`,
    );
    expect(test.statusCode).toBe(202);
    expect(test.json().delivery).toMatchObject({
      trigger: "test",
      status: "pending",
      recipient: "oncall@example.com",
    });

    const log = await as(member, "GET", `/orgs/${owner.org.id}/notifications`);
    expect(log.json().deliveries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: test.json().delivery.id })]),
    );
    await as(owner, "DELETE", `/orgs/${owner.org.id}/notification-channels/${channelId}`);
  });
});
