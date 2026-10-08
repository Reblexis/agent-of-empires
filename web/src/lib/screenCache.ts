import type { LiveFrame } from "../hooks/useLiveTerminal";
import type { HistoryCache } from "./liveHistory";

// This browser's memory of the screens it showed (and prefetched), so opening
// a session draws its last known screen at once while the live stream
// connects (docs/guides/web/terminal.md, "Switching sessions"). Module scope:
// it outlives the terminal views and lasts as long as the page.

/** How many session screens are remembered, most recently shown first. */
export const REMEMBERED_SCREENS = 32;
/** Floor between two prefetches of the same session. */
export const PREFETCH_INTERVAL_MS = 10_000;

export interface RememberedScreen {
  frame: LiveFrame;
  /** The downloaded scrollback (lib/liveHistory.ts), when there is one. */
  history: HistoryCache | null;
}

const screens = new Map<string, RememberedScreen>();
const lastPrefetch = new Map<string, number>();

/** One entry per session and terminal surface (agent pane, paired shells). */
export const screenKey = (sessionId: string, wsPath: string) => `${sessionId} ${wsPath}`;

export function rememberScreen(key: string, screen: RememberedScreen) {
  // Map order is insertion order: re-inserting makes the key most recent.
  screens.delete(key);
  screens.set(key, screen);
  while (screens.size > REMEMBERED_SCREENS) screens.delete(screens.keys().next().value!);
}

export function recallScreen(key: string): RememberedScreen | undefined {
  return screens.get(key);
}

/** Fetch a session's current agent screen into memory. A prefetched screen is
 *  a picture of the pane (no cursor, no scrollback geometry); it refreshes the
 *  remembered picture and keeps any downloaded scrollback. */
export async function prefetchScreen(sessionId: string, now = Date.now()) {
  if (now - (lastPrefetch.get(sessionId) ?? Number.NEGATIVE_INFINITY) < PREFETCH_INTERVAL_MS) return;
  lastPrefetch.set(sessionId, now);
  let content: string;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/output?format=ansi&lines=1`);
    if (!res.ok) return;
    const body = (await res.json()) as { content?: unknown };
    if (typeof body.content !== "string") return;
    content = body.content;
  } catch {
    return;
  }
  const rows = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  const key = screenKey(sessionId, "live-ws");
  rememberScreen(key, {
    frame: { content, rows, history: 0, cursor: null, altScreen: false, mouse: false, mouseSgr: false },
    history: recallScreen(key)?.history ?? null,
  });
}

/** Tests only: start from an empty memory. */
export function forgetAllScreens() {
  screens.clear();
  lastPrefetch.clear();
}
