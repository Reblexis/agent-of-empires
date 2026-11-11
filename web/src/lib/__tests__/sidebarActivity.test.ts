import { describe, expect, it } from "vitest";
import { sessionMatchesActivity } from "../sidebarActivity";
import type { SessionResponse } from "../types";

describe("sidebar activity view", () => {
  it("keeps a session the Active view must show and hides an idle one read long ago", () => {
    const idle = { status: "Idle", last_accessed_at: "2020-01-01T00:00:00Z" } as unknown as SessionResponse;
    const cases: [Partial<SessionResponse>, boolean][] = [
      [{}, false],
      [{ unread: true }, true], // finished work not yet read stays until it is read
      [{ unread: false }, false],
      [{ favorited: true }, true],
      [{ status: "Error" }, true],
    ];
    for (const [over, shown] of cases) {
      expect(sessionMatchesActivity({ ...idle, ...over } as SessionResponse, 60_000), JSON.stringify(over)).toBe(shown);
    }
  });
});
