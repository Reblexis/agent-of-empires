import { test, expect } from "./helpers/mockedTest";
import { mockSessionsList } from "./helpers/sessions";
import { iPhone13 } from "./helpers/viewports";

const sessions = () => [
  {
    id: "ads",
    title: "Ad budget",
    unread: true,
    priority: 8,
    priority_ask: {
      kind: "decide",
      text: "Approve the 40 EUR ad budget",
      objective: "Telarchy social media",
      link: "https://telarchy.test/ads",
      value: 72,
      minutes: 2,
      options: ["Approve 40 EUR", "No"],
    },
  },
  { id: "report", title: "Weekly report", unread: true, priority: 3 },
  { id: "seen", title: "Already read", unread: false, priority: 9 },
  { id: "busy", title: "Still working", status: "Running", unread: true, priority: 0 },
];

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", iPhone13.viewport],
] as const) {
  test(`${name} home screen queues the asks, and a tap on the top one opens its ask page whose pick goes back to the session`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockSessionsList(page, sessions);
    await page.goto("/");
    const next = page.getByTestId("inbox-next");
    await expect(next).toContainText("Ad budget");
    await expect(next).toContainText("Do this next");
    await expect(next).toContainText("decide");
    await expect(next).toContainText("Approve the 40 EUR ad budget");
    await expect(next).toContainText("Telarchy social media");
    await expect(next).toContainText("2 min");
    const rest = page.getByTestId("inbox-entry");
    await expect(rest).toHaveCount(1);
    await expect(rest).toContainText("Weekly report");
    await expect(rest).toContainText("Read what it finished");
    await expect(page.getByTestId("inbox")).not.toContainText("Already read");
    await expect(page.getByTestId("inbox")).not.toContainText("Still working");
    const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/sessions/ads/send"));
    const read = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/api/sessions/ads/unread"));
    await page.route("**/api/sessions/ads/send", (r) => r.fulfill({ json: { sent: true } }));
    await page.route("**/api/sessions/ads/unread", (r) => r.fulfill({ json: { id: "ads" } }));
    await next.getByRole("button", { name: "Go" }).click();
    await expect(page).toHaveURL(/\/ask\/ads$/);
    const ask = page.getByTestId("ask-page");
    await expect(ask.getByRole("heading", { name: "Approve the 40 EUR ad budget" })).toBeVisible();
    await expect(ask.getByRole("link", { name: "https://telarchy.test/ads" })).toBeVisible();
    await ask.getByRole("button", { name: "Approve 40 EUR" }).click();
    expect((await sent).postDataJSON()).toEqual({
      message: 'Inbox reply to "Approve the 40 EUR ad budget": Approve 40 EUR',
    });
    expect((await read).postDataJSON()).toEqual({ unread: false });
    await expect(page).toHaveURL(/\/$/);
  });
}

test("a long Inbox never pushes the home screen's top out of reach on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockSessionsList(page, () =>
    Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Session ${i}`, unread: true, priority: 5 })),
  );
  await page.goto("/");
  await expect(page.getByTestId("inbox-entry").first()).toBeVisible();
  const heading = page.getByRole("heading", { name: "empires" });
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
});

test("Done marks an ask done elsewhere as read without opening its session", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockSessionsList(page, sessions);
  const patched = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/api/sessions/ads/unread"));
  await page.route("**/api/sessions/ads/unread", (r) => r.fulfill({ json: { id: "ads" } }));
  await page.goto("/");
  await page.getByTestId("inbox-next").getByRole("button", { name: "Done" }).click();
  expect((await patched).postDataJSON()).toEqual({ unread: false });
  await expect(page).toHaveURL(/\/$/);
});

test("an ask page opened by its URL, as a push or a shared link does, shows the ask", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockSessionsList(page, () =>
    sessions().map((s) => (s.id === "ads" ? { ...s, priority_ask: { ...s.priority_ask!, page: true } } : s)),
  );
  await page.route("**/api/sessions/ads/ask/page", (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>40 EUR buys 3k views</p>" }),
  );
  await page.goto("/ask/ads");
  await expect(page.getByTestId("ask-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve the 40 EUR ad budget" })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Ask page"]').getByText("40 EUR buys 3k views")).toBeVisible();
});
