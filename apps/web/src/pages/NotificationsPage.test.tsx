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
const channel = (id: string, extra: object) => ({
  id,
  userId: "u1",
  orgId: null,
  enabled: true,
  minSeverity: "low",
  createdAt: "2026-10-01T00:00:00Z",
  ...extra,
});

function setup(role: "owner" | "member") {
  return fakeApi({
    "GET /auth/me": () => ({ body: { user } }),
    "GET /orgs": () => ({
      body: { organizations: [{ id: "o1", name: "Ada's org", slug: "a", role }] },
    }),
    "GET /orgs/o1/projects": () => ({ body: { projects: [project] } }),
    "GET /projects/p1": () => ({ body: { project, keys: [] } }),
    "GET /projects/p1/environments": () => ({ body: { environments: [] } }),
    "GET /me/notification-channels": () => ({
      body: {
        channels: [
          channel("c1", { type: "email", name: "Account email", target: "ada@example.com" }),
        ],
        available: { email: true, sms: false, push: false },
        pushPublicKey: null,
      },
    }),
    "PATCH /me/notification-channels/c1": (body) => ({
      body: {
        channel: channel("c1", { type: "email", name: "Account email", ...(body as object) }),
      },
    }),
    "POST /me/notification-channels": () => ({ status: 201, body: { channel: {} } }),
    "GET /orgs/o1/notification-channels": () => ({ body: { channels: [] } }),
    "POST /orgs/o1/notification-channels": () => ({
      status: 201,
      body: { channel: {}, secret: "whsec_shown_once" },
    }),
    "GET /orgs/o1/notifications": () => ({
      body: {
        deliveries: [
          {
            id: "d1",
            channelId: "c1",
            channelType: "email",
            recipient: "ada@example.com",
            trigger: "incident_triggered",
            status: "failed",
            attempts: 6,
            error: "Connection refused",
            createdAt: "2026-10-22T00:00:00Z",
            sentAt: null,
            incident: { id: "i1", title: "TypeError: boom", projectId: "p1" },
          },
        ],
      },
    }),
  });
}

function renderPage() {
  const router = createMemoryRouter(routes, { initialEntries: ["/projects/p1/notifications"] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe("notifications page", () => {
  it("changes your preferences and adds a contact method", async () => {
    const { calls } = setup("owner");
    renderPage();

    const select = await screen.findByRole("combobox", {
      name: "Which incidents reach Account email",
    });
    await userEvent.selectOptions(select, "critical");
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        path: "/me/notification-channels/c1",
        body: { minSeverity: "critical" },
      }),
    );

    const mine = screen.getByRole("heading", { name: "Your contact methods" }).closest("section");
    await userEvent.type(
      within(mine as HTMLElement).getByLabelText("Email address"),
      "pager@example.com",
    );
    await userEvent.click(within(mine as HTMLElement).getByRole("button", { name: "Add" }));
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/me/notification-channels",
        body: { type: "email", minSeverity: "low", config: { address: "pager@example.com" } },
      }),
    );
    // SMS isn't configured on the server, so it isn't offered
    expect(screen.getByText(/SMS isn't set up on this server/)).toBeInTheDocument();
  });

  it("admins add a webhook and see its secret once; the log shows failures", async () => {
    setup("owner");
    renderPage();

    const team = (await screen.findByRole("heading", { name: /Team channels/ })).closest("section");
    await userEvent.type(
      await within(team as HTMLElement).findByLabelText("Webhook URL"),
      "https://example.com/hook",
    );
    await userEvent.click(within(team as HTMLElement).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("whsec_shown_once")).toBeInTheDocument();

    const row = (await screen.findByText("TypeError: boom")).closest("tr");
    expect(row).toHaveTextContent("failed");
    expect(row).toHaveTextContent("after 6 tries");
    expect(row).toHaveTextContent("Connection refused");
  });

  it("members can't change team channels", async () => {
    setup("member");
    renderPage();
    expect(await screen.findByText("Only admins can change team channels.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  });
});
