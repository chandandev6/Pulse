import { describe, expect, it } from "vitest";
import { parseDsn } from "../src/dsn.js";
import { parseStack } from "../src/stacktrace.js";

describe("parseStack", () => {
  it("reads Node / V8 stacks, oldest call first", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'total')",
      "    at checkout (/srv/shop/src/cart.js:42:7)",
      "    at async Object.handler [as post] (file:///srv/shop/src/routes.js:10:3)",
      "    at Layer.handle (/srv/shop/node_modules/express/lib/router/layer.js:95:5)",
      "    at /srv/shop/src/server.js:5:1",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
      "    at async Promise.all (index 0)",
    ].join("\n");

    expect(parseStack(stack)).toEqual([
      {
        function: "process.processTicksAndRejections",
        filename: "node:internal/process/task_queues",
        lineno: 105,
        colno: 5,
        in_app: false,
      },
      {
        function: undefined,
        filename: "/srv/shop/src/server.js",
        lineno: 5,
        colno: 1,
        in_app: true,
      },
      {
        function: "Layer.handle",
        filename: "/srv/shop/node_modules/express/lib/router/layer.js",
        lineno: 95,
        colno: 5,
        in_app: false,
      },
      {
        function: "Object.handler",
        filename: "/srv/shop/src/routes.js",
        lineno: 10,
        colno: 3,
        in_app: true,
      },
      {
        function: "checkout",
        filename: "/srv/shop/src/cart.js",
        lineno: 42,
        colno: 7,
        in_app: true,
      },
    ]);
  });

  it("reads Chrome stacks with URLs", () => {
    const frames = parseStack(
      "Error: boom\n    at onClick (https://shop.com/assets/app.3f9a1c2b.js:1:2345)",
    );
    expect(frames).toEqual([
      {
        function: "onClick",
        filename: "https://shop.com/assets/app.3f9a1c2b.js",
        lineno: 1,
        colno: 2345,
        in_app: true,
      },
    ]);
  });

  it("reads Firefox / Safari stacks", () => {
    const stack = [
      "checkout@https://shop.com/cart.js:42:7",
      "@https://shop.com/app.js:10:3",
      "",
    ].join("\n");

    expect(parseStack(stack).map((f) => [f.function, f.filename, f.lineno])).toEqual([
      [undefined, "https://shop.com/app.js", 10],
      ["checkout", "https://shop.com/cart.js", 42],
    ]);
  });

  it("parses a real error from this runtime", () => {
    function failingFunction() {
      return new Error("real");
    }
    const frames = parseStack(failingFunction().stack);
    const last = frames.at(-1);
    expect(last?.function).toBe("failingFunction");
    expect(last?.filename).toContain("stacktrace.test.ts");
    expect(last?.in_app).toBe(true);
  });

  it("returns no frames for a missing stack", () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("parseDsn", () => {
  it("splits a DSN into endpoint and key", () => {
    expect(parseDsn("https://abc123@pulse.example.com/0e5c-project")).toEqual({
      endpoint: "https://pulse.example.com/api/0e5c-project/events",
      publicKey: "abc123",
      projectId: "0e5c-project",
    });
  });

  it("rejects broken DSNs with a clear message", () => {
    expect(() => parseDsn("not a url")).toThrow(/invalid DSN/);
    expect(() => parseDsn("https://pulse.example.com/123")).toThrow(/must look like/);
  });
});
