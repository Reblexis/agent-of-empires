import { useMemo } from "react";
import { setSessionUnread } from "../lib/api";
import { inboxEntries, type InboxEntry } from "../lib/inbox";
import type { SessionResponse } from "../lib/types";

interface Props {
  sessions: readonly SessionResponse[];
  activeSessionId?: string | null;
  onOpen: (sessionId: string) => void;
  readOnly?: boolean;
}

const isUrl = (link: string) => /^https?:\/\//i.test(link);

function Entry({
  entry,
  next,
  onOpen,
  readOnly,
}: {
  entry: InboxEntry;
  next: boolean;
  onOpen: (id: string) => void;
  readOnly?: boolean;
}) {
  const { session, kind, text, objective, link } = entry;
  return (
    <li
      data-testid={next ? "inbox-next" : "inbox-entry"}
      className={`min-w-0 rounded-md border ${next ? "border-brand-600/60 bg-surface-850/60" : "border-surface-700/40"}`}
    >
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className="w-full min-w-0 cursor-pointer text-left px-3 pt-2 pb-1 rounded-t-md hover:bg-surface-850 active:bg-surface-800 focus-visible:outline-2 focus-visible:outline-brand-600"
      >
        {next && <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-brand-400">Do this next</div>}
        <div className="flex items-baseline gap-2 min-w-0">
          {kind && (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-text-dim">{kind}</span>
          )}
          <span
            className={`min-w-0 flex-1 break-words leading-relaxed ${next ? "text-sm text-text-primary" : "text-xs text-text-primary"}`}
          >
            {text}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-text-dim" aria-label="priority">
            {session.priority}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-text-dim min-w-0">
          {objective && <span className="text-text-secondary break-words">{objective}</span>}
          <span className="truncate font-mono">{session.title}</span>
        </div>
      </button>
      {(link || !readOnly) && (
        <div className="flex items-center gap-2 px-3 pb-2 min-w-0">
          {link &&
            (isUrl(link) ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-[11px] text-brand-400 hover:underline"
              >
                {link}
              </a>
            ) : (
              <code className="min-w-0 flex-1 truncate select-all text-[11px] text-text-secondary">{link}</code>
            ))}
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
      )}
    </li>
  );
}

export function InboxPane({ sessions, activeSessionId, onOpen, readOnly }: Props) {
  const entries = useMemo(() => inboxEntries(sessions, activeSessionId), [sessions, activeSessionId]);
  return (
    <div data-testid="inbox" className="flex-1 min-h-0 overflow-y-auto bg-surface-900 text-left px-3 py-3">
      {entries.length === 0 ? (
        <p className="text-xs text-text-secondary">Nothing needs you</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, i) => (
            <Entry key={entry.session.id} entry={entry} next={i === 0} onOpen={onOpen} readOnly={readOnly} />
          ))}
        </ol>
      )}
    </div>
  );
}
