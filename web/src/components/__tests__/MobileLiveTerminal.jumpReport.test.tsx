// @vitest-environment jsdom
//
// docs/development/logging.md: the live terminal reports, at warn with target
// `live-terminal.jump`, any time its view moves up by more than a row although
// the user did not scroll up (no upward wheel, touch, or press on the scroller
// in the last half second), with the scroll geometry and follow state. At most
// one report per 10 seconds. Reported twice as "it scrolls up when I'm trying
// to scroll down" without a reproduction; the report is how the next one gets
// traced.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  LINE_H,
  installResizeObserver,
  liveFrame,
  renderLiveTerminal,
} from "./liveTerminalHarness";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({
    settings: { mobileFontSize: 14, desktopFontSize: 14 },
    update: vi.fn(),
  }),
}));
installResizeObserver();

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/logger", () => ({ reportError: reportErrorMock }));

const CLIENT_HEIGHT = 200;
let scrollHeight = 1000;
const bottom = () => scrollHeight - CLIENT_HEIGHT;
const scrollTops = new WeakMap<Element, number>();
const saved = ["clientHeight", "scrollHeight", "scrollTop"].map(
  (p) =>
    [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)] as const,
);

beforeAll(() => {
  const define = (p: string, d: PropertyDescriptor) =>
    Object.defineProperty(HTMLElement.prototype, p, {
      configurable: true,
      ...d,
    });
  define("clientHeight", { get: () => CLIENT_HEIGHT });
  define("scrollHeight", { get: () => scrollHeight });
  // Clamped like a real scroller, so a content shrink pulls scrollTop to the new bottom.
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
  for (const [p, d] of saved)
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
});
beforeEach(() => {
  scrollHeight = 1000;
});

let seq = 0;
/** A fresh frame each call, so the pin effect re-runs like a streamed frame. */
const nextFrame = () => liveFrame({ content: `frame ${++seq}\n` });

function mount(over = {}) {
  const view = renderLiveTerminal({ frame: nextFrame(), ...over });
  const stream = () => view.rerenderWith({ frame: nextFrame() });
  const scrollTo = (top: number) => {
    view.scroller.scrollTop = top;
    fireEvent.scroll(view.scroller);
  };
  // A browser fires a scroll event for the initial pin; jsdom does not.
  fireEvent.scroll(view.scroller);
  return { ...view, stream, scrollTo };
}

beforeEach(() => {
  reportErrorMock.mockClear();
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const jumpReports = () =>
  reportErrorMock.mock.calls.filter(
    ([, ctx]) => ctx?.target === "live-terminal.jump",
  );

function moveTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

describe("MobileLiveTerminal jump report", () => {
  it("reports a view that moves up without the user scrolling up", () => {
    const { scroller } = mount();
    expect(scroller.scrollTop).toBe(bottom());
    vi.advanceTimersByTime(1000);

    moveTo(scroller, bottom() - 5 * LINE_H);

    expect(jumpReports()).toHaveLength(1);
    const [message, ctx] = jumpReports()[0]!;
    expect(ctx.level).toBe("warn");
    expect(String(message)).toContain(
      `scrollTop ${Math.round(bottom())} -> ${Math.round(bottom() - 5 * LINE_H)}`,
    );
    expect(String(message)).toContain(`clientHeight ${CLIENT_HEIGHT}`);
    expect(String(message)).toMatch(/detached (true|false)/);
    expect(String(message)).toMatch(/coarse (true|false)/);
  });

  it("does not report an upward wheel scroll", () => {
    const { scroller } = mount();
    vi.advanceTimersByTime(1000);
    fireEvent.wheel(scroller, { deltaY: -100 });
    moveTo(scroller, bottom() - 5 * LINE_H);
    expect(jumpReports()).toHaveLength(0);
  });

  it("reports a move up that comes more than half a second after the last upward wheel", () => {
    const { scroller } = mount();
    fireEvent.wheel(scroller, { deltaY: -100 });
    vi.advanceTimersByTime(600);
    moveTo(scroller, bottom() - 5 * LINE_H);
    expect(jumpReports()).toHaveLength(1);
  });

  it("reports a move up while the user wheels down", () => {
    const { scroller } = mount();
    moveTo(scroller, bottom() - 20 * LINE_H);
    reportErrorMock.mockClear();
    vi.advanceTimersByTime(11_000);
    fireEvent.wheel(scroller, { deltaY: 100 });
    moveTo(scroller, bottom() - 30 * LINE_H);
    expect(jumpReports()).toHaveLength(1);
  });

  it("does not report a press on the scroller (scrollbar drag)", () => {
    const { scroller } = mount();
    vi.advanceTimersByTime(1000);
    fireEvent.pointerDown(scroller, { pointerType: "mouse", button: 0 });
    moveTo(scroller, bottom() - 5 * LINE_H);
    fireEvent.pointerUp(window, { pointerType: "mouse", button: 0 });
    expect(jumpReports()).toHaveLength(0);
  });

  it("does not report a touch drag", () => {
    const { scroller } = mount();
    vi.advanceTimersByTime(1000);
    fireEvent.touchStart(scroller, { touches: [{ clientX: 10, clientY: 10 }] });
    moveTo(scroller, bottom() - 5 * LINE_H);
    expect(jumpReports()).toHaveLength(0);
  });

  it("does not report a move up of less than a row", () => {
    const { scroller } = mount();
    vi.advanceTimersByTime(1000);
    moveTo(scroller, bottom() - LINE_H / 2);
    expect(jumpReports()).toHaveLength(0);
  });

  it("does not report a move down", () => {
    const { scroller } = mount();
    moveTo(scroller, bottom() - 20 * LINE_H);
    reportErrorMock.mockClear();
    vi.advanceTimersByTime(11_000);
    moveTo(scroller, bottom() - 10 * LINE_H);
    expect(jumpReports()).toHaveLength(0);
  });

  it("reports at most once per 10 seconds", () => {
    const { scroller } = mount();
    vi.advanceTimersByTime(1000);
    moveTo(scroller, bottom() - 5 * LINE_H);
    moveTo(scroller, bottom() - 10 * LINE_H);
    vi.advanceTimersByTime(9_000);
    moveTo(scroller, bottom() - 15 * LINE_H);
    expect(jumpReports()).toHaveLength(1);
    vi.advanceTimersByTime(1_100);
    moveTo(scroller, bottom() - 20 * LINE_H);
    expect(jumpReports()).toHaveLength(2);
  });
});
