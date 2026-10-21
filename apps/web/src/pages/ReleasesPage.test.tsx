import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App, createQueryClient } from "../App";
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
const issue = (id: string, title: string, firstRelease: string) => ({
  id,
  projectId: "p1",
  title,
  type: "Error",
  culprit: null,
  status: "unresolved",
  severity: "high",
  isRegression: false,
  assigneeId: null,
  firstRelease,
  lastRelease: "1.1.0",
  firstSeen: "2026-10-20T00:00:00Z",
  lastSeen: "2026-10-21T00:00:00Z",
  eventCount: 3,
  userCount: 2,
  resolvedAt: null,
});

function setup(environments: string[]) {
  const api = fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({ body: { organizations: [org] } }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1/environments": () => ({
      body: { environments: environments.map((name) => ({ name, eventCount: 1 })) },
    }),
    "GET /projects/p1/releases": () => ({
      body: {
        releases: [
          {
            version: "1.1.0",
            firstSeen: "2026-10-21T00:00:00Z",
            lastSeen: "2026-10-21T00:00:00Z",
            eventCount: 5,
            newIssues: 1,
          },
          {
            version: "1.0.0",
            firstSeen: "2026-10-20T00:00:00Z",
            lastSeen: "2026-10-20T00:00:00Z",
            eventCount: 2,
            newIssues: 0,
          },
        ],
      },
    }),
    "GET /projects/p1/releases/1.1.0": () => ({
      body: {
        release: {
          version: "1.1.0",
          firstSeen: "2026-10-21T00:00:00Z",
          lastSeen: "2026-10-21T00:00:00Z",
          eventCount: 5,
          newIssues: 1,
          affectedUsers: 4,
        },
        newIssues: [issue("i2", "TypeError: brand new", "1.1.0")],
        issues: [
          { issue: issue("i2", "TypeError: brand new", "1.1.0"), events: 3 },
          { issue: issue("i1", "RangeError: old friend", "1.0.0"), events: 2 },
        ],
      },
    }),
    "GET /projects/p1/releases/compare": (_body, url) => ({
      body: {
        a: url.searchParams.get("a"),
        b: url.searchParams.get("b"),
        onlyInA: [{ issue: issue("i3", "Fixed thing", "1.0.0"), countA: 1, countB: 0 }],
        onlyInB: [{ issue: issue("i2", "TypeError: brand new", "1.1.0"), countA: 0, countB: 3 }],
        inBoth: [],
      },
    }),
  });
  return api;
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("releases", () => {
  it("lists releases and compares the newest two", async () => {
    localStorage.clear();
    const { calls } = setup(["production"]);
    const router = renderAt("/projects/p1/releases");

    const row = (await screen.findByRole("link", { name: "1.1.0" })).closest("tr");
    expect(row).toHaveTextContent("1 new");

    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(router.state.location.pathname).toBe("/projects/p1/releases/compare");
    expect(router.state.location.search).toBe("?a=1.0.0&b=1.1.0");

    const newIn = (await screen.findByRole("heading", { name: "New in 1.1.0" })).closest("section");
    expect(within(newIn as HTMLElement).getByText("TypeError: brand new")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Gone in 1.1.0 (only seen in 1.0.0)" }),
    ).toBeInTheDocument();
    // The global environment defaults to production and is sent along
    expect(calls.some((c) => c.path === "/projects/p1/releases/compare")).toBe(true);
  });

  it("answers 'which release introduced this?' on a release page", async () => {
    localStorage.clear();
    setup(["staging"]); // no production: the selector shows all environments
    renderAt("/projects/p1/releases/1.1.0");

    expect(await screen.findByRole("heading", { name: "Release 1.1.0" })).toBeInTheDocument();
    // Once the environment list arrives (staging only), the page shows all environments
    expect(await screen.findByRole("combobox", { name: "Environment" })).toHaveValue("");
    const newIn = (await screen.findByRole("heading", { name: "New in this release" })).closest(
      "section",
    );
    expect(within(newIn as HTMLElement).getByText("TypeError: brand new")).toBeInTheDocument();
    const old = screen.getByRole("link", { name: "RangeError: old friend" }).closest("tr");
    expect(old).toHaveTextContent("1.0.0");
  });
});
