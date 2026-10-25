import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App, createQueryClient } from "../App";
import { routes } from "../routes";
import { fakeApi } from "../test/fakeApi";

const user = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  createdAt: "2026-10-01T00:00:00Z",
  emailVerified: true,
  mustVerifyEmail: false,
};
const loggedOut = { "GET /auth/me": () => ({ status: 401 }) };

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe("account pages", () => {
  it("forgot password: sends the email and says so without revealing if the account exists", async () => {
    const { calls } = fakeApi({
      ...loggedOut,
      "POST /auth/forgot-password": () => ({ status: 202, body: { ok: true } }),
    });
    renderApp("/login");

    await userEvent.click(await screen.findByRole("link", { name: "Forgot your password?" }));
    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send the link" }));

    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(calls).toContainEqual(
      expect.objectContaining({
        path: "/auth/forgot-password",
        body: { email: "ada@example.com" },
      }),
    );
  });

  it("reset password: uses the token from the link and logs in", async () => {
    const { calls } = fakeApi({
      ...loggedOut,
      "POST /auth/reset-password": () => ({ body: { user } }),
      "GET /orgs": () => ({ body: { organizations: [] } }),
    });
    const router = renderApp("/reset-password#token=the-secret-token-from-email");

    await userEvent.type(await screen.findByLabelText("New password"), "new-password-1");
    await userEvent.type(screen.getByLabelText("Repeat it"), "new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Save and log in" }));

    await waitFor(() => expect(router.state.location.pathname).not.toBe("/reset-password"));
    expect(calls).toContainEqual(
      expect.objectContaining({
        path: "/auth/reset-password",
        body: { token: "the-secret-token-from-email", password: "new-password-1" },
      }),
    );
  });

  it("verify email: confirms once from the link", async () => {
    const { calls } = fakeApi({
      ...loggedOut,
      "POST /auth/verify-email": () => ({ body: { verified: true } }),
    });
    renderApp("/verify-email#token=verify-token-from-the-email");

    expect(await screen.findByRole("heading", { name: "Email confirmed" })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/auth/verify-email")).toHaveLength(1);
  });

  it("invitation: logged out, it offers to sign up with the invited email", async () => {
    fakeApi({
      ...loggedOut,
      "POST /invitations/preview": () => ({
        body: {
          invitation: {
            orgName: "Acme",
            inviterName: "Olive",
            email: "new@acme.com",
            role: "member",
          },
        },
      }),
    });
    renderApp("/invite#token=invitation-token-1234567890");

    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup?next=/invite&email=new%40acme.com",
    );
  });

  it("invitation: logged in, one click joins the org", async () => {
    const { calls } = fakeApi({
      "GET /auth/me": () => ({ body: { user } }),
      "POST /invitations/preview": () => ({
        body: {
          invitation: { orgName: "Acme", inviterName: "Olive", email: user.email, role: "admin" },
        },
      }),
      "POST /invitations/accept": () => ({ body: { orgId: "o2", alreadyMember: false } }),
      "GET /orgs": () => ({ body: { organizations: [] } }),
    });
    const router = renderApp("/invite#token=invitation-token-1234567890");

    await userEvent.click(await screen.findByRole("button", { name: "Join Acme" }));
    await waitFor(() => expect(router.state.location.pathname).not.toBe("/invite"));
    expect(calls).toContainEqual(
      expect.objectContaining({
        path: "/invitations/accept",
        body: { token: "invitation-token-1234567890" },
      }),
    );
  });

  it("asks unverified users to confirm their email", async () => {
    const { calls } = fakeApi({
      "GET /auth/me": () => ({
        body: { user: { ...user, emailVerified: false, mustVerifyEmail: true } },
      }),
      "GET /orgs": () => ({
        body: { organizations: [{ id: "o1", name: "Ada's org", slug: "ada", role: "owner" }] },
      }),
      "POST /auth/resend-verification": () => ({ status: 202, body: { ok: true } }),
    });
    renderApp("/projects/new");

    expect(await screen.findByText("Confirm your email.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send it again" }));
    expect(await screen.findByText(/Sent\. Check your inbox/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/auth/resend-verification")).toBe(true);
  });
});
