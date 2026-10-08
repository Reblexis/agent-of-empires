// @vitest-environment jsdom
//
// Typing shows on screen before the server echoes it
// (docs/guides/web/terminal.md, "Typing echoes locally").

import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MobileLiveTerminal } from "../MobileLiveTerminal";
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
const frameWith = (input: string): LiveFrame => ({
  // capture-pane -N keeps every row at the pane's full width.
  content: [`${PROMPT}${input}`, "", "status"].map((l) => `${l.padEnd(20)}\n`).join(""),
  rows: 3,
  history: 0,
  cursor: { x: 2 + input.length, y: 0 },
  altScreen: false,
  mouse: false,
  mouseSgr: false,
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
  const frame = (input: string, predict = predictEcho) => view.rerender(props(frameWith(input), predict));
  const screen = () => view.container.querySelector("[data-live-content]")!.textContent ?? "";
  return { sendData, type, frame, screen };
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
});
