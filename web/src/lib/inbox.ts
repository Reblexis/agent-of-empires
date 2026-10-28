// The Inbox: the unread sessions that need the user, the one to open first on
// top, each with why. Spec: docs/guides/session-inbox.md.

import type { SessionResponse } from "./types";

export interface InboxEntry {
  session: SessionResponse;
  why: string;
}

function why(s: SessionResponse): string {
  if (s.priority_reason) return s.priority_reason;
  if (s.status === "Waiting") return "Waiting for you";
  if (s.status === "Error") return "Error";
  return "Finished";
}

const waitedSince = (s: SessionResponse) =>
  s.idle_entered_at ? Date.parse(s.idle_entered_at) : Number.POSITIVE_INFINITY;

export function inboxEntries(sessions: readonly SessionResponse[], activeSessionId?: string | null): InboxEntry[] {
  return sessions
    .filter((s) => s.unread && (s.priority ?? 0) > 0 && s.id !== activeSessionId)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || waitedSince(a) - waitedSince(b))
    .map((session) => ({ session, why: why(session) }));
}
