import { describe, expect, it } from "vitest";
import { count, timeAgo } from "./format";

describe("format", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");

  it("describes times relative to now", () => {
    expect(timeAgo("2026-10-22T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-10-22T11:57:00Z", now)).toBe("3 minutes ago");
    expect(timeAgo("2026-10-21T12:00:00Z", now)).toBe("yesterday");
  });

  it("shortens big numbers", () => {
    expect(count(999)).toBe("999");
    expect(count(1234)).toBe("1.2K");
  });
});
