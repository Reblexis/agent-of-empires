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
// echoes) never shows what was typed.

/** How long a prediction may stay unconfirmed before it is dropped. */
export const ECHO_CONFIRM_MS = 1500;
/** Longest prompt signature kept for trust. */
const SIGNATURE_MAX = 40;

export type EchoEvent = { kind: "char"; ch: string } | { kind: "bs" };

/** The cursor's row in the latest snapshot. */
export interface EchoRow {
  segs: AnsiSegment[];
  x: number;
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

const isBlank = (c: Cell) => c.ch.trim() === "";

/** The row after `events`, or null when the outcome is not predictable (the
 *  cursor would leave the row, or text would be pushed off its end). */
function applyEvents(row: Cell[], x0: number, events: EchoEvent[]): { cells: Cell[]; x: number } | null {
  const cells = row.slice();
  const width = cells.length;
  let x = x0;
  for (const ev of events) {
    if (ev.kind === "bs") {
      if (x === 0 || cells[x - 1]!.ch === "") return null;
      cells.splice(x - 1, 1);
      cells.push({ ch: " ", style: BLANK });
      x -= 1;
      continue;
    }
    const style = x > 0 ? cells[x - 1]!.style : BLANK;
    const rest = cells.slice(x);
    if (rest.every((c) => isBlank(c) || c.style.dim)) {
      // Blank or a dim placeholder: the app overwrites it.
      for (let i = x; i < width; i++) cells[i] = { ch: " ", style: BLANK };
      cells[x] = { ch: ev.ch, style };
    } else {
      cells.splice(x, 0, { ch: ev.ch, style });
      if (!isBlank(cells[width]!)) return null;
      cells.length = width;
    }
    x += 1;
    if (x >= width) return null;
  }
  return { cells, x };
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
  x: number;
  events: EchoEvent[];
  sig: string;
  shown: boolean;
  /** When an unconfirmed prediction is dropped; null right after progress,
   *  until `arm` restarts the clock. */
  deadline: number | null;
}

export class EchoTracker {
  private trusted = new Set<string>();
  private state: Pending | null = null;

  /** Typing sent to the app; `row` is the cursor row it lands on, or null
   *  when nothing may be predicted (no cursor, full-screen app, reading). */
  input(data: string, row: EchoRow | null, now: number) {
    const events = classifyInput(data);
    if (!events || !row) {
      this.state = null;
      return;
    }
    if (!this.state) {
      const base = cellsOf(row.segs);
      const sig = signature(base, row.x);
      this.state = { base, x: row.x, events: [], sig, shown: this.trusted.has(sig), deadline: now + ECHO_CONFIRM_MS };
    }
    this.state.events.push(...events);
    if (!applyEvents(this.state.base, this.state.x, this.state.events)) this.state = null;
  }

  /** A new snapshot: settle what the app has processed. A null row (cursor
   *  hidden mid-redraw) settles nothing. Clock-free so it can run during
   *  render; progress restarts the confirmation clock through `arm`. */
  reconcile(row: EchoRow | null) {
    const s = this.state;
    if (!s || !row) return;
    const seen = cellsOf(row.segs);
    for (let j = s.events.length; j >= 0; j--) {
      const r = applyEvents(s.base, s.x, s.events.slice(0, j));
      if (!r || r.x !== row.x) continue;
      let same = true;
      for (let i = 0; i < r.x && same; i++) same = r.cells[i]!.ch === seen[i]?.ch;
      if (!same) continue;
      if (j > 0) {
        this.trusted.add(s.sig);
        s.shown = true;
        s.deadline = null;
      }
      s.events = s.events.slice(j);
      s.base = seen;
      s.x = row.x;
      if (s.events.length === 0) this.state = null;
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
    this.state = null;
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

  /** The cursor row as predicted, or null when nothing is shown. */
  render(row: EchoRow): { segs: AnsiSegment[]; x: number } | null {
    const s = this.state;
    if (!s || !s.shown) return null;
    const r = applyEvents(cellsOf(row.segs), row.x, s.events);
    return r && { segs: segsOf(r.cells), x: r.x };
  }
}
