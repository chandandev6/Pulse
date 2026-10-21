import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Timeseries } from "../api/types";
import { FrequencyChart, niceMax } from "./FrequencyChart";

const hours = (counts: number[]): Timeseries => ({
  interval: "hour",
  buckets: counts.map((count, i) => ({
    start: new Date(Date.UTC(2026, 9, 22, i)).toISOString(),
    count,
  })),
});

describe("niceMax", () => {
  it("rounds the axis top up so its half is a round number too", () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(1)).toBe(2);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(37)).toBe(40);
    expect(niceMax(1234)).toBe(2000);
  });
});

describe("FrequencyChart", () => {
  it("draws a bar for each hour with events, sized against the axis", () => {
    render(<FrequencyChart series={hours([0, 2, 4, 1])} label="Events" />);

    const bars = screen.getAllByTestId("chart-bar");
    expect(bars).toHaveLength(3); // the empty hour has no bar
    expect(bars.map((bar) => bar.style.height)).toEqual(["50%", "100%", "25%"]);
  });

  it("has a table with every value for screen readers", () => {
    render(<FrequencyChart series={hours([0, 2, 4, 1])} label="Events" />);

    const table = screen.getByRole("table", { name: "Events" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(5); // header + 4 hours
    expect(rows[2]).toHaveTextContent("2");
  });

  it("reads out bars with the arrow keys", async () => {
    render(<FrequencyChart series={hours([0, 2, 4, 1])} label="Events" />);

    const chart = screen.getByRole("slider", { name: "Events" });
    chart.focus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("status")).toHaveTextContent("1 event");
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("status")).toHaveTextContent("4 events");
    expect(chart).toHaveAttribute("aria-valuetext", expect.stringContaining("4 events"));
  });

  it("says so when there are no events", () => {
    render(<FrequencyChart series={hours([0, 0, 0])} label="Events" />);
    expect(screen.getByText("No events in this period")).toBeInTheDocument();
    expect(screen.queryAllByTestId("chart-bar")).toHaveLength(0);
  });
});
