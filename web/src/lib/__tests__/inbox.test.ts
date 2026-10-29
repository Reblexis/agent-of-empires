import { expect, it } from "vitest";
import { inboxEntries, nextAskId } from "../inbox";
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

it("asks are ordered by value per minute of attention, ties by the earlier due", () => {
  const ask = (value: number | null, minutes: number | null, due: string | null = null) => ({
    priority_ask: { text: "x", value, minutes, due },
  });
  const sessions = [
    row("cheap-low", { ...ask(20, 10) }), // 2 per minute
    row("no-estimate", { priority: 9 }), // stand-in: after every estimated ask
    row("big-slow", { ...ask(90, 30) }), // 3 per minute
    row("quick-win", { ...ask(40, 2) }), // 20 per minute
    row("tie-late", { ...ask(30, 10, "2026-10-30") }), // 3 per minute, later due
    row("tie-early", { ...ask(30, 10, "2026-10-29") }), // 3 per minute, earlier due
    row("value-only", { ...ask(80, null), priority: 4 }), // no minutes: unestimated
  ];
  expect(inboxEntries(sessions).map((e) => e.session.id)).toEqual([
    "quick-win",
    "tie-early",
    "tie-late",
    "big-slow",
    "cheap-low",
    "no-estimate",
    "value-only",
  ]);
});

it("the session you are looking at is not listed", () => {
  expect(inboxEntries([row("a"), row("b")], "a").map((e) => e.session.id)).toEqual(["b"]);
});

it("an entry is the session's ask, or a stand-in ask from its status", () => {
  const ask = {
    kind: "learn",
    text: "Read the pricing note",
    objective: "Creators product",
    link: "https://x.test",
    minutes: 5,
  };
  const cases: [Partial<SessionResponse>, object][] = [
    [{ priority_ask: ask as SessionResponse["priority_ask"] }, { ...ask, posted: true }],
    [
      { priority_ask: { text: "Approve the budget" } },
      { kind: null, text: "Approve the budget", objective: null, link: null, minutes: null, posted: true },
    ],
    [
      { status: "Waiting" },
      { kind: "answer", text: "Reply to it", objective: null, link: null, minutes: null, posted: false },
    ],
    [
      { status: "Idle" },
      { kind: "check", text: "Read what it finished", objective: null, link: null, minutes: null, posted: false },
    ],
    [
      { status: "Error" },
      { kind: "check", text: "It stopped with an error", objective: null, link: null, minutes: null, posted: false },
    ],
    [
      { status: "Unknown", priority: 1 },
      { kind: "check", text: "Read what it finished", objective: null, link: null, minutes: null, posted: false },
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

it("a merged ask is not listed; the one it is merged into is", () => {
  const sessions = [
    row("primary", { priority_ask: { text: "Budget?" } }),
    row("dup", { priority_ask: { text: "Budget too?", merged_into: "primary" } }),
  ];
  expect(inboxEntries(sessions).map((e) => e.session.id)).toEqual(["primary"]);
});

it("after an answer the next posted ask comes up, skipping the answered ones and stand-ins", () => {
  const ask = (value: number, minutes: number) => ({ priority_ask: { text: "x", value, minutes } });
  const sessions = [
    row("first", ask(90, 1)),
    row("standin", { priority: 9 }),
    row("second", ask(50, 1)),
    row("third", ask(10, 1)),
  ];
  const done = (...ids: string[]) => new Map(ids.map((id) => [id, null] as [string, string | null]));
  // (answered in this visit, expected next)
  const cases: [Map<string, string | null>, string | null][] = [
    [done("first"), "second"],
    [done("first", "second"), "third"],
    [done("first", "second", "third"), null],
    // A newer ask from an answered session comes up again.
    [new Map([["first", "2026-10-01T00:00:00Z"]]), "first"],
  ];
  for (const [answered, next] of cases) {
    expect(nextAskId(sessions, answered), [...answered.keys()].join()).toBe(next);
  }
});
