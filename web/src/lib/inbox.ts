// The Inbox: the user's prompt queue, one ask per unread session that needs
// them, the one to do next on top. Spec: docs/guides/session-inbox.md.

import type { AskKind, SessionResponse } from "./types";

export interface InboxEntry {
  session: SessionResponse;
  kind: AskKind | null;
  text: string;
  objective: string | null;
  link: string | null;
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
    };
  if (s.status === "Waiting") return { kind: "answer", text: "Reply to it", objective: null, link: null };
  if (s.status === "Error") return { kind: "check", text: "It stopped with an error", objective: null, link: null };
  return { kind: "check", text: "Read what it finished", objective: null, link: null };
}

const waitedSince = (s: SessionResponse) =>
  s.idle_entered_at ? Date.parse(s.idle_entered_at) : Number.POSITIVE_INFINITY;

export function inboxEntries(sessions: readonly SessionResponse[], activeSessionId?: string | null): InboxEntry[] {
  return sessions
    .filter((s) => s.unread && (s.priority ?? 0) > 0 && s.id !== activeSessionId)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || waitedSince(a) - waitedSince(b))
    .map((session) => ({ session, ...ask(session) }));
}
