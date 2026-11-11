// Arranges an outside agent's session tree (docs/guides/session-owners.md) for the dashboard; computes nothing new.
import { createContext } from "react";
import type { OwnerTransaction, SessionResponse } from "./types";

export type Plan = "claude" | "codex";
export type MeterTone = "teal" | "amber" | "red";

/** Sessions by id, so a worker's row can name its module. */
export const OwnedSessionsContext = createContext<ReadonlyMap<string, SessionResponse>>(new Map());

/** A share as a percent number of one weekly limit: two decimals, trailing zeros dropped; `?` when unknown. */
export function formatShare(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return "?";
  return String(Number((share * 100).toFixed(2)));
}

export function formatPercent(share: number | null | undefined): string {
  const n = formatShare(share);
  return n === "?" ? n : `${n}%`;
}

export function formatLeft(share: number | null | undefined): string {
  return `${formatPercent(share)} left`;
}

/** A fuel gauge: full while nothing is spent, amber under a fifth of the grant left, red at none left. */
export function meterTone(
  left: number | null | undefined,
  granted: number | null | undefined,
  over: boolean,
): MeterTone {
  if (over) return "red";
  if (left == null) return "teal";
  if (left <= 0) return "red";
  return granted != null && left < 0.2 * granted ? "amber" : "teal";
}

export function meterFill(left: number | null | undefined, granted: number | null | undefined): number {
  if (left == null || granted == null || granted <= 0) return 0;
  return Math.max(0, Math.min(1, left / granted));
}

/** `C +0.5% X +0.2%`; a cut is negative however it was written. */
export function formatAmount(tx: OwnerTransaction): string {
  const part = (letter: string, share: number | null) => {
    if (share == null) return null;
    const signed = tx.kind === "cut" ? -Math.abs(share) : share;
    return `${letter} ${signed < 0 ? "-" : "+"}${formatPercent(Math.abs(signed))}`;
  };
  return [part("C", tx.claude), part("X", tx.codex)].filter(Boolean).join(" ") || "?";
}

// Idle and snoozed sessions stay in the tree, so every worker shows; archived and trashed ones have left it.
const inTree = (s: SessionResponse) => s.archived_at == null && s.trashed_at == null;

const byClaudeLimitThenTitle = (a: SessionResponse, b: SessionResponse) =>
  (b.owner?.granted.claude ?? -1) - (a.owner?.granted.claude ?? -1) || a.title.localeCompare(b.title);

function modulesOf(sessions: readonly SessionResponse[]): SessionResponse[] {
  return sessions.filter((s) => s.owner?.role === "module").sort(byClaudeLimitThenTitle);
}

/** The modules in the tree, as favorites shows them; null when there are none. */
export function buildCore(sessions: readonly SessionResponse[]): SessionResponse[] | null {
  const modules = modulesOf(sessions.filter(inTree));
  return modules.length > 0 ? modules : null;
}

export interface NestedWorker {
  session: SessionResponse;
  depth: number;
}

// A session's direct children in the tree, by Claude grant then title.
export const childrenOf = (sessions: readonly SessionResponse[], id: string): SessionResponse[] =>
  sessions.filter((s) => s.owner?.role === "worker" && s.owner.parent === id && inTree(s)).sort(byClaudeLimitThenTitle);

/** Every session below one, depth first, depth 0 for its children; one below a session that left the tree leaves with it. */
export function sessionsBelow(sessions: readonly SessionResponse[], id: string): NestedWorker[] {
  const out: NestedWorker[] = [];
  const seen = new Set<string>([id]);
  const visit = (parent: string, depth: number) => {
    for (const child of childrenOf(sessions, parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ session: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(id, 0);
  return out;
}

/** The title without the owner's own prefix (`Central: ` for owner `central`, any case); any other title stays whole. */
export function moduleShortName(title: string, owner: string): string {
  const i = title.indexOf(": ");
  return i >= 0 && title.slice(0, i).toLowerCase() === owner.toLowerCase() ? title.slice(i + 2) : title;
}

/** What the owner handed out: its modules' grants per plan; an unknown grant counts as nothing. */
export function ownerHandedOut(modules: readonly SessionResponse[], plan: Plan): number {
  return modules.reduce((t, m) => t + (m.owner?.granted[plan] ?? 0), 0);
}

const PLAN_NAME: Record<Plan, string> = { claude: "Claude", codex: "Codex" };

export interface LeftPart {
  plan: string;
  text: string;
  tone: MeterTone;
}

/** What is left per plan, each plan named in full: both for a module, the plan a worker runs on for a worker. */
export function leftParts(session: SessionResponse): LeftPart[] {
  const o = session.owner;
  if (!o) return [];
  const plans: Plan[] = o.role === "module" ? ["claude", "codex"] : [workerPlan(session)];
  return plans.map((p) => ({
    plan: PLAN_NAME[p],
    text: formatPercent(o.left[p]),
    tone: meterTone(o.left[p], o.granted[p], o.over),
  }));
}

/** The hover of a budget: what was granted on the plans its text shows. */
export function budgetTitle(session: SessionResponse): string {
  const o = session.owner;
  const plans: Plan[] = o?.role === "module" ? ["claude", "codex"] : [workerPlan(session)];
  const granted = plans.map((p) => `${PLAN_NAME[p]} ${formatPercent(o?.granted[p])}`).join(" · ");
  return `left of the weekly plan; granted ${granted}`;
}

export function formatProgress(progress: number): string {
  return formatPercent(progress / 100);
}

/** The plan a worker's agent runs on. */
export function workerPlan(session: SessionResponse): Plan {
  return session.tool === "codex" ? "codex" : "claude";
}

export function workerTag(session: SessionResponse, byId: ReadonlyMap<string, SessionResponse>): string | null {
  if (session.owner?.role !== "worker") return null;
  const module = session.owner.module ? byId.get(session.owner.module) : undefined;
  return module ? `worker · ${moduleShortName(module.title, session.owner.owner)}` : "worker";
}

export interface PlanBudget {
  plan: Plan;
  granted: number | null;
  left: number | null;
  handedOut: number;
}

export interface BudgetChild {
  session: SessionResponse;
  claudeLeft: number | null;
  codexLeft: number | null;
  claudeGranted: number | null;
  codexGranted: number | null;
  /** Entries below this child, at any depth. */
  below: number;
}

export interface BudgetTransaction extends OwnerTransaction {
  fromTitle: string;
  toTitle: string;
  amount: string;
}

export interface ModuleBudget {
  plans: PlanBudget[];
  children: BudgetChild[];
  transactions: BudgetTransaction[];
}

/** A module's grant, what is left of it and what its direct children were granted, per plan; its children; its transfers by title. */
export function moduleBudget(module: SessionResponse, sessions: readonly SessionResponse[]): ModuleBudget {
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? (id === module.id ? module.title : id);
  const children = childrenOf(sessions, module.id);
  return {
    plans: (["claude", "codex"] as const).map((plan) => ({
      plan,
      granted: module.owner?.granted[plan] ?? null,
      left: module.owner?.left[plan] ?? null,
      handedOut: children.reduce((t, c) => t + (c.owner?.granted[plan] ?? 0), 0),
    })),
    children: children.map((c) => ({
      session: c,
      claudeLeft: c.owner?.left.claude ?? null,
      codexLeft: c.owner?.left.codex ?? null,
      claudeGranted: c.owner?.granted.claude ?? null,
      codexGranted: c.owner?.granted.codex ?? null,
      below: sessionsBelow(sessions, c.id).length,
    })),
    transactions: (module.owner?.transactions ?? []).map((tx) => ({
      ...tx,
      fromTitle: titleOf(tx.from),
      toTitle: titleOf(tx.to),
      amount: formatAmount(tx),
    })),
  };
}
