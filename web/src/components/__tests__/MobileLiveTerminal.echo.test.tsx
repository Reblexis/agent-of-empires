// @vitest-environment jsdom
//
// Typing shows on screen before the server echoes it
// (docs/guides/web/terminal.md, "Typing echoes locally").

import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EchoTracker } from "../../lib/liveEcho";
import type { LiveFrame } from "../../hooks/useLiveTerminal";
import { installResizeObserver, liveFrame, renderLiveTerminal } from "./liveTerminalHarness";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({
    settings: { mobileFontSize: 14, desktopFontSize: 14 },
    update: vi.fn(),
  }),
}));
installResizeObserver();

const PROMPT = "❯ ";
type FrameOpts = { trimmed?: boolean; split?: boolean };
const frameWith = (input: string, opts: FrameOpts = {}): LiveFrame =>
  liveFrame({
    // capture-pane -N keeps every row at the pane's full width; the live
    // stream's rows end at their last visible character (`trimmed`).
    content: [`${PROMPT}${input}`, "", "status"]
      .map((l) => `${opts.trimmed ? l.replace(/ +$/, "") : l.padEnd(20)}\n`)
      .join(""),
    rows: 3,
    history: 0,
    cursor: { x: 2 + input.length, y: 0 },
    ...(opts.split ? { pane0: { cols: 20, rows: 3 } } : {}),
  });

function mount(predictEcho = true, delivered = true) {
  const sendData = vi.fn((_data: string) => delivered);
  const view = renderLiveTerminal({
    frame: frameWith(""),
    sendData,
    predictEcho,
  });
  // A soft or hardware key lands as the browser applies it: the value grows, then `input` fires.
  const type = (data: string) =>
    act(() => {
      const input = view.input();
      input.value = input.value + data;
      input.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data,
          bubbles: true,
        }),
      );
    });
  const frame = (input: string, predict = predictEcho, opts: FrameOpts = {}) =>
    view.rerenderWith({ frame: frameWith(input, opts), predictEcho: predict });
  const frameRaw = (f: LiveFrame) => view.rerenderWith({ frame: f });
  const screen = () => view.content().textContent ?? "";
  const sent = () => sendData.mock.calls.map((c) => c[0]);
  return { sendData, sent, type, frame, frameRaw, screen };
}

describe("MobileLiveTerminal local echo", () => {
  it("shows typed characters before the server's snapshot, then gives way to it without doubling", () => {
    const t = mount();
    // The prompt has not echoed this browser yet: the first key waits.
    t.type("h");
    expect(t.sendData).toHaveBeenCalledWith("h");
    expect(t.screen()).not.toContain(`${PROMPT}h`);
    t.frame("h");
    t.type("i");
    expect(t.screen()).toContain(`${PROMPT}hi`);
    t.frame("hi");
    expect(t.screen()).toContain(`${PROMPT}hi`);
    expect(t.screen()).not.toContain(`${PROMPT}hii`);
  });

  it("predicts nothing while this browser may not type", () => {
    const t = mount(false);
    t.type("h");
    t.frame("h", false);
    t.type("i");
    expect(t.screen()).not.toContain(`${PROMPT}hi`);
  });

  it("predicts nothing for a key the pane never received", () => {
    const t = mount(true, false);
    t.type("h");
    t.frame("h");
    t.type("i");
    expect(t.screen()).not.toContain(`${PROMPT}hi`);
  });

  // 2026-10-10: after typing a space the dashboard showed "Something went
  // wrong", or keys stopped reaching the session until Enter.
  it("typing after a space still reaches the session", () => {
    const t = mount();
    t.frame("", true, { trimmed: true });
    t.type("a");
    t.frame("a", true, { trimmed: true });
    t.type(" ");
    t.frame("a ", true, { trimmed: true });
    t.type("b");
    t.type("c");
    expect(t.sent()).toEqual(["a", " ", "b", "c"]);
    t.frame("a bc", true, { trimmed: true });
    expect(t.screen()).toContain(`${PROMPT}a bc`);
    expect(t.screen()).not.toContain(`${PROMPT}a bcbc`);
  });

  it("typing on the second line of a multi-line message reaches the session", () => {
    const t = mount();
    // Claude after Shift+Enter: the cursor sits indented on a row the app
    // never wrote, so the row arrives empty.
    const secondLine: LiveFrame = {
      ...frameWith("one two", { trimmed: true }),
      content: [`${PROMPT}one two`, "", "status"].map((l) => `${l}\n`).join(""),
      cursor: { x: 2, y: 1 },
    };
    t.frameRaw(secondLine);
    t.type("t");
    t.type("h");
    expect(t.sent()).toEqual(["t", "h"]);
    expect(t.screen()).toContain("status");
  });

  it("a window split into panes predicts nothing", () => {
    const t = mount();
    t.frame("", true, { split: true });
    t.type("h");
    t.frame("h", true, { split: true });
    t.type("i");
    expect(t.sendData).toHaveBeenCalledWith("i");
    expect(t.screen()).not.toContain(`${PROMPT}hi`);
  });

  it("a key is sent even when predicting it fails", () => {
    const spy = vi.spyOn(EchoTracker.prototype, "input").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const t = mount();
      expect(() => t.type("h")).not.toThrow();
      expect(t.sendData).toHaveBeenCalledWith("h");
    } finally {
      spy.mockRestore();
    }
  });

  it("the view shows the server's screen when settling predictions fails", () => {
    const spy = vi.spyOn(EchoTracker.prototype, "reconcile").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const t = mount();
      t.type("h");
      expect(() => t.frame("h")).not.toThrow();
      expect(t.screen()).toContain(`${PROMPT}h`);
      expect(t.screen()).toContain("status");
    } finally {
      spy.mockRestore();
    }
  });
});
