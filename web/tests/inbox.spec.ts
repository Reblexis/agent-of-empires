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
  test(`${name} home screen queues the asks, the one to do next on top, and a tap opens that session`, async ({
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
    await expect(next.getByRole("link", { name: "https://telarchy.test/ads" })).toBeVisible();
    const rest = page.getByTestId("inbox-entry");
    await expect(rest).toHaveCount(1);
    await expect(rest).toContainText("Weekly report");
    await expect(rest).toContainText("Read what it finished");
    await expect(page.getByTestId("inbox")).not.toContainText("Already read");
    await expect(page.getByTestId("inbox")).not.toContainText("Still working");
    await next.getByText("Approve the 40 EUR ad budget").click();
    await expect(page).toHaveURL(/\/session\/ads$/);
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
