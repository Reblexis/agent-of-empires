import { expect, it } from "vitest";
import { inboxEntries } from "../inbox";
import type { SessionResponse } from "../types";

const row = (id: string, patch: Partial<SessionResponse> = {}): SessionResponse =>
  ({
    id,
    title: id,
    status: "Idle",
    unread: true,
    priority: 5,
    priority_reason: null,
    idle_entered_at: null,
    ...patch,
  }) as SessionResponse;

it("lists only the unread sessions that need you, highest priority first", () => {
  const sessions = [
    row("low", { priority: 2 }),
    row("read", { priority: 9, unread: false }),
    row("zero", { priority: 0 }),
    row("running", { status: "Running", priority: 0 }),
    row("top", { priority: 8 }),
    row("mid", { priority: 5 }),
  ];
  expect(inboxEntries(sessions).map((e) => e.session.id)).toEqual(["top", "mid", "low"]);
});

it("among equal priorities the session that has waited longest comes first", () => {
  const sessions = [
    row("none"),
    row("late", { idle_entered_at: "2026-10-28T20:00:00Z" }),
    row("early", { idle_entered_at: "2026-10-28T08:00:00Z" }),
  ];
  expect(inboxEntries(sessions).map((e) => e.session.id)).toEqual(["early", "late", "none"]);
});

it("the session you are looking at is not listed", () => {
  expect(inboxEntries([row("a"), row("b")], "a").map((e) => e.session.id)).toEqual(["b"]);
});

it("says why: the agent's reason, else the status", () => {
  const cases: [Partial<SessionResponse>, string][] = [
    [{ priority_reason: "Approve the ad budget" }, "Approve the ad budget"],
    [{ status: "Waiting" }, "Waiting for you"],
    [{ status: "Idle" }, "Finished"],
    [{ status: "Error" }, "Error"],
    [{ status: "Unknown", priority: 1 }, "Finished"],
  ];
  for (const [patch, why] of cases) {
    expect(inboxEntries([row("s", patch)])[0]?.why, JSON.stringify(patch)).toBe(why);
  }
});

it("a missing priority reads as zero, so an older payload lists nothing", () => {
  expect(inboxEntries([row("old", { priority: undefined })])).toEqual([]);
});
