import { describe, expect, it } from "vitest";
import { formatPercent, impactOf } from "./impact";

describe("impactOf", () => {
  it("is unknown without a total", () => {
    expect(impactOf(5, 0)).toEqual({ percent: null, high: false });
    expect(impactOf(5, undefined)).toEqual({ percent: null, high: false });
  });

  it("flags issues that reach 10% of users (and at least 3 people)", () => {
    expect(impactOf(10, 100)).toEqual({ percent: 10, high: true });
    expect(impactOf(9, 100).high).toBe(false);
    expect(impactOf(2, 4).high).toBe(false); // 50%, but only 2 people
  });

  it("formats percentages", () => {
    expect(formatPercent(0.4)).toBe("<1%");
    expect(formatPercent(12.6)).toBe("13%");
    expect(formatPercent(0)).toBe("0%");
  });
});
