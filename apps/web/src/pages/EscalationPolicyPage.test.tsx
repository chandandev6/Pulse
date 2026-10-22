import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App, createQueryClient } from "../App";
import { routes } from "../routes";
import { fakeApi } from "../test/fakeApi";
import { describeStep } from "./IncidentPage";

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

function setup(role: "owner" | "member") {
  return fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({
      body: { organizations: [{ id: "o1", name: "Org", slug: "org", role }] },
    }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({ body: { project, keys: [] } }),
    "GET /projects/p1/environments": () => ({ body: { environments: [] } }),
    "GET /orgs/o1/members": () => ({
      body: {
        members: [
          { userId: "u1", name: "Ada", email: "ada@example.com", role: "owner" },
          { userId: "u2", name: "Ben", email: "ben@example.com", role: "member" },
        ],
      },
    }),
    "GET /orgs/o1/schedules": () => ({
      body: { schedules: [{ id: "s1", orgId: "o1", name: "Primary", onCall: null }] },
    }),
    "GET /orgs/o1/escalation-policies": () => ({ body: { policies: [] } }),
    "POST /orgs/o1/escalation-policies": (body) => ({
      status: 201,
      body: { policy: { id: "pol1", ...(body as object) } },
    }),
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("escalation policy editor", () => {
  it("builds two levels, reorders them, and saves them in order", async () => {
    const { calls } = setup("owner");
    const router = renderAt("/projects/p1/escalation/new");

    await userEvent.type(await screen.findByLabelText("Name"), "Checkout team");

    // Level 1: Ben, after 5 minutes
    const add1 = await screen.findByRole("combobox", { name: "Add to level 1" });
    await screen.findByRole("option", { name: "Ben" });
    await userEvent.selectOptions(add1, "user:u2");
    const timeout1 = screen.getByLabelText("Then wait (minutes)");
    await userEvent.clear(timeout1);
    await userEvent.type(timeout1, "5");

    // Level 2: whoever is on call on Primary
    await userEvent.click(screen.getByRole("button", { name: "+ Add level" }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Add to level 2" }),
      "schedule:s1",
    );
    expect(
      within(screen.getByRole("list", { name: "Level 2 targets" })).getByText(
        "Primary (whoever is on call)",
      ),
    ).toBeVisible();

    // The schedule should go first
    await userEvent.click(screen.getByRole("button", { name: "Move level 2 up" }));
    await userEvent.selectOptions(screen.getByLabelText("Start again from level 1"), "1");
    expect(screen.getByText(/escalation stops after 40 min/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Create policy" }));
    await screen.findByRole("heading", { name: "Escalation" });
    expect(router.state.location.pathname).toBe("/projects/p1/escalation");

    const saved = calls.find((c) => c.method === "POST");
    expect(saved?.body).toEqual({
      name: "Checkout team",
      description: null,
      repeatCount: 1,
      levels: [
        { timeoutMinutes: 15, targets: [{ type: "schedule", id: "s1" }] },
        { timeoutMinutes: 5, targets: [{ type: "user", id: "u2" }] },
      ],
    });
  });

  it("is read-only for members", async () => {
    setup("member");
    renderAt("/projects/p1/escalation/new");
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeDisabled()); // once the role is known
    expect(screen.queryByRole("button", { name: "+ Add level" })).toBeNull();
  });
});

describe("escalation in the incident timeline", () => {
  const base = { id: "t", createdAt: "2026-10-22T10:00:00Z", actor: null };
  const cara = { id: "u3", name: "Cara", schedule: { id: "s1", name: "Primary" } };

  it("says who each level reached", () => {
    expect(
      describeStep({
        ...base,
        kind: "notified",
        data: {
          responder: null,
          everyone: false,
          channels: 1,
          escalation: {
            policy: { id: "pol1", name: "Checkout team" },
            targets: [{ id: "u2", name: "Ben", schedule: null }],
          },
        },
      }),
    ).toBe('Notified level 1 of "Checkout team": Ben (1 channel)');
    expect(
      describeStep({
        ...base,
        kind: "escalated",
        data: { step: 3, level: 2, pass: 2, targets: [cara], channels: 2 },
      }),
    ).toBe(
      "Nobody acknowledged in time: escalated to level 2 (round 2), Cara (on call on Primary) (2 channels)",
    );
    expect(describeStep({ ...base, kind: "exhausted", data: { levels: 2, passes: 2 } })).toBe(
      "Every level was tried 2 times and nobody acknowledged: escalation stopped",
    );
  });
});
