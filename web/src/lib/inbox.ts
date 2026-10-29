// The Inbox: the user's prompt queue, one ask per unread session that needs
// them, the one worth the most per minute of attention on top.
// Spec: docs/guides/session-inbox.md.

import type { AskKind, SessionResponse } from "./types";

export interface InboxEntry {
  session: SessionResponse;
  kind: AskKind | null;
  text: string;
  objective: string | null;
  link: string | null;
  minutes: number | null;
  /** False for a stand-in built from the status: it has no ask page. */
  posted: boolean;
}

/** The session's ask, or a stand-in from its status when it posted none. */
function ask(s: SessionResponse): Omit<InboxEntry, "session"> {
  const posted = s.priority_ask;
  if (posted)
    return {
      kind: posted.kind ?? null,
      text: posted.text,
      objective: posted.objective ?? null,
      link: posted.link ?? null,
      minutes: posted.minutes ?? null,
      posted: true,
    };
  const standIn = { objective: null, link: null, minutes: null, posted: false };
  if (s.status === "Waiting") return { kind: "answer", text: "Reply to it", ...standIn };
  if (s.status === "Error") return { kind: "check", text: "It stopped with an error", ...standIn };
  return { kind: "check", text: "Read what it finished", ...standIn };
}

/** Value per minute, or null when the ask lacks either estimate. */
function perMinute(s: SessionResponse): number | null {
  const a = s.priority_ask;
  return a?.value != null && a.minutes ? a.value / a.minutes : null;
}

/** Earlier first; a missing time after every present one. */
function byTime(a: string | null | undefined, b: string | null | undefined): number {
  const ta = a ? Date.parse(a) : Number.POSITIVE_INFINITY;
  const tb = b ? Date.parse(b) : Number.POSITIVE_INFINITY;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

function compare(a: SessionResponse, b: SessionResponse): number {
  const ra = perMinute(a);
  const rb = perMinute(b);
  if (ra != null || rb != null) {
    if (ra == null) return 1;
    if (rb == null) return -1;
    if (ra !== rb) return rb - ra;
    const due = byTime(a.priority_ask?.due, b.priority_ask?.due);
    if (due) return due;
  } else if ((b.priority ?? 0) !== (a.priority ?? 0)) {
    return (b.priority ?? 0) - (a.priority ?? 0);
  }
  return byTime(a.idle_entered_at, b.idle_entered_at);
}

export function inboxEntries(sessions: readonly SessionResponse[], activeSessionId?: string | null): InboxEntry[] {
  return sessions
    .filter((s) => s.unread && (s.priority ?? 0) > 0 && s.id !== activeSessionId)
    .sort(compare)
    .map((session) => ({ session, ...ask(session) }));
}
