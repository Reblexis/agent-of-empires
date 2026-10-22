// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { ActivityRow } from "../../lib/acpTypes";
import { DEFAULT_HISTORY_WINDOW, MAX_AUTO_HISTORY_WINDOW } from "../../lib/acpHistoryWindow";
import { pinnedWindowStart, useHistoryWindow } from "../useHistoryWindow";

function transcript(turns: number, perTurn: number): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (let t = 0; t < turns; t += 1) {
    rows.push({ id: `u-${t}`, kind: "user_prompt", text: `prompt ${t}` });
    for (let r = 0; r < perTurn; r += 1) rows.push({ id: `m-${t}-${r}`, kind: "message", text: `msg ${t}.${r}` });
  }
  return rows;
}

/** One prompt followed by `extra` rows past the default window, so the turn alone overflows it. */
function longTurn(extra: number): ActivityRow[] {
  const rows: ActivityRow[] = [{ id: "u-0", kind: "user_prompt", text: "big question" }];
  for (let r = 0; r < DEFAULT_HISTORY_WINDOW + extra; r += 1) {
    rows.push({ id: `m-0-${r}`, kind: "message", text: `part ${r}` });
  }
  return rows;
}

const followUp: ActivityRow[] = [
  { id: "u-1", kind: "user_prompt", text: "follow-up" },
  { id: "m-1-0", kind: "message", text: "short answer" },
];

const render = (a: ActivityRow[], sid = "s1") =>
  renderHook(({ sid, a }: { sid: string; a: ActivityRow[] }) => useHistoryWindow(sid, a, false), {
    initialProps: { sid, a },
  });

describe("useHistoryWindow", () => {
  it("renders a short transcript whole, and windows a long one until loadEarlier shows it all", () => {
    const short = transcript(3, 1); // 6 rows
    const shortView = render(short).result;
    expect(shortView.current.windowedActivity).toHaveLength(short.length);
    expect(shortView.current.canLoadEarlier).toBe(false);

    const activity = transcript(100, 1); // 200 rows
    const { result } = render(activity);
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW);
    expect(result.current.canLoadEarlier).toBe(true);
    for (let i = 0; i < 5 && result.current.canLoadEarlier; i += 1) {
      act(() => result.current.loadEarlier());
    }
    expect(result.current.windowedActivity).toHaveLength(activity.length);
    expect(result.current.canLoadEarlier).toBe(false);
  });

  it("keeps earlier rows on screen when new turns append (no re-fold)", () => {
    const activity = transcript(100, 1);
    const { result, rerender } = render(activity);
    const topBefore = result.current.windowedActivity[0]!.id;
    expect(topBefore).toBeDefined();
    const appended = activity.concat(
      Array.from({ length: 5 }, (_, t) => [
        { id: `nu-${t}`, kind: "user_prompt" as const, text: `new ${t}` },
        { id: `nm-${t}`, kind: "message" as const, text: `reply ${t}` },
      ]).flat(),
    );
    rerender({ sid: "s1", a: appended });
    const ids = result.current.windowedActivity.map((r) => r.id);
    expect(ids).toContain(topBefore);
    expect(ids).toContain("nu-4");
  });

  it("never snaps a long last turn forward when the next prompt lands (#3707)", () => {
    const long = longTurn(10);
    const { result, rerender } = render(long);
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    expect(result.current.windowedActivity).toHaveLength(long.length);
    expect(result.current.canLoadEarlier).toBe(false);

    rerender({ sid: "s1", a: long.concat(followUp) });
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    expect(result.current.windowedActivity.at(-1)!.id).toBe("m-1-0");
    expect(result.current.canLoadEarlier).toBe(false);
  });

  it("holds a mid-turn cut when a prompt lands after a no-boundary open (pinnedWindowStart)", () => {
    const noBoundary: ActivityRow[] = [];
    for (let r = 0; r < DEFAULT_HISTORY_WINDOW + 100; r += 1) {
      noBoundary.push({ id: `m-${r}`, kind: "message", text: `part ${r}` });
    }
    const { result, rerender } = render(noBoundary);
    expect(result.current.windowedActivity[0]!.id).toBe("m-100");
    expect(result.current.canLoadEarlier).toBe(true);

    rerender({ sid: "s1", a: noBoundary.concat(followUp) });
    expect(result.current.windowedActivity[0]!.id).toBe("m-100");
    expect(result.current.windowedActivity.at(-1)!.id).toBe("m-1-0");
  });

  it("drops the pin when its row is trimmed away", () => {
    const activity = transcript(100, 1);
    const { result, rerender } = render(activity);
    const topBefore = result.current.windowedActivity[0]!.id;
    const trimmed = activity.filter((r) => r.id !== topBefore).slice(60);
    rerender({ sid: "s1", a: trimmed });
    expect(result.current.windowedActivity[0]!.id).toBe(trimmed[0]!.id);
  });

  it("caps automatic growth so a parked live session cannot grow the DOM without bound", () => {
    const activity = transcript(100, 1); // 200 rows
    const { result, rerender } = render(activity);
    // Stream ten more 200-row batches, far past the automatic cap.
    let current = activity;
    for (let batch = 0; batch < 10; batch += 1) {
      current = current.concat(transcript(100, 1).map((r) => ({ ...r, id: `b${batch}-${r.id}` })));
      rerender({ sid: "s1", a: current });
    }
    expect(current.length).toBeGreaterThan(MAX_AUTO_HISTORY_WINDOW);
    // The window stops at the cap instead of tracking the transcript 1:1, and the newest row still renders.
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(MAX_AUTO_HISTORY_WINDOW);
    expect(result.current.windowedActivity.at(-1)?.id).toBe(current.at(-1)!.id);
    // "Load earlier" still reaches past the cap.
    expect(result.current.canLoadEarlier).toBe(true);
    const before = result.current.windowedActivity.length;
    act(() => result.current.loadEarlier());
    expect(result.current.windowedActivity.length).toBeGreaterThan(before);
  });

  it("caps a parked session streamed one row at a time", () => {
    let current = transcript(100, 1);
    const { result, rerender } = render(current);
    for (let i = 0; i < MAX_AUTO_HISTORY_WINDOW + 100; i += 1) {
      current = current.concat({
        id: `s-${i}`,
        kind: "message",
        text: `stream ${i}`,
      });
      rerender({ sid: "s1", a: current });
    }
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(MAX_AUTO_HISTORY_WINDOW);
    expect(result.current.windowedActivity.at(-1)?.id).toBe(current.at(-1)!.id);
  });

  it("a window grown past the cap by Load earlier holds its size as rows stream", () => {
    let current = transcript(500, 1); // 1000 rows
    const { result, rerender } = render(current);
    for (let i = 0; i < 4; i += 1) act(() => result.current.loadEarlier()); // 750 rows of 1000
    const grown = result.current.windowedActivity.length;
    expect(grown).toBeGreaterThan(MAX_AUTO_HISTORY_WINDOW);
    for (let i = 0; i < 50; i += 1) {
      current = current.concat({
        id: `s-${i}`,
        kind: "message",
        text: `stream ${i}`,
      });
      rerender({ sid: "s1", a: current });
    }
    const len = result.current.windowedActivity.length;
    expect(len).toBeGreaterThanOrEqual(grown - 2);
    expect(len).toBeLessThanOrEqual(grown + 2);
  });

  it("a turn longer than the cap rolls instead of folding away when the next prompt lands", () => {
    const long = longTurn(MAX_AUTO_HISTORY_WINDOW);
    const { result, rerender } = render(long);
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    rerender({ sid: "s1", a: long.concat(followUp) });
    const ids = result.current.windowedActivity.map((r) => r.id);
    // Most of the long turn stays on screen; only the rows the append pushed past the window fold.
    expect(ids).toContain(long.at(-1)!.id);
    expect(ids).toContain(long[10]!.id);
    expect(ids.at(-1)).toBe("m-1-0");
    expect(ids.length).toBeLessThanOrEqual(long.length);
  });

  it("resets the window to recent when the session changes", () => {
    const activity = transcript(100, 1);
    const { result, rerender } = render(activity);
    act(() => result.current.loadEarlier());
    act(() => result.current.loadEarlier());
    const grown = result.current.windowedActivity.length;
    rerender({ sid: "s2", a: activity });
    expect(result.current.windowedActivity.length).toBeLessThan(grown);
    expect(result.current.canLoadEarlier).toBe(true);
  });

  it("re-sizes to the new session's last turn on a session switch", () => {
    const { result, rerender } = render(transcript(100, 1)); // last turn is 2 rows: default window
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW);

    const long = longTurn(50);
    rerender({ sid: "s2", a: long });
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    expect(result.current.windowedActivity).toHaveLength(long.length);
    expect(result.current.canLoadEarlier).toBe(false);
  });
});

describe("pinnedWindowStart", () => {
  const rows = transcript(50, 1); // 100 rows
  it("holds the pin while the pinned window fits", () => {
    expect(pinnedWindowStart(rows, 80, rows[40]!.id, 600)).toBe(40);
  });
  it("rolls the pin forward just enough to fit the cap", () => {
    expect(pinnedWindowStart(rows, 80, rows[10]!.id, 50)).toBe(50);
  });
  it("never moves past the computed start when rolling", () => {
    expect(pinnedWindowStart(rows, 30, rows[10]!.id, 50)).toBe(30);
  });
  it("falls back to the computed start without a live pin", () => {
    expect(pinnedWindowStart(rows, 80, null, 50)).toBe(80);
    expect(pinnedWindowStart(rows, 80, "gone", 50)).toBe(80);
  });
});
