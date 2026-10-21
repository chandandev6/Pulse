import { type EventInput, EventSchema } from "@pulse/shared";
import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  fingerprintParts,
  normalizeFilename,
  normalizeMessage,
} from "../src/events/fingerprint.js";
import { issueCulprit, issueTitle, userKey } from "../src/events/issue-details.js";

// Fill in defaults the same way the API does
const event = (input: EventInput) => EventSchema.parse(input);
const fp = (input: EventInput) => computeFingerprint(event(input));

function crash(
  type: string,
  frames: { filename?: string; function?: string; lineno?: number; in_app?: boolean }[],
) {
  return { exception: { type, value: "boom", stacktrace: { frames } } };
}

describe("normalizeMessage", () => {
  it("removes the parts that change between occurrences", () => {
    expect(normalizeMessage("Order 1234 for 'ada' failed")).toBe("Order <num> for <str> failed");
    expect(normalizeMessage("User 3f2a6c1e-9b1d-4c7e-8f00-123456789abc not found")).toBe(
      "User <uuid> not found",
    );
    expect(normalizeMessage("bad pointer 0x7ffe12 in deadbeefcafe1234")).toBe(
      "bad pointer <hex> in <hex>",
    );
    expect(normalizeMessage('can\'t load "config.json"')).toBe("can't load <str>");
  });
});

describe("normalizeFilename", () => {
  it("drops origins, query strings and build hashes", () => {
    expect(normalizeFilename("https://cdn.shop.com/assets/app.3f9a1c2b.js?v=2")).toBe(
      "/assets/app.js",
    );
    expect(normalizeFilename("webpack://shop/src/cart.ts")).toBe("/src/cart.ts");
    expect(normalizeFilename("/srv/app/src/cart.js")).toBe("/srv/app/src/cart.js");
  });
});

describe("fingerprint", () => {
  const frames = [
    { filename: "src/server.js", function: "handle", lineno: 10 },
    { filename: "src/cart.js", function: "checkout", lineno: 42 },
  ];

  it("is the same for identical errors", () => {
    expect(fp(crash("TypeError", frames))).toBe(fp(crash("TypeError", frames)));
  });

  it("ignores line numbers, so editing code above the bug keeps the same issue", () => {
    const moved = frames.map((f) => ({ ...f, lineno: f.lineno + 7 }));
    expect(fp(crash("TypeError", moved))).toBe(fp(crash("TypeError", frames)));
  });

  it("separates different error types and different functions", () => {
    expect(fp(crash("RangeError", frames))).not.toBe(fp(crash("TypeError", frames)));

    const otherFunction = [frames[0], { ...frames[1], function: "applyCoupon" }];
    expect(fp(crash("TypeError", otherFunction))).not.toBe(fp(crash("TypeError", frames)));
  });

  it("only looks at the app's own frames when there are some", () => {
    const withLib = (fn: string) => [
      { filename: "node_modules/express/router.js", function: fn, in_app: false },
      ...frames,
    ];
    expect(fp(crash("TypeError", withLib("dispatch")))).toBe(
      fp(crash("TypeError", withLib("next"))),
    );
  });

  it("falls back to the normalized message when there is no stack", () => {
    const a = fp({ exception: { type: "Error", value: "Order 1 failed" } });
    const b = fp({ exception: { type: "Error", value: "Order 2 failed" } });
    const c = fp({ exception: { type: "Error", value: "Payment declined" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(fp({ message: "Disk 91% full" })).toBe(fp({ message: "Disk 97% full" }));
  });

  it("lets the app choose its own grouping", () => {
    const custom = { fingerprint: ["payment-timeout"] };
    expect(fp({ ...crash("TypeError", frames), ...custom })).toBe(
      fp({ ...crash("RangeError", []), ...custom }),
    );
    expect(fingerprintParts(event({ message: "x", ...custom }))).toEqual([
      "custom",
      "payment-timeout",
    ]);
  });
});

describe("issue details", () => {
  it("builds a title, a culprit and a user key", () => {
    const e = event({
      ...crash("TypeError", [
        { filename: "src/server.js", function: "handle" },
        { filename: "https://shop.com/cart.abcdef12.js", function: "checkout" },
      ]),
      user: { email: "Ada@Example.com", ip: "1.2.3.4" },
    });

    expect(issueTitle(e)).toBe("TypeError: boom");
    expect(issueCulprit(e)).toBe("checkout (/cart.js)"); // the crash frame is the last one
    expect(userKey(e)).toBe("email:ada@example.com");
  });

  it("uses the route as culprit when there is no stack", () => {
    const e = event({ message: "slow", request: { method: "POST", route: "/orders/:id" } });
    expect(issueCulprit(e)).toBe("POST /orders/:id");
    expect(userKey(e)).toBeNull();
  });
});
