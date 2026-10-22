import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App, createQueryClient } from "../App";
import { routes } from "../routes";
import { fakeApi } from "../test/fakeApi";

const user = { id: "u1", email: "ada@example.com", name: "Ada", createdAt: "2026-10-01T00:00:00Z" };
const project = {
  id: "p1",
  orgId: "o1",
  name: "Shop",
  slug: "shop",
  platform: "node",
  createdAt: "2026-10-01T00:00:00Z",
};
const recentIssue = {
  id: "i1",
  projectId: "p1",
  title: "TypeError: cart.total is undefined",
  lastSeen: new Date().toISOString(),
};

function setup(role: "owner" | "member") {
  return fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({
      body: { organizations: [{ id: "o1", name: "Org", slug: "org", role }] },
    }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({ body: { project, keys: [] } }),
    "GET /projects/p1/environments": () => ({
      body: { environments: [{ name: "production" }, { name: "staging" }] },
    }),
    "GET /projects/p1/alert-rules": () => ({ body: { rules: [] } }),
    "GET /projects/p1/incidents": () => ({ body: { incidents: [] } }),
    "GET /orgs/o1/escalation-policies": () => ({
      body: { policies: [{ id: "pol1", name: "Checkout team", levels: [], repeatCount: 0 }] },
    }),
    "POST /projects/p1/alert-rules": (body) => ({
      status: 201,
      body: { rule: { id: "r1", ...(body as object) } },
    }),
    "POST /projects/p1/alert-rules/preview": () => ({ body: { matches: [recentIssue], total: 1 } }),
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("alert rule builder", () => {
  it("builds a rule with two conditions, tests it, and saves it", async () => {
    localStorage.clear();
    const { calls } = setup("owner");
    const router = renderAt("/projects/p1/alerts/new");

    await userEvent.type(await screen.findByLabelText("Name"), "Checkout on fire");

    // Condition 1: more than N events in X minutes
    await userEvent.selectOptions(screen.getByLabelText("Condition 1"), "event_frequency");
    const n = screen.getByLabelText("N =");
    await userEvent.clear(n);
    await userEvent.type(n, "50");

    // Condition 2, and both must be true
    await userEvent.click(screen.getByRole("button", { name: "+ Add condition" }));
    await userEvent.selectOptions(screen.getByLabelText("Fire when"), "all");
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Only in environment" }),
      "production",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Open an incident with severity"),
      "critical",
    );
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Escalation policy" }),
      await screen.findByRole("option", { name: "Checkout team" }),
    );

    // Test before saving
    await userEvent.click(screen.getByRole("button", { name: "Test rule" }));
    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("1 recent issue would match");
    expect(within(result).getByRole("link", { name: recentIssue.title })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create rule" }));
    await screen.findByRole("heading", { name: "Alerts" });
    expect(router.state.location.pathname).toBe("/projects/p1/alerts");

    const saved = calls.find((c) => c.method === "POST" && c.path === "/projects/p1/alert-rules");
    expect(saved?.body).toEqual({
      name: "Checkout on fire",
      enabled: true,
      environment: "production",
      match: "all",
      conditions: [
        { type: "event_frequency", count: 50, minutes: 10 },
        { type: "severity_critical" },
      ],
      severity: "critical",
      escalationPolicyId: "pol1",
      cooldownMinutes: 30,
    });
  });

  it("is read-only for members", async () => {
    setup("member");
    renderAt("/projects/p1/alerts/new");

    expect(await screen.findByText("Only admins can change alert rules.")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Create rule" })).not.toBeInTheDocument();
    // Testing is still allowed: it changes nothing
    expect(screen.getByRole("button", { name: "Test rule" })).toBeEnabled();
  });
});
