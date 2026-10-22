import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AnsiSegment } from "../../lib/ansi";
import { EchoTracker, type EchoRow } from "../../lib/liveEcho";
import { cursorLineIndex } from "../../lib/liveMouse";
import { reportError } from "../../lib/logger";
import type { LiveFrame } from "../../hooks/useLiveTerminal";

const fail = (echo: EchoTracker, err: unknown) => {
  echo.reset();
  reportError(err, { target: "live.echo" });
};

/** Local echo (docs/guides/web/terminal.md, "Typing echoes locally"): the frame's lines with pending typing drawn
 *  at the cursor, the predicted cursor column, and `sent` to call after each delivered key. Prediction only ever
 *  adds a preview: any failure drops it and the server's screen shows as it is. */
export function useLocalEcho({
  enabled,
  reading,
  frame,
  lines: parsedLines,
  renderCols,
}: {
  /** This browser's keys reach the pane: connected and owning it. */
  enabled: boolean;
  reading: boolean;
  frame: LiveFrame | null;
  lines: AnsiSegment[][];
  renderCols: number;
}) {
  const [echo] = useState(() => new EchoTracker());
  const [echoVersion, setEchoVersion] = useState(0);
  // Nothing is predicted without a cursor, in a full-screen app, while reading, or in a split window (whose cursor
  // row carries the other pane's text).
  const echoRow = useMemo((): (EchoRow & { idx: number }) | null => {
    const cursor = frame?.cursor;
    if (!enabled || reading || !frame || !cursor || frame.altScreen || frame.pane0) return null;
    const idx = cursorLineIndex(parsedLines.length, frame.rows, cursor.y);
    const segs = parsedLines[idx];
    const width = renderCols > 0 ? renderCols : undefined;
    return segs ? { segs, x: cursor.x, width, idx } : null;
  }, [enabled, reading, frame, parsedLines, renderCols]);
  // Each new snapshot settles the predictions before paint, so a confirmed character is never drawn twice.
  const [reconciledRow, setReconciledRow] = useState(echoRow);
  if (reconciledRow !== echoRow) {
    setReconciledRow(echoRow);
    try {
      echo.reconcile(echoRow);
    } catch (err) {
      fail(echo, err);
    }
  }
  const echoRowRef = useRef(echoRow);
  useLayoutEffect(() => {
    echoRowRef.current = echoRow;
  }, [echoRow]);
  const predicted = useMemo(
    () => {
      if (!echoRow) return null;
      try {
        return echo.render(echoRow);
      } catch (err) {
        fail(echo, err);
        return null;
      }
    },
    // echoVersion: the tracker is mutable; a bump means its state changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [echo, echoRow, echoVersion],
  );
  const lines = useMemo(() => {
    if (!predicted || !echoRow) return parsedLines;
    const out = parsedLines.slice();
    out[echoRow.idx] = predicted.segs;
    return out;
  }, [parsedLines, predicted, echoRow]);
  useEffect(() => {
    echo.arm(Date.now());
    const deadline = echo.deadline();
    if (deadline == null) return;
    const timer = setTimeout(
      () => {
        echo.expire(Date.now());
        setEchoVersion((v) => v + 1);
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [echo, echoVersion, reconciledRow]);

  /** Called after the key went out; an undelivered key drops every prediction. */
  const sent = useCallback(
    (data: string, delivered: boolean) => {
      try {
        if (delivered) echo.input(data, echoRowRef.current, Date.now());
        else echo.reset();
      } catch (err) {
        fail(echo, err);
      }
      setEchoVersion((v) => v + 1);
    },
    [echo],
  );

  return { lines, cursorX: predicted?.x ?? null, sent };
}
