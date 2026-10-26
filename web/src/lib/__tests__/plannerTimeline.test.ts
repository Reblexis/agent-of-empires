import { describe, expect, it } from "vitest";
import { plannerGroups, wallNow, type PlannerTask } from "../plannerTimeline";

const task = (id: string, startDate: string | null, dueDate: string | null, extra = {}): PlannerTask => ({
  id,
  number: 1,
  title: id,
  startDate,
  dueDate,
  priority: null,
  status: "open",
  ...extra,
});

describe("planner time and precision", () => {
  it("uses the planner timezone across daylight saving and midnight", () => {
    for (const [instant, expected] of [
      ["2026-10-26T20:30:00Z", "2026-10-26T13:30:00"],
      ["2026-10-27T06:59:59Z", "2026-10-26T23:59:59"],
      ["2026-10-27T07:00:00Z", "2026-10-27T00:00:00"],
      ["2026-11-01T08:30:00Z", "2026-11-01T01:30:00"],
      ["2026-11-01T09:30:00Z", "2026-11-01T01:30:00"],
    ])
      expect(wallNow(new Date(instant), "America/Los_Angeles")).toBe(expected);
  });

  it("never invents appointments from partial dates or missing bounds", () => {
    const tasks = [
      task("window", "2026-10-26T13", "2026-10-26T14"),
      task("next", "2026-10-26T15:00", "2026-10-26T16:00"),
      task("later", "2026-10-27T09:00", null),
      task("today", "2026-10-26", "2026-10-26"),
      task("month", null, "2026-10"),
      task("year", null, "2026"),
      task("undated", null, null),
      task("due-only", null, "2026-10-26T17:00"),
      task("done", "2026-10-26T14", null, { status: "done" }),
      task("template", null, null, { isTemplate: true }),
      task("overdue", "2026-10-25", "2026-10-25", { status: "missed" }),
    ];
    const groups = plannerGroups([...tasks].reverse(), "2026-10-26T14:30:00");
    expect(groups.now.map((t) => t.id)).toEqual(["window", "due-only"]);
    expect(groups.upcoming.map((t) => t.id)).toEqual(["next", "later"]);
    expect(groups.flexible.map((t) => t.id)).toEqual(["today", "month", "year", "undated"]);
    expect(groups.overdue.map((t) => t.id)).toEqual(["overdue"]);
    expect(plannerGroups([], "2026-10-26T14:30:00")).toEqual({ now: [], upcoming: [], flexible: [], overdue: [] });
  });

  it("expands due precision inclusively and orders by time then priority", () => {
    const rows = [task("leap", null, "2028-02"), task("hour", "2028-02-29T12", "2028-02-29T12")];
    expect(plannerGroups(rows, "2028-02-29T12:59:59").now.map((t) => t.id)).toEqual(["hour"]);
    expect(plannerGroups(rows, "2028-02-29T13:00:00").overdue.map((t) => t.id)).toEqual(["hour"]);
    expect(plannerGroups(rows, "2028-03-01T00:00:00").overdue.map((t) => t.id)).toEqual(["hour", "leap"]);
    const current = [
      task("low", null, "2028-02-29T17", { priority: 1 }),
      task("high-late", null, "2028-02-29T19", { priority: 9 }),
      task("high-early", null, "2028-02-29T18", { priority: 9 }),
    ];
    expect(plannerGroups(current, "2028-02-29T13:00:00").now.map((t) => t.id)).toEqual([
      "high-early",
      "high-late",
      "low",
    ]);
    const flexible = [
      task("year", null, "2028", { priority: 9 }),
      task("month-low", null, "2028-02", { priority: 1 }),
      task("month-high", null, "2028-02", { priority: 9 }),
    ];
    expect(plannerGroups(flexible, "2028-02-29T13:00:00").flexible.map((t) => t.id)).toEqual([
      "month-high",
      "month-low",
      "year",
    ]);
    const timed = [task("low", "2026-10-27T09", null), task("high", "2026-10-27T09", null, { priority: 9 })];
    expect(plannerGroups(timed, "2026-10-26T14:00:00").upcoming.map((t) => t.id)).toEqual(["high", "low"]);
  });
});

it("rejects invalid planner data rather than fabricating an empty schedule", async () => {
  const { validPlannerSnapshot, plannerWindow } = await import("../plannerTimeline");
  const snapshot = {
    tasks: [task("a", null, "2026-10-26")],
    timeZone: "America/Los_Angeles",
    fetchedAt: "2026-10-26T20:00:00Z",
    truncated: false,
  };
  expect(validPlannerSnapshot(snapshot)).toBe(true);
  for (const invalid of [
    "",
    "2026-13",
    "2026-02-30",
    "2026-10-26T24",
    "2026-10-26T13:60",
    "2026-10-26T13:00:60",
    "wrong",
  ]) {
    expect(validPlannerSnapshot({ ...snapshot, tasks: [task("a", invalid, null)] }), invalid).toBe(false);
  }
  for (const change of [
    { timeZone: "Invalid/Zone" },
    { fetchedAt: "invalid" },
    { tasks: null },
    { tasks: [{ ...snapshot.tasks[0], number: 0 }] },
    { tasks: [task("a", "2026-10-27", "2026-10-26")] },
  ]) {
    expect(validPlannerSnapshot({ ...snapshot, ...change } as typeof snapshot)).toBe(false);
  }
  for (const [start, due, expected] of [
    [null, null, "Anytime"],
    [null, "2026-10", "By 2026-10"],
    ["2026", null, "From 2026"],
    ["2026-10-26", "2026-10-26", "2026-10-26"],
    ["2026-10-26T13:00", "2026-10-26T14:00", "2026-10-26 13:00 to 14:00"],
    ["2026-10-26", "2026-10-27", "2026-10-26 to 2026-10-27"],
  ])
    expect(plannerWindow(task("a", start, due))).toBe(expected);
});
