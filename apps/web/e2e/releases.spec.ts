import { expect, test } from "@playwright/test";

const API_URL = "http://localhost:3098";

// F9 acceptance: "which release introduced this?" and "how many users does this affect?"
test("a developer finds which release introduced an error and who it affects", async ({
  page,
  request,
}) => {
  const email = `e2e-releases-${Date.now()}@example.com`;
  const password = "e2e-password-123";

  await request.post(`${API_URL}/auth/signup`, { data: { email, password, name: "E2E" } });
  await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  const { organizations } = await (await request.get(`${API_URL}/orgs`)).json();
  const { project } = await (
    await request.post(`${API_URL}/orgs/${organizations[0].id}/projects`, {
      data: { name: "Release Shop", platform: "node" },
    })
  ).json();
  const send = (data: object) =>
    request.post(`${API_URL}/api/${project.id}/events`, {
      headers: { "x-pulse-key": new URL(project.dsn).username },
      data,
    });

  // 1.0.0 is fine apart from an old warning; 1.1.0 breaks checkout for 4 of the 5 users
  await send({
    message: "Slow payment provider",
    level: "warning",
    release: "1.0.0",
    user: { id: "u5" },
  });
  for (const id of ["u1", "u2", "u3", "u4"]) {
    await send({
      exception: { type: "TypeError", value: "cart.total is undefined" },
      release: "1.1.0",
      user: { id },
    });
  }
  await expect
    .poll(
      async () =>
        (await (await request.get(`${API_URL}/projects/${project.id}/releases`)).json()).releases
          .length,
    )
    .toBe(2);
  await expect
    .poll(
      async () =>
        (await (await request.get(`${API_URL}/projects/${project.id}/stats`)).json()).stats
          .totalUsers,
    )
    .toBe(5);

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Release Shop" })).toBeVisible();

  // How many users? Shown right on the issue list, with a high impact badge
  const row = page
    .getByRole("row")
    .filter({ hasText: "TypeError: cart.total is undefined" })
    .first();
  await expect(row).toContainText("80%");
  await expect(row.getByText("High impact")).toBeVisible();

  // Which release introduced it?
  await row.getByRole("link", { name: /TypeError/ }).click();
  await expect(page.locator(".mini-stat").filter({ hasText: "Introduced in" })).toContainText(
    "1.1.0",
  );

  // The release page agrees, and comparing 1.0.0 with 1.1.0 lists it as new
  await page.locator(".mini-stat").filter({ hasText: "Introduced in" }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Release 1.1.0" })).toBeVisible();
  await expect(page.locator("section").filter({ hasText: "New in this release" })).toContainText(
    "cart.total is undefined",
  );

  await page.getByRole("link", { name: "Releases", exact: true }).first().click();
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.locator("section").filter({ hasText: "New in 1.1.0" })).toContainText(
    "cart.total",
  );
  await expect(page.locator("section").filter({ hasText: "Gone in 1.1.0" })).toContainText(
    "Slow payment",
  );
});
