// @vitest-environment jsdom
//
// ContextPane contract: shows the daemon-cached terminal-context recap,
// auto-regenerates once on open when the cache is absent or predates the
// session's last completed turn, and offers a manual refresh.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextPane } from "../ContextPane";
import * as api from "../../lib/api";
import type { SessionResponse } from "../../lib/types";

vi.mock("../../lib/api", () => ({
  getTerminalContext: vi.fn(),
  refreshTerminalContext: vi.fn(),
}));

const getMock = vi.mocked(api.getTerminalContext);
const refreshMock = vi.mocked(api.refreshTerminalContext);

// Only the fields the pane reads.
function session(idleEnteredAt: string | null): SessionResponse {
  return { idle_entered_at: idleEnteredAt } as SessionResponse;
}

beforeEach(() => {
  getMock.mockReset();
  refreshMock.mockReset();
  refreshMock.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("ContextPane", () => {
  it("renders a fresh cached recap without regenerating", async () => {
    getMock.mockResolvedValue({
      text: "Last ask: fix the login bug",
      generated_at: "2026-08-21T12:00:00Z",
      inflight: false,
    });
    render(<ContextPane sessionId="s1" session={session("2026-08-21T11:00:00Z")} />);
    expect(await screen.findByText(/Last ask: fix the login bug/)).toBeTruthy();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("auto-regenerates when the recap predates the last turn end", async () => {
    getMock.mockResolvedValue({
      text: "old recap",
      generated_at: "2026-08-21T10:00:00Z",
      inflight: false,
    });
    render(<ContextPane sessionId="s1" session={session("2026-08-21T11:00:00Z")} />);
    await waitFor(() => expect(refreshMock).toHaveBeenCalledWith("s1"));
    // The stale text stays visible while the regeneration runs.
    expect(screen.getByText(/old recap/)).toBeTruthy();
  });

  it("auto-regenerates when there is no recap yet", async () => {
    getMock.mockResolvedValue({ text: null, generated_at: null, inflight: false });
    render(<ContextPane sessionId="s1" session={session(null)} />);
    await waitFor(() => expect(refreshMock).toHaveBeenCalledWith("s1"));
    expect(screen.getByText(/Reading the session/)).toBeTruthy();
  });

  it("surfaces the server's gate message when a refresh is refused", async () => {
    getMock.mockResolvedValue({ text: null, generated_at: null, inflight: false });
    refreshMock.mockResolvedValue({ ok: false, message: "Context recaps are not available" });
    render(<ContextPane sessionId="s1" session={session(null)} />);
    expect(await screen.findByText(/Context recaps are not available/)).toBeTruthy();
  });

  it("manual refresh starts a regeneration", async () => {
    getMock.mockResolvedValue({
      text: "fresh recap",
      generated_at: "2026-08-21T12:00:00Z",
      inflight: false,
    });
    render(<ContextPane sessionId="s1" session={session("2026-08-21T11:00:00Z")} />);
    await screen.findByText(/fresh recap/);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate context" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledWith("s1"));
  });

  it("shows the empty state without a session", () => {
    render(<ContextPane sessionId={null} session={null} />);
    expect(screen.getByText(/No active session/)).toBeTruthy();
    expect(getMock).not.toHaveBeenCalled();
  });
});
