import { useMemo } from "react";
import { setSessionUnread } from "../lib/api";
import { inboxEntries, type InboxEntry } from "../lib/inbox";
import type { SessionResponse } from "../lib/types";

interface Props {
  sessions: readonly SessionResponse[];
  activeSessionId?: string | null;
  /** A stand-in (no posted ask) opens its session. */
  onOpen: (sessionId: string) => void;
  /** A posted ask opens its ask page. */
  onOpenAsk: (sessionId: string) => void;
  readOnly?: boolean;
}

function Entry({
  entry,
  next,
  open,
  readOnly,
}: {
  entry: InboxEntry;
  next: boolean;
  open: () => void;
  readOnly?: boolean;
}) {
  const { session, kind, text, objective, minutes } = entry;
  return (
    <li
      data-testid={next ? "inbox-next" : "inbox-entry"}
      className={`min-w-0 rounded-md border ${next ? "border-brand-600/60 bg-surface-850/60" : "border-surface-700/40"}`}
    >
      <button
        type="button"
        onClick={open}
        className={`w-full min-w-0 cursor-pointer text-left rounded-t-md hover:bg-surface-850 active:bg-surface-800 focus-visible:outline-2 focus-visible:outline-brand-600 ${next ? "px-4 pt-3 pb-1" : "px-3 pt-2 pb-1"}`}
      >
        {next && <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-brand-400">Do this next</div>}
        <div className="flex items-baseline gap-2 min-w-0">
          {kind && (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-dim">{kind}</span>
          )}
          <span
            className={`min-w-0 flex-1 break-words leading-snug text-text-primary ${next ? "text-lg font-medium" : "text-xs"}`}
          >
            {text}
          </span>
          {minutes != null && <span className="shrink-0 font-mono text-[10px] text-text-dim">{minutes} min</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-text-dim min-w-0">
          {objective && <span className="text-text-secondary break-words">{objective}</span>}
          <span className="truncate font-mono">{session.title}</span>
        </div>
      </button>
      <div className={`flex items-center gap-2 min-w-0 ${next ? "px-4 pb-3 pt-1" : "px-3 pb-2"}`}>
        {next && (
          <button
            type="button"
            onClick={open}
            className="cursor-pointer rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-surface-950 hover:bg-brand-500"
          >
            Go
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={() => void setSessionUnread(session.id, false)}
            className="ml-auto shrink-0 cursor-pointer rounded px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-800 hover:text-text-primary"
          >
            Done
          </button>
        )}
      </div>
    </li>
  );
}

export function InboxPane({ sessions, activeSessionId, onOpen, onOpenAsk, readOnly }: Props) {
  const entries = useMemo(() => inboxEntries(sessions, activeSessionId), [sessions, activeSessionId]);
  return (
    <div data-testid="inbox" className="flex-1 min-h-0 overflow-y-auto bg-surface-900 text-left px-3 py-3">
      {entries.length === 0 ? (
        <p className="text-xs text-text-secondary">Nothing needs you</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, i) => (
            <Entry
              key={entry.session.id}
              entry={entry}
              next={i === 0}
              open={() => (entry.posted ? onOpenAsk : onOpen)(entry.session.id)}
              readOnly={readOnly}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
