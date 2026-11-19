// Viktor, 2026-11-17: "sometimes weird stuff iwth the sseesion happens like this and i cant read shit". A terminal
// that changes width makes tmux re-wrap its history and the agent redraw over it, leaving duplicated, broken lines.
// The right dock therefore lies over a terminal session instead of squeezing it.

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

async function terminalWidth(page: Page) {
  return (await page.locator("[data-live-terminal]").first().boundingBox())!.width;
}

test("the terminal keeps its width and columns when the side panel closes", async ({ page }) => {
  const mock = await mockTerminalApis(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await clickSidebarSession(page, "pinch-test");
  await page.locator("[data-live-terminal]").first().waitFor({ state: "visible", timeout: 10_000 });
  const handle = page.getByTestId("content-split-resize-handle");
  await expect(handle).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => resizeCols(mock).length, { timeout: 5_000 }).toBeGreaterThan(0);

  const openWidth = await terminalWidth(page);
  const openCols = resizeCols(mock).at(-1);

  await handle.dblclick();
  await expect(handle).toBeHidden();
  await page.waitForTimeout(600);
  expect(await terminalWidth(page)).toBe(openWidth);

  expect(new Set(resizeCols(mock))).toEqual(new Set([openCols]));
});

test("the side panel covers the terminal's right edge and Back to live stays beside it", async ({ page }) => {
  await mockTerminalApis(page, { liveHistory: 400 });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await clickSidebarSession(page, "pinch-test");
  const terminal = page.locator("[data-live-terminal]").first();
  await terminal.waitFor({ state: "visible", timeout: 10_000 });
  const dock = page.locator('[data-pane-dock="right"]').first();
  await expect(dock).toBeVisible({ timeout: 10_000 });

  const t = (await terminal.boundingBox())!;
  const d = (await dock.boundingBox())!;
  expect(d.x).toBeLessThan(t.x + t.width - 100);

  await terminal.hover();
  await page.mouse.wheel(0, -2000);
  const back = page.getByRole("button", { name: "Back to live" });
  await expect(back).toBeVisible({ timeout: 5_000 });
  const b = (await back.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(d.x);
});
