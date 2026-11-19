// Viktor, 2026-11-19: "fix the sidebar and window resize too". A terminal that changes width makes tmux re-wrap its
// history and the agent redraw over it ("i cant read shit", 17 Nov). The desktop agent terminal keeps its columns
// and draws its text smaller when it gets narrower.

import { test, expect } from "./helpers/mockedTest";
import type { Page } from "@playwright/test";
import { clickSidebarSession } from "./helpers/sidebar";
import { mockTerminalApis, type MockHandle } from "./helpers/terminal-mocks";

// A real screen does not change with the window; without this the emulated one follows the viewport.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.screen, "width", { get: () => 1920 }));
});

function resizes(mock: MockHandle): { cols: number; rows: number }[] {
  return mock.liveMessages.flatMap((raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; cols?: number; rows?: number };
      return msg.type === "resize" ? [{ cols: msg.cols!, rows: msg.rows! }] : [];
    } catch {
      return [];
    }
  });
}

async function fontPx(page: Page) {
  return page
    .locator("[data-live-terminal] > div")
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function open(page: Page, mock: MockHandle) {
  await page.goto("/");
  await clickSidebarSession(page, "pinch-test");
  await page.locator("[data-live-terminal]").first().waitFor({ state: "visible", timeout: 10_000 });
  await expect.poll(() => resizes(mock).length, { timeout: 5_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(400);
}

test("dragging the session sidebar wider keeps the terminal's columns and shrinks its text", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  const before = resizes(mock).at(-1)!;
  const fullFont = await fontPx(page);

  const handle = page.getByTestId("sidebar-resize-handle");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect(resizes(mock).at(-1)).toEqual(before);
  expect(new Set(resizes(mock).map((r) => r.cols)).size).toBe(1);
  expect(await fontPx(page)).toBeLessThan(fullFont);
});

test("shrinking the browser window keeps the terminal's columns, and the text returns to full size", async ({
  page,
}) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  const before = resizes(mock).at(-1)!;
  const fullFont = await fontPx(page);

  await page.setViewportSize({ width: 1250, height: 900 });
  await page.waitForTimeout(600);
  expect(resizes(mock).at(-1)!.cols).toBe(before.cols);
  expect(await fontPx(page)).toBeLessThan(fullFont);

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  expect(new Set(resizes(mock).map((r) => r.cols)).size).toBe(1);
  expect(await fontPx(page)).toBe(fullFont);
});

test("a window narrower than 70% of the widest re-wraps the terminal at full text size", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, mock);
  const before = resizes(mock).at(-1)!;
  const fullFont = await fontPx(page);

  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(600);
  expect(resizes(mock).at(-1)!.cols).toBeLessThan(before.cols);
  expect(await fontPx(page)).toBe(fullFont);
});
