import { expect, test } from "@playwright/test";

const API_URL = "http://localhost:3098";

// F10 acceptance: a matching error creates exactly one incident linked to its issue and rule
test("an alert rule turns a matching error into exactly one incident", async ({
  page,
  request,
}) => {
  const email = `e2e-alerts-${Date.now()}@example.com`;
  const password = "e2e-password-123";

  await request.post(`${API_URL}/auth/signup`, { data: { email, password, name: "E2E" } });
  await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  const { organizations } = await (await request.get(`${API_URL}/orgs`)).json();
  const { project } = await (
    await request.post(`${API_URL}/orgs/${organizations[0].id}/projects`, {
      data: { name: "Alert Shop", platform: "node" },
    })
  ).json();

  // 1. Create the rule in the UI: "a new issue appears" → critical incident
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Alert Shop" })).toBeVisible();

  await page.getByRole("link", { name: "Alerts", exact: true }).click();
  await page.getByRole("link", { name: "New alert rule" }).click();
  await page.getByLabel("Name").fill("Every new error");
  await page.getByLabel("Open an incident with severity").selectOption("critical");
  await page.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByRole("link", { name: "Every new error" })).toBeVisible();

  // 2. The same error happens 3 times
  for (let i = 0; i < 3; i++) {
    const res = await request.post(`${API_URL}/api/${project.id}/events`, {
      headers: { "x-pulse-key": new URL(project.dsn).username },
      data: { exception: { type: "TypeError", value: "payment.id is undefined" } },
    });
    expect(res.status()).toBe(202);
  }
  await expect
    .poll(async () => {
      const { issues } = await (
        await request.get(`${API_URL}/projects/${project.id}/issues`)
      ).json();
      return issues[0]?.eventCount ?? 0;
    })
    .toBe(3);

  // 3. Exactly one incident, linked to the rule and to the issue
  await page.reload();
  const incidents = page.locator("section").filter({ hasText: "Recent incidents" });
  const rows = incidents.getByRole("row").filter({ hasText: "payment.id is undefined" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Every new error");
  await expect(rows).toContainText("Triggered");
  await expect(page.getByRole("row").filter({ hasText: "Every new error" }).first()).toContainText(
    "1",
  );

  await rows.getByRole("link").click();
  await expect(
    page.getByRole("heading", { name: "TypeError: payment.id is undefined" }),
  ).toBeVisible();
});
