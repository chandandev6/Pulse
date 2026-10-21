import { EventSchema } from "@pulse/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PulseClient } from "../src/client.js";
import type { PulseEvent, PulseOptions } from "../src/types.js";

const DSN = "http://abc@localhost:3000/project-1";

// A client whose transport just collects events in an array
function testClient(options: Partial<PulseOptions> = {}) {
  const sent: PulseEvent[] = [];
  const client = new PulseClient({
    dsn: DSN,
    transport: async (event) => {
      sent.push(event);
    },
    ...options,
  });
  return { client, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captured events", () => {
  it("match the API's event schema exactly", async () => {
    const { client, sent } = testClient({ environment: "staging", release: "1.4.2" });
    client.setUser({ id: "42", email: "ada@example.com" });
    client.setTag("region", "eu");
    client.setContext("cart", { items: 3 });

    const id = client.captureException(new TypeError("x is undefined"), {
      tags: { feature: "checkout" },
      request: { method: "POST", url: "/orders", route: "/orders" },
    });
    await client.flush();

    expect(sent).toHaveLength(1);
    const event = sent[0];
    // The same check the API runs: if this passes, Pulse will accept the event
    expect(EventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      event_id: id,
      level: "error",
      environment: "staging",
      release: "1.4.2",
      user: { id: "42", email: "ada@example.com" },
      tags: { region: "eu", feature: "checkout" },
      context: { cart: { items: 3 } },
      request: { route: "/orders" },
      sdk: { name: "@pulse/sdk", version: "0.1.0" },
      exception: { type: "TypeError", value: "x is undefined" },
    });
    expect(event?.event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(event?.exception?.stacktrace?.frames.length).toBeGreaterThan(0);
  });

  it("handles things that aren't Errors", async () => {
    const { client, sent } = testClient();
    client.captureException("just a string");
    client.captureException({ code: 7 });
    await client.flush();

    expect(sent.map((e) => e.exception)).toEqual([
      { type: "Error", value: "just a string" },
      { type: "Error", value: '{"code":7}' },
    ]);
  });

  it("captures messages with a level", async () => {
    const { client, sent } = testClient();
    client.captureMessage("Disk almost full", "warning");
    await client.flush();

    expect(sent[0]).toMatchObject({ message: "Disk almost full", level: "warning" });
    expect(EventSchema.safeParse(sent[0]).success).toBe(true);
  });
});

describe("beforeSend", () => {
  it("can edit events", async () => {
    const { client, sent } = testClient({
      beforeSend: (event) => ({ ...event, user: undefined }), // strip personal data
    });
    client.setUser({ email: "private@example.com" });
    client.captureException(new Error("x"));
    await client.flush();

    expect(sent[0]?.user).toBeUndefined();
  });

  it("can drop events, and sees the original error", async () => {
    const { client, sent } = testClient({
      beforeSend: (event, { originalError }) =>
        originalError instanceof RangeError ? null : event,
    });

    expect(client.captureException(new RangeError("ignore me"))).toBeUndefined();
    client.captureException(new Error("keep me"));
    await client.flush();

    expect(sent.map((e) => e.exception?.value)).toEqual(["keep me"]);
  });
});

describe("sampling and switches", () => {
  it("sends only the sampled share of events", async () => {
    const random = vi.spyOn(Math, "random");
    const { client, sent } = testClient({ sampleRate: 0.25 });

    random.mockReturnValue(0.1); // below 0.25: kept
    client.captureMessage("kept");
    random.mockReturnValue(0.9); // above: dropped
    client.captureMessage("dropped");
    await client.flush();

    expect(sent.map((e) => e.message)).toEqual(["kept"]);
  });

  it("sends nothing when disabled", async () => {
    const { client, sent } = testClient({ enabled: false });
    client.captureException(new Error("x"));
    await client.flush();
    expect(sent).toHaveLength(0);
  });

  it("never throws into the app when sending fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new PulseClient({
      dsn: DSN,
      transport: () => Promise.reject(new Error("Pulse is down")),
    });

    expect(() => client.captureException(new Error("x"))).not.toThrow();
    await client.flush();
    expect(error).toHaveBeenCalledWith("Pulse: could not send event", "Pulse is down");
  });
});
