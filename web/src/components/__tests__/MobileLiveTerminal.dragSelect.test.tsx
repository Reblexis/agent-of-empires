// @vitest-environment jsdom
// A desktop drag-select in the live terminal (docs/guides/web/terminal.md, "Copy and scroll"): streamed frames must not
// scroll the text under the pointer mid-drag, and releasing the drag copies the selection.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { LINE_H, installResizeObserver, liveFrame, renderLiveTerminal } from "./liveTerminalHarness";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({ settings: { mobileFontSize: 14, desktopFontSize: 14 }, update: vi.fn() }),
}));
const writeClipboard = vi.hoisted(() => vi.fn());
vi.mock("../../lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clipboard")>()),
  writeClipboard,
}));
installResizeObserver();

const CLIENT_HEIGHT = 200;
let scrollHeight = 1000;
const bottom = () => scrollHeight - CLIENT_HEIGHT;
const scrollTops = new WeakMap<Element, number>();
const saved = ["clientHeight", "scrollHeight", "scrollTop"].map(
  (p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)] as const,
);

beforeAll(() => {
  const define = (p: string, d: PropertyDescriptor) =>
    Object.defineProperty(HTMLElement.prototype, p, { configurable: true, ...d });
  define("clientHeight", { get: () => CLIENT_HEIGHT });
  define("scrollHeight", { get: () => scrollHeight });
  define("scrollTop", {
    get() {
      return scrollTops.get(this) ?? 0;
    },
    set(v: number) {
      scrollTops.set(this, Math.max(0, Math.min(v, bottom())));
    },
  });
});
afterAll(() => {
  for (const [p, d] of saved) if (d) Object.defineProperty(HTMLElement.prototype, p, d);
});
beforeEach(() => {
  scrollHeight = 1000;
  writeClipboard.mockClear();
  window.getSelection()?.removeAllRanges();
});

let seq = 0;
const nextFrame = () => liveFrame({ content: `frame ${++seq}\n` });

function mount() {
  const view = renderLiveTerminal({ frame: nextFrame() });
  const stream = () => view.rerenderWith({ frame: nextFrame() });
  return { ...view, stream };
}

/** Selects the first rendered row's text, as a drag across it would. */
function selectFirstText(scroller: HTMLElement) {
  const content = scroller.querySelector("[data-live-content]")!;
  const textNode = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!;
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return textNode.textContent;
}

describe("MobileLiveTerminal drag-select", () => {
  it("suspends the follow pin while a mouse selection drag is held, resumes on release", () => {
    // Regression: streamed frames re-pinning scrollTop during a desktop
    // drag-select scrolled the text up under the pointer, so the finished
    // selection covered rows above the intended ones.
    const { scroller, stream } = mount();
    expect(scroller.scrollTop).toBe(bottom());
    const held = scroller.scrollTop;

    fireEvent.pointerDown(scroller, { pointerType: "mouse", button: 0 });
    scrollHeight += 2 * LINE_H;
    stream();
    stream();
    expect(scroller.scrollTop).toBe(held);

    fireEvent.pointerUp(window, { pointerType: "mouse", button: 0 });
    scrollHeight += LINE_H;
    stream();
    expect(scroller.scrollTop).toBe(bottom());
  });

  it("copies the selection to the clipboard when the drag releases", () => {
    const { scroller } = mount();
    fireEvent.pointerDown(scroller, { pointerType: "mouse", button: 0 });
    const text = selectFirstText(scroller);
    fireEvent.pointerUp(window, { pointerType: "mouse", button: 0 });
    expect(writeClipboard).toHaveBeenCalledWith(text);
  });

  it("a release with no drag over the terminal copies nothing", () => {
    const { scroller } = mount();
    selectFirstText(scroller);
    fireEvent.pointerUp(window, { pointerType: "mouse", button: 0 });
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("a drag ending in a selection outside the terminal copies nothing", () => {
    const { scroller } = mount();
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    try {
      fireEvent.pointerDown(scroller, { pointerType: "mouse", button: 0 });
      const range = document.createRange();
      range.selectNodeContents(outside);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.pointerUp(window, { pointerType: "mouse", button: 0 });
      expect(writeClipboard).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });
});
