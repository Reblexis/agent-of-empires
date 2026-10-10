// @vitest-environment jsdom
//
// Typing shows on screen before the server echoes it
// (docs/guides/web/terminal.md, "Typing echoes locally").

import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MobileLiveTerminal } from "../MobileLiveTerminal";
import { EchoTracker } from "../../lib/liveEcho";
import type { LiveFrame } from "../../hooks/useLiveTerminal";

vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({ settings: { mobileFontSize: 14, desktopFontSize: 14 }, update: vi.fn() }),
}));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const PROMPT = "❯ ";
const frameWith = (input: string, opts: { trimmed?: boolean; split?: boolean } = {}): LiveFrame => ({
  // capture-pane -N keeps every row at the pane's full width; the live
  // stream's rows end at their last visible character (`trimmed`).
  content: [`${PROMPT}${input}`, "", "status"]
    .map((l) => `${opts.trimmed ? l.replace(/ +$/, "") : l.padEnd(20)}\n`)
    .join(""),
  rows: 3,
  history: 0,
  cursor: { x: 2 + input.length, y: 0 },
  altScreen: false,
  mouse: false,
  mouseSgr: false,
  ...(opts.split ? { pane0: { cols: 20, rows: 3 } } : {}),
});

function mount(predictEcho = true) {
  const sendData = vi.fn();
  const inputRef = createRef<HTMLTextAreaElement>();
  const props = (frame: LiveFrame, predict = predictEcho) => (
    <MobileLiveTerminal
      frame={frame}
      connected
      active
      reading={false}
      sendResize={vi.fn()}
      setWindow={vi.fn()}
      setCadence={vi.fn()}
      enterReading={vi.fn()}
      returnToLive={vi.fn()}
      sendData={sendData}
      uploadPastedImage={vi.fn().mockResolvedValue(null)}
      forwardWheel={vi.fn()}
      forwardButton={vi.fn()}
      ctrlActiveRef={createRef<boolean>() as React.RefObject<boolean>}
      clearCtrl={vi.fn()}
      inputRef={inputRef}
      onInputFocusChange={vi.fn()}
      bottomAlign
      keyboardOpen={false}
      predictEcho={predict}
    />
  );
  const view = render(props(frameWith("")));
  const type = (data: string) =>
    act(() => {
      inputRef.current!.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "insertText", data, bubbles: true, cancelable: true }),
      );
    });
  const frame = (input: string, predict = predictEcho, opts: { trimmed?: boolean; split?: boolean } = {}) =>
    view.rerender(props(frameWith(input, opts), predict));
  const frameRaw = (f: LiveFrame) => view.rerender(props(f));
  const screen = () => view.container.querySelector("[data-live-content]")!.textContent ?? "";
  return { sendData, type, frame, frameRaw, screen };
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
    expect(t.sendData.mock.calls.map((c) => c[0])).toEqual(["a", " ", "b", "c"]);
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
    expect(t.sendData.mock.calls.map((c) => c[0])).toEqual(["t", "h"]);
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
