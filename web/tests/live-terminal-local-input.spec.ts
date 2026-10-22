import { test, expect } from "./helpers/mockedTest";
import type { Page } from "@playwright/test";
import { lastResizeCols, liveContent, openLiveTerminal, scroller } from "./helpers/liveTerminal";
import type { MockHandle } from "./helpers/terminal-mocks";

// Local input features of the live terminal in a real browser (docs/guides/web/terminal.md): typing echoes before
// the server answers, a drag copies on release, a stray Ctrl+V reaches the terminal, and a URL tmux wrapped across
// full-width rows links its whole address.
test.describe("Live terminal local input (desktop)", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    hasTouch: false,
    permissions: ["clipboard-read", "clipboard-write"],
  });

  const input = (page: Page) => page.locator('textarea[aria-label="Live terminal input"]').first();
  const screenOf = (rows: string[]) => [...rows, ...Array<string>(24 - rows.length).fill("")].join("\n") + "\n";
  const typed = (h: MockHandle) => Buffer.concat(h.liveInput).toString();

  test("typing shows at the prompt before the server's frame", async ({ page }) => {
    const handle = await openLiveTerminal(page);
    await handle.pushLiveFrame({ content: screenOf(["❯ "]), rows: 24, history: 0, cursor: { x: 2, y: 0 } });
    await scroller(page).click();
    await expect(input(page)).toBeFocused();

    // The prompt has not echoed this browser yet, so the first key waits for the server.
    await page.keyboard.type("h");
    await expect.poll(() => typed(handle)).toBe("h");
    await handle.pushLiveFrame({ content: screenOf(["❯ h"]), rows: 24, history: 0, cursor: { x: 3, y: 0 } });

    await page.keyboard.type("i");
    await expect.poll(() => typed(handle)).toBe("hi");
    await expect(liveContent(page)).toContainText("❯ hi");

    // The server's echo replaces the prediction without doubling it.
    await handle.pushLiveFrame({ content: screenOf(["❯ hi"]), rows: 24, history: 0, cursor: { x: 4, y: 0 } });
    await expect(liveContent(page)).toContainText("❯ hi");
    await expect(liveContent(page)).not.toContainText("❯ hii");
  });

  test("releasing a drag over the text copies it", async ({ page }) => {
    const handle = await openLiveTerminal(page);
    await handle.pushLiveFrame({ content: screenOf(["alpha beta"]), rows: 24, history: 0, cursor: null });
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    const row = (await page.getByText("alpha beta", { exact: true }).boundingBox())!;
    const y = row.y + row.height / 2;
    await page.mouse.move(row.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width - 1, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("alpha beta");
  });

  test("a Ctrl+V with nothing focused pastes into the terminal", async ({ page }) => {
    const handle = await openLiveTerminal(page);
    await handle.pushLiveFrame({ content: screenOf(["output"]), rows: 24, history: 0, cursor: null });
    await page.evaluate(() => navigator.clipboard.writeText("stray paste"));
    await scroller(page).click();
    // Ending a selection or clicking a link drops focus to <body>.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(input(page)).not.toBeFocused();
    const before = handle.liveMessages.length;
    await page.keyboard.press("Control+v");
    await expect
      .poll(() => handle.liveMessages.slice(before).map((m) => m.toString("utf8")))
      .toContainEqual(JSON.stringify({ type: "paste", text: "stray paste", submit: false }));
    await expect(input(page)).toBeFocused();
  });

  test("a URL wrapped across full-width rows links every part to the whole address", async ({ page }) => {
    const handle = await openLiveTerminal(page);
    await expect.poll(() => lastResizeCols(handle) ?? 0).toBeGreaterThan(20);
    const cols = lastResizeCols(handle)!;
    const head = "see https://a.io/";
    const first = head + "x".repeat(cols - head.length);
    const url = `https://a.io/${"x".repeat(cols - head.length)}yz`;
    await handle.pushLiveFrame({ content: screenOf([first, "yz done"]), rows: 24, history: 0, cursor: null });
    const anchors = page.locator("[data-live-content] a");
    await expect(anchors).toHaveCount(2);
    await expect(anchors.nth(0)).toHaveAttribute("href", url);
    await expect(anchors.nth(1)).toHaveAttribute("href", url);
    await expect(anchors.nth(1)).toHaveText("yz");
  });
});
