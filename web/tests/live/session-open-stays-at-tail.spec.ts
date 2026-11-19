// Regression (Viktor, 18 Nov 2026): "when i go to a session on aoe SOMETImes
// as it loads it first shows itsefl weirdly formatted and then once itloads it
// sacrollls up for me.. fully and i have to scroll backdwon mysel".
//
// docs/guides/web/terminal.md: nothing but the reader's own scroll takes them
// off the live tail. The cause was two things meeting: the terminal had become
// shorter since it was first laid out (a banner or panel arriving), which was
// taken for a soft keyboard, so the view followed the cursor's last known row
// instead of the bottom; and the agent, resized on open, cleared its
// scrollback and printed the whole conversation again with its cursor hidden,
// so that row stayed where the history had been empty. Drives a real
// `aoe serve` + tmux.
import type { Page, Locator } from "@playwright/test";
import { join } from "node:path";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { test, expect } from "../helpers/liveTest";
import { spawnAoeServe, resolveAoeBinary } from "../helpers/aoeServe";
import { clickSidebarSession } from "../helpers/sidebar";

type SeedEnv = { shimBin: string; home: string; env: NodeJS.ProcessEnv };

/** A fake agent that prints 1500 numbered lines and idles on a blank row. `redraw`: like Claude Code, a resize
 *  (or here also a key) clears the screen and the scrollback and prints everything again, over about a second. */
function seedSession(e: SeedEnv, name: string, prefix: string, redraw: boolean) {
  const tool = join(e.shimBin, `dump-${prefix}`);
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
  writeFileSync(
    tool,
    `#!/bin/bash
dump() {
  for i in $(seq 1 1500); do
    echo "${prefix} $i ${filler}"
    ${redraw ? "if (( i % 100 == 0 )); then sleep 0.06; fi" : ""}
  done
  echo "${prefix} READY"
}
# The cursor rests on a row with text for a moment while the history is still nearly empty.
redraw() { printf '\\033[2J\\033[3J\\033[H'; printf '${prefix} redrawing> '; sleep 0.4; printf '\\r\\033[K'; dump; }
trap 'again=1' WINCH
dump
while true; do
  if read -rsn1 -t 0.2 key; then again=1; fi
  if [ -n "$again" ]; then again=; ${redraw ? "redraw" : ":"}; fi
done
`,
  );
  chmodSync(tool, 0o755);
  const pd = join(e.home, `project-${prefix}`);
  mkdirSync(pd, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: pd });
  const r = spawnSync(resolveAoeBinary(), ["add", pd, "-t", name, "-c", "claude", "--cmd-override", tool], {
    env: e.env,
  });
  if (r.status !== 0) throw new Error(String(r.stderr));
}

function activeScroller(page: Page): Locator {
  return page.locator('[aria-hidden="false"] [data-live-terminal] > div, main [data-live-terminal] > div').first();
}

async function waitReady(page: Page, prefix: string) {
  await page
    .locator("[data-live-content]")
    .filter({ hasText: `${prefix} READY` })
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
}

/** How far the view is from the end of the content, in px, and whether the "Back to live" button shows. */
async function tailState(page: Page) {
  const reading = await page.getByRole("button", { name: "Back to live" }).count();
  const geom = await activeScroller(page).evaluate((el) => ({
    fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    scrollHeight: el.scrollHeight,
  }));
  return { ...geom, reading: reading > 0 };
}

/** Samples the view for 8 s: once loaded it sits at the live tail, on the agent's last line, not reading. */
async function expectSettlesAtTail(page: Page) {
  const samples: Awaited<ReturnType<typeof tailState>>[] = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    samples.push(await tailState(page));
  }
  const trace = samples.map((s) => `${s.fromBottom}${s.reading ? "R" : ""}/${s.scrollHeight}`).join(" ");
  for (const s of samples.slice(-6)) {
    expect(s.fromBottom, `at the live tail once loaded (px from the end[R]/content height: ${trace})`).toBeLessThan(40);
    expect(s.reading, `not left in reading mode (${trace})`).toBe(false);
  }
  const visible = await activeScroller(page).evaluate((el) => {
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    return Array.from(el.querySelectorAll<HTMLElement>("[data-live-content] > div"))
      .filter((row) => row.offsetTop >= top && row.offsetTop + row.offsetHeight <= bottom + 1)
      .map((row) => row.textContent ?? "")
      .join("\n");
  });
  expect(visible, "the agent's last line is in view").toContain("alpha READY");
}

/** With AOE_E2E_WEB_SRC set, the page is served from the web source by Vite against the spawned daemon, so a
 *  change can be tried without rebuilding the binary that embeds the bundle. */
async function frontendUrl(baseUrl: string, port: number): Promise<{ url: string; stop: () => void }> {
  if (!process.env.AOE_E2E_WEB_SRC) return { url: baseUrl, stop: () => {} };
  const vite: ChildProcess = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    env: { ...process.env, VITE_PROXY: baseUrl },
    stdio: "ignore",
    detached: true,
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, stop: () => process.kill(-vite.pid!, "SIGTERM") };
}

const WIDE = { width: 1600, height: 900 };
const NARROW = { width: 1000, height: 600 };

const CASES = [
  { name: "the terminal got shorter, then the agent prints its history again", shorter: true },
  { name: "reopened in a narrower window, the agent redraws", redraw: true, from: WIDE, to: NARROW },
  { name: "reopened in a wider window, the agent redraws", redraw: true, from: NARROW, to: WIDE },
  { name: "a plain pane reopened in a narrower window", redraw: false, from: WIDE, to: NARROW },
  { name: "reopened after resting the pointer on it", redraw: true, from: WIDE, to: NARROW, hover: true },
] as const;

for (const [index, c] of CASES.entries()) {
  test(`opening a session shows it weirdly formatted, then scrolls up fully: ${c.name}`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const serve = await spawnAoeServe({
      authMode: "none",
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      seedFn: (e) => {
        spawnSync(resolveAoeBinary(), ["hooks", "approve"], { env: e.env });
        seedSession(e, "alpha-agent", "alpha", "shorter" in c || c.redraw);
        seedSession(e, "beta-other", "beta", false);
      },
    });
    const front = await frontendUrl(serve.baseUrl, 5300 + testInfo.parallelIndex * 10 + index);
    try {
      const first = "shorter" in c ? WIDE : c.from;
      const ctx = await browser.newContext({ viewport: first });
      await ctx.addInitScript(() => {
        localStorage.setItem("aoe-web-settings", JSON.stringify({ sidebarActiveOnly: false }));
      });
      const page = await ctx.newPage();
      await page.goto(front.url);

      await clickSidebarSession(page, "alpha-agent");
      await waitReady(page, "alpha");
      await expectSettlesAtTail(page);

      if ("shorter" in c) {
        // Same width, so the pane keeps its rows and the terminal now shows fewer of them: what a banner or a
        // panel arriving after the first layout does.
        await page.setViewportSize({ width: first.width, height: first.height - 90 });
        await page.waitForTimeout(800);
        await activeScroller(page).click();
        await page.keyboard.press("r");
        await page.waitForTimeout(300);
        await expectSettlesAtTail(page);
        return;
      }

      await clickSidebarSession(page, "beta-other");
      await waitReady(page, "beta");
      await page.waitForTimeout(800);

      // The window changes while alpha is closed, so alpha's pane is still sized for the old one.
      await page.setViewportSize(c.to);
      await page.waitForTimeout(800);
      if ("hover" in c) {
        await page.getByRole("link").filter({ hasText: "alpha-agent" }).first().hover();
        await page.waitForTimeout(700);
      }
      await clickSidebarSession(page, "alpha-agent");
      await expectSettlesAtTail(page);
    } finally {
      front.stop();
      await serve.stop();
    }
  });
}

// Viktor, 19 Nov 2026: "just now the loading is a bit weird and sometimmes it doesnt format correctly cutting at
// half etc". docs/guides/web/terminal.md: the live stream's first screen is the pane at this browser's size.
test("loading is a bit weird, formatted wrong and cut at half: a pane last shown narrower never draws at its old width", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const serve = await spawnAoeServe({
    authMode: "none",
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    seedFn: (e) => {
      spawnSync(resolveAoeBinary(), ["hooks", "approve"], { env: e.env });
      seedSession(e, "alpha-agent", "alpha", false);
    },
  });
  const front = await frontendUrl(serve.baseUrl, 5390 + testInfo.parallelIndex);
  const open = async (viewport: { width: number; height: number }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      localStorage.setItem("aoe-web-settings", JSON.stringify({ sidebarActiveOnly: false }));
      // The longest row of every picture the terminal paints.
      const widths: number[] = [];
      (window as unknown as { __widths: number[] }).__widths = widths;
      const sample = () => {
        const rows = document.querySelectorAll("[data-live-content] > div");
        if (rows.length > 0) {
          let longest = 0;
          for (const row of rows) longest = Math.max(longest, (row.textContent ?? "").trimEnd().length);
          if (longest > 0) widths.push(longest);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const page = await ctx.newPage();
    await page.goto(front.url);
    await clickSidebarSession(page, "alpha-agent");
    await waitReady(page, "alpha");
    await page.waitForTimeout(1500);
    const widths = await page.evaluate(() => (window as unknown as { __widths: number[] }).__widths);
    await ctx.close();
    return widths;
  };
  try {
    const narrow = await open({ width: 800, height: 600 });
    const narrowCols = Math.max(...narrow.slice(-5));
    // A new page, so nothing is remembered: every picture comes from the live stream.
    const wide = await open(WIDE);
    const settled = Math.max(...wide.slice(-5));
    expect(settled, "the wide window fits the whole 108-character line").toBeGreaterThan(narrowCols);
    expect(
      Math.min(...wide),
      `no picture at the old ${narrowCols}-column width (longest row per painted picture: ${wide.slice(0, 40).join(" ")})`,
    ).toBeGreaterThan(narrowCols);
  } finally {
    front.stop();
    await serve.stop();
  }
});
