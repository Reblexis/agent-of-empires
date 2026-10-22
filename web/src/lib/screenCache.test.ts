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
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ content }),
  } as Response);

describe("screenCache", () => {
  it("remembers each session's screen per terminal surface", () => {
    rememberScreen(screenKey("a", "live-ws"), frame("agent\n"));
    rememberScreen(screenKey("a", "terminal/live-ws?index=0"), frame("shell\n"));
    expect(recallScreen(screenKey("a", "live-ws"))?.content).toBe("agent\n");
    expect(recallScreen(screenKey("a", "terminal/live-ws?index=0"))?.content).toBe("shell\n");
    expect(recallScreen(screenKey("b", "live-ws"))).toBeUndefined();
  });

  it("keeps the most recently shown sessions only", () => {
    for (let i = 0; i <= REMEMBERED_SCREENS; i++) {
      rememberScreen(screenKey(`s${i}`, "live-ws"), frame(`${i}\n`));
    }
    // Showing s1 again makes it recent, so s2 is the one that falls out next.
    rememberScreen(screenKey("s1", "live-ws"), frame("1\n"));
    rememberScreen(screenKey("new", "live-ws"), frame("n\n"));
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
    expect(got.content).toBe("\x1b[1mtitle\x1b[0m\nline\n❯ \n");
    expect(got).toMatchObject({
      rows: 3,
      history: 0,
      cursor: null,
      altScreen: false,
    });
  });

  it("prefetches each session at most once per interval", async () => {
    answer("one\n");
    await prefetchScreen("a", 0);
    await prefetchScreen("a", PREFETCH_INTERVAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer("two\n");
    await prefetchScreen("a", PREFETCH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recallScreen(screenKey("a", "live-ws"))!.content).toBe("two\n");
  });

  it("a failed prefetch leaves nothing behind", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ content: "server error" }),
    } as Response);
    await prefetchScreen("a", 0);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await prefetchScreen("b", 0);
    expect(recallScreen(screenKey("a", "live-ws"))).toBeUndefined();
    expect(recallScreen(screenKey("b", "live-ws"))).toBeUndefined();
  });
});
