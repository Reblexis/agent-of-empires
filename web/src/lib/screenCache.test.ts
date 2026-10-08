// docs/guides/web/terminal.md, "Switching sessions".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveFrame } from "../hooks/useLiveTerminal";
import {
  PREFETCH_INTERVAL_MS,
  REMEMBERED_SCREENS,
  forgetAllScreens,
  prefetchScreen,
  recallScreen,
  rememberScreen,
  screenKey,
} from "./screenCache";

const frame = (content: string): LiveFrame => ({
  content,
  rows: 2,
  history: 0,
  cursor: { x: 0, y: 0 },
  altScreen: false,
  mouse: false,
  mouseSgr: false,
});
const fetchMock = vi.fn();

beforeEach(() => {
  forgetAllScreens();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const answer = (content: string) =>
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ content }) } as Response);

describe("screenCache", () => {
  it("remembers each session's screen per terminal surface", () => {
    rememberScreen(screenKey("a", "live-ws"), { frame: frame("agent\n"), history: null });
    rememberScreen(screenKey("a", "terminal/live-ws?index=0"), { frame: frame("shell\n"), history: null });
    expect(recallScreen(screenKey("a", "live-ws"))?.frame.content).toBe("agent\n");
    expect(recallScreen(screenKey("a", "terminal/live-ws?index=0"))?.frame.content).toBe("shell\n");
    expect(recallScreen(screenKey("b", "live-ws"))).toBeUndefined();
  });

  it("keeps the most recently shown sessions only", () => {
    for (let i = 0; i <= REMEMBERED_SCREENS; i++) {
      rememberScreen(screenKey(`s${i}`, "live-ws"), { frame: frame(`${i}\n`), history: null });
    }
    // Showing s1 again makes it recent, so s2 is the one that falls out next.
    rememberScreen(screenKey("s1", "live-ws"), { frame: frame("1\n"), history: null });
    rememberScreen(screenKey("new", "live-ws"), { frame: frame("n\n"), history: null });
    expect(recallScreen(screenKey("s0", "live-ws"))).toBeUndefined();
    expect(recallScreen(screenKey("s1", "live-ws"))).toBeDefined();
    expect(recallScreen(screenKey("s2", "live-ws"))).toBeUndefined();
    expect(recallScreen(screenKey("new", "live-ws"))).toBeDefined();
  });

  it("prefetches a session's current screen as a picture of its pane", async () => {
    answer("\x1b[1mtitle\x1b[0m\nline\n❯ \n");
    await prefetchScreen("a", 0);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/a/output?format=ansi&lines=1");
    const got = recallScreen(screenKey("a", "live-ws"))!;
    expect(got.frame.content).toBe("\x1b[1mtitle\x1b[0m\nline\n❯ \n");
    expect(got.frame).toMatchObject({ rows: 3, history: 0, cursor: null, altScreen: false });
  });

  it("prefetches each session at most once per interval", async () => {
    answer("one\n");
    await prefetchScreen("a", 0);
    await prefetchScreen("a", PREFETCH_INTERVAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer("two\n");
    await prefetchScreen("a", PREFETCH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recallScreen(screenKey("a", "live-ws"))!.frame.content).toBe("two\n");
  });

  it("a prefetch refreshes the picture but keeps the downloaded scrollback", async () => {
    const history = { lines: ["old"], history: 1 };
    rememberScreen(screenKey("a", "live-ws"), { frame: frame("stale\n"), history });
    answer("fresh\n");
    await prefetchScreen("a", 0);
    const got = recallScreen(screenKey("a", "live-ws"))!;
    expect(got.frame.content).toBe("fresh\n");
    expect(got.history).toBe(history);
  });

  it("a failed prefetch leaves nothing behind", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ content: "server error" }) } as Response);
    await prefetchScreen("a", 0);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await prefetchScreen("b", 0);
    expect(recallScreen(screenKey("a", "live-ws"))).toBeUndefined();
    expect(recallScreen(screenKey("b", "live-ws"))).toBeUndefined();
  });
});
