import { expect, test } from "@playwright/test";

const API_URL = "http://localhost:3098";
const MAILPIT_URL = "http://localhost:8025";

// F13 acceptance: a responder can acknowledge from an email link,
// and the dashboard shows who acknowledged and when
test("acknowledge an incident from the email link", async ({ page, request, browser }) => {
  const email = `e2e-incidents-${Date.now()}@example.com`;
  const password = "e2e-password-123";

  // Signup gives the account an "Account email" channel, so incidents email this address
  await request.post(`${API_URL}/auth/signup`, { data: { email, password, name: "Ada" } });
  await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  const { organizations } = await (await request.get(`${API_URL}/orgs`)).json();
  const { project } = await (
    await request.post(`${API_URL}/orgs/${organizations[0].id}/projects`, {
      data: { name: "Incident Shop", platform: "node" },
    })
  ).json();
  await request.post(`${API_URL}/projects/${project.id}/alert-rules`, {
    data: { name: "Every new error", conditions: [{ type: "new_issue" }], severity: "critical" },
  });

  const res = await request.post(`${API_URL}/api/${project.id}/events`, {
    headers: { "x-pulse-key": new URL(project.dsn).username },
    data: { exception: { type: "TypeError", value: "order.total is undefined" } },
  });
  expect(res.status()).toBe(202);

  // 1. The email arrives in Mailpit with an "Acknowledge" link
  let text = "";
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT_URL}/api/v1/search`, {
          params: { query: `to:"${email}"` },
        });
        const id = (await search.json()).messages?.[0]?.ID;
        if (!id) return "";
        text = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${id}`)).json()).Text;
        return text;
      },
      { timeout: 20_000 },
    )
    .toContain("Acknowledge:");
  const link = new URL(text.match(/Acknowledge: (\S+)/)?.[1] ?? "");

  // 2. Open it in a fresh browser (not logged in) and acknowledge
  const outside = await browser.newContext();
  const linkPage = await outside.newPage();
  await linkPage.goto(link.pathname + link.search);
  await expect(linkPage.getByText(/Acknowledging as/)).toContainText("Ada");
  await linkPage.getByRole("button", { name: "Acknowledge" }).click();
  await expect(linkPage.getByRole("status")).toContainText("You acknowledged this");
  await outside.close();

  // 3. The dashboard shows who and when
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("link", { name: "Incidents", exact: true }).click();
  await page.getByRole("tab", { name: "Acknowledged" }).click();
  await page.getByRole("link", { name: /order\.total is undefined/ }).click();

  await expect(page.getByText(/^Ada, /)).toBeVisible(); // "Acknowledged: Ada, <date>"
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText('Opened by alert rule "Every new error"');
  await expect(timeline).toContainText("Ada acknowledged it from a notification link");
});
