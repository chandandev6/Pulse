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
  onCallScheduleId: null,
  createdAt: "2026-10-01T00:00:00Z",
};
const ben = { id: "u2", name: "Ben" };
const now = new Date().toISOString();

const incident = {
  id: "inc1",
  title: "TypeError: cart.total is undefined",
  status: "triggered",
  severity: "high",
  issueId: "i1",
  triggeredAt: now,
  acknowledgedAt: null,
  resolvedAt: null,
  rule: { id: "r1", name: "Checkout on fire" },
  responder: ben,
  acknowledgedBy: null,
  resolvedBy: null,
};

const detail = {
  incident: {
    ...incident,
    project: { id: "p1", name: "Shop" },
    issue: {
      id: "i1",
      title: incident.title,
      culprit: "cart.ts in total",
      status: "unresolved",
      eventCount: 120,
      userCount: 14,
      lastSeen: now,
    },
  },
  timeline: [
    {
      id: "t1",
      kind: "triggered",
      data: { ruleId: "r1", ruleName: "Checkout on fire" },
      createdAt: now,
      actor: null,
    },
    {
      id: "t2",
      kind: "notified",
      data: { responder: { ...ben, source: "layer" }, everyone: false, channels: 2 },
      createdAt: now,
      actor: null,
    },
  ],
  deliveries: [
    {
      id: "d1",
      channelType: "email",
      recipient: "ben@example.com",
      status: "sent",
      attempts: 1,
      error: null,
      createdAt: now,
      sentAt: now,
    },
  ],
};

function setup(ackResult: { status?: number; body?: unknown }) {
  return fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({
      body: { organizations: [{ id: "o1", name: "Org", slug: "org", role: "member" }] },
    }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({ body: { project, keys: [] } }),
    "GET /projects/p1/environments": () => ({ body: { environments: [] } }),
    "GET /incidents/inc1": () => ({ body: detail }),
    "GET /projects/p1/incidents": () => ({ body: { incidents: [incident] } }),
    "POST /incidents/inc1/acknowledge": () => ackResult,
    "POST /incidents/inc1/resolve": () => ({
      body: { incident: { ...incident, status: "resolved" } },
    }),
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("incident page", () => {
  it("shows the story so far and acknowledges", async () => {
    const { calls } = setup({ body: { incident: { ...incident, status: "acknowledged" } } });
    renderAt("/projects/p1/incidents/inc1");

    const timeline = await screen.findByRole("list", { name: "Timeline" });
    expect(within(timeline).getByText('Opened by alert rule "Checkout on fire"')).toBeVisible();
    expect(
      within(timeline).getByText("Notified Ben (on call) and team channels (2 channels)"),
    ).toBeVisible();
    expect(screen.getByText("ben@example.com")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(calls.some((c) => c.method === "POST" && c.path === "/incidents/inc1/acknowledge")).toBe(
      true,
    );
  });

  it("says who was faster", async () => {
    setup({
      status: 409,
      body: {
        error: { code: "ALREADY_ACKNOWLEDGED", message: "Ben already acknowledged this incident" },
      },
    });
    renderAt("/projects/p1/incidents/inc1");

    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ben already acknowledged this incident",
    );
  });

  it("can resolve the issue along with the incident", async () => {
    const { calls } = setup({});
    renderAt("/projects/p1/incidents/inc1");

    await userEvent.click(await screen.findByLabelText("Also resolve the issue"));
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const call = calls.find((c) => c.path === "/incidents/inc1/resolve");
    expect(call?.body).toEqual({ resolveIssue: true });
  });

  it("lists incidents waiting for someone", async () => {
    setup({});
    renderAt("/projects/p1/incidents");
    expect(await screen.findByText("Waiting for Ben (on call)")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Needs someone" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("acknowledge link page", () => {
  const view = {
    incident: {
      id: "inc1",
      title: incident.title,
      severity: "high",
      status: "triggered",
      triggeredAt: now,
      acknowledgedAt: null,
      resolvedAt: null,
    },
    project: { id: "p1", name: "Shop" },
    acknowledgedBy: null,
    user: ben,
    needsLogin: false,
  };

  it("works without logging in, and only acts on the button", async () => {
    const { calls } = fakeApi({
      "GET /auth/me": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED" } } }),
      "POST /incidents/inc1/link": () => ({ body: view }),
      "POST /incidents/inc1/link/acknowledge": () => ({ body: { incident: {} } }),
    });
    renderAt("/incidents/inc1/acknowledge#token=abc");

    expect(await screen.findByText(/Acknowledging as/)).toHaveTextContent("Ben");
    const acks = () => calls.filter((c) => c.path.endsWith("/link/acknowledge"));
    expect(acks()).toHaveLength(0); // opening changed nothing
    // The token travels in a request body, never in a URL that servers would log
    expect(calls.find((c) => c.path === "/incidents/inc1/link")?.body).toEqual({ token: "abc" });

    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    const post = acks()[0];
    expect(post).toMatchObject({
      path: "/incidents/inc1/link/acknowledge",
      body: { token: "abc" },
    });
  });

  it("explains a bad link", async () => {
    fakeApi({
      "POST /incidents/inc1/link": () => ({
        status: 403,
        body: { error: { code: "INVALID_LINK", message: "This link is invalid or has expired." } },
      }),
    });
    renderAt("/incidents/inc1/acknowledge#token=forged");
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
  });

  it("asks to log in for a team link", async () => {
    fakeApi({
      "POST /incidents/inc1/link": () => ({ body: { ...view, user: null, needsLogin: true } }),
    });
    renderAt("/incidents/inc1/acknowledge#token=team");
    const login = await screen.findByRole("link", { name: "Log in" });
    expect(login).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent("/incidents/inc1/acknowledge#token=team")}`,
    );
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });
});
