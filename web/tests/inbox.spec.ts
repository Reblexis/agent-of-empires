import { test, expect } from "./helpers/mockedTest";
import { mockSessionsList } from "./helpers/sessions";
import { iPhone13 } from "./helpers/viewports";

const sessions = () => [
  { id: "ads", title: "Ad budget", unread: true, priority: 8, priority_reason: "Approve the 40 EUR ad budget" },
  { id: "report", title: "Weekly report", unread: true, priority: 3 },
  { id: "seen", title: "Already read", unread: false, priority: 9 },
  { id: "busy", title: "Still working", status: "Running", unread: true, priority: 0 },
];

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", iPhone13.viewport],
] as const) {
  test(`${name} home screen says where to go next, and a tap opens that session`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockSessionsList(page, sessions);
    await page.goto("/");
    const next = page.getByTestId("inbox-next");
    await expect(next).toContainText("Ad budget");
    await expect(next).toContainText("Approve the 40 EUR ad budget");
    const rest = page.getByTestId("inbox-entry");
    await expect(rest).toHaveCount(1);
    await expect(rest).toContainText("Weekly report");
    await expect(rest).toContainText("Finished");
    await expect(page.getByTestId("inbox")).not.toContainText("Already read");
    await expect(page.getByTestId("inbox")).not.toContainText("Still working");
    await next.click();
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
