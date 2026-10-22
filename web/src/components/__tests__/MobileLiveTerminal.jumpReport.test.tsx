// @vitest-environment jsdom
//
// docs/development/logging.md: the live terminal reports, at warn with target
// `live-terminal.jump`, any time its view moves up by more than a row although
// the user did not scroll up (no upward wheel, touch, or press on the scroller
// in the last half second), with the scroll geometry and follow state. At most
// one report per 10 seconds. Reported twice as "it scrolls up when I'm trying
// to scroll down" without a reproduction; the report is how the next one gets
// traced.

import { createRef } from "react";
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
import { fireEvent, render } from "@testing-library/react";
import { MobileLiveTerminal } from "../MobileLiveTerminal";
import type { LiveFrame } from "../../hooks/useLiveTerminal";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({
    settings: { mobileFontSize: 14, desktopFontSize: 14 },
    update: vi.fn(),
  }),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/logger", () => ({ reportError: reportErrorMock }));

const writeClipboardMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clipboard")>()),
  writeClipboard: writeClipboardMock,
}));

const CLIENT_HEIGHT = 200;
const LINE_H = 14 * 1.2; // fontSize * LINE_RATIO

// scrollHeight is mutable so a test can simulate appended output growing the
// document (and thus the live-edge target).
let scrollHeight = 1000;
const bottom = () => scrollHeight - CLIENT_HEIGHT;

const scrollTopStore = new WeakMap<Element, number>();
let savedClientHeight: PropertyDescriptor | undefined;
let savedScrollHeight: PropertyDescriptor | undefined;
let savedScrollTop: PropertyDescriptor | undefined;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  savedClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  savedScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  savedScrollTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return scrollTopStore.get(this) ?? 0;
    },
    set(v: number) {
      // Clamp to the scrollable range like a real scroller, so a content
      // shrink pulls scrollTop down to the new bottom (the case the latch
      // must not mistake for a user scroll-up).
      scrollTopStore.set(this, Math.max(0, Math.min(v, bottom())));
    },
  });
});

afterAll(() => {
  if (savedClientHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      savedClientHeight,
    );
  if (savedScrollHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      savedScrollHeight,
    );
  if (savedScrollTop)
    Object.defineProperty(HTMLElement.prototype, "scrollTop", savedScrollTop);
});

beforeEach(() => {
  scrollHeight = 1000;
});

let frameSeq = 0;
function frame(): LiveFrame {
  // A fresh content string each call so `frame` identity changes and the
  // pinning layout effect re-runs, mimicking a streamed frame.
  frameSeq += 1;
  return {
    content: `frame ${frameSeq}\n`,
    rows: 3,
    history: 1000,
    cursor: null,
    altScreen: false,
    mouse: false,
    mouseSgr: false,
  };
}

function props() {
  return {
    frame: frame(),
    connected: true,
    active: true,
    reading: false,
    sendResize: vi.fn(),
    setWindow: vi.fn(),
    setCadence: vi.fn(),
    enterReading: vi.fn(),
    returnToLive: vi.fn(),
    sendData: vi.fn(),
    forwardWheel: vi.fn(),
    forwardButton: vi.fn(),
    ctrlActiveRef: createRef<boolean>() as React.RefObject<boolean>,
    clearCtrl: vi.fn(),
    inputRef: createRef<HTMLTextAreaElement>(),
    onInputFocusChange: vi.fn(),
    bottomAlign: true,
    keyboardOpen: false,
  };
}

function mount() {
  const { container, rerender } = render(<MobileLiveTerminal {...props()} />);
  const scroller = container.querySelector(
    "[data-live-terminal] > div",
  ) as HTMLElement;
  // A browser fires a scroll event for the initial pin; jsdom does not.
  fireEvent.scroll(scroller);
  const stream = () => rerender(<MobileLiveTerminal {...props()} />);
  return { scroller, stream };
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
