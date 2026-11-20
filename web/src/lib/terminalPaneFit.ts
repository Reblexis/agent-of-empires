// An agent prints its whole conversation again whenever its pane's columns change, on top of the old lines tmux
// has just re-wrapped, which leaves duplicated, broken text in the history. So a session keeps the columns it has
// (docs/guides/web/terminal.md, "Width"): the desktop agent terminal asks for the columns that fit its room, the
// server keeps the pane's present columns when they are close (`kept_cols` in src/tmux/session.rs), and the
// terminal draws whatever columns the pane has in the room it has.

/** Smallest text scale drawn. The server re-wraps a pane this page controls before it gets under 70%; a pane
 *  another device controls can be wider still. */
export const MIN_DRAWN_FIT = 0.5;

/** Factor on the font size that makes a pane of `paneCols` columns fit `width` px, where a cell is `baseCharW` px
 *  at full font size. 1 when the pane fits (a narrower pane leaves a margin) or its columns are unknown. */
export function paneFit(width: number, baseCharW: number, paneCols: number): number {
  const needed = paneCols * baseCharW;
  if (!(paneCols > 0) || !(needed > 0) || !(width > 0) || width >= needed) return 1;
  return Math.max(MIN_DRAWN_FIT, Math.floor((width / needed) * 1000) / 1000);
}

/** The text scale a pane's columns are sized at: a pane sized at another one takes this page's columns. */
export function columnsScale(fontSize: number): string {
  return String(Math.round(fontSize * 10) / 10);
}
