// Viktor, 2026-11-19: "now the bug is back again please look at it deeply and figure out root cause". An agent
// prints its whole conversation again whenever its pane's columns change, on top of the lines tmux re-wrapped
// ("i cant read shit", 17 Nov). That day one session's columns changed three times: the dock closed, the sidebar
// collapsed, and a new layout shipped. A session therefore keeps the columns it has; the desktop agent terminal
// draws them in the room it has (docs/guides/web/terminal.md, "Width").

import { test, expect } from "./helpers/mockedTest";
import type { Page } from "@playwright/test";
import { clickSidebarSession } from "./helpers/sidebar";
import { mockTerminalApis, type MockHandle } from "./helpers/terminal-mocks";

function resizes(mock: MockHandle): { cols: number; rows: number; keep?: string }[] {
  return mock.liveMessages.flatMap((raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; cols?: number; rows?: number; keep?: string };
      return msg.type === "resize" ? [{ cols: msg.cols!, rows: msg.rows!, keep: msg.keep }] : [];
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

test("the terminal asks the server to keep the session's columns", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  expect(resizes(mock).every((r) => r.keep === "14")).toBe(true);
});

test("a session wider than the room keeps its columns and is drawn in smaller text", async ({ page }) => {
  const mock = await mockTerminalApis(page, { paneCols: 100 });
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  const asked = resizes(mock).at(-1)!.cols;
  expect(asked).toBeLessThan(100);
  expect(asked).toBeGreaterThan(70);
  expect(new Set(mock.livePaneCols)).toEqual(new Set([100]));

  const font = await fontPx(page);
  expect(font).toBeLessThan(14);
  expect(font).toBeGreaterThan(14 * 0.7);
  // All 100 columns fit the room: the widest line the pane can hold is not cut or wrapped.
  const fits = await page
    .locator("[data-live-terminal]")
    .first()
    .evaluate((el) => {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(100);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      const grid = el.firstElementChild as HTMLElement;
      grid.appendChild(probe);
      const ok = probe.getBoundingClientRect().width <= grid.clientWidth;
      probe.remove();
      return ok;
    });
  expect(fits).toBe(true);
});

test("a session narrower than the room keeps its columns at full text size", async ({ page }) => {
  const mock = await mockTerminalApis(page, { paneCols: 70 });
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  expect(resizes(mock).at(-1)!.cols).toBeGreaterThan(70);
  expect(new Set(mock.livePaneCols)).toEqual(new Set([70]));
  expect(await fontPx(page)).toBe(14);
});

test("dragging the session sidebar wider keeps the session's columns and shrinks the text", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  const fullFont = await fontPx(page);

  const handle = page.getByTestId("sidebar-resize-handle");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect(new Set(mock.livePaneCols).size).toBe(1);
  expect(await fontPx(page)).toBeLessThan(fullFont);
});

test("shrinking the browser window keeps the session's columns, and the text returns to full size", async ({
  page,
}) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  const fullFont = await fontPx(page);

  await page.setViewportSize({ width: 1250, height: 900 });
  await page.waitForTimeout(600);
  expect(await fontPx(page)).toBeLessThan(fullFont);

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);
  expect(new Set(mock.livePaneCols).size).toBe(1);
  expect(await fontPx(page)).toBe(fullFont);
});

test("a wider browser window keeps the session's columns and leaves a margin", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, mock);
  const fullFont = await fontPx(page);

  await page.setViewportSize({ width: 1550, height: 900 });
  await page.waitForTimeout(600);
  expect(new Set(mock.livePaneCols).size).toBe(1);
  expect(await fontPx(page)).toBe(fullFont);
});

test("a room under 70% of the session's columns re-wraps it at full text size", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1700, height: 900 });
  await open(page, mock);
  const before = mock.livePaneCols.at(-1)!;
  const fullFont = await fontPx(page);

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(600);
  expect(mock.livePaneCols.at(-1)!).toBeLessThan(before);
  expect(await fontPx(page)).toBe(fullFont);
});
