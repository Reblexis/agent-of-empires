// @vitest-environment jsdom
// A URL in pane output links with its full href even when tmux wrapped it across full-width rows
// (docs/guides/web/terminal.md, "Copy and scroll").

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHAR_W, installResizeObserver, linesFrame, renderLiveTerminal, stubElementSize } from "./liveTerminalHarness";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({ settings: { mobileFontSize: 14, desktopFontSize: 14 }, update: vi.fn() }),
}));

const WIDTH = 240;
stubElementSize({ clientWidth: () => WIDTH, clientHeight: () => 600 });
const observers = installResizeObserver();

beforeEach(() => {
  vi.useFakeTimers();
  observers.clear();
});
afterEach(() => vi.useRealTimers());

const hrefs = (root: HTMLElement) =>
  [...root.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

it("links both halves of a URL tmux wrapped across full-width rows", () => {
  const cols = Math.floor(WIDTH / CHAR_W);
  expect(cols).toBe(28);
  const first = "see https://a.io/abcdefghijk"; // exactly 28 cells, the URL runs to the edge
  expect(first.length).toBe(cols);
  const view = renderLiveTerminal({ frame: linesFrame([first, "lmno done", "$ "], { rows: 3, history: 0 }) });
  observers.settle(150);
  expect(hrefs(view.content())).toEqual([
    ["https://a.io/abcdefghijk", "https://a.io/abcdefghijklmno"],
    ["lmno", "https://a.io/abcdefghijklmno"],
  ]);
});

it("links every row of a URL longer than the rendered width", () => {
  // Another client widened the window, so the line arrives longer than this view and is wrapped here.
  const url = "https://a.io/" + "x".repeat(40);
  const view = renderLiveTerminal({ frame: linesFrame([url, "$ "], { rows: 2, history: 0 }) });
  observers.settle(150);
  const links = hrefs(view.content());
  expect(links.length).toBe(2);
  expect(links.every(([, href]) => href === url)).toBe(true);
  expect(links.map(([text]) => text).join("")).toBe(url);
});
