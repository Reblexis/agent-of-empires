import { describe, expect, it } from "vitest";
import {
  buildCore,
  formatPercent,
  formatShare,
  formatAmount,
  formatLeft,
  meterFill,
  meterTone,
  moduleShortName,
  ownerHandedOut,
  moduleWorkers,
  moduleBudget,
  workerCount,
  workerPlan,
  workerTag,
} from "../sessionOwners";
import type { OwnerTransaction, SessionOwner, SessionResponse } from "../types";

type OwnerOver = Partial<Omit<SessionOwner, "granted" | "left">> & {
  granted?: [number | null, number | null];
  left?: [number | null, number | null];
};

function owned(id: string, title: string, o: OwnerOver | null, over: Partial<SessionResponse> = {}): SessionResponse {
  const owner: SessionOwner | null = o && {
    owner: "central",
    parent: null,
    role: "worker",
    module: null,
    budgeted: true,
    over: false,
    transactions: [],
    ...o,
    granted: { claude: o.granted?.[0] ?? null, codex: o.granted?.[1] ?? null },
    left: { claude: o.left?.[0] ?? null, codex: o.left?.[1] ?? null },
  };
  return { id, title, tool: "claude", owner, ...over } as SessionResponse;
}

const TX = (kind: OwnerTransaction["kind"], claude: number | null, codex: number | null): OwnerTransaction => ({
  at: "2026-11-10T19:00:00Z",
  from: "central",
  to: "planner",
  claude,
  codex,
  kind,
  by: "central",
});
// The owner is the tree's root and no session: modules have no parent.
const PLANNER = owned("planner", "Central: Planner", {
  role: "module",
  granted: [0.08, 0.03],
  left: [0.0224, 0],
  transactions: [
    { ...TX("cut", 0.005, null), from: "planner", to: "w1" },
    TX("grant", 0.08, 0.03),
    { ...TX("default", 0.02, 0.01), from: "planner", to: "gone" },
  ],
});
const ROUTER = owned("router", "Central: Router", { role: "module", granted: [0.02, 0.01] });
const ASSISTANT = owned("assistant", "Central: Assistant", { role: "module", granted: [0.04, null] });
const ALPHA = owned("alpha", "Alpha", { role: "module", granted: [0.02, null] });
const SNOOZED = owned(
  "snoozed",
  "Central: Snoozed",
  { role: "module", granted: [0.5, 0.5] },
  { snoozed_until: "2099-01-01T00:00:00Z" },
);
const W1 = owned("w1", "Make aoe fast", {
  parent: "planner",
  module: "planner",
  granted: [0.01, null],
  left: [0.0043, null],
});
const W1A = owned("w1a", "Sub of w1", { parent: "w1", module: "planner", left: [0.001, 0.002] }, { tool: "codex" });
const W2 = owned("w2", "Daily posts", { parent: "planner", module: "planner", granted: [0.02, 0.01] });
const W1B = owned("w1b", "Another sub", { parent: "w1", module: "planner" });
const STRAY = owned("stray", "Stray", { parent: "nowhere", module: null, left: [0.3, 0.3] });
const PLAIN = owned("plain", "Plain", null);
const ALL = [W1A, PLAIN, ROUTER, W2, ALPHA, STRAY, PLANNER, W1, SNOOZED, ASSISTANT, W1B];

describe("session owners", () => {
  it("formats a share as a percent of one weekly limit, two decimals, trailing zeros dropped", () => {
    const cases: [number | null | undefined, string, string][] = [
      [0.0224, "2.24", "2.24%"],
      [0.08, "8", "8%"],
      [0.175, "17.5", "17.5%"],
      [0, "0", "0%"],
      [1, "100", "100%"],
      [0.123456, "12.35", "12.35%"],
      [null, "?", "?"],
      [undefined, "?", "?"],
    ];
    for (const [share, bare, pct] of cases) {
      expect(formatShare(share), String(share)).toBe(bare);
      expect(formatPercent(share), String(share)).toBe(pct);
    }
    expect(formatLeft(0.0576)).toBe("5.76% left");
    expect(formatLeft(null)).toBe("? left");
  });

  it("tones a fuel meter teal, amber below 20% of granted left, red at none left or while over", () => {
    const cases: [number | null, number | null, boolean, string][] = [
      [0.0576, 0.08, false, "teal"],
      [0.016, 0.08, false, "teal"], // exactly 20% left is not yet low
      [0.01, 0.08, false, "amber"],
      [0, 0.08, false, "red"],
      [-0.01, 0.08, false, "red"],
      [0.07, 0.08, true, "red"],
      [null, 0.08, false, "teal"],
      [0.01, null, false, "teal"],
      [0, 0, false, "red"],
    ];
    for (const [left, granted, over, tone] of cases) {
      expect(meterTone(left, granted, over), `${left}/${granted} over=${over}`).toBe(tone);
    }
  });

  it("fills a fuel meter by left over granted, clamped to 0..1, empty when either side is unknown", () => {
    const cases: [number | null, number | null, number][] = [
      [0.02, 0.08, 0.25],
      [0.08, 0.08, 1],
      [0.2, 0.08, 1],
      [-0.01, 0.08, 0],
      [null, 0.08, 0],
      [0.02, null, 0],
      [0, 0, 0],
    ];
    for (const [left, granted, fill] of cases) {
      expect(meterFill(left, granted), `${left}/${granted}`).toBeCloseTo(fill);
    }
  });

  it("writes a transaction's amount per plan with its sign, a cut negative, an unknown plan left out", () => {
    const cases: [OwnerTransaction, string][] = [
      [TX("grant", 0.005, 0.002), "C +0.5% X +0.2%"],
      [TX("raise", 0.01, null), "C +1%"],
      [TX("auto-raise", null, 0.03), "X +3%"],
      [TX("cut", 0.005, null), "C -0.5%"],
      [TX("cut", -0.005, null), "C -0.5%"], // a cut written negative is still one cut
      [TX("default", null, null), "?"],
    ];
    for (const [tx, amount] of cases) expect(formatAmount(tx), tx.kind).toBe(amount);
  });

  it("builds the core: every module in the tree, snoozed too, by Claude limit desc, then title", () => {
    expect(buildCore(ALL)?.map((s) => s.id)).toEqual(["snoozed", "planner", "assistant", "alpha", "router"]);
    expect(buildCore([PLAIN, W1])).toBeNull();
    const archived = { ...ROUTER, archived_at: "2026-01-01T00:00:00Z" };
    expect(buildCore([archived, PLANNER])).toEqual([PLANNER]);
    expect(buildCore([{ ...PLANNER, trashed_at: "2026-01-01T00:00:00Z" }])).toBeNull();
  });

  it("lists a module's workers nested by parent with their depth, and counts them at any depth", () => {
    expect(moduleWorkers(ALL, "planner").map((w) => [w.session.id, w.depth])).toEqual([
      ["w2", 0],
      ["w1", 0],
      ["w1b", 1],
      ["w1a", 1],
    ]);
    // A worker whose parent left the tree (trashed) still shows, at the top; an archived worker does not.
    expect(workerCount([{ ...W2, archived_at: "2026-01-01T00:00:00Z" }, W1], "planner")).toBe(1);
    const trashedW1 = { ...W1, trashed_at: "2026-01-01T00:00:00Z" };
    expect(moduleWorkers([trashedW1, W1A, W2], "planner").map((w) => [w.session.id, w.depth])).toEqual([
      ["w2", 0],
      ["w1a", 0],
    ]);
    expect(workerCount(ALL, "planner")).toBe(4);
    expect(workerCount(ALL, "router")).toBe(0);
    expect(moduleWorkers(ALL, "router")).toEqual([]);
  });

  it("names a module by its title without the owner prefix up to the first ': '", () => {
    const cases = [
      ["Central: Planner", "Planner"],
      ["central: Ops: Daily", "Ops: Daily"],
      ["Planner", "Planner"],
      ["Telarchy: minimize steps", "Telarchy: minimize steps"], // only the owner's own prefix goes
    ];
    for (const [title, short] of cases) expect(moduleShortName(title, "central"), title).toBe(short);
    expect(ownerHandedOut([PLANNER, ROUTER, ASSISTANT], "claude")).toBeCloseTo(0.14);
  });

  it("tags a worker with its module's short name, a moduleless worker plainly, and others not at all", () => {
    const byId = new Map(ALL.map((s) => [s.id, s]));
    const cases: [SessionResponse, string | null][] = [
      [W1A, "worker · Planner"],
      [STRAY, "worker"],
      [owned("x", "x", { module: "gone" }), "worker"],
      [PLANNER, null],
      [PLAIN, null],
    ];
    for (const [s, tag] of cases) expect(workerTag(s, byId), s.id).toBe(tag);
    expect(workerPlan(W1A)).toBe("codex");
    expect(workerPlan(W1)).toBe("claude");
  });

  it("computes a module's budget per plan, its direct children, and its transfers by title", () => {
    const budget = moduleBudget(PLANNER, ALL);
    const [claude, codex] = budget.plans;
    expect(claude).toMatchObject({ plan: "claude", granted: 0.08, left: 0.0224 });
    // Handed out is its direct children's grants (w1 0.01 + w2 0.02), not the grandchildren's.
    expect(claude.handedOut).toBeCloseTo(0.03);
    expect(codex).toMatchObject({ plan: "codex", granted: 0.03, left: 0 });
    expect(codex.handedOut).toBeCloseTo(0.01);
    expect(
      budget.children.map((c) => [c.session.id, c.claudeLeft, c.codexLeft, c.claudeGranted, c.codexGranted, c.below]),
    ).toEqual([
      ["w2", null, null, 0.02, 0.01, 0],
      ["w1", 0.0043, null, 0.01, null, 2],
    ]);
    expect(budget.transactions.map((t) => [t.kind, t.fromTitle, t.toTitle, t.amount, t.by])).toEqual([
      ["cut", "Central: Planner", "Make aoe fast", "C -0.5%", "central"],
      ["grant", "central", "Central: Planner", "C +8% X +3%", "central"], // a name outside the tree shows as written
      ["default", "Central: Planner", "gone", "C +2% X +1%", "central"],
    ]);
    const bare = moduleBudget(owned("m", "m", { role: "module" }), []);
    expect(bare.plans[0]).toMatchObject({ granted: null, left: null, handedOut: 0 });
    expect(bare.children).toEqual([]);
    expect(bare.transactions).toEqual([]);
  });
});
