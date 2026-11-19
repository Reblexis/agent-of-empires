import { safeGetItem, safeSetItem } from "./safeStorage";

// A terminal that changes width makes tmux re-wrap its whole history and the agent redraw on top of it, which
// leaves duplicated, broken lines in the scrollback. So the desktop agent terminal keeps its column count: the
// count comes from the widest the pane has been, and a narrower pane draws the same columns in smaller text.

/** Below this share of the widest width the text would be too small: re-wrap at full size instead. */
export const MIN_FIT = 0.7;

const STORAGE_PREFIX = "aoe-term-width-latch:";

export interface ColumnFit {
  cols: number;
  /** Factor on the font size that makes `cols` fit the current width; 1 at full size. */
  fit: number;
  /** The width the columns are taken from, to remember for the next call. */
  latchWidth: number;
}

/** Columns and text scale for a pane `width` px wide whose cell is `baseCharW` px at full font size, given the
 *  widest width remembered so far (`0` for none). */
export function fitColumns(width: number, baseCharW: number, latchWidth: number): ColumnFit {
  const latch = latchWidth <= 0 || width > latchWidth || width < latchWidth * MIN_FIT ? width : latchWidth;
  const cols = Math.floor(latch / baseCharW);
  const needed = cols * baseCharW;
  const fit = needed <= 0 || width >= needed ? 1 : Math.floor((width / needed) * 1000) / 1000;
  return { cols, fit, latchWidth: latch };
}

/** The remembered widest width for `key`, valid only on the screen it was measured on. */
export function loadColumnLatch(key: string): number {
  try {
    const saved = JSON.parse(safeGetItem(STORAGE_PREFIX + key) ?? "null") as { screen?: number; width?: number } | null;
    if (saved && saved.screen === window.screen.width && typeof saved.width === "number" && saved.width > 0) {
      return saved.width;
    }
  } catch {
    // Unreadable entry: start over.
  }
  return 0;
}

export function saveColumnLatch(key: string, width: number): void {
  safeSetItem(STORAGE_PREFIX + key, JSON.stringify({ screen: window.screen.width, width }));
}
