import { render, screen } from "@testing-library/react";
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
  rateLimitPerMinute: 1000,
  monthlyQuota: 5000,
  retentionDays: 90,
  scrubData: true,
  scrubFields: [],
  scrubIpAddresses: false,
  createdAt: "2026-10-01T00:00:00Z",
};

function setup(role: "owner" | "member") {
  return fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({
      body: { organizations: [{ id: "o1", name: "Ada's org", slug: "a", role }] },
    }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({
      body: { project, keys: [], usage: { eventsThisMonth: 1234 } },
    }),
    "GET /projects/p1/environments": () => ({ body: { environments: [] } }),
    "GET /orgs/o1/schedules": () => ({ body: { schedules: [] } }),
    "PATCH /projects/p1": (body) => ({ body: { project: { ...project, ...(body as object) } } }),
    "GET /orgs/o1/audit-log": () =>
      role === "member"
        ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Admins only" } } }
        : {
            body: {
              entries: [
                {
                  id: "a1",
                  action: "key.rotated",
                  targetType: "project",
                  targetId: "p1",
                  data: { keyId: "k2" },
                  ip: "203.0.113.7",
                  createdAt: "2026-10-22T00:00:00Z",
                  actor: { id: "u1", name: "Ada", email: "ada@example.com" },
                },
              ],
              nextCursor: null,
            },
          },
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe("data & limits settings", () => {
  it("shows usage and saves retention, quota and scrub fields", async () => {
    const { calls } = setup("owner");
    renderAt("/projects/p1/settings");

    expect(await screen.findByText("1,234")).toBeInTheDocument();
    const retention = screen.getByLabelText("Keep events for (days)");
    await userEvent.clear(retention);
    await userEvent.type(retention, "30");
    await userEvent.clear(screen.getByLabelText("Monthly quota"));
    await userEvent.type(screen.getByLabelText(/Extra fields to scrub/), "iban, national_id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        path: "/projects/p1",
        body: {
          rateLimitPerMinute: 1000,
          monthlyQuota: null,
          retentionDays: 30,
          scrubData: true,
          scrubFields: ["iban", "national_id"],
          scrubIpAddresses: false,
        },
      }),
    );
  });
});

describe("audit log page", () => {
  it("lists who did what, from where", async () => {
    setup("owner");
    renderAt("/projects/p1/audit-log");
    // (The action filter lists "Key rotated" too, so look for the row's details)
    expect(await screen.findByText("keyId: k2")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /Key rotated/ })).toBeInTheDocument();
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
  });

  it("tells members it's for admins", async () => {
    setup("member");
    renderAt("/projects/p1/audit-log");
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
  });
});
