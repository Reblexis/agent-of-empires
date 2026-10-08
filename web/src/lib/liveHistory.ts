import type { LiveFrame } from "../hooks/useLiveTerminal";

// Client-side copy of a pane's tmux scrollback, so the live view scrolls
// through history without asking the server (docs/guides/web/terminal.md,
// "Scrollback is local").
//
// The live stream only carries the screen plus a little history above it.
// The copy is downloaded once (one wide-window frame) and then kept current
// from those small frames: tmux history is append-only, so each frame's
// history lines overlap the tail of the copy, and the overlap proves where the
// new lines go. When it cannot be proven (history cleared, a gap larger than a
// frame, rewritten lines) the copy restarts from what the frame itself
// carries, which reports incomplete and so triggers a fresh download.

/** Mirrors MAX_WINDOW_LINES in src/server/live_ws.rs: the widest capture the
 *  server serves, and the most history the copy keeps. */
export const HISTORY_CAP_LINES = 4000;

/** tmux emits SGR only when the style changes, so every line's escapes are
 *  relative to the line before it in the SAME capture. A line that starts a
 *  capture is relative to the default style; prefixing a reset keeps the
 *  previous capture's style from bleeding into it after the splice. */
const RESET = "\x1b[0m";

export interface HistoryCache {
  /** Raw `capture-pane -e` lines, oldest first; the last one is history line
   *  `history - 1`. */
  lines: string[];
  /** tmux `#{history_size}` the lines were aligned to. */
  history: number;
}

export interface MergeResult {
  cache: HistoryCache | null;
  /** The frame to render: the cached history followed by the frame's screen. */
  frame: LiveFrame;
  /** The copy holds all the history the server could deliver. */
  complete: boolean;
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (line: string) => line.replace(ESCAPES, "").trimEnd();

/** Lines appended since `cache` was aligned, proven by the overlap between the
 *  cache's tail and the frame's history lines `f`, or null when nothing fits. */
function appendedSince(cache: HistoryCache, f: string[], history: number): number | null {
  const tail = cache.lines;
  const matches = (a: number, requireText: boolean) => {
    const n = Math.min(tail.length, f.length - a);
    if (n < 1) return false;
    let text = false;
    for (let j = 0; j < n; j++) {
      const p = plain(tail[tail.length - 1 - j]!);
      if (p !== plain(f[f.length - 1 - a - j]!)) return false;
      if (p !== "") text = true;
    }
    return !requireText || text;
  };
  const expected = history - cache.history;
  if (expected >= 0 && matches(expected, false)) return expected;
  // tmux's history is full: lines appended at the bottom push the oldest out
  // and the count stays put, so the shift has to be found from the content.
  for (let a = 0; a < f.length; a++) {
    if (a !== expected && matches(a, true)) return a;
  }
  return null;
}

export function mergeFrame(cache: HistoryCache | null, frame: LiveFrame): MergeResult {
  // A full-screen app's history is not in tmux, and a frame without geometry
  // cannot be split into history and screen; both render as they are.
  if (frame.altScreen || frame.rows <= 0) return { cache, frame, complete: true };

  const raw = frame.content.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const rows = Math.min(frame.rows, raw.length);
  const f = raw.slice(0, raw.length - rows);
  const screen = raw.slice(raw.length - rows);
  const history = frame.history;
  const fresh = f.length > 0 ? [RESET + f[0]!, ...f.slice(1)] : [];

  let kept: string[];
  if (f.length >= history || !cache) {
    kept = fresh;
  } else if (f.length === 0) {
    // Nothing to align against: an unchanged count keeps the copy, anything
    // else drops it rather than guess.
    kept = cache.history === history ? cache.lines : [];
  } else {
    const a = appendedSince(cache, f, history);
    kept = a == null ? fresh : [...cache.lines.slice(0, Math.max(0, cache.lines.length - (f.length - a))), ...fresh];
  }
  const limit = Math.min(history, HISTORY_CAP_LINES);
  if (kept.length > limit) kept = kept.slice(kept.length - limit);

  const next: HistoryCache = { lines: kept, history };
  // A screen that does not follow its own capture's history lines starts a
  // capture of its own, so it gets the same reset.
  const screenLines = f.length > 0 || screen.length === 0 ? screen : [RESET + screen[0]!, ...screen.slice(1)];
  const content = [...kept, ...screenLines].map((l) => `${l}\n`).join("");
  return {
    cache: next,
    frame: { ...frame, content },
    complete: kept.length >= Math.min(history, HISTORY_CAP_LINES - rows),
  };
}
