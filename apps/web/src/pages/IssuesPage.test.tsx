import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App, createQueryClient } from "../App";
import type { Issue } from "../api/types";
import { routes } from "../routes";
import { fakeApi } from "../test/fakeApi";

const user = { id: "u1", email: "ada@example.com", name: "Ada", createdAt: "2026-10-01T00:00:00Z" };
const org = { id: "o1", name: "Ada's org", slug: "ada", role: "owner" };
const project = {
  id: "p1",
  orgId: "o1",
  name: "Shop",
  slug: "shop",
  platform: "node",
  createdAt: "2026-10-01T00:00:00Z",
};
const issue: Issue = {
  id: "i1",
  projectId: "p1",
  title: "TypeError: cart is undefined",
  type: "TypeError",
  culprit: "checkout (src/cart.js)",
  status: "unresolved",
  severity: "critical",
  isRegression: false,
  assigneeId: null,
  firstRelease: null,
  lastRelease: null,
  firstSeen: "2026-10-20T00:00:00Z",
  lastSeen: new Date().toISOString(),
  eventCount: 42,
  userCount: 7,
  resolvedAt: null,
};

// Records the query string of every issues request, and answers with `issues`
function setup(path: string, issues: Issue[] = [issue]) {
  const requests: URLSearchParams[] = [];
  fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({ body: { organizations: [org] } }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({ body: { project, keys: [] } }),
    "GET /projects/p1/issues": (_body, url) => {
      requests.push(url.searchParams);
      return { body: { issues, nextCursor: null } };
    },
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  const urlParams = () => new URLSearchParams(router.state.location.search);
  return { requests, last: () => requests.at(-1), urlParams };
}

describe("issue filters", () => {
  it("opens a shared link with its filters applied", async () => {
    const { last } = setup(
      "/projects/p1/issues?q=cart&severity=high,critical&period=7d&environment=production",
    );

    expect(await screen.findByRole("link", { name: issue.title })).toBeInTheDocument();
    expect(last()?.get("q")).toBe("cart");
    expect(last()?.get("severity")).toBe("high,critical");
    expect(last()?.get("environment")).toBe("production");
    expect(last()?.get("status")).toBe("unresolved");
    // "7d" becomes a real date when the request is sent
    const since = new Date(last()?.get("since") ?? "").getTime();
    expect(Date.now() - since).toBeGreaterThan(6.9 * 86_400_000);
    expect(Date.now() - since).toBeLessThan(7.1 * 86_400_000);

    // ...and the controls show them
    expect(screen.getByRole("searchbox", { name: "Search issues" })).toHaveValue("cart");
    expect(screen.getByRole("button", { name: "critical" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "low" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("combobox", { name: "Time range" })).toHaveValue("7d");
  });

  it("ignores filter values it doesn't know instead of breaking", async () => {
    const { last } = setup("/projects/p1/issues?severity=urgent,high&period=forever");

    await screen.findByRole("link", { name: issue.title });
    expect(last()?.get("severity")).toBe("high");
    expect(last()?.has("since")).toBe(false);
  });

  it("puts the search in the URL once you stop typing", async () => {
    const { last, urlParams } = setup("/projects/p1/issues");
    await screen.findByRole("link", { name: issue.title });

    await userEvent.type(screen.getByRole("searchbox", { name: "Search issues" }), "cannot read");

    await waitFor(() => expect(urlParams().get("q")).toBe("cannot read"));
    await waitFor(() => expect(last()?.get("q")).toBe("cannot read"));
  });

  it("toggles severities in a fixed order and clears all filters", async () => {
    const { last, urlParams } = setup("/projects/p1/issues?sort=event_count");
    await screen.findByRole("link", { name: issue.title });

    await userEvent.click(screen.getByRole("button", { name: "low" }));
    await userEvent.click(screen.getByRole("button", { name: "critical" }));
    expect(urlParams().get("severity")).toBe("critical,low");
    await waitFor(() => expect(last()?.get("severity")).toBe("critical,low"));

    await userEvent.click(screen.getByRole("button", { name: "low" }));
    expect(urlParams().get("severity")).toBe("critical");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(urlParams().has("severity")).toBe(false);
    expect(urlParams().get("sort")).toBe("event_count"); // sort isn't a filter: it stays
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("says when nothing matches the filters", async () => {
    setup("/projects/p1/issues?q=nothing-like-this", []);

    expect(await screen.findByText("No issues match these filters")).toBeInTheDocument();
  });
});
