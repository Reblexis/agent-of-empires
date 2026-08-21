import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getTerminalContext, refreshTerminalContext, type TerminalContextResult } from "../lib/api";
import type { SessionResponse } from "../lib/types";

interface Props {
  sessionId: string | null;
  /** The active session row, for staleness: a turn that ended after the recap
   *  was generated makes it stale and worth regenerating on open. */
  session: SessionResponse | null;
}

/** Poll cadence while a recap one-shot is in flight. */
const POLL_MS = 3000;

/** Whether a fetched snapshot is worth regenerating: no recap yet, or the
 *  session completed a turn after the recap was generated. */
function isStale(res: TerminalContextResult, idleEnteredAt: string | null): boolean {
  if (!res.text) return true;
  if (!idleEnteredAt || !res.generated_at) return false;
  return new Date(idleEnteredAt).getTime() > new Date(res.generated_at).getTime();
}

/**
 * "Context" pane for terminal sessions: a short agent-generated recap of what
 * is happening in the session (last user ask, work done, open threads), so a
 * human returning to a forgotten session re-orients without replaying the
 * scrollback. Reads the daemon-cached snapshot; regenerates on open when the
 * cache predates the session's last completed turn, and on demand via the
 * refresh control. Terminal sessions only; structured sessions carry their
 * own inline conversation summary. The parent keys this component by session
 * id, so a session switch is a fresh mount, not a prop change.
 */
export function ContextPane({ sessionId, session }: Props) {
  const [result, setResult] = useState<TerminalContextResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // One auto-refresh per pane mount: without this, a session whose pane
  // capture never yields a usable recap would re-trigger on every poll.
  const autoRefreshed = useRef(false);
  const idleEnteredAt = session?.idle_entered_at ?? null;

  const refresh = useCallback(() => {
    if (!sessionId) return;
    setGenerating(true);
    setError(null);
    void refreshTerminalContext(sessionId).then((started) => {
      if (started.ok) return;
      setGenerating(false);
      setError(started.message ?? "Could not start the recap");
    });
  }, [sessionId]);

  // Fetch once on mount; kick off a regeneration when the cache is absent or
  // predates the session's last completed turn. Mount-only on purpose: the
  // parent remounts the pane per session, and a turn ending while the pane is
  // open must not silently regenerate under the reader.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void getTerminalContext(sessionId).then((res) => {
      if (cancelled) return;
      if (!res) {
        setError("Could not load the session context");
        return;
      }
      setResult(res);
      if (res.inflight) {
        setGenerating(true);
        return;
      }
      if (isStale(res, idleEnteredAt) && !autoRefreshed.current) {
        autoRefreshed.current = true;
        refresh();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While generating, poll until the daemon reports the one-shot done.
  useEffect(() => {
    if (!generating || !sessionId) return;
    const t = setInterval(() => {
      void getTerminalContext(sessionId).then((res) => {
        if (!res) return;
        setResult(res);
        if (!res.inflight) setGenerating(false);
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [generating, sessionId]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-900 text-text-dim">
        <span className="text-sm">No active session</span>
      </div>
    );
  }

  const generatedAt = result?.generated_at ? new Date(result.generated_at) : null;

  return (
    <div className="flex-1 flex flex-col bg-surface-900 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-700/20 shrink-0">
        <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wide">Context</span>
        {generatedAt && (
          <span className="text-[11px] text-text-dim" title={generatedAt.toLocaleString()}>
            {generatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={generating}
          className="ml-auto w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-text-secondary hover:bg-surface-700/50 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
          title="Regenerate context"
          aria-label="Regenerate context"
        >
          <RefreshCw className={`size-3.5 ${generating ? "animate-spin" : ""}`} aria-hidden />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {error ? (
          <span className="text-sm text-status-error">{error}</span>
        ) : result?.text ? (
          <div className="text-[13px] leading-relaxed text-text-primary whitespace-pre-wrap">
            {result.text}
            {generating && <div className="mt-2 text-[11px] text-text-dim">Refreshing...</div>}
          </div>
        ) : generating ? (
          <span className="text-sm text-text-dim">Reading the session...</span>
        ) : (
          <span className="text-sm text-text-dim">No context yet</span>
        )}
      </div>
    </div>
  );
}
