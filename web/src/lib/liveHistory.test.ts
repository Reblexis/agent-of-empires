import { describe, expect, it } from "vitest";
import type { LiveFrame } from "../hooks/useLiveTerminal";
import { HISTORY_CAP_LINES, mergeFrame } from "./liveHistory";
import { LineParseCache, lineText } from "./liveTermLines";

// docs/guides/web/terminal.md, "Scrollback is local".

// Builds a frame the way the hook holds it: the last `historyInFrame` history lines, then the screen.
function frameOf(
  all: string[],
  screen: string[],
  history: number,
  historyInFrame: number,
  extra: Partial<LiveFrame> = {},
): LiveFrame {
  const lines = [...all.slice(history - historyInFrame, history), ...screen];
  return {
    content: lines.map((l) => `${l}\n`).join(""),
    lines,
    rows: screen.length,
    history,
    cursor: null,
    altScreen: false,
    mouse: false,
    mouseSgr: false,
    ...extra,
  };
}

const lines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `line ${from + i}`);
const screen = ["$ prompt", "", "status"];

// eslint-disable-next-line no-control-regex
const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
const rendered = (frame: LiveFrame) => new LineParseCache().lines(frame.lines!).map(lineText);

describe("mergeFrame", () => {
  it("a frame carrying the whole history becomes a complete copy", () => {
    const all = lines(100);
    const r = mergeFrame(null, frameOf(all, screen, 100, 100));
    expect(r.complete).toBe(true);
    expect(r.cache?.lines.length).toBe(100);
    expect(rendered(r.frame)).toEqual([...all, ...screen]);
  });

  it("a small live frame after a complete copy still renders the whole history, with no spacer", () => {
    const all = lines(110);
    const first = mergeFrame(null, frameOf(all, screen, 100, 100));
    // The agent appended 10 lines; the live frame only carries 30 history lines.
    const r = mergeFrame(first.cache, frameOf(all, screen, 110, 30));
    expect(r.complete).toBe(true);
    expect(r.cache?.history).toBe(110);
    expect(rendered(r.frame)).toEqual([...all, ...screen]);
    // The component's spacer is history minus the frame's history lines.
    expect(r.frame.lines!.length - r.frame.rows).toBe(r.frame.history);
  });

  it("the screen rows are the frame's own, so the cursor row and local echo see the live screen", () => {
    const all = lines(100);
    const first = mergeFrame(null, frameOf(all, screen, 100, 100));
    const r = mergeFrame(first.cache, frameOf(all, ["$ typed", "", "status"], 100, 10));
    expect(r.frame.lines!.slice(-3)).toEqual(["$ typed", "", "status"]);
  });

  it("a partial copy that grows by appends stays incomplete", () => {
    const all = lines(500);
    const first = mergeFrame(null, frameOf(all, screen, 490, 30));
    expect(first.complete).toBe(false);
    const r = mergeFrame(first.cache, frameOf(all, screen, 500, 30));
    expect(r.complete).toBe(false);
    expect(r.cache?.lines.map(plain)).toEqual(all.slice(460, 500));
  });

  it("aligns when tmux's history is full and the oldest lines scroll away (count unchanged)", () => {
    const before = lines(2000);
    const first = mergeFrame(null, frameOf(before, screen, 2000, 2000));
    const after = lines(2000, 5); // 5 new lines appended, 5 oldest trimmed
    const r = mergeFrame(first.cache, frameOf(after, screen, 2000, 30));
    expect(r.complete).toBe(true);
    expect(rendered(r.frame)).toEqual([...after, ...screen]);
  });

  it("a history that no longer matches (cleared, rewritten) is dropped and must be downloaded again", () => {
    const all = lines(100);
    const first = mergeFrame(null, frameOf(all, screen, 100, 100));
    const other = lines(100, 1000);
    const r = mergeFrame(first.cache, frameOf(other, screen, 100, 30));
    expect(r.complete).toBe(false);
    // Nothing stale is shown: only what this frame itself carries.
    expect(rendered(r.frame)).toEqual([...other.slice(70), ...screen]);
  });

  it("more output between two frames than a frame covers is a gap, not a guess", () => {
    const all = lines(200);
    const first = mergeFrame(null, frameOf(all, screen, 100, 100));
    const r = mergeFrame(first.cache, frameOf(all, screen, 200, 30));
    expect(r.complete).toBe(false);
    expect(rendered(r.frame)).toEqual([...all.slice(170), ...screen]);
  });

  it("style from an older capture never bleeds into lines spliced after it", () => {
    // tmux emits SGR only on change, so a cached line can leave bold on;
    // the next capture's first line starts from the default style.
    const all = [...lines(10), "\x1b[1mbold", "plain mid", "plain after"];
    const first = mergeFrame(null, frameOf(all, screen, 12, 12));
    const r = mergeFrame(first.cache, frameOf(all, screen, 13, 2));
    const parsed = new LineParseCache().lines(r.frame.lines!);
    expect(parsed.map(lineText).slice(10, 13)).toEqual(["bold", "plain mid", "plain after"]);
    expect(parsed[10]![0]!.style.bold).toBe(true);
    expect(parsed[11]![0]!.style.bold).toBeFalsy();
  });

  it("alt-screen frames pass through and keep the copy for when the app exits", () => {
    const all = lines(100);
    const first = mergeFrame(null, frameOf(all, screen, 100, 100));
    const alt = frameOf([], ["vim"], 0, 0, { altScreen: true, mouse: true });
    const r = mergeFrame(first.cache, alt);
    expect(r.frame).toBe(alt);
    expect(r.cache).toBe(first.cache);
    expect(r.complete).toBe(true);
  });

  it("keeps at most the cap of history lines", () => {
    const all = lines(HISTORY_CAP_LINES + 50);
    const first = mergeFrame(null, frameOf(all, screen, HISTORY_CAP_LINES, HISTORY_CAP_LINES - screen.length));
    expect(first.complete).toBe(true);
    const r = mergeFrame(first.cache, frameOf(all, screen, HISTORY_CAP_LINES + 50, 60));
    expect(r.cache!.lines.length).toBe(HISTORY_CAP_LINES);
    expect(rendered(r.frame).slice(-screen.length - 1)).toEqual([all.at(-1), ...screen]);
  });

  it("a frame with no history lines keeps an unchanged copy and drops a changed one", () => {
    const all = lines(100);
    const first = mergeFrame(null, frameOf(all, screen, 100, 100));
    const same = mergeFrame(first.cache, frameOf(all, screen, 100, 0));
    expect(same.complete).toBe(true);
    expect(rendered(same.frame)).toEqual([...all, ...screen]);
    const grew = mergeFrame(first.cache, frameOf(lines(101), screen, 101, 0));
    expect(grew.complete).toBe(false);
  });

  it("an empty history is complete from the first frame", () => {
    const r = mergeFrame(null, frameOf([], screen, 0, 0));
    expect(r.complete).toBe(true);
    expect(rendered(r.frame)).toEqual(screen);
  });

  it("a frame without lines is split from its content", () => {
    const all = lines(20);
    const { lines: _drop, ...noLines } = frameOf(all, screen, 20, 20);
    const r = mergeFrame(null, noLines);
    expect(r.complete).toBe(true);
    expect(rendered(r.frame)).toEqual([...all, ...screen]);
  });
});
