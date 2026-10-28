import { useMemo } from "react";
import { inboxEntries, type InboxEntry } from "../lib/inbox";
import type { SessionResponse } from "../lib/types";

interface Props {
  sessions: readonly SessionResponse[];
  activeSessionId?: string | null;
  onOpen: (sessionId: string) => void;
}

function Entry({ entry, next, onOpen }: { entry: InboxEntry; next: boolean; onOpen: (id: string) => void }) {
  const { session, why } = entry;
  return (
    <li>
      <button
        type="button"
        data-testid={next ? "inbox-next" : "inbox-entry"}
        onClick={() => onOpen(session.id)}
        className={`w-full min-w-0 cursor-pointer text-left rounded-md border px-3 py-2 hover:bg-surface-850 active:bg-surface-800 focus-visible:outline-2 focus-visible:outline-brand-600 ${
          next ? "border-brand-600/60 bg-surface-850/60" : "border-surface-700/40"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {next && <span className="text-[10px] font-mono uppercase tracking-wider text-brand-400">Next</span>}
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-text-primary">
            {session.title}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-text-dim" aria-label="priority">
            {session.priority}
          </span>
        </div>
        <div
          className={`mt-0.5 break-words leading-relaxed ${next ? "text-sm text-text-primary" : "text-xs text-text-secondary"}`}
        >
          {why}
        </div>
      </button>
    </li>
  );
}

export function InboxPane({ sessions, activeSessionId, onOpen }: Props) {
  const entries = useMemo(() => inboxEntries(sessions, activeSessionId), [sessions, activeSessionId]);
  return (
    <div data-testid="inbox" className="flex-1 min-h-0 overflow-y-auto bg-surface-900 text-left px-3 py-3">
      {entries.length === 0 ? (
        <p className="text-xs text-text-secondary">Nothing needs you</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, i) => (
            <Entry key={entry.session.id} entry={entry} next={i === 0} onOpen={onOpen} />
          ))}
        </ol>
      )}
    </div>
  );
}
