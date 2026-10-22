import { test, expect } from "./helpers/mockedTest";
import type { Page } from "@playwright/test";
import { mockTerminalApis, type MockHandle } from "./helpers/terminal-mocks";
import { liveTexts, openLiveSession } from "./helpers/liveTerminal";

// docs/guides/web/terminal.md: "Scrolling up into history surfaces a Back to
// live button; scrolling back to the bottom (or clicking it) returns to the
// live tail." Reported as "it autoscrolls up from time to time and when I
// scroll back down it jumps up again": after a wheel trip up and back down,
// the view stopped following, so every new line of output left it further
// above the bottom.
test.describe("Desktop live tail", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });

  const ROWS = 30;
  // `blankFoot`: Claude's inline UI after its dynamic region shrank, the
  // prompt and the status bar on top and blank rows below them to the bottom
  // of the screen. Otherwise the screen is full down to the status bar.
  let blankFoot = true;
  function frame(history: number) {
    const lines: string[] = [];
    for (let i = 1; i <= history; i++) lines.push(`output line ${i}`);
    lines.push("❯ ");
    if (blankFoot) {
      lines.push("  status bar");
      for (let i = 2; i < ROWS; i++) lines.push("");
    } else {
      for (let i = 1; i < ROWS - 3; i++) lines.push(`screen line ${i}`);
      lines.push("❯ typed");
      lines.push("  status bar");
      lines.push("  mode line");
    }
    return {
      content: lines.join("\n") + "\n",
      rows: ROWS,
      history,
      cursor: blankFoot ? { x: 2, y: 0 } : { x: 8, y: ROWS - 3 },
    };
  }

  function scroller(page: Page) {
    return page.locator("[data-live-terminal] > div").first();
  }
  const gap = (page: Page) =>
    scroller(page).evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
    );

  async function open(page: Page): Promise<MockHandle> {
    return openLiveSession(page, await mockTerminalApis(page));
  }

  async function stream(
    page: Page,
    handle: MockHandle,
    from: number,
    count: number,
  ) {
    for (let h = from; h < from + count; h++) {
      handle.pushLiveFrame(frame(h));
      await page.waitForTimeout(40);
    }
  }

  test("scrolling back down to the bottom with the wheel follows new output again", async ({
    page,
  }) => {
    const handle = await open(page);
    await stream(page, handle, 200, 10);
    await expect.poll(() => gap(page)).toBeLessThan(2);

    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(50);
    }
    await expect.poll(() => gap(page)).toBeGreaterThan(200);
    // Output keeps arriving while the user reads.
    await stream(page, handle, 210, 5);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }
    await expect.poll(() => gap(page)).toBeLessThan(2);

    await stream(page, handle, 215, 20);
    expect(
      await gap(page),
      "the view follows output after returning to the bottom",
    ).toBeLessThan(2);
  });

  test("a scroll down that stops a few pixels short of the bottom follows new output again", async ({
    page,
  }) => {
    // A trackpad or an uneven wheel rarely lands on the exact last pixel.
    // Ending inside the live-edge band returns the view to live, which trims
    // the screen's trailing blank rows; the page shrinks under the user and
    // the browser moves the scroll up to the new bottom. The view must follow
    // output from there, not treat that move as the user scrolling away.
    const handle = await open(page);
    await stream(page, handle, 200, 10);
    await expect.poll(() => gap(page)).toBeLessThan(2);

    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(50);
    }
    await expect.poll(() => gap(page)).toBeGreaterThan(200);
    await page.waitForTimeout(300);
    const away = await gap(page);
    await page.mouse.wheel(0, away - 8);
    await page.waitForTimeout(400);
    // More notches at the bottom move nothing, as for the user.
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }
    await expect.poll(() => gap(page)).toBeLessThan(2);

    await stream(page, handle, 210, 20);
    expect(
      await gap(page),
      "the view follows output after returning to the live edge",
    ).toBeLessThan(2);
  });

  test("a scroll down that stops a few pixels short of the bottom of a full screen follows new output", async ({
    page,
  }) => {
    // Same stop inside the live-edge band, on a screen with no blank rows to
    // trim: nothing moves the scroll afterwards, and the user scrolls no
    // further. The view still counts as back at the live tail.
    blankFoot = false;
    const handle = await open(page);
    await stream(page, handle, 200, 10);
    await expect.poll(() => gap(page)).toBeLessThan(2);

    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(50);
    }
    await expect.poll(() => gap(page)).toBeGreaterThan(200);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, (await gap(page)) - 8);
    await page.waitForTimeout(400);

    await stream(page, handle, 210, 20);
    expect(
      await gap(page),
      "the view follows output after returning to the live edge",
    ).toBeLessThan(2);
  });

  test("the bottom rows stay in view after the window was once taller", async ({
    page,
  }) => {
    // Reported as "when I scroll down it just goes up again", a few lines: the
    // terminal pinned the live edge to the cursor row as if a soft keyboard
    // covered the bottom, because the window had been taller at this width
    // once. On a desktop nothing covers the bottom; the live edge is the
    // literal bottom, status rows included.
    blankFoot = false;
    const handle = await open(page);
    await stream(page, handle, 200, 10);
    await expect.poll(() => gap(page)).toBeLessThan(2);

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.waitForTimeout(600);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(600);
    await stream(page, handle, 210, 5);
    expect(
      await gap(page),
      "the live edge after the window shrank back",
    ).toBeLessThan(2);

    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);
    await stream(page, handle, 215, 10);
    expect(await gap(page), "scrolling down stays at the bottom").toBeLessThan(
      2,
    );
  });

  test("output streaming while the user sits at the bottom never moves the view up", async ({
    page,
  }) => {
    // 60 frames with a geometry read after each; Firefox needs more than the default 30s.
    test.setTimeout(90_000);
    const handle = await open(page);
    let worst = 0;
    for (let h = 200; h < 260; h++) {
      handle.pushLiveFrame(frame(h));
      await page.waitForTimeout(40);
      if (h > 205) worst = Math.max(worst, await gap(page));
    }
    expect(worst).toBeLessThan(2);
  });
  // docs/guides/web/terminal.md: the pane's rows come from the tallest the terminal has been at its current width,
  // so a shorter terminal never shrinks the agent's pane. Reported as "I just can't scroll down, it goes up when I
  // try": the terminal's height wobbled by a row (594 vs 572 px), every wobble resized tmux, the agent redrew, and
  // the view moved under the reader.
  test("a terminal one row shorter, then back, never resizes the agent's pane", async ({
    page,
  }) => {
    const handle = await open(page);
    await stream(page, handle, 200, 5);
    const resizes = () =>
      liveTexts(handle)
        .filter((m) => m.startsWith("{"))
        .map((m) => JSON.parse(m) as { type?: string; rows?: number })
        .filter((m) => m.type === "resize");
    await expect.poll(() => resizes().length).toBeGreaterThan(0);
    const settled = resizes().length;
    for (let i = 0; i < 3; i++) {
      await page.setViewportSize({ width: 1280, height: 778 });
      await page.waitForTimeout(400);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(400);
    }
    expect(
      resizes().slice(settled),
      "no resize after the height wobbles",
    ).toEqual([]);
  });
});
