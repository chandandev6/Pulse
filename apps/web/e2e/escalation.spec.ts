import { type APIRequestContext, expect, test } from "@playwright/test";

const API_URL = "http://localhost:3098";
const MAILPIT_URL = "http://localhost:8025";

// The text of the newest email to `to` whose subject matches, once it arrives
async function waitForEmail(
  request: APIRequestContext,
  to: string,
  subject: RegExp,
  timeout: number,
  contains = "Acknowledge:",
) {
  let text = "";
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT_URL}/api/v1/search`, {
          params: { query: `to:"${to}"` },
        });
        const message = (await search.json()).messages?.find((m: { Subject: string }) =>
          subject.test(m.Subject),
        );
        if (!message) return "";
        text = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${message.ID}`)).json())
          .Text;
        return text;
      },
      { timeout, intervals: [2_000] },
    )
    .toContain(contains);
  return text;
}

// F14 acceptance: an unacknowledged incident walks through the levels on time,
// acknowledging stops it, and the history shows who was contacted
test("escalates to the next level when nobody acknowledges", async ({
  page,
  request,
  playwright,
}) => {
  test.setTimeout(150_000); // one real 1-minute level
  const stamp = Date.now();
  const ada = { email: `e2e-esc-ada-${stamp}@example.com`, password: "e2e-password-123" };
  const ben = { email: `e2e-esc-ben-${stamp}@example.com`, password: "e2e-password-123" };

  // Ben signs up in his own session; Ada (the owner) invites him and he accepts from the email
  const benApi = await playwright.request.newContext();
  await benApi.post(`${API_URL}/auth/signup`, { data: { ...ben, name: "Ben" } });
  await request.post(`${API_URL}/auth/signup`, { data: { ...ada, name: "Ada" } });
  await request.post(`${API_URL}/auth/login`, { data: ada });
  const { organizations } = await (await request.get(`${API_URL}/orgs`)).json();
  const orgId = organizations[0].id;
  await request.post(`${API_URL}/orgs/${orgId}/invitations`, {
    data: { email: ben.email, role: "member" },
  });
  const invite = await waitForEmail(request, ben.email, /invited you/, 20_000, "#token=");
  const inviteToken = /#token=([\w-]+)/.exec(invite)?.[1];
  await benApi.post(`${API_URL}/auth/login`, { data: ben });
  await benApi.post(`${API_URL}/invitations/accept`, { data: { token: inviteToken } });
  const { user: adaUser } = await (await request.get(`${API_URL}/auth/me`)).json();
  const { members } = await (await request.get(`${API_URL}/orgs/${orgId}/members`)).json();
  const benId = members.find((m: { email: string }) => m.email === ben.email).userId;

  const { project } = await (
    await request.post(`${API_URL}/orgs/${orgId}/projects`, {
      data: { name: "Escalation Shop", platform: "node" },
    })
  ).json();

  // Level 1: Ada for 1 minute. Level 2: Ben.
  const { policy } = await (
    await request.post(`${API_URL}/orgs/${orgId}/escalation-policies`, {
      data: {
        name: "Ada then Ben",
        levels: [
          { timeoutMinutes: 1, targets: [{ type: "user", id: adaUser.id }] },
          { timeoutMinutes: 1, targets: [{ type: "user", id: benId }] },
        ],
      },
    })
  ).json();
  await request.post(`${API_URL}/projects/${project.id}/alert-rules`, {
    data: {
      name: "Every new error",
      conditions: [{ type: "new_issue" }],
      severity: "critical",
      escalationPolicyId: policy.id,
    },
  });

  await request.post(`${API_URL}/api/${project.id}/events`, {
    headers: { "x-pulse-key": new URL(project.dsn).username },
    data: { exception: { type: "TypeError", value: "stock.count is undefined" } },
  });

  // 1. Ada (level 1) is told right away; Ben isn't
  await waitForEmail(request, ada.email, /^\[CRITICAL\] Escalation Shop/, 20_000);

  // 2. Nobody acknowledges: about a minute later Ben (level 2) gets an ESCALATED email
  const benMail = await waitForEmail(request, ben.email, /ESCALATED/, 100_000);
  const link = new URL(benMail.match(/Acknowledge: (\S+)/)?.[1] ?? "");

  // 3. Ben acknowledges from his link
  await page.goto(link.pathname + link.search + link.hash);
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("status")).toContainText("You acknowledged this");

  // 4. Ada's dashboard shows the whole story
  const { incidents } = await (
    await request.get(`${API_URL}/projects/${project.id}/incidents?status=acknowledged`)
  ).json();
  expect(incidents).toHaveLength(1);
  const detail = await (await request.get(`${API_URL}/incidents/${incidents[0].id}`)).json();
  expect(detail.incident).toMatchObject({
    acknowledgedBy: { name: "Ben" },
    escalationStep: 1,
    nextEscalationAt: null,
  });
  expect(detail.timeline.map((step: { kind: string }) => step.kind)).toEqual([
    "triggered",
    "notified",
    "escalated",
    "acknowledged",
  ]);
  await benApi.dispose();
});
