// @vitest-environment jsdom
//
// The live view downloads the pane's scrollback once when a session opens and
// keeps it current from the small live frames, so scrolling never waits on the
// server (docs/guides/web/terminal.md, "Scrollback is local").

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveTerminal } from "./useLiveTerminal";
import { forgetAllScreens } from "../lib/screenCache";

vi.mock("../lib/token", () => ({ getToken: () => null }));
vi.mock("../lib/deviceBinding", () => ({ getOrCreateDeviceBindingSecret: () => null }));
vi.mock("../lib/frameStream", () => ({ supportsFrameDeflate: () => false, createFrameInflater: vi.fn() }));

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = FakeWS.OPEN;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(_url: string, _protocols?: string | string[]) {
    FakeWS.all.push(this);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetAllScreens();
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});

const last = () => FakeWS.all.at(-1)!;
const windowsSent = (ws: FakeWS) =>
  ws.sent
    .filter((d): d is string => typeof d === "string")
    .map((d) => JSON.parse(d) as { type: string; lines?: number })
    .filter((m) => m.type === "window")
    .map((m) => m.lines);

const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `line ${from + i}`);
const SCREEN = ["$ prompt", "status"];

function sendFrame(ws: FakeWS, all: string[], history: number, historyInFrame: number, extra: object = {}) {
  const content = [...all.slice(history - historyInFrame, history), ...SCREEN].map((l) => `${l}\n`).join("");
  act(() => {
    ws.onmessage?.({
      data: JSON.stringify({ type: "frame", content, rows: SCREEN.length, history, cursor: null, ...extra }),
    });
  });
}

function open(sessionId = "s") {
  const hook = renderHook(({ id }) => useLiveTerminal(id, "live-ws"), { initialProps: { id: sessionId } });
  act(() => last().onopen?.({}));
  // The component asks for its live window (screen plus a little history).
  act(() => hook.result.current.setWindow(4));
  return hook;
}

const renderedLines = (content: string) =>
  content
    .split("\n")
    .slice(0, -1)
    .map((l) => l.replace(/\x1b\[0m/g, ""));
// A download that just finished is not repeated within this long.
const settle = () => act(() => vi.advanceTimersByTime(2000));

describe("useLiveTerminal scrollback download", () => {
  it("downloads the whole history in the background when a session opens, then shrinks back to the live window", () => {
    const { result } = open();
    const ws = last();
    const all = lines(1000);
    sendFrame(ws, all, 1000, 2);
    expect(windowsSent(ws).at(-1)).toBe(4000);
    sendFrame(ws, all, 1000, 1000);
    expect(windowsSent(ws).at(-1)).toBe(4);
    expect(renderedLines(result.current.state.frame!.content)).toEqual([...all, ...SCREEN]);
  });

  it("keeps rendering the whole history from small live frames as the agent appends", () => {
    const { result } = open();
    const ws = last();
    const all = lines(1010);
    sendFrame(ws, all, 1000, 2);
    sendFrame(ws, all, 1000, 1000);
    const before = windowsSent(ws).length;
    sendFrame(ws, all, 1010, 20);
    expect(renderedLines(result.current.state.frame!.content)).toEqual([...all, ...SCREEN]);
    expect(windowsSent(ws).length).toBe(before);
  });

  it("scrolling up does not ask the server for anything once the history is downloaded", () => {
    const { result } = open();
    const ws = last();
    const all = lines(1000);
    sendFrame(ws, all, 1000, 2);
    sendFrame(ws, all, 1000, 1000);
    const before = windowsSent(ws).length;
    act(() => result.current.enterReading());
    expect(result.current.state.reading).toBe(true);
    sendFrame(ws, all, 1000, 2);
    expect(windowsSent(ws).length).toBe(before);
  });

  it("downloads again when the history stops matching", () => {
    open();
    const ws = last();
    sendFrame(ws, lines(1000), 1000, 2);
    sendFrame(ws, lines(1000), 1000, 1000);
    settle();
    sendFrame(ws, lines(1000, 5000), 1000, 2);
    expect(windowsSent(ws).at(-1)).toBe(4000);
  });

  it("downloads again when the width changes, since tmux re-wraps its history", () => {
    const { result } = open();
    const ws = last();
    act(() => result.current.sendResize(80, 2));
    sendFrame(ws, lines(1000), 1000, 2);
    sendFrame(ws, lines(1000), 1000, 1000);
    act(() => result.current.sendResize(80, 3));
    sendFrame(ws, lines(1000), 1000, 2);
    expect(windowsSent(ws).at(-1)).toBe(4);
    settle();
    act(() => result.current.sendResize(100, 3));
    sendFrame(ws, lines(1000), 1000, 2);
    expect(windowsSent(ws).at(-1)).toBe(4000);
  });

  it("does not download for a full-screen app, whose history is not in tmux", () => {
    open();
    const ws = last();
    sendFrame(ws, lines(0), 0, 0, { altScreen: true, mouse: true });
    expect(windowsSent(ws)).not.toContain(4000);
  });

  it("keeps a matching copy across a reconnect", () => {
    const { result } = open();
    const all = lines(1000);
    sendFrame(last(), all, 1000, 2);
    sendFrame(last(), all, 1000, 1000);
    act(() => last().onclose?.({ code: 1006 }));
    act(() => vi.runOnlyPendingTimers());
    const ws2 = last();
    act(() => ws2.onopen?.({}));
    sendFrame(ws2, all, 1000, 2);
    expect(windowsSent(ws2)).not.toContain(4000);
    expect(renderedLines(result.current.state.frame!.content)).toEqual([...all, ...SCREEN]);
  });

  it("starts over for a different session", () => {
    const hook = open("a");
    sendFrame(last(), lines(1000), 1000, 2);
    sendFrame(last(), lines(1000), 1000, 1000);
    hook.rerender({ id: "b" });
    const ws = last();
    act(() => ws.onopen?.({}));
    sendFrame(ws, lines(1000), 1000, 2);
    expect(windowsSent(ws).at(-1)).toBe(4000);
  });

  it("switching back to a session shows its last screen before the socket opens", () => {
    const hook = open("a");
    const all = lines(1000);
    sendFrame(last(), all, 1000, 2);
    sendFrame(last(), all, 1000, 1000);
    const shownA = hook.result.current.state.frame!.content;
    hook.rerender({ id: "b" });
    expect(hook.result.current.state.frame).toBeNull();
    hook.rerender({ id: "a" });
    expect(hook.result.current.state.connected).toBe(false);
    expect(hook.result.current.state.frame?.content).toBe(shownA);
  });

  it("reuses a remembered session's scrollback instead of downloading it again", () => {
    const hook = open("a");
    const all = lines(1010);
    sendFrame(last(), all, 1000, 2);
    sendFrame(last(), all, 1000, 1000);
    hook.rerender({ id: "b" });
    hook.rerender({ id: "a" });
    const ws = last();
    act(() => ws.onopen?.({}));
    act(() => hook.result.current.setWindow(4));
    sendFrame(ws, all, 1010, 20);
    expect(windowsSent(ws)).not.toContain(4000);
    expect(renderedLines(hook.result.current.state.frame!.content)).toEqual([...all, ...SCREEN]);
  });
});
