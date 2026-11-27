import type { AnsiSegment, AnsiStyle } from "./ansi";
import { cellWidth } from "./liveTermLines";

// Local echo for the live view (docs/guides/web/terminal.md, "Typing echoes
// locally"): predict what plain typing does to the cursor's row so it shows
// before the server's snapshot arrives, the way mosh does.
//
// A prediction is a list of input events applied to the cursor row of the
// latest snapshot. Each snapshot is matched against the predictions: the
// longest prefix of the events that turns the previous row into this one (same
// cursor column, same text left of it) is what the app has processed, and the
// rest stays predicted on top of the new row. No prefix fitting means the app
// did something else, and every prediction is dropped.
//
// Trust is per prompt: a row is predicted visibly only once a row with the same
// prompt has echoed this browser's typing, so a password prompt (which never
// echoes) never shows what was typed. Trust also carries from row to row while
// only plain typing is sent (a prompt that wrapped onto its next row), and an
// agent's own input box, which always echoes, is trusted from the first key.
//
// An agent's input box wraps by word at a known column, so there the row below
// the cursor's is predicted too: the word that no longer fits moves down to the
// box's indent, the way the agent will draw it.

/** How long a prediction may stay unconfirmed before it is dropped. */
export const ECHO_CONFIRM_MS = 1500;
/** Longest prompt signature kept for trust. */
const SIGNATURE_MAX = 40;

export type EchoEvent = { kind: "char"; ch: string } | { kind: "bs" };

/** The cursor's row in the latest snapshot. Its segments may end at the
 *  last visible character (the screen keeps no trailing spaces), so the
 *  cursor can sit past them; `width` is the pane's width when known. */
export interface EchoRow {
  segs: AnsiSegment[];
  x: number;
  width?: number;
  /** The row under the cursor's, which a wrap is predicted onto. */
  below?: AnsiSegment[];
  /** Set for an agent's input box, which wraps by word: the columns it keeps free at the right edge. */
  wrapMargin?: number;
}

interface Cell {
  ch: string;
  style: AnsiStyle;
}

const BLANK: AnsiStyle = {};

/** Input bytes as predictable events, or null when anything in them is not
 *  plain typing (which must drop every prediction). */
export function classifyInput(data: string): EchoEvent[] | null {
  if (data.length === 0) return null;
  const events: EchoEvent[] = [];
  for (const ch of data) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x7f) events.push({ kind: "bs" });
    else if (cp < 0x20 || (cp >= 0x80 && cp < 0xa0) || cellWidth(ch) !== 1) return null;
    else events.push({ kind: "char", ch });
  }
  return events;
}

function cellsOf(segs: AnsiSegment[]): Cell[] {
  const cells: Cell[] = [];
  for (const seg of segs) {
    for (const ch of seg.text) {
      const w = cellWidth(ch);
      if (w === 0 && cells.length > 0) cells[cells.length - 1]!.ch += ch;
      else {
        cells.push({ ch, style: seg.style });
        if (w === 2) cells.push({ ch: "", style: seg.style });
      }
    }
  }
  return cells;
}

function segsOf(cells: Cell[]): AnsiSegment[] {
  const segs: AnsiSegment[] = [];
  for (const c of cells) {
    const last = segs.at(-1);
    if (last && last.style === c.style) last.text += c.ch;
    else segs.push({ text: c.ch, style: c.style });
  }
  return segs;
}

/** The row's cells, padded with blanks to its width and past the cursor so
 *  every cell left of and at the cursor exists. */
function rowCells(row: EchoRow): Cell[] {
  const cells = cellsOf(row.segs);
  const target = Math.max(row.width ?? 0, row.x + 1);
  while (cells.length < target) cells.push({ ch: " ", style: BLANK });
  return cells;
}

const isBlank = (c: Cell) => c.ch.trim() === "";

/** Longest indent an input box may have for its wrap to be predicted. */
const WRAP_INDENT_MAX = 4;

interface Applied {
  /** The cursor's row of the snapshot. */
  cells: Cell[];
  /** The row under it, when the typing wrapped onto it. */
  below: Cell[] | null;
  x: number;
}

/** Where an input box's text starts: after the prompt glyph and its space on the first row (`❯ `), at the
 *  leading blanks on a continuation row. Null when the row does not look like one. */
function boxIndent(cells: Cell[], x: number): number | null {
  let i = 0;
  // An empty continuation row is all blanks; its text starts no further right than the cursor.
  if (cells[0] && isBlank(cells[0])) while (i < cells.length && i < x && isBlank(cells[i]!)) i++;
  else {
    while (i < cells.length && !isBlank(cells[i]!)) i++;
    i += 1;
  }
  return i >= 1 && i <= WRAP_INDENT_MAX ? i : null;
}

/** The rows after `events`, or null when the outcome is not predictable (the cursor would leave the row another
 *  way than a predicted wrap, or text would be pushed off its end). `wrapMargin` and `under` (the row below, padded
 *  to the same width) turn on wrap prediction. */
function applyEvents(
  row: Cell[],
  x0: number,
  events: EchoEvent[],
  wrapMargin?: number,
  under?: Cell[] | null,
): Applied | null {
  const first = row.slice();
  const width = first.length;
  const indent = wrapMargin != null ? boxIndent(first, x0) : null;
  const wraps = indent != null && wrapMargin != null;
  // The column the cursor rests at when the row is full; past it the text wraps.
  const limit = wraps ? width - wrapMargin : width;
  let below: Cell[] | null = null;
  let cells = first;
  let x = x0;
  if (x < 0 || x >= width) return null;
  for (const ev of events) {
    if (ev.kind === "bs") {
      if (x === 0 || cells[x - 1]!.ch === "") return null;
      // Backspace at the start of the box's text joins the row above, which is not predicted.
      if (wraps && x <= indent) return null;
      cells.splice(x - 1, 1);
      cells.push({ ch: " ", style: BLANK });
      x -= 1;
      continue;
    }
    const style = x > 0 ? cells[x - 1]!.style : BLANK;
    const rest = cells.slice(x);
    const atEnd = rest.every((c) => isBlank(c) || c.style.dim);
    if (wraps && atEnd && x >= limit) {
      // The row is full: the agent wraps. Only one wrap is predicted ahead of the server.
      if (below || !under || x > limit) return null;
      const next: Cell[] = Array.from({ length: width }, () => ({ ch: " ", style: BLANK }));
      let nx = indent;
      if (ev.ch !== " ") {
        // The word that no longer fits moves down whole; a row that is one long word breaks where it is full.
        let space = -1;
        for (let i = x - 1; i >= indent; i--) {
          if (isBlank(cells[i]!)) {
            space = i;
            break;
          }
        }
        if (space >= 0) {
          const word = cells.slice(space + 1, x);
          if (word.some((c) => c.ch === "") || indent + word.length + 1 > limit) return null;
          for (const c of word) next[nx++] = c;
          for (let i = space; i < width; i++) cells[i] = { ch: " ", style: BLANK };
        }
        next[nx++] = { ch: ev.ch, style };
      }
      below = next;
      cells = next;
      x = nx;
      continue;
    }
    if (atEnd) {
      // Blank or a dim placeholder: the app overwrites it.
      for (let i = x; i < width; i++) cells[i] = { ch: " ", style: BLANK };
      cells[x] = { ch: ev.ch, style };
    } else {
      cells.splice(x, 0, { ch: ev.ch, style });
      if (!isBlank(cells[width]!)) return null;
      cells.length = width;
      // Text pushed past the box's last column would wrap, which is not predicted mid-row.
      if (wraps && cells.slice(limit).some((c) => !isBlank(c))) return null;
    }
    x += 1;
    if (wraps ? x > limit : x >= width) return null;
  }
  return { cells: first, below, x };
}

/** The row's prompt: its text left of the cursor up to the first space after
 *  the first word (`❯ `, `user@host:~$ `, `[sudo] `). */
function signature(cells: Cell[], x: number): string {
  const text = cells
    .slice(0, x)
    .map((c) => c.ch)
    .join("");
  const end = text.search(/\S\s/);
  return (end < 0 ? text : text.slice(0, end + 2)).slice(0, SIGNATURE_MAX);
}

interface Pending {
  base: Cell[];
  /** The row under the base row, for a predicted wrap. */
  under: Cell[] | null;
  wrapMargin: number | undefined;
  x: number;
  events: EchoEvent[];
  sig: string;
  shown: boolean;
  /** When an unconfirmed prediction is dropped; null right after progress,
   *  until `arm` restarts the clock. */
  deadline: number | null;
}

/** The row under the cursor's, padded to `width`. */
function underCells(row: EchoRow, width: number): Cell[] | null {
  if (!row.below) return null;
  const cells = cellsOf(row.below);
  while (cells.length < width) cells.push({ ch: " ", style: BLANK });
  return cells;
}

/** The row the cursor is on after `r`. */
const cursorRow = (r: Applied) => r.below ?? r.cells;

export class EchoTracker {
  private trusted = new Set<string>();
  private state: Pending | null = null;
  /** The app echoed this browser's last typing and only plain typing was sent since. */
  private flow = false;
  /** Every row echoes (an agent's own input box), so no row has to earn trust. */
  private trustAll = false;

  setTrustAll(on: boolean) {
    this.trustAll = on;
  }

  /** Typing sent to the app; `row` is the cursor row it lands on, or null
   *  when nothing may be predicted (no cursor, full-screen app, reading). */
  input(data: string, row: EchoRow | null, now: number) {
    const events = classifyInput(data);
    if (!events) this.flow = false;
    if (!events || !row) {
      this.state = null;
      return;
    }
    if (!this.state) {
      const base = rowCells(row);
      const sig = signature(base, row.x);
      this.state = {
        base,
        under: underCells(row, base.length),
        wrapMargin: row.wrapMargin,
        x: row.x,
        events: [],
        sig,
        shown: this.trustAll || this.flow || this.trusted.has(sig),
        deadline: now + ECHO_CONFIRM_MS,
      };
    }
    const s = this.state;
    s.events.push(...events);
    if (!applyEvents(s.base, s.x, s.events, s.wrapMargin, s.under)) this.state = null;
  }

  /** A new snapshot: settle what the app has processed. A null row (cursor
   *  hidden mid-redraw) settles nothing. Clock-free so it can run during
   *  render; progress restarts the confirmation clock through `arm`. */
  reconcile(row: EchoRow | null) {
    const s = this.state;
    if (!s || !row) return;
    const seen = rowCells(row);
    for (let j = s.events.length; j >= 0; j--) {
      const r = applyEvents(s.base, s.x, s.events.slice(0, j), s.wrapMargin, s.under);
      if (!r || r.x !== row.x) continue;
      const want = cursorRow(r);
      let same = true;
      for (let i = 0; i < r.x && same; i++) same = want[i]!.ch === seen[i]?.ch;
      if (!same) continue;
      if (j > 0) {
        this.trusted.add(s.sig);
        this.flow = true;
        s.shown = true;
        s.deadline = null;
      }
      s.events = s.events.slice(j);
      s.base = seen;
      s.under = underCells(row, seen.length);
      s.wrapMargin = row.wrapMargin;
      s.x = row.x;
      if (s.events.length === 0 || !applyEvents(s.base, s.x, s.events, s.wrapMargin, s.under)) this.state = null;
      return;
    }
    this.state = null;
  }

  /** Drop a prediction the app has not confirmed in time; its prompt has to
   *  earn trust again. */
  expire(now: number) {
    const deadline = this.state?.deadline;
    if (!this.state || deadline == null || now < deadline) return;
    this.trusted.delete(this.state.sig);
    this.flow = false;
    this.state = null;
  }

  /** Drop every prediction (prediction failed; show the server's screen). */
  reset() {
    this.state = null;
    this.flow = false;
  }

  pending(): boolean {
    return this.state != null;
  }

  /** Restart the confirmation clock after progress. */
  arm(now: number) {
    if (this.state && this.state.deadline == null) this.state.deadline = now + ECHO_CONFIRM_MS;
  }

  deadline(): number | null {
    return this.state?.deadline ?? null;
  }

  /** The cursor row as predicted (and the row under it when the typing wrapped onto it, where the cursor then
   *  is), or null when nothing is shown. */
  render(row: EchoRow): { segs: AnsiSegment[]; x: number; below: AnsiSegment[] | null } | null {
    const s = this.state;
    if (!s || !s.shown) return null;
    const base = rowCells(row);
    const r = applyEvents(base, row.x, s.events, row.wrapMargin, underCells(row, base.length));
    return r && { segs: segsOf(r.cells), x: r.x, below: r.below && segsOf(r.below) };
  }
}
