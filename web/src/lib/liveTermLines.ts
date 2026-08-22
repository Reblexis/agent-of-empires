import { parseAnsi, parseAnsiFrom, type AnsiSegment, type AnsiStyle } from "./ansi";

// Frame helpers for the mobile live terminal: turn one `capture-pane -e`
// snapshot into per-line styled segments the component can render as DOM
// rows. SGR state legitimately spans lines (tmux emits a reset only when
// the style changes), so the split happens AFTER parsing, carrying each
// segment's style across the newline.

export function ansiToLines(content: string): AnsiSegment[][] {
  const segs = parseAnsi(content);
  const lines: AnsiSegment[][] = [[]];
  for (const seg of segs) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part.length > 0) {
        lines[lines.length - 1]!.push({ text: part, style: seg.style });
      }
    });
  }
  // capture-pane terminates every line, including the last, with `\n`;
  // drop the phantom empty line that trailing terminator creates so the
  // last rendered row is the pane's real bottom row.
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines;
}

interface CachedLine {
  segs: AnsiSegment[];
  /** SGR state left in effect after this line, threaded into the next. */
  exit: AnsiStyle;
}

/** Key for the SGR state a line is entered with. Two identical raw lines
 *  parsed under different carried styles are different render results, so
 *  the entry state is part of the cache key. */
function styleKey(s: AnsiStyle): string {
  return `${s.fg ?? ""}|${s.bg ?? ""}|${+!!s.bold}${+!!s.dim}${+!!s.italic}${+!!s.underline}${+!!s.inverse}|${s.link ?? ""}`;
}

/**
 * Frame-to-frame parse cache for [`ansiToLines`]-equivalent output.
 *
 * A streamed capture frame is byte-identical to the previous one on almost
 * every line (only the tail moves), yet re-parsing the whole window per
 * frame made every line's segment arrays fresh objects, which both burned
 * main-thread time on multi-thousand-line reading windows and defeated the
 * row memoization downstream (every mounted row re-rendered per frame, the
 * scroll-jank driver on phones). `lines()` parses per line, keyed on
 * (entry SGR state, raw line), and returns the SAME segment arrays for
 * unchanged lines, so identity-based memo and WeakMap caches hold.
 *
 * Two-generation eviction: entries used by the current frame move to the
 * live generation; the rest are dropped when the next frame arrives.
 * Memory is bounded to two frames' unique lines, and re-running on the
 * same content (React StrictMode double-invoke) converges to identical
 * output and identities.
 */
export class LineParseCache {
  private live = new Map<string, CachedLine>();
  private prev = new Map<string, CachedLine>();

  lines(content: string): AnsiSegment[][] {
    this.prev = this.live;
    this.live = new Map();
    const raw = content.split("\n");
    const lines: AnsiSegment[][] = [];
    let entry: AnsiStyle = {};
    for (const r of raw) {
      // NUL separator: it appears in neither a style key (CSS color
      // strings) nor capture-pane text, so the key cannot be ambiguous.
      const key = styleKey(entry) + "\u0000" + r;
      let hit = this.live.get(key) ?? this.prev.get(key);
      if (!hit) {
        const parsed = parseAnsiFrom(r, entry);
        hit = { segs: parsed.segs, exit: parsed.exit };
      }
      this.live.set(key, hit);
      lines.push(hit.segs);
      entry = hit.exit;
    }
    // Mirror ansiToLines: capture-pane terminates every line, including
    // the last, with `\n`; drop the phantom empty line that creates.
    if (lines.length > 1 && lines[lines.length - 1]!.length === 0) {
      lines.pop();
    }
    return lines;
  }
}

/** Plain text of one rendered line (for tests / cursor math). */
export function lineText(line: AnsiSegment[]): string {
  return line.map((s) => s.text).join("");
}

// Match http(s) URLs so agent output in the terminal view can be linkified.
// ponytail: plain per-line regex, no OSC 8 / reflow tracking (there is no
// xterm here). A URL split across wrapped visual rows linkifies only its
// first part; upgrade to reflow-aware matching only if that proves painful.
const URL_RE = /https?:\/\/\S+/g;
// Trailing punctuation that is usually sentence/wrapping syntax, not the URL
// (e.g. `see https://x.com/a).`). Stripped from the match; re-emitted as text.
const URL_TRAILING = /[.,;:!?)\]}'">]+$/;

export interface UrlPart {
  text: string;
  /** The href when this part is a link, else null. */
  url: string | null;
}

/** Split one line of plain text into link and non-link parts. Returns a
 *  single non-link part when there are no URLs. */
export function splitUrls(text: string): UrlPart[] {
  const parts: UrlPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    const raw = m[0];
    const trimmed = raw.replace(URL_TRAILING, "");
    // Keep the trimmed form only if a host character survives; otherwise the
    // match was scheme + punctuation and the original stands.
    const url = /^https?:\/\/\S/.test(trimmed) ? trimmed : raw;
    if (start > last) parts.push({ text: text.slice(last, start), url: null });
    parts.push({ text: url, url });
    last = start + url.length;
  }
  if (parts.length === 0) return [{ text, url: null }];
  if (last < text.length) parts.push({ text: text.slice(last), url: null });
  return parts;
}

/** One clickable range inside a rendered row, in UTF-16 code-unit offsets of
 *  the row's joined text. `href` is the FULL url, which for a wrapped URL is
 *  longer than the row's visible fragment. */
export interface LinkSpan {
  start: number;
  end: number;
  href: string;
}

/** How many extra rows a wrapped URL may continue across. tmux panes are at
 *  most a few hundred cells wide, so 8 rows covers every real URL while
 *  bounding the join walk. */
const MAX_URL_CONTINUATION_ROWS = 8;

/**
 * Per-row link spans for a window of rendered rows, matching URLs on each
 * row's JOINED text (so a URL styled as several ANSI segments is one link,
 * not per-segment fragments) and joining a URL that wraps across full-width
 * rows (tmux wraps by cells, so a long URL continues on the next row with no
 * marker). Every row a wrapped URL touches gets a span carrying the full
 * joined href. Rows without links share the exported `NO_LINKS` constant so
 * memoized row components keep identity.
 *
 * `matchCache`/`spanCache`, when supplied, are keyed by row segment-array
 * identity (stable across frames via LineParseCache) so a streamed frame
 * only pays regex work for changed rows and unchanged rows keep their span
 * array identity.
 */
export const NO_LINKS: LinkSpan[] = [];

interface RowMatch {
  index: number;
  raw: string;
}

/** Explicit link spans from OSC 8 hyperlink state on a row's segments: a
 *  contiguous run of segments carrying the same `style.link` is one span
 *  whose href is the escape's own URI. These outrank regex matching: the
 *  emitting program said exactly what the link is, and the visible text may
 *  be arbitrary (shortened labels, wrapped fragments). */
function explicitSpans(row: AnsiSegment[]): LinkSpan[] {
  let spans: LinkSpan[] | null = null;
  let open: LinkSpan | null = null;
  let off = 0;
  for (const seg of row) {
    const link = seg.style.link;
    if (open && open.href !== link) {
      open.end = off;
      (spans ??= []).push(open);
      open = null;
    }
    if (link && !open) open = { start: off, end: off, href: link };
    off += seg.text.length;
  }
  if (open) {
    open.end = off;
    (spans ??= []).push(open);
  }
  return spans ?? NO_LINKS;
}

export function computeRowLinks(
  rows: AnsiSegment[][],
  cols: number,
  matchCache?: WeakMap<AnsiSegment[], RowMatch[]>,
  spanCache?: WeakMap<AnsiSegment[], LinkSpan[]>,
  textCache?: WeakMap<AnsiSegment[], string>,
): LinkSpan[][] {
  const textFor = (i: number): string => {
    const key = rows[i]!;
    const hit = textCache?.get(key);
    if (hit !== undefined) return hit;
    const text = lineText(key);
    textCache?.set(key, text);
    return text;
  };
  const texts: string[] = rows.map((_, i) => textFor(i));
  const matchesFor = (i: number): RowMatch[] => {
    const key = rows[i]!;
    const hit = matchCache?.get(key);
    if (hit) return hit;
    const out: RowMatch[] = [];
    for (const m of texts[i]!.matchAll(URL_RE)) out.push({ index: m.index, raw: m[0] });
    matchCache?.set(key, out);
    return out;
  };
  const result: LinkSpan[][] = new Array(rows.length).fill(NO_LINKS);
  // Rows already consumed as a continuation carry the code-unit offset the
  // primary scan should resume from (the URL fragment prefix is spoken for).
  const resumeAt: number[] = new Array(rows.length).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const text = texts[i]!;
    const explicit = explicitSpans(rows[i]!);
    const spans: LinkSpan[] = result[i] === NO_LINKS ? [...explicit] : [...result[i]!, ...explicit];
    for (const m of matchesFor(i)) {
      if (m.index < resumeAt[i]!) continue;
      // An OSC 8 hyperlink already covers this text: its escape-supplied
      // href wins over anything the regex would guess.
      if (explicit.some((s) => s.start < m.index + m.raw.length && s.end > m.index)) continue;
      let raw = m.raw;
      let end = m.index + raw.length;
      // A match running to the exact end of a full-width row continues on
      // the next row: tmux wrapped it mid-URL with no marker. Join the
      // leading non-space run of each following row while the wrap keeps
      // filling the full width.
      const contSpans: { row: number; end: number }[] = [];
      if (end === text.length && textWidth(text) === cols) {
        let j = i + 1;
        while (j < rows.length && j - i <= MAX_URL_CONTINUATION_ROWS) {
          const next = texts[j]!;
          const frag = /^\S+/.exec(next);
          if (!frag) break;
          raw += frag[0];
          contSpans.push({ row: j, end: frag[0].length });
          if (frag[0].length === next.length && textWidth(next) === cols) {
            j++;
            continue;
          }
          break;
        }
      }
      const trimmed = raw.replace(URL_TRAILING, "");
      const href = /^https?:\/\/\S/.test(trimmed) ? trimmed : raw;
      const cut = raw.length - href.length;
      // Trailing punctuation trimmed from the href also leaves the visible
      // span, shrinking the LAST fragment (dropping it entirely if the trim
      // ate the whole fragment).
      if (contSpans.length > 0) {
        const last = contSpans[contSpans.length - 1]!;
        last.end -= cut;
        if (last.end <= 0) contSpans.pop();
      } else {
        end -= cut;
      }
      if (end > m.index) spans.push({ start: m.index, end, href });
      for (const c of contSpans) {
        const rowSpans = result[c.row] === NO_LINKS ? [] : [...result[c.row]!];
        rowSpans.push({ start: 0, end: c.end, href });
        result[c.row] = rowSpans;
        resumeAt[c.row] = Math.max(resumeAt[c.row]!, c.end);
      }
    }
    if (spans.length > 0) {
      // Renderers walk spans in order; explicit and regex spans were
      // appended from separate passes, so normalize here.
      spans.sort((a, b) => a.start - b.start);
      result[i] = spans;
    }
  }
  // Preserve span-array identity for unchanged rows so memoized row
  // components skip them. Continuations make a row's spans depend on its
  // neighbors, so the cache is validated by value, not just row identity.
  if (spanCache) {
    for (let i = 0; i < rows.length; i++) {
      if (result[i] === NO_LINKS) continue;
      const key = rows[i]!;
      const cached = spanCache.get(key);
      if (
        cached &&
        cached.length === result[i]!.length &&
        cached.every(
          (s, k) => s.start === result[i]![k]!.start && s.end === result[i]![k]!.end && s.href === result[i]![k]!.href,
        )
      ) {
        result[i] = cached;
      } else {
        spanCache.set(key, result[i]!);
      }
    }
  }
  return result;
}

// Terminal cell widths, wcwidth-style: combining marks and zero-width
// joiners take no cell; East Asian Wide/Fullwidth and emoji take two.
// tmux wraps by cells, so wrapping (and the cursor math built on it)
// must count the same way, not in UTF-16 code units.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]|\p{M}/u;
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}]|\p{Emoji_Presentation}/u;
const ASCII_PRINTABLE_ONLY = /^[\x20-\x7E]*$/;

export function cellWidth(codePoint: string): number {
  if (ZERO_WIDTH.test(codePoint)) return 0;
  return WIDE.test(codePoint) ? 2 : 1;
}

export function textWidth(text: string): number {
  if (ASCII_PRINTABLE_ONLY.test(text)) return text.length;
  let width = 0;
  for (const ch of text) width += cellWidth(ch);
  return width;
}

/** Find the code point in `text` whose terminal cell range contains `col`
 *  (cell units from the start of `text`), or null if `col` falls at or
 *  past the end. Iterates code points (an emoji's surrogate pair never
 *  splits) and counts cells the same way `textWidth`/`wrapLine` do, so a
 *  cursor column from tmux (already cell-based) lands on the right glyph
 *  even when wide CJK or zero-width characters precede it. */
export function findCursorCharIndex(text: string, col: number): number | null {
  if (ASCII_PRINTABLE_ONLY.test(text)) {
    return col >= 0 && col < text.length ? col : null;
  }
  let c = 0;
  let i = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (col >= c && col < c + w) return i;
    c += w;
    i++;
  }
  return null;
}

/** Hard-wrap one styled line at `cols` terminal cells, preserving
 *  segment styles across the breaks. Lines at or under the limit return
 *  a single visual row (the normal case: the pane is sized to the
 *  viewer's grid, so this is the identity). Wider lines appear when
 *  another writer resized the tmux window out from under the viewer;
 *  wrapping keeps them readable until the server re-asserts the grid.
 *  Iterates code points (an emoji's surrogate pair never splits) and
 *  counts cells, so CJK and emoji wrap where tmux would wrap them. */
export function wrapLine(line: AnsiSegment[], cols: number): AnsiSegment[][] {
  if (!Number.isFinite(cols) || cols <= 0) return [line];
  const total = line.reduce((n, s) => n + textWidth(s.text), 0);
  if (total <= cols) return [line];
  const rows: AnsiSegment[][] = [];
  let current: AnsiSegment[] = [];
  let used = 0;
  for (const seg of line) {
    let chunk = "";
    const flushChunk = () => {
      if (chunk.length > 0) {
        current.push({ text: chunk, style: seg.style });
        chunk = "";
      }
    };
    for (const ch of seg.text) {
      const w = cellWidth(ch);
      // A wide char that doesn't fit wraps whole (terminals leave the
      // last cell empty); zero-width marks stay with their base char.
      if (used + w > cols && used > 0) {
        flushChunk();
        rows.push(current);
        current = [];
        used = 0;
      }
      chunk += ch;
      used += w;
    }
    flushChunk();
  }
  if (current.length > 0 || rows.length === 0) rows.push(current);
  return rows;
}
