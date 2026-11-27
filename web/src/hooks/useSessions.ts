import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionResponse } from "../lib/types";
import { fetchSessions, type SessionsEnvelope } from "../lib/api";
import { setServerDown } from "../lib/connectionState";
import { beginRead, markReadApplied } from "../lib/sessionReads";

const POLL_INTERVAL = 3000;
const LOCAL_ORDERING_WINDOW_MS = 4000;

/** Whether two values parsed from JSON hold the same data. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    const bArray = b as unknown[];
    if (a.length !== bArray.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], bArray[i])) return false;
    return true;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  if (keys.length !== Object.keys(bRecord).length) return false;
  for (const key of keys) if (!(key in bRecord) || !sameJson(aRecord[key], bRecord[key])) return false;
  return true;
}

/** `next` with every session that did not change replaced by its object from `prev`, and `prev` itself when
 *  nothing changed, so a refresh re-renders only what the server changed (docs/guides/web/dashboard.md, "A
 *  refresh that changes nothing costs nothing"). */
function keepUnchanged(prev: SessionResponse[], next: SessionResponse[]): SessionResponse[] {
  if (prev.length === 0) return next;
  const byId = new Map(prev.map((s) => [s.id, s]));
  let same = prev.length === next.length;
  const out = next.map((session, i) => {
    const old = byId.get(session.id);
    const kept = old && sameJson(old, session) ? old : session;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

export function useSessions() {
  const [sessions, setSessions] = useState<SessionResponse[]>([]);
  const [workspaceOrdering, setWorkspaceOrdering] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [appliedRead, setAppliedRead] = useState(0);
  const lastReadRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocalOrderingAtRef = useRef<number>(0);

  const injectSession = useCallback((session: SessionResponse) => {
    // Single-session responses omit rate-limit fields; keep the last known values (#3514).
    setSessions((prev) => {
      if (prev.some((s) => s.id === session.id)) return prev;
      return [session, ...prev];
    });
  }, []);

  const markLocalOrderingUpdate = useCallback(() => {
    lastLocalOrderingAtRef.current = Date.now();
  }, []);

  const applyResult = useCallback((data: SessionsEnvelope | null, read: number) => {
    if (data !== null) {
      if (read < lastReadRef.current) return;
      lastReadRef.current = read;
      setSessions((prev) => keepUnchanged(prev, data.sessions));
      setAppliedRead(read);
      // Ignore server ordering while a local drag's PUT may still be landing.
      if (Date.now() - lastLocalOrderingAtRef.current > LOCAL_ORDERING_WINDOW_MS) {
        setWorkspaceOrdering((prev) => (sameJson(prev, data.workspace_ordering) ? prev : data.workspace_ordering));
      }
      setError(false);
      setServerDown(false);
    } else {
      setError(true);
      setServerDown(true);
    }
    setLoaded(true);
  }, []);

  // Published after the commit so no row sees the new ordinal beside the previous snapshot.
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler
    if (appliedRead) markReadApplied(appliedRead);
  }, [appliedRead]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      const read = beginRead();
      void fetchSessions()
        .then((data) => {
          if (!cancelled) applyResult(data, read);
        })
        .finally(() => {
          if (!cancelled) timeoutRef.current = setTimeout(poll, POLL_INTERVAL);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [applyResult]);

  const setSessionStatus = useCallback((id: string, status: SessionResponse["status"]) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));
  }, []);

  const applySession = useCallback((session: SessionResponse) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === session.id
          ? {
              ...session,
              rate_limit: session.rate_limit === undefined ? s.rate_limit : session.rate_limit,
              rate_limit_auto_resume: session.rate_limit_auto_resume ?? s.rate_limit_auto_resume,
            }
          : s,
      ),
    );
  }, []);

  return {
    sessions,
    workspaceOrdering,
    setWorkspaceOrdering,
    markLocalOrderingUpdate,
    error,
    loaded,
    injectSession,
    setSessionStatus,
    applySession,
  };
}
