// @vitest-environment jsdom
//
// Opening a session shows its remembered screen at once instead of the
// "Starting session..." placeholder (docs/guides/web/terminal.md,
// "Switching sessions").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { forgetAllScreens, rememberScreen, screenKey } from "../../lib/screenCache";
import { LiveTerminalView } from "../LiveTerminalView";
import { makeSession } from "./fixtures";

vi.mock("../../lib/api", () => ({
  // The session is still being ensured for the whole test.
  ensureSession: () => new Promise(() => {}),
  ensureTerminal: () => new Promise(() => {}),
  pasteImage: vi.fn(),
  isStartRefusal: () => false,
  reportTelemetrySeen: vi.fn(),
}));
vi.mock("../../hooks/useWebSettings", () => ({
  useWebSettings: () => ({
    settings: { mobileFontSize: 14, desktopFontSize: 14 },
    update: vi.fn(),
  }),
}));

beforeEach(() => {
  forgetAllScreens();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const session = makeSession({ id: "sess-1" });

describe("LiveTerminalView remembered screen", () => {
  it("shows the session's remembered screen while it is being started", () => {
    rememberScreen(screenKey("sess-1", "live-ws"), {
      content: "remembered screen text\n❯ \n",
      rows: 2,
      history: 0,
      cursor: null,
      altScreen: false,
      mouse: false,
      mouseSgr: false,
    });
    render(<LiveTerminalView session={session} />);
    expect(screen.queryByText("Starting session...")).toBeNull();
    expect(document.body.textContent).toContain("remembered screen text");
  });

  it("shows the placeholder when nothing is remembered", () => {
    render(<LiveTerminalView session={session} />);
    expect(screen.getByText("Starting session...")).toBeTruthy();
  });
});
