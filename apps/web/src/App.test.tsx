import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App, createQueryClient } from "./App";
import type { Issue } from "./api/types";
import { routes } from "./routes";
import { fakeApi } from "./test/fakeApi";

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
  severity: "high",
  isRegression: false,
  assigneeId: null,
  firstRelease: "1.4.0",
  lastRelease: "1.4.2",
  firstSeen: "2026-10-20T00:00:00Z",
  lastSeen: new Date().toISOString(),
  eventCount: 42,
  userCount: 7,
  resolvedAt: null,
};
const event = {
  id: "e1",
  issueId: "i1",
  eventId: "a".repeat(32),
  timestamp: new Date().toISOString(),
  level: "error",
  type: "TypeError",
  message: "cart is undefined",
  stacktrace: {
    frames: [{ function: "checkout", filename: "src/cart.js", lineno: 42, in_app: true }],
  },
  environment: "production",
  release: "1.4.2",
  user: { id: "42" },
  request: { method: "POST", url: "/checkout", route: "/checkout" },
  tags: { browser: "Firefox" },
  context: null,
  sdk: { name: "@pulse/sdk", version: "0.1.0" },
};

// Two hours: 3 events, then 5
const series = {
  interval: "hour",
  buckets: [
    { start: "2026-10-22T10:00:00.000Z", count: 3 },
    { start: "2026-10-22T11:00:00.000Z", count: 5 },
  ],
};

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("the dashboard", () => {
  it("sends logged-out visitors to the login page", async () => {
    fakeApi({
      "GET /auth/me": () => ({
        status: 401,
        body: { error: { code: "UNAUTHENTICATED", message: "x" } },
      }),
    });
    const router = renderApp("/projects/p1/issues");

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?next=%2Fprojects%2Fp1%2Fissues");
  });

  it("shows the landing page to logged-out visitors", async () => {
    fakeApi({ "GET /auth/me": () => ({ status: 401 }) });
    renderApp("/");

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Errors in.The right personpaged.",
    );
    expect(screen.getAllByRole("link", { name: /Start/ })[0]).toHaveAttribute("href", "/signup");
  });

  it("sends logged-in visitors from the landing page to their project", async () => {
    fakeApi({
      "GET /auth/me": () => ({ body: { user } }),
      "GET /orgs": () => ({ body: { organizations: [org] } }),
      "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
      "GET /projects/p1": () => ({ body: { project, keys: [] } }),
      "GET /projects/p1/stats": () => ({
        body: { stats: { activeIssues: 0, criticalIssues: 0, events24h: 0, users24h: 0 } },
      }),
      "GET /projects/p1/issues": () => ({ body: { issues: [], nextCursor: null } }),
      "GET /projects/p1/timeseries": () => ({ body: { interval: "hour", buckets: [] } }),
    });
    const router = renderApp("/");

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"));
  });

  it("shows login errors", async () => {
    fakeApi({
      "GET /auth/me": () => ({ status: 401 }),
      "POST /auth/login": () => ({
        status: 401,
        body: { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } },
      }),
    });
    renderApp("/login");

    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect");
  });

  it("logs in, shows project health, opens an issue and resolves it", async () => {
    let loggedIn = false;
    let current = issue;
    const { calls } = fakeApi({
      "GET /auth/me": () => (loggedIn ? { body: { user } } : { status: 401 }),
      "POST /auth/login": () => {
        loggedIn = true;
        return { body: { user } };
      },
      "GET /orgs": () => ({ body: { organizations: [org] } }),
      "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
      "GET /projects/p1": () => ({ body: { project, keys: [] } }),
      "GET /projects/p1/stats": () => ({
        body: { stats: { activeIssues: 3, criticalIssues: 1, events24h: 1234, users24h: 56 } },
      }),
      "GET /projects/p1/issues": () => ({ body: { issues: [current], nextCursor: null } }),
      "GET /issues/i1": () => ({
        body: {
          issue: { ...current, assignee: null },
          latestEvent: event,
          environments: [{ name: "production", count: 42 }],
          releases: [],
        },
      }),
      "GET /events/e1": () => ({ body: { event, previousEventId: "e0", nextEventId: null } }),
      "GET /issues/i1/activity": () => ({ body: { activity: [] } }),
      "GET /projects/p1/timeseries": () => ({ body: series }),
      "GET /issues/i1/timeseries": () => ({ body: series }),
      "PATCH /issues/i1": (body) => {
        current = { ...current, ...(body as Partial<Issue>) };
        return { body: { issue: current } };
      },
    });

    renderApp("/app");

    // 1. Log in
    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct-password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    // 2. Land on the project's overview
    expect(await screen.findByRole("heading", { name: "Shop" })).toBeInTheDocument();
    expect(screen.getByText("1.2K")).toBeInTheDocument();
    expect(screen.getByText("Affected users (24h)")).toBeInTheDocument();
    expect(
      await screen.findByRole("slider", { name: /Events, last 24 hours/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("events in the last 24 hours", { exact: false })).toHaveTextContent(
      "8",
    );

    // 3. Open the issue from "Recent issues"
    const recent = screen.getByRole("heading", { name: "Recent issues" }).closest("section");
    if (!recent) throw new Error("no recent section");
    await userEvent.click(await within(recent).findByRole("link", { name: issue.title }));

    expect(await screen.findByRole("heading", { name: issue.title })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Stack trace" })).toHaveTextContent("checkout");
    expect(screen.getByText("Firefox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "← Older" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Newer →" })).toBeDisabled();

    // 4. Resolve it
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument());
    expect(calls).toContainEqual({
      method: "PATCH",
      path: "/issues/i1",
      body: { status: "resolved" },
    });
    expect(screen.getAllByText("Resolved").length).toBeGreaterThan(0);
  });

  it("asks a user without projects to create one", async () => {
    fakeApi({
      "GET /auth/me": () => ({ body: { user } }),
      "GET /orgs": () => ({ body: { organizations: [org] } }),
      "GET /orgs/o1/projects": () => ({ body: { projects: [] } }),
    });
    renderApp("/app");

    expect(await screen.findByRole("heading", { name: "Create a project" })).toBeInTheDocument();
  });
});
