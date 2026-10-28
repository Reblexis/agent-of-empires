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
    priority_ask: null,
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

it("an entry is the session's ask, or a stand-in ask from its status", () => {
  const ask = { kind: "learn", text: "Read the pricing note", objective: "Creators product", link: "https://x.test" };
  const cases: [Partial<SessionResponse>, object][] = [
    [{ priority_ask: ask as SessionResponse["priority_ask"] }, ask],
    [
      { priority_ask: { text: "Approve the budget" } },
      { kind: null, text: "Approve the budget", objective: null, link: null },
    ],
    [{ status: "Waiting" }, { kind: "answer", text: "Reply to it", objective: null, link: null }],
    [{ status: "Idle" }, { kind: "check", text: "Read what it finished", objective: null, link: null }],
    [{ status: "Error" }, { kind: "check", text: "It stopped with an error", objective: null, link: null }],
    [
      { status: "Unknown", priority: 1 },
      { kind: "check", text: "Read what it finished", objective: null, link: null },
    ],
  ];
  for (const [patch, expected] of cases) {
    const { session: _session, ...entry } = inboxEntries([row("s", patch)])[0]!;
    expect(entry, JSON.stringify(patch)).toEqual(expected);
  }
});

it("a missing priority reads as zero, so an older payload lists nothing", () => {
  expect(inboxEntries([row("old", { priority: undefined })])).toEqual([]);
});
