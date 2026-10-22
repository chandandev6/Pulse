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
const ada = { id: "u1", name: "Ada", email: "ada@example.com" };
const bo = { id: "u2", name: "Bo", email: "bo@example.com" };
const onCall = (person: typeof ada) => ({
  user: person,
  source: "layer",
  layer: { id: "l1", name: "Primary" },
  overrideId: null,
});
const schedule = {
  id: "s1",
  orgId: "o1",
  name: "Backend",
  description: null,
  timezone: "Asia/Kolkata",
  createdAt: "2026-10-01T00:00:00Z",
  onCall: onCall(ada),
  onCallUntil: "2026-10-23T03:30:00Z",
};

function setup(layers: unknown[] = []) {
  const now = Date.now();
  const hour = 3600_000;
  return fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({
      body: { organizations: [{ id: "o1", name: "Ada's org", slug: "a", role: "owner" }] },
    }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({ body: { project, keys: [] } }),
    "GET /projects/p1/environments": () => ({ body: { environments: [] } }),
    "GET /orgs/o1/members": () => ({
      body: {
        members: [
          { userId: "u1", name: "Ada", email: "ada@example.com", role: "owner" },
          { userId: "u2", name: "Bo", email: "bo@example.com", role: "member" },
        ],
      },
    }),
    "GET /orgs/o1/schedules": () => ({ body: { schedules: [schedule] } }),
    "GET /orgs/o1/oncall": () => ({
      body: {
        oncall: [
          {
            schedule: { id: "s1", name: "Backend", timezone: "Asia/Kolkata" },
            onCall: onCall(ada),
            until: schedule.onCallUntil,
          },
        ],
      },
    }),
    "POST /orgs/o1/schedules": () => ({ status: 201, body: { schedule } }),
    "GET /schedules/s1": () => ({ body: { schedule, layers, overrides: [] } }),
    "GET /schedules/s1/shifts": () => ({
      body: {
        shifts: [
          {
            start: new Date(now - hour).toISOString(),
            end: new Date(now + hour).toISOString(),
            onCall: onCall(ada),
          },
          {
            start: new Date(now + hour).toISOString(),
            end: new Date(now + 25 * hour).toISOString(),
            onCall: onCall(bo),
          },
        ],
      },
    }),
    "POST /schedules/s1/layers": () => ({ status: 201, body: { layer: {} } }),
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("on-call", () => {
  it("shows who is on call now and creates a schedule", async () => {
    const { calls } = setup();
    const router = renderAt("/projects/p1/schedules");

    const widget = (await screen.findByRole("heading", { name: "Who's on call now" })).closest(
      "section",
    );
    expect(await within(widget as HTMLElement).findByText("Ada")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Name"), "Backend");
    await userEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/orgs/o1/schedules",
        body: expect.objectContaining({ name: "Backend" }),
      }),
    );
    await screen.findByRole("heading", { name: "Backend" });
    expect(router.state.location.pathname).toBe("/projects/p1/schedules/s1");
  });

  it("shows the timeline and adds the first rotation with people in order", async () => {
    const { calls } = setup();
    renderAt("/projects/p1/schedules/s1");

    expect(await screen.findByRole("heading", { name: "Next 14 days" })).toBeInTheDocument();
    const upcoming = (await screen.findByRole("heading", { name: "Upcoming shifts" })).nextSibling;
    expect(upcoming).toHaveTextContent("Ada");
    expect(upcoming).toHaveTextContent("Bo");

    const form = (await screen.findByRole("heading", { name: "Add the first rotation" })).closest(
      "form",
    ) as HTMLElement;
    const picker = within(form).getByLabelText("Add person");
    await userEvent.selectOptions(picker, "u2");
    await userEvent.selectOptions(within(form).getByLabelText("Add person"), "u1");
    await userEvent.click(within(form).getByRole("button", { name: "Add layer" }));

    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/schedules/s1/layers",
        body: expect.objectContaining({
          name: "Primary",
          rotationType: "weekly",
          participants: ["u2", "u1"],
          restriction: null,
        }),
      }),
    );
    // The first layer is the base layer: it can't be time-limited
    expect(within(form).queryByText(/Only active at certain times/)).not.toBeInTheDocument();
  });

  it("lists layers top first and marks the base layer", async () => {
    setup([
      {
        id: "l1",
        name: "Primary",
        position: 0,
        rotationType: "daily",
        shiftLengthHours: null,
        handoffTime: "09:00",
        startDate: "2026-10-01",
        restriction: null,
        participants: [ada, bo],
      },
      {
        id: "l2",
        name: "Business hours",
        position: 1,
        rotationType: "weekly",
        shiftLengthHours: null,
        handoffTime: "09:00",
        startDate: "2026-10-05",
        restriction: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
        participants: [bo],
      },
    ]);
    renderAt("/projects/p1/schedules/s1");

    const cards = await screen.findAllByRole("listitem", {
      name: (_name, element) => element.classList.contains("layer-card"),
    });
    expect(cards[0]).toHaveTextContent("Business hours");
    expect(cards[0]).toHaveTextContent("only Mon, Tue, Wed, Thu, Fri, 09:00–17:00");
    expect(cards[1]).toHaveTextContent("base layer");
    expect(cards[1]).toHaveTextContent("Every day at 09:00");
    expect(await screen.findByRole("heading", { name: "Add a layer on top" })).toBeInTheDocument();
  });
});
