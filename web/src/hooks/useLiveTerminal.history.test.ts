// @vitest-environment jsdom
//
// The live view downloads the pane's scrollback once when a session opens and keeps it current from the small live
// frames, so scrolling never waits on the server (docs/guides/web/terminal.md, "Scrollback is local").

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveTerminal } from "./useLiveTerminal";
import { forgetAllScreens, REMEMBERED_HISTORIES } from "../lib/screenCache";

vi.mock("../lib/token", () => ({ getToken: () => null }));
vi.mock("../lib/deviceBinding", () => ({ getOrCreateDeviceBindingSecret: () => "test-secret" }));
vi.mock("../lib/frameStream", () => ({ supportsFrameDeflate: () => false, createFrameInflater: vi.fn() }));

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static sockets: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  binaryType = "blob";
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  sent: unknown[] = [];
  constructor() {
    FakeWS.sockets.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }
  open() {
    this.readyState = FakeWS.OPEN;
    act(() => this.onopen?.({} as Event));
  }
  deliver(payload: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent));
  }
  windows() {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as { type: string; lines?: number })
      .filter((m) => m.type === "window")
      .map((m) => m.lines);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetAllScreens();
  FakeWS.sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  vi.useRealTimers();
});

const last = () => FakeWS.sockets.at(-1)!;
const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `line ${from + i}`);
const SCREEN = ["$ prompt", "status"];
const LIVE_WINDOW = 4;
let seq = 0;

function sendFrame(ws: FakeWS, all: string[], history: number, historyInFrame: number, extra: object = {}) {
  const content = [...all.slice(history - historyInFrame, history), ...SCREEN].map((l) => `${l}\n`).join("");
  seq += 1;
  ws.deliver({
    type: "frame",
    seq,
    content,
    rows: SCREEN.length,
    history,
    cursor: null,
    altScreen: false,
    mouse: false,
    mouseSgr: false,
    pane0: null,
    ...extra,
  });
}

function open(sessionId = "s") {
  const hook = renderHook(({ id }) => useLiveTerminal(id, "live-ws"), { initialProps: { id: sessionId } });
  last().open();
  // The component asks for its live window (screen plus a little history).
  act(() => hook.result.current.setWindow(LIVE_WINDOW));
  return hook;
}

// eslint-disable-next-line no-control-regex
const shown = (hook: ReturnType<typeof open>) =>
  hook.result.current.state.frame!.lines!.map((l) => l.replace(/\x1b\[0m/g, ""));
// A download that just finished is not repeated within this long.
const settle = () => act(() => vi.advanceTimersByTime(2000));

describe("useLiveTerminal scrollback download", () => {
  it("downloads the whole history in the background when a session opens, then shrinks back to the live window", () => {
    const hook = open();
    const ws = last();
    const all = lines(1000);
    sendFrame(ws, all, 1000, 2);
    expect(ws.windows().at(-1)).toBe(4000);
    sendFrame(ws, all, 1000, 1000);
    expect(ws.windows().at(-1)).toBe(LIVE_WINDOW);
    expect(shown(hook)).toEqual([...all, ...SCREEN]);
  });

  it("keeps rendering the whole history from small live frames as the agent appends", () => {
    const hook = open();
    const ws = last();
    const all = lines(1010);
    sendFrame(ws, all, 1000, 2);
    sendFrame(ws, all, 1000, 1000);
    const before = ws.windows().length;
    sendFrame(ws, all, 1010, 20);
    expect(shown(hook)).toEqual([...all, ...SCREEN]);
    expect(ws.windows().length).toBe(before);
  });

  it("scrolling up does not ask the server for anything once the history is downloaded", () => {
    const hook = open();
    const ws = last();
    const all = lines(1000);
    sendFrame(ws, all, 1000, 2);
    sendFrame(ws, all, 1000, 1000);
    const before = ws.windows().length;
    act(() => hook.result.current.enterReading());
    expect(hook.result.current.state.reading).toBe(true);
    sendFrame(ws, all, 1000, 2);
    expect(ws.windows().length).toBe(before);
    act(() => hook.result.current.returnToLive(LIVE_WINDOW));
    expect(ws.windows().length).toBe(before);
  });

  it("row patches apply to the live window, under the downloaded history", () => {
    const hook = open();
    const ws = last();
    const all = lines(1000);
    sendFrame(ws, all, 1000, 2);
    sendFrame(ws, all, 1000, 1000);
    sendFrame(ws, all, 1000, 2);
    const base = seq;
    seq += 1;
    ws.deliver({
      type: "patch",
      seq,
      base,
      shift: 0,
      lines: [[2, "$ typed"]],
      rows: SCREEN.length,
      history: 1000,
      cursor: null,
      altScreen: false,
      mouse: false,
      mouseSgr: false,
      pane0: null,
    });
    expect(shown(hook)).toEqual([...all, "$ typed", "status"]);
    expect(ws.sent.filter((d) => typeof d === "string" && d.includes('"resync"'))).toHaveLength(0);
  });

  it("downloads again when the history stops matching", () => {
    open();
    const ws = last();
    sendFrame(ws, lines(1000), 1000, 2);
    sendFrame(ws, lines(1000), 1000, 1000);
    settle();
    sendFrame(ws, lines(1000, 5000), 1000, 2);
    expect(ws.windows().at(-1)).toBe(4000);
  });

  it("downloads at most once every 2 seconds", () => {
    open();
    const ws = last();
    sendFrame(ws, lines(1000), 1000, 2);
    sendFrame(ws, lines(1000), 1000, 1000);
    sendFrame(ws, lines(1000, 5000), 1000, 2);
    expect(ws.windows().at(-1)).toBe(LIVE_WINDOW);
    settle();
    sendFrame(ws, lines(1000, 5000), 1000, 2);
    expect(ws.windows().at(-1)).toBe(4000);
  });

  it("downloads again when the width changes, since tmux re-wraps its history", () => {
    const hook = open();
    const ws = last();
    act(() => hook.result.current.sendResize(80, 2));
    sendFrame(ws, lines(1000), 1000, 2);
    sendFrame(ws, lines(1000), 1000, 1000);
    act(() => hook.result.current.sendResize(80, 3));
    sendFrame(ws, lines(1000), 1000, 2);
    expect(ws.windows().at(-1)).toBe(LIVE_WINDOW);
    settle();
    act(() => hook.result.current.sendResize(100, 3));
    sendFrame(ws, lines(1000), 1000, 2);
    expect(ws.windows().at(-1)).toBe(4000);
  });

  it("does not download for a full-screen app, whose history is not in tmux", () => {
    open();
    const ws = last();
    sendFrame(ws, lines(0), 0, 0, { altScreen: true, mouse: true });
    expect(ws.windows()).not.toContain(4000);
  });

  it("keeps a matching copy across a reconnect", () => {
    const hook = open();
    const all = lines(1000);
    sendFrame(last(), all, 1000, 2);
    sendFrame(last(), all, 1000, 1000);
    act(() => last().onclose?.({ code: 1006 } as CloseEvent));
    act(() => vi.runOnlyPendingTimers());
    const ws2 = last();
    ws2.open();
    sendFrame(ws2, all, 1000, 2);
    expect(ws2.windows()).not.toContain(4000);
    expect(shown(hook)).toEqual([...all, ...SCREEN]);
  });

  it("downloads for a session it has no copy of", () => {
    const hook = open("a");
    sendFrame(last(), lines(1000), 1000, 2);
    sendFrame(last(), lines(1000), 1000, 1000);
    hook.rerender({ id: "b" });
    const ws = last();
    ws.open();
    sendFrame(ws, lines(1000, 7000), 1000, 2);
    expect(ws.windows().at(-1)).toBe(4000);
  });

  it("switching back to a recently shown session scrolls its history at once, before the socket opens", () => {
    const all = lines(1000);
    const hook = open("a");
    sendFrame(last(), all, 1000, 2);
    sendFrame(last(), all, 1000, 1000);
    sendFrame(last(), all, 1000, 2);
    hook.rerender({ id: "b" });
    hook.rerender({ id: "a" });
    expect(hook.result.current.state.connected).toBe(false);
    expect(shown(hook)).toEqual([...all, ...SCREEN]);
    const ws = last();
    ws.open();
    sendFrame(ws, all, 1000, 2);
    expect(ws.windows()).not.toContain(4000);
  });

  it(`remembers the copies of the ${REMEMBERED_HISTORIES} most recently shown sessions, no more`, () => {
    const all = lines(1000);
    const hook = open("s0");
    sendFrame(last(), all, 1000, 2);
    sendFrame(last(), all, 1000, 1000);
    for (let i = 1; i <= REMEMBERED_HISTORIES; i++) {
      hook.rerender({ id: `s${i}` });
      last().open();
      sendFrame(last(), all, 1000, 1000);
    }
    hook.rerender({ id: "s0" });
    const ws = last();
    ws.open();
    sendFrame(ws, all, 1000, 2);
    expect(ws.windows().at(-1)).toBe(4000);
  });
});
