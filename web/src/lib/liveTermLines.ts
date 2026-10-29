import { parseAnsi, parseAnsiFrom, type AnsiSegment, type AnsiState } from "./ansi";

// Split a `capture-pane -e` snapshot into styled rows. SGR state spans lines, so split after parsing.

export function ansiToLines(content: string): AnsiSegment[][] {
  const segs = parseAnsi(content);
  const lines: AnsiSegment[][] = [[]];
  for (const seg of segs) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part.length > 0) {
        lines[lines.length - 1]!.push({ text: part, style: seg.style, url: seg.url });
      }
    });
  }
  // capture-pane terminates the last line too; drop the phantom empty row.
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines;
}

interface CachedLine {
  segs: AnsiSegment[];
  /** Escape state left in effect after this line. */
  exit: AnsiState;
}

/** A line's render depends on the style and hyperlink it is entered with, so both are in the key. */
function styleKey({ style: s, url }: AnsiState): string {
  return `${s.fg ?? ""}|${s.bg ?? ""}|${+!!s.bold}${+!!s.dim}${+!!s.italic}${+!!s.underline}${+!!s.inverse}|${url ?? ""}`;
}

/** Per-line parse cache that returns the same segment arrays for unchanged lines, keeping row memoization intact across frames. Two generations: entries unused by the current frame are dropped on the next. */
export class LineParseCache {
  private live = new Map<string, CachedLine>();
  private prev = new Map<string, CachedLine>();

  lines(content: string | readonly string[]): AnsiSegment[][] {
    this.prev = this.live;
    this.live = new Map();
    const raw = typeof content === "string" ? content.split("\n") : content;
    const lines: AnsiSegment[][] = [];
    let entry: AnsiState = { style: {} };
    for (const r of raw) {
      // NUL appears in neither style keys nor pane text, so the key is unambiguous.
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
    // A row array from the hook has already dropped the phantom trailing line.
    if (typeof content === "string" && lines.length > 1 && lines[lines.length - 1]!.length === 0) {
      lines.pop();
    }
    return lines;
  }
}

export function lineText(line: AnsiSegment[]): string {
  return line.map((s) => s.text).join("");
}

// splitUrls matches one string; computeRowLinks matches whole rows and joins URLs wrapped across full-width rows.
const URL_RE = /https?:\/\/\S+/g;

/** Pane output is agent-controlled, so only http(s) targets become hrefs. */
export function isHttpUrl(url: string): boolean {
  // A control byte in a target is never legitimate and would let pane output
  // inject escapes into whatever re-emits it.
  // eslint-disable-next-line no-control-regex
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u001f\u007f]/.test(url)) return false;
  try {
    // `https://` alone names no host.
    return new URL(url).hostname.length > 0;
  } catch {
    return false;
  }
}
// Trailing sentence punctuation, re-emitted as text.
const URL_TRAILING = /[.,;:!?)\]}'">]+$/;

export interface UrlPart {
  text: string;
  url: string | null;
}

export function splitUrls(text: string): UrlPart[] {
  const parts: UrlPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    const raw = m[0];
    const trimmed = raw.replace(URL_TRAILING, "");
    // Keep the trimmed form only if a host character survives.
    const url = /^https?:\/\/\S/.test(trimmed) ? trimmed : raw;
    if (start > last) parts.push({ text: text.slice(last, start), url: null });
    parts.push({ text: url, url });
    last = start + url.length;
  }
  if (parts.length === 0) return [{ text, url: null }];
  if (last < text.length) parts.push({ text: text.slice(last), url: null });
  return parts;
}

/** One clickable range in a rendered row, in UTF-16 offsets of the row's joined text. `href` is the full URL, which
 *  for a wrapped URL is longer than the row's visible fragment. */
export interface LinkSpan {
  start: number;
  end: number;
  href: string;
}

/** Shared by every row without links, so memoized rows keep identity. */
export const NO_LINKS: LinkSpan[] = [];

/** How many extra rows a wrapped URL may continue across; bounds the join walk. */
const MAX_URL_CONTINUATION_ROWS = 8;
/** A row's text column: its indent plus a list or tool-output marker, where an agent's hard wrap resumes. */
const TEXT_COLUMN_RE = /^\s*(?:(?:[-*+•⎿]|\d+[.)])\s+)?/;
/** A continuation row: indent, then the run of characters a URL can contain. */
const URL_CONTINUATION_RE = /^(\s*)([A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/;

interface RowMatch {
  index: number;
  raw: string;
}

/** OSC 8 runs on a row: consecutive segments with the same http(s) target are one span whose href is the escape's
 *  own URI. They outrank the URL matcher, since the visible text may be a label or a fragment. */
function explicitSpans(row: AnsiSegment[]): LinkSpan[] {
  let spans: LinkSpan[] | null = null;
  let open: LinkSpan | null = null;
  let off = 0;
  for (const seg of row) {
    const link = seg.url && isHttpUrl(seg.url) ? seg.url : undefined;
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

/**
 * Link spans per rendered row, matched on each row's joined text (a URL styled as several segments is one link) and
 * joined across full-width rows (tmux wraps a long URL by cells with no marker), so every fragment carries the full
 * href. The caches, keyed by row identity (stable via LineParseCache and the wrap cache), keep a streamed frame's
 * regex work to changed rows and keep unchanged rows' span arrays identical.
 */
export function computeRowLinks(
  rows: AnsiSegment[][],
  cols: number,
  matchCache?: WeakMap<AnsiSegment[], RowMatch[]>,
  spanCache?: WeakMap<AnsiSegment[], LinkSpan[]>,
  textCache?: WeakMap<AnsiSegment[], string>,
): LinkSpan[][] {
  const texts = rows.map((key) => {
    const hit = textCache?.get(key);
    if (hit !== undefined) return hit;
    const text = lineText(key);
    textCache?.set(key, text);
    return text;
  });
  const matchesFor = (i: number): RowMatch[] => {
    const key = rows[i]!;
    const hit = matchCache?.get(key);
    if (hit) return hit;
    const out: RowMatch[] = [];
    for (const m of texts[i]!.matchAll(URL_RE)) out.push({ index: m.index, raw: m[0] });
    matchCache?.set(key, out);
    return out;
  };
  const result: LinkSpan[][] = new Array<LinkSpan[]>(rows.length).fill(NO_LINKS);
  // A row consumed as a continuation resumes its own scan after the fragment.
  const resumeAt: number[] = new Array<number>(rows.length).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const text = texts[i]!;
    const explicit = explicitSpans(rows[i]!);
    const spans: LinkSpan[] = result[i] === NO_LINKS ? [...explicit] : [...result[i]!, ...explicit];
    for (const m of matchesFor(i)) {
      if (m.index < resumeAt[i]!) continue;
      if (explicit.some((s) => s.start < m.index + m.raw.length && s.end > m.index)) continue;
      let raw = m.raw;
      let end = m.index + raw.length;
      // A match running to the end of a full-width row continues with the next row's leading URL run, for as long as
      // the wrap keeps filling the width. tmux wraps to column 0; an agent that hard-wraps its own indented output
      // (Claude Code) resumes at the row's text column.
      const contSpans: { row: number; start: number; end: number }[] = [];
      if (end === text.length && textWidth(text) === cols) {
        const textColumn = TEXT_COLUMN_RE.exec(text)![0].length;
        let j = i + 1;
        while (j < rows.length && j - i <= MAX_URL_CONTINUATION_ROWS) {
          const next = texts[j]!;
          const frag = URL_CONTINUATION_RE.exec(next);
          if (!frag) break;
          const indent = frag[1]!.length;
          if (indent !== 0 && indent !== textColumn) break;
          raw += frag[2]!;
          contSpans.push({ row: j, start: indent, end: frag[0].length });
          if (frag[0].length === next.length && textWidth(next) === cols) {
            j++;
            continue;
          }
          break;
        }
      }
      const trimmed = raw.replace(URL_TRAILING, "");
      const href = /^https?:\/\/\S/.test(trimmed) ? trimmed : raw;
      // Punctuation trimmed off the href leaves the visible span too, from its last fragment.
      const cut = raw.length - href.length;
      if (contSpans.length > 0) {
        const last = contSpans[contSpans.length - 1]!;
        last.end -= cut;
        if (last.end <= last.start) contSpans.pop();
      } else {
        end -= cut;
      }
      if (end > m.index) spans.push({ start: m.index, end, href });
      for (const c of contSpans) {
        const rowSpans = result[c.row] === NO_LINKS ? [] : [...result[c.row]!];
        rowSpans.push({ start: c.start, end: c.end, href });
        result[c.row] = rowSpans;
        resumeAt[c.row] = Math.max(resumeAt[c.row]!, c.end);
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a.start - b.start);
      result[i] = spans;
    }
  }
  // A continuation makes a row's spans depend on its neighbours, so the identity cache is validated by value.
  if (spanCache) {
    for (let i = 0; i < rows.length; i++) {
      const spans = result[i]!;
      if (spans === NO_LINKS) continue;
      const key = rows[i]!;
      const cached = spanCache.get(key);
      const same =
        cached?.length === spans.length &&
        cached.every((s, k) => s.start === spans[k]!.start && s.end === spans[k]!.end && s.href === spans[k]!.href);
      if (same) result[i] = cached;
      else spanCache.set(key, spans);
    }
  }
  return result;
}

// Cell widths per grapheme cluster, aligned with tmux 3.6a: marks, ZWJ and variation selectors take no column; VS16 emoji, flags and ZWJ chains take two.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]|\p{M}/u;
const EMOJI_TAIL = /^[\uFE0E\uFE0F]$/u;
// Skin tones fold into a modifier base only. tmux uses its own ~70-entry list, so bases like U+270B measure 2 here but 4 in tmux.
const SKIN_TONE = /^[\u{1F3FB}-\u{1F3FF}]$/u;
const MODIFIER_BASE = /\p{Emoji_Modifier_Base}/u;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u;
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}]|\p{Emoji_Presentation}/u;
const ASCII_PRINTABLE_ONLY = /^[\x20-\x7E]*$/;
const ZWJ = "\u200D";

export function cellWidth(codePoint: string): number {
  if (ZERO_WIDTH.test(codePoint) || EMOJI_TAIL.test(codePoint)) return 0;
  return WIDE.test(codePoint) ? 2 : 1;
}

/** Shared by splitGraphemes and clusterSpanAt so cluster rules cannot drift. */
function composesOnto(base: string, next: string): boolean {
  if (SKIN_TONE.test(next)) return MODIFIER_BASE.test(base);
  return ZERO_WIDTH.test(next) || EMOJI_TAIL.test(next);
}

function splitGraphemes(text: string): string[] {
  const clusters: string[] = [];
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const base = chars[i]!;
    let cluster = base;
    if (chars[i + 1] === "\uFE0F" && chars[i + 2] === "\u20E3") {
      // Keycap sequence: one two-cell cluster even on an ASCII base.
      cluster += chars[++i]!;
      cluster += chars[++i]!;
    } else if (REGIONAL_INDICATOR.test(cluster)) {
      // Pair on parity within the maximal RI run.
      let runStart = i;
      while (runStart > 0 && REGIONAL_INDICATOR.test(chars[runStart - 1]!)) runStart--;
      if ((i - runStart) % 2 === 0 && REGIONAL_INDICATOR.test(chars[i + 1] ?? "")) {
        cluster += chars[++i]!;
      }
    } else if (!ASCII_PRINTABLE_ONLY.test(cluster)) {
      for (;;) {
        const next = chars[i + 1];
        if (next === undefined) break;
        if (next === ZWJ) {
          cluster += next;
          i++;
          const joined = chars[i + 1];
          if (joined === undefined || ASCII_PRINTABLE_ONLY.test(joined)) break;
          cluster += joined;
          i++;
          continue;
        }
        if (composesOnto(base, next)) {
          cluster += next;
          i++;
          continue;
        }
        break;
      }
    }
    clusters.push(cluster);
    i++;
  }
  return clusters;
}

function graphemeWidth(cluster: string): number {
  const cps = [...cluster];
  const riCount = cps.filter((c) => REGIONAL_INDICATOR.test(c)).length;
  // An orphan U+20E3 or U+200D with no base is an ordinary zero-width mark.
  if (cps.length > 1 && cps.some((c) => c === "\u20E3")) return 2;
  if (riCount >= 2) return 2;
  if (riCount === 1 && cps.length === 1) return 1;
  if (cps.length > 1 && cps.some((c) => c === ZWJ)) return 2;
  if (cps.length > 1 && cps[cps.length - 1] === "\uFE0F") return 2;
  return cellWidth(cps[0]!);
}

export function textWidth(text: string): number {
  if (ASCII_PRINTABLE_ONLY.test(text)) return text.length;
  return splitGraphemes(text).reduce((n, c) => n + graphemeWidth(c), 0);
}

/** Code point starting the cluster whose cells contain `col`, or null past the end. */
export function findCursorCharIndex(text: string, col: number): number | null {
  let c = 0;
  let pos = 0;
  for (const cluster of splitGraphemes(text)) {
    const w = graphemeWidth(cluster);
    if (col >= c && col < c + w) return pos;
    c += w;
    pos += [...cluster].length;
  }
  return null;
}

/** Printable ASCII flows; every other contiguous stretch becomes one `cells x cellWidth` box so fallback fonts cannot shift columns (#3342). Stretches stay in one text node to keep bidi, shaping and emoji composition intact. */
export interface CellRun {
  text: string;
  /** Zero-width marks add no cells. */
  cells: number;
  fixed: boolean;
}

/** Marks and emoji tails glue onto the preceding run (else browsers draw dotted circles); a fixed stretch swallows contiguous non-ASCII. */
export function splitCellRuns(text: string): CellRun[] {
  const runs: CellRun[] = [];
  let flow = "";
  let fixedStretch = "";
  const flushFlow = () => {
    if (flow) {
      runs.push({ text: flow, cells: textWidth(flow), fixed: false });
      flow = "";
    }
  };
  const flushFixed = () => {
    if (fixedStretch) {
      runs.push({ text: fixedStretch, cells: textWidth(fixedStretch), fixed: true });
      fixedStretch = "";
    }
  };
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (ASCII_PRINTABLE_ONLY.test(ch)) {
      flushFixed();
      flow += ch;
    } else if (ZERO_WIDTH.test(ch)) {
      if (fixedStretch) fixedStretch += ch;
      else flow += ch;
    } else if (EMOJI_TAIL.test(ch)) {
      if (fixedStretch) fixedStretch += ch;
      else flow += ch;
    } else {
      flushFlow();
      fixedStretch += ch;
    }
    i++;
  }
  flushFlow();
  flushFixed();
  return runs;
}

/** Code-point range of the cluster containing `charIndex`, mirroring splitCellRuns so the cursor cell never strands a composition tail. */
export function clusterSpanAt(text: string, charIndex: number): [number, number] {
  const chars = [...text];
  let start = charIndex;
  let end = charIndex + 1;
  const glueAt = (k: number) => k >= 0 && k < chars.length && composesOnto(chars[start] ?? "", chars[k]!);
  while (glueAt(end)) end++;
  // Pair on parity so a cursor between adjacent flags stays on its own flag.
  let runStart = start;
  while (runStart > 0 && REGIONAL_INDICATOR.test(chars[runStart - 1] ?? "")) runStart--;
  const onRi = REGIONAL_INDICATOR.test(chars[start] ?? "");
  const oddInRun = (start - runStart) % 2 === 1;
  if (onRi && (oddInRun || REGIONAL_INDICATOR.test(chars[start + 1] ?? ""))) {
    if (oddInRun) start--;
    end = Math.max(end, start + 2);
    while (glueAt(end)) end++;
  }
  while (chars[end - 1] === "\u200D") {
    end++;
    while (glueAt(end)) end++;
  }
  return [Math.max(start, 0), Math.min(end, chars.length)];
}

/** Hard-wrap at `cols` cells, preserving styles. Only needed when another client resized the tmux window. */
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
        current.push({ text: chunk, style: seg.style, url: seg.url });
        chunk = "";
      }
    };
    for (const cluster of splitGraphemes(seg.text)) {
      const w = graphemeWidth(cluster);
      // A cluster that doesn't fit wraps whole; zero-width members stay with their base.
      if (used + w > cols && used > 0) {
        flushChunk();
        rows.push(current);
        current = [];
        used = 0;
      }
      chunk += cluster;
      used += w;
    }
    flushChunk();
  }
  if (current.length > 0 || rows.length === 0) rows.push(current);
  return rows;
}
