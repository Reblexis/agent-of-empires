// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSessions } from "./useSessions";
import * as api from "../lib/api";
import type { SessionResponse } from "../lib/types";

describe("useSessions / loaded sentinel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts loaded=false before the first fetch resolves", () => {
    let resolveFetch: (value: api.SessionsEnvelope | null) => void = () => {};
    vi.spyOn(api, "fetchSessions").mockImplementation(() => new Promise((r) => (resolveFetch = r)));

    const { result } = renderHook(() => useSessions());

    expect(result.current.loaded).toBe(false);
    expect(result.current.sessions).toEqual([]);
    resolveFetch(null);
  });

  it.each([
    ["a successful fetch", { sessions: [], workspace_ordering: [] }, false],
    ["a failed fetch", null, true],
  ] as [string, api.SessionsEnvelope | null, boolean][])(
    "flips loaded=true after %s",
    async (_label, envelope, error) => {
      vi.spyOn(api, "fetchSessions").mockResolvedValue(envelope);
      const { result } = renderHook(() => useSessions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.error).toBe(error);
    },
  );
});

describe("useSessions / slow session-list polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not overlap session-list requests when the server is slower than the poll interval", async () => {
    vi.useFakeTimers();
    const resolvers: ((value: api.SessionsEnvelope | null) => void)[] = [];
    const fetch = vi.spyOn(api, "fetchSessions").mockImplementation(() => new Promise((r) => resolvers.push(r)));
    const { result } = renderHook(() => useSessions());

    await act(async () => void vi.advanceTimersByTime(9000));
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => resolvers[0]!({ sessions: [{ id: "latest" } as SessionResponse], workspace_ordering: [] }));
    expect(result.current.sessions.map((s) => s.id)).toEqual(["latest"]);
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// Viktor, 27 Nov 2026: "terminal seems like it's still laggy and often delayed". Measured: each 3 s refresh of
// the session list (1,191 sessions, none changed) froze the page for 100 to 186 ms, typing included.
// docs/guides/web/dashboard.md, "A refresh that changes nothing costs nothing".
describe("useSessions / a refresh that changes nothing re-renders nothing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const row = (id: string, status = "Idle") =>
    ({ id, status, title: `t-${id}`, rate_limit: { resets_at: null } }) as unknown as SessionResponse;

  it("keeps the same list and ordering objects when a poll returns the same data", async () => {
    vi.useFakeTimers();
    // Every poll parses fresh objects, like JSON from the network.
    vi.spyOn(api, "fetchSessions").mockImplementation(() =>
      Promise.resolve({ sessions: [row("a"), row("b")], workspace_ordering: ["w1", "w2"] }),
    );
    const { result } = renderHook(() => useSessions());
    await act(async () => void vi.advanceTimersByTime(0));
    const first = result.current.sessions;
    const firstOrdering = result.current.workspaceOrdering;
    expect(first.map((s) => s.id)).toEqual(["a", "b"]);

    await act(async () => void vi.advanceTimersByTime(3000));
    expect(result.current.sessions).toBe(first);
    expect(result.current.workspaceOrdering).toBe(firstOrdering);
  });

  it("replaces only the session that changed", async () => {
    vi.useFakeTimers();
    let status = "Idle";
    vi.spyOn(api, "fetchSessions").mockImplementation(() =>
      Promise.resolve({ sessions: [row("a"), row("b", status)], workspace_ordering: [] }),
    );
    const { result } = renderHook(() => useSessions());
    await act(async () => void vi.advanceTimersByTime(0));
    const [a, b] = result.current.sessions;

    status = "Running";
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(result.current.sessions[0]).toBe(a);
    expect(result.current.sessions[1]).not.toBe(b);
    expect(result.current.sessions[1]!.status).toBe("Running");
  });

  it("follows the server when a session is added, removed or reordered", async () => {
    vi.useFakeTimers();
    let ids = ["a", "b"];
    vi.spyOn(api, "fetchSessions").mockImplementation(() =>
      Promise.resolve({ sessions: ids.map((id) => row(id)), workspace_ordering: [] }),
    );
    const { result } = renderHook(() => useSessions());
    await act(async () => void vi.advanceTimersByTime(0));
    const a = result.current.sessions[0];

    ids = ["c", "a"];
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(result.current.sessions.map((s) => s.id)).toEqual(["c", "a"]);
    expect(result.current.sessions[1]).toBe(a);
  });
});
