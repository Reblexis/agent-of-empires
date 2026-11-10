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

const isLive = (s: SessionResponse) => s.archived_at == null && s.snoozed_until == null && s.trashed_at == null;

const byClaudeLimitThenTitle = (a: SessionResponse, b: SessionResponse) =>
  (b.owner?.granted.claude ?? -1) - (a.owner?.granted.claude ?? -1) || a.title.localeCompare(b.title);

function modulesOf(sessions: readonly SessionResponse[]): SessionResponse[] {
  return sessions.filter((s) => s.owner?.role === "module").sort(byClaudeLimitThenTitle);
}

export interface OwnerCore {
  root: SessionResponse | null;
  modules: SessionResponse[];
}

/** The root and its modules, as favorites shows them; null when nothing live is in the core. */
export function buildCore(sessions: readonly SessionResponse[]): OwnerCore | null {
  const live = sessions.filter(isLive);
  const root = live.find((s) => s.owner?.role === "root") ?? null;
  const modules = modulesOf(live);
  return root || modules.length > 0 ? { root, modules } : null;
}

export interface NestedWorker {
  session: SessionResponse;
  depth: number;
}

const workersOf = (sessions: readonly SessionResponse[], moduleId: string) =>
  sessions.filter((s) => s.owner?.role === "worker" && s.owner.module === moduleId && s.trashed_at == null);

/** A module's workers in tree order; a worker whose parent is not listed starts at depth 0. */
export function moduleWorkers(sessions: readonly SessionResponse[], moduleId: string): NestedWorker[] {
  const workers = workersOf(sessions, moduleId).sort((a, b) => a.title.localeCompare(b.title));
  const ids = new Set(workers.map((w) => w.id));
  const out: NestedWorker[] = [];
  const seen = new Set<string>();
  const visit = (s: SessionResponse, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth });
    for (const child of workers) if (child.owner?.parent === s.id) visit(child, depth + 1);
  };
  for (const w of workers) if (!ids.has(w.owner?.parent ?? "")) visit(w, 0);
  // A cycle among workers reaches no top; list what is left flat rather than drop it.
  for (const w of workers) visit(w, 0);
  return out;
}

export function workerCount(sessions: readonly SessionResponse[], moduleId: string): number {
  return workersOf(sessions, moduleId).length;
}

/** The title with the owner's `Central: ` style prefix removed. */
export function moduleShortName(title: string): string {
  const i = title.indexOf(": ");
  return i >= 0 ? title.slice(i + 2) : title;
}

/** The plan a worker's agent runs on. */
export function workerPlan(session: SessionResponse): Plan {
  return session.tool === "codex" ? "codex" : "claude";
}

export function workerTag(session: SessionResponse, byId: ReadonlyMap<string, SessionResponse>): string | null {
  if (session.owner?.role !== "worker") return null;
  const module = session.owner.module ? byId.get(session.owner.module) : undefined;
  return module ? `worker · ${moduleShortName(module.title)}` : "worker";
}

export interface PlanBudget {
  plan: Plan;
  granted: number | null;
  left: number | null;
  handedOut: number;
}

export interface BudgetModule {
  session: SessionResponse;
  short: string;
  claudeLeft: number | null;
  codexLeft: number | null;
  claudeGranted: number | null;
  codexGranted: number | null;
  workers: number;
}

export interface BudgetTransaction extends OwnerTransaction {
  fromTitle: string;
  toTitle: string;
  amount: string;
}

export interface RootBudget {
  plans: PlanBudget[];
  modules: BudgetModule[];
  transactions: BudgetTransaction[];
}

/** Sum of the modules' grants per plan; an unknown grant counts as nothing. */
export function handedOut(sessions: readonly SessionResponse[], plan: Plan): number {
  return modulesOf(sessions).reduce((t, m) => t + (m.owner?.granted[plan] ?? 0), 0);
}

/** The root's grant, what is left of it and what it handed out, per plan; its modules; its transfers by title. */
export function rootBudget(root: SessionResponse, sessions: readonly SessionResponse[]): RootBudget {
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? (id === root.id ? root.title : id);
  return {
    plans: (["claude", "codex"] as const).map((plan) => ({
      plan,
      granted: root.owner?.granted[plan] ?? null,
      left: root.owner?.left[plan] ?? null,
      handedOut: handedOut(sessions, plan),
    })),
    modules: modulesOf(sessions).map((m) => ({
      session: m,
      short: moduleShortName(m.title),
      claudeLeft: m.owner?.left.claude ?? null,
      codexLeft: m.owner?.left.codex ?? null,
      claudeGranted: m.owner?.granted.claude ?? null,
      codexGranted: m.owner?.granted.codex ?? null,
      workers: workerCount(sessions, m.id),
    })),
    transactions: (root.owner?.transactions ?? []).map((tx) => ({
      ...tx,
      fromTitle: titleOf(tx.from),
      toTitle: titleOf(tx.to),
      amount: formatAmount(tx),
    })),
  };
}
