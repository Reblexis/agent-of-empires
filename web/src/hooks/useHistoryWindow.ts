import { useCallback, useMemo, useState } from "react";

import type { ActivityRow } from "../lib/acpTypes";
import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_WINDOW_STEP,
  MAX_AUTO_HISTORY_WINDOW,
  canLoadEarlierFrom,
  historyWindow,
  initialHistoryWindow,
  snapBackToSubagentParent,
} from "../lib/acpHistoryWindow";

export interface HistoryWindowState {
  windowedActivity: ActivityRow[];
  canLoadEarlier: boolean;
  loadEarlier: () => void;
}

export function useHistoryWindow(
  sessionId: string,
  activity: ActivityRow[],
  showClearedTurns: boolean,
): HistoryWindowState {
  const [visibleRows, setVisibleRows] = useState(DEFAULT_HISTORY_WINDOW);
  const [windowSessionId, setWindowSessionId] = useState(sessionId);
  // null until first populate, so the initial page lands as the default window, not as growth.
  const [anchorLen, setAnchorLen] = useState<number | null>(null);
  const [anchorRowId, setAnchorRowId] = useState<string | null>(null);
  if (windowSessionId !== sessionId) {
    setWindowSessionId(sessionId);
    setVisibleRows(initialHistoryWindow(activity));
    setAnchorLen(activity.length > 0 ? activity.length : null);
    setAnchorRowId(null);
  } else if (anchorLen === null) {
    if (activity.length > 0) {
      setAnchorLen(activity.length);
      setVisibleRows(initialHistoryWindow(activity));
    }
  } else if (activity.length !== anchorLen) {
    // Appends grow the window so on-screen rows don't fold, up to MAX_AUTO_HISTORY_WINDOW; a window "Load earlier"
    // grew past the cap holds its size rather than shrinking.
    if (activity.length > anchorLen) {
      setVisibleRows((v) => Math.min(v + (activity.length - anchorLen), Math.max(v, MAX_AUTO_HISTORY_WINDOW)));
    }
    setAnchorLen(activity.length);
  }
  const computed = useMemo(
    () => historyWindow(activity, visibleRows, showClearedTurns),
    [activity, visibleRows, showClearedTurns],
  );
  // The start may only move earlier; moving it later shrinks a rendered message (#3707). Past the window's cap the
  // pin rolls forward just enough to stay within it, or the auto-growth cap would never bound the DOM.
  const start = pinnedWindowStart(
    activity,
    computed.start,
    anchorRowId,
    Math.max(visibleRows, MAX_AUTO_HISTORY_WINDOW),
  );
  const startRowId = start < activity.length ? (activity[start]?.id ?? null) : null;
  if (startRowId !== anchorRowId && windowSessionId === sessionId) {
    setAnchorRowId(startRowId);
  }
  const canLoadEarlier = canLoadEarlierFrom(activity, start, showClearedTurns);
  const windowedActivity = useMemo(() => (start === 0 ? activity : activity.slice(start)), [activity, start]);
  const loadEarlier = useCallback(() => setVisibleRows((v) => v + HISTORY_WINDOW_STEP), []);
  return { windowedActivity, canLoadEarlier, loadEarlier };
}

export function pinnedWindowStart(
  rows: readonly ActivityRow[],
  computed: number,
  anchorRowId: string | null,
  maxRows: number = Infinity,
): number {
  if (anchorRowId === null) return computed;
  const pinned = rows.findIndex((r) => r.id === anchorRowId);
  if (pinned < 0) return computed;
  if (rows.length - pinned <= maxRows) return Math.min(computed, pinned);
  // Roll row by row rather than snapping to `computed`, which on a turn longer than the cap would jump to the next
  // prompt and fold the whole turn away.
  return Math.max(pinned, Math.min(computed, snapBackToSubagentParent(rows, rows.length - maxRows)));
}
