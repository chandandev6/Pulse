import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDsn } from "../src/dsn.js";
import { createFetchTransport } from "../src/transport.js";

const dsn = parseDsn("http://key123@localhost:3000/project-1");
const event = { message: "hello" };

const reply = (status: number) => Promise.resolve(new Response(null, { status }));

afterEach(() => {
  vi.useRealTimers();
});

describe("fetch transport", () => {
  it("posts JSON with the project key to the ingest endpoint", async () => {
    const fetchMock = vi.fn(() => reply(202));
    await createFetchTransport(dsn, fetchMock)(event);

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/api/project-1/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pulse-key": "key123" },
      body: JSON.stringify(event),
      keepalive: true,
    });
  });

  it("retries server errors and network failures with backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => reply(503))
      .mockImplementationOnce(() => Promise.reject(new TypeError("fetch failed")))
      .mockImplementationOnce(() => reply(202));

    const sending = createFetchTransport(dsn, fetchMock)(event);
    await vi.advanceTimersByTimeAsync(1_000); // first wait
    await vi.advanceTimersByTimeAsync(2_000); // second wait, twice as long
    await sending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a rejected event (bad key or payload)", async () => {
    const fetchMock = vi.fn(() => reply(401));
    await expect(createFetchTransport(dsn, fetchMock)(event)).rejects.toThrow("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => reply(500));

    const sending = createFetchTransport(dsn, fetchMock)(event);
    const result = expect(sending).rejects.toThrow("HTTP 500");
    await vi.advanceTimersByTimeAsync(3_000);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("on 429, stops sending until Retry-After has passed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "30" } })),
      )
      .mockImplementation(() => reply(202));
    const send = createFetchTransport(dsn, fetchMock);

    await expect(send(event)).rejects.toThrow("rate limiting");
    // Paused: dropped without a request
    await expect(send(event)).rejects.toThrow("rate limiting");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await send(event);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
