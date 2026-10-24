import { expect, test } from "@playwright/test";

const API_URL = "http://localhost:3098";

// The PRD's acceptance flow: log in, pick a project, see its health, open an issue, resolve it
test("a developer finds an error and resolves it", async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = "e2e-password-123";

  // Set up through the API: an account, a project, and an error sent with the project's key
  await request.post(`${API_URL}/auth/signup`, { data: { email, password, name: "E2E" } });
  await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  const { organizations } = await (await request.get(`${API_URL}/orgs`)).json();
  const created = await request.post(`${API_URL}/orgs/${organizations[0].id}/projects`, {
    data: { name: "E2E Shop", platform: "node" },
  });
  const { project } = await created.json();

  const sent = await request.post(`${API_URL}/api/${project.id}/events`, {
    headers: { "x-pulse-key": new URL(project.dsn).username },
    data: {
      exception: {
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'total')",
        stacktrace: {
          frames: [
            { function: "handle", filename: "/srv/shop/server.js", lineno: 10, in_app: true },
            { function: "checkout", filename: "/srv/shop/cart.js", lineno: 42, in_app: true },
          ],
        },
      },
      user: { id: "42" },
      release: "1.4.2",
      request: { method: "POST", url: "/checkout", route: "/checkout" },
    },
  });
  expect(sent.status()).toBe(202);

  // The worker groups it in the background; wait until the issue exists
  await expect
    .poll(
      async () =>
        (await (await request.get(`${API_URL}/projects/${project.id}/issues`)).json()).issues
          .length,
    )
    .toBe(1);

  // Now as a person, in the browser
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.getByRole("heading", { name: "E2E Shop" })).toBeVisible();
  await expect(page.locator(".stat-card").filter({ hasText: "Active issues" })).toContainText("1");

  await page
    .getByRole("link", { name: /TypeError: Cannot read properties/ })
    .first()
    .click();
  await expect(page.getByRole("list", { name: "Stack trace" })).toContainText("checkout");
  await expect(page.getByText("1.4.2").first()).toBeVisible();

  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(page.getByText(/changed status from unresolved to resolved/)).toBeVisible();
});
