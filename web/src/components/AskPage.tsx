import { useEffect, useRef, useState } from "react";
import { getAskPage, postAskEvent, sendSessionMessage, setSessionUnread } from "../lib/api";
import type { SessionResponse } from "../lib/types";

interface Props {
  session: SessionResponse;
  /** Sessions whose current ask is merged into this one: the reply reaches them too. */
  followers: readonly SessionResponse[];
  onOpenSession: (sessionId: string) => void;
  /** The reply went through and these sessions' asks closed. */
  onDone: (answered: string[]) => void;
  readOnly?: boolean;
}

// The agent's page runs in an opaque, script-less frame; this policy also
// refuses every fetch, so only inline content renders.
const PAGE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";
const PAGE_BASE = "body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;color:#e7e5e4;background:#1c1917}";

const isUrl = (link: string) => /^https?:\/\//i.test(link);

const now = () => Date.now();

/** The page was shown: the start of the user's attention on this ask. */
function reportOpened(id: string, postedAt: string | null, readOnly: boolean | undefined) {
  if (postedAt && !readOnly) void postAskEvent(id, { event: "opened", posted_at: postedAt });
}

function framed(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${PAGE_BASE}</style></head><body>${html}</body></html>`;
}

export function AskPage({ session, followers, onOpenSession, onDone, readOnly }: Props) {
  const ask = session.priority_ask;
  const postedAt = ask?.posted_at ?? null;
  const openedAt = useRef(0);
  const [page, setPage] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ask?.page) return;
    let live = true;
    void getAskPage(session.id).then((html) => live && setPage(html));
    return () => {
      live = false;
    };
  }, [session.id, ask?.page]);

  useEffect(() => {
    openedAt.current = now();
    reportOpened(session.id, postedAt, readOnly);
  }, [session.id, postedAt, readOnly]);

  if (!ask) return null;
  const takesInput = !readOnly && session.view !== "structured";

  const reply = async (input: string, form: "option" | "text" | "done") => {
    setSending(true);
    setError(null);
    const message = `Inbox reply to "${ask.text}": ${input}`;
    const failed = await sendSessionMessage(session.id, message);
    if (failed) {
      setError(`Not sent: ${failed}`);
      setSending(false);
      return;
    }
    if (postedAt)
      void postAskEvent(session.id, {
        event: "answered",
        posted_at: postedAt,
        form,
        ms_open: now() - openedAt.current,
      });
    const answered = [session.id];
    for (const follower of followers) {
      if (!(await sendSessionMessage(follower.id, message))) answered.push(follower.id);
    }
    await Promise.all(answered.map((id) => setSessionUnread(id, false)));
    onDone(answered);
  };

  const choices = ask.options?.length ? ask.options : ["Yes", "No"];
  const button = "cursor-pointer rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-default";

  return (
    <div data-testid="ask-page" className="flex-1 min-h-0 flex flex-col bg-surface-900 text-left">
      <header className="px-4 pt-4 pb-3 border-b border-surface-700/40">
        <div className="flex items-baseline gap-2 min-w-0">
          {ask.kind && (
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-brand-400">{ask.kind}</span>
          )}
          <h1 className="min-w-0 flex-1 break-words text-lg font-medium leading-snug text-text-primary">{ask.text}</h1>
          {ask.minutes != null && (
            <span className="shrink-0 font-mono text-[11px] text-text-dim">{ask.minutes} min</span>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        {ask.page && page != null ? (
          <iframe title="Ask page" sandbox="" srcDoc={framed(page)} className="flex-1 min-h-[12rem] w-full border-0" />
        ) : (
          <div className="px-4 py-3 space-y-2 text-sm">
            {ask.objective && <p className="text-text-secondary">{ask.objective}</p>}
            {ask.link &&
              (isUrl(ask.link) ? (
                <a
                  href={ask.link}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-brand-400 hover:underline"
                >
                  {ask.link}
                </a>
              ) : (
                <code className="block select-all break-all rounded bg-surface-850 px-2 py-1 text-text-primary">
                  {ask.link}
                </code>
              ))}
          </div>
        )}
      </div>

      <footer
        className="px-4 pt-3 border-t border-surface-700/40 space-y-2"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        {error && (
          <p role="alert" className="text-xs text-status-error">
            {error}
          </p>
        )}
        {takesInput && ask.kind === "decide" && (
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={sending}
                onClick={() => void reply(choice, "option")}
                className={`${button} bg-brand-600 text-surface-950 hover:bg-brand-500`}
              >
                {choice}
              </button>
            ))}
          </div>
        )}
        {takesInput && (ask.kind === "answer" || ask.kind === "evaluate") && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (answer.trim()) void reply(answer.trim(), "text");
            }}
          >
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={2}
              className="min-w-0 flex-1 resize-none rounded-md border border-surface-700/60 bg-surface-850 px-2 py-1.5 text-sm text-text-primary"
            />
            <button
              type="submit"
              disabled={sending || !answer.trim()}
              className={`${button} self-end bg-brand-600 text-surface-950 hover:bg-brand-500`}
            >
              Send
            </button>
          </form>
        )}
        {takesInput && ask.kind !== "decide" && ask.kind !== "answer" && ask.kind !== "evaluate" && (
          <button
            type="button"
            disabled={sending}
            onClick={() => void reply("done", "done")}
            className={`${button} bg-brand-600 text-surface-950 hover:bg-brand-500`}
          >
            Done
          </button>
        )}
        <div>
          <button
            type="button"
            onClick={() => onOpenSession(session.id)}
            className="cursor-pointer text-[11px] text-text-dim hover:text-text-secondary"
          >
            Open session
          </button>
          <span className="ml-2 font-mono text-[11px] text-text-dim">{session.title}</span>
        </div>
      </footer>
    </div>
  );
}
