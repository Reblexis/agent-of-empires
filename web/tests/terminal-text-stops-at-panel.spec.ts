// Viktor, 2026-11-19: "theres problem that the text doesn tproperly stop and instead goess behind the next
// uielement... so theres no proper newlining". The right dock had been laid over the terminal so that opening it
// would not change the terminal's width (17 Nov: "i cant read shit", the agent redrawing over re-wrapped history).
// The dock sits beside the terminal again; its room stays set aside while it is closed, so the width still never
// changes.

import { test, expect } from "./helpers/mockedTest";
import type { Page } from "@playwright/test";
import { clickSidebarSession } from "./helpers/sidebar";
import { mockTerminalApis, type MockHandle } from "./helpers/terminal-mocks";

function resizeCols(mock: MockHandle): number[] {
  return mock.liveMessages.flatMap((raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; cols?: number };
      return msg.type === "resize" && typeof msg.cols === "number" ? [msg.cols] : [];
    } catch {
      return [];
    }
  });
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await clickSidebarSession(page, "pinch-test");
  const terminal = page.locator("[data-live-terminal]").first();
  await terminal.waitFor({ state: "visible", timeout: 10_000 });
  return terminal;
}

test("terminal text stops at the side panel and never goes behind it", async ({ page }) => {
  await mockTerminalApis(page);
  const terminal = await open(page);
  const dock = page.locator('[data-pane-dock="right"]').first();
  await expect(dock).toBeVisible({ timeout: 10_000 });

  const t = (await terminal.boundingBox())!;
  const d = (await dock.boundingBox())!;
  expect(t.x + t.width).toBeLessThanOrEqual(d.x);
});

test("closing the side panel keeps the terminal's width, columns and text size", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  const terminal = await open(page);
  const handle = page.getByTestId("content-split-resize-handle");
  await expect(handle).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => resizeCols(mock).length, { timeout: 5_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(400);

  const fontPx = () =>
    terminal
      .locator("> div")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const openWidth = (await terminal.boundingBox())!.width;
  const openCols = resizeCols(mock).at(-1);
  const openFont = await fontPx();

  await handle.dblclick();
  await expect(handle).toBeHidden();
  await page.waitForTimeout(600);

  expect((await terminal.boundingBox())!.width).toBe(openWidth);
  expect(await fontPx()).toBe(openFont);
  expect(new Set(resizeCols(mock))).toEqual(new Set([openCols]));
});
