import { useState, type ReactNode } from "react";
import type { SessionResponse } from "../lib/types";
import { formatPercent, meterFill, meterTone, rootBudget, type PlanBudget } from "../lib/sessionOwners";

const TONE_BG = { teal: "bg-teal-500", amber: "bg-amber-500", red: "bg-red-500" } as const;
const PLAN_NAME = { claude: "Claude", codex: "Codex" } as const;

const fill = (part: number | null, whole: number | null) => `${Math.round(meterFill(part, whole) * 100)}%`;

function PlanCard({ p, over }: { p: PlanBudget; over: boolean }) {
  return (
    <section
      data-testid="owner-budget-plan"
      className="flex flex-col gap-3 rounded-lg border border-surface-700 bg-surface-900 p-4"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-text-primary">{PLAN_NAME[p.plan]}</span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-text-dim">
          granted {formatPercent(p.granted)} of the weekly plan
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[32px] font-medium leading-none text-brand-400">{formatPercent(p.left)}</span>
        <span className="text-text-muted">left</span>
      </div>
      {/* Handed out and left, each against the grant. */}
      <div className="flex flex-col gap-1" aria-hidden="true">
        <div className="h-2 overflow-hidden rounded bg-surface-800">
          <div className="h-full bg-brand-700" style={{ width: fill(p.handedOut, p.granted) }} />
        </div>
        <div className="h-1 overflow-hidden rounded bg-surface-800">
          <div
            className={`h-full ${TONE_BG[meterTone(p.left, p.granted, over)]}`}
            style={{ width: fill(p.left, p.granted) }}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-4 font-mono text-[11px] text-text-secondary">
        <span>
          <span className="text-brand-600">■</span> handed out {formatPercent(p.handedOut)}
        </span>
        <span>
          <span className="text-teal-500">■</span> left {formatPercent(p.left)}
        </span>
      </div>
    </section>
  );
}

const GRID = "grid grid-cols-[minmax(0,1fr)_repeat(5,minmax(3.5rem,auto))] gap-x-4";

/** The root's grant, its modules and its transfers (docs/guides/session-owners.md, "The root's budget"). */
export function BudgetPane({ root, sessions }: { root: SessionResponse; sessions: readonly SessionResponse[] }) {
  const budget = rootBudget(root, sessions);
  const over = !!root.owner?.over;
  return (
    <div data-testid="owner-budget" className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
      <div className="flex max-w-5xl flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {budget.plans.map((p) => (
            <PlanCard key={p.plan} p={p} over={over} />
          ))}
        </div>

        <section className="overflow-x-auto rounded-lg border border-surface-700">
          <div className="border-b border-surface-800 bg-surface-900 px-4 py-3 font-semibold text-text-primary">
            Handed out
          </div>
          <div className="min-w-[32rem]">
            <div className={`${GRID} px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-text-dim`}>
              <span>Module</span>
              <span>C left</span>
              <span>X left</span>
              <span>C granted</span>
              <span>X granted</span>
              <span>Workers</span>
            </div>
            {budget.modules.map((m) => (
              <div
                key={m.session.id}
                data-testid="owner-budget-module"
                className={`${GRID} items-center border-t border-surface-800 px-4 py-1.5 font-mono text-[12px] text-text-secondary`}
              >
                <span className="truncate text-text-primary" title={m.session.title}>
                  {m.short}
                </span>
                <span>{formatPercent(m.claudeLeft)}</span>
                <span>{formatPercent(m.codexLeft)}</span>
                <span className="text-text-dim">{formatPercent(m.claudeGranted)}</span>
                <span className="text-text-dim">{formatPercent(m.codexGranted)}</span>
                <span className="text-text-dim">{m.workers}</span>
              </div>
            ))}
          </div>
        </section>

        {budget.transactions.length > 0 && (
          <section className="overflow-hidden rounded-lg border border-surface-700">
            <div className="border-b border-surface-800 bg-surface-900 px-4 py-3 font-semibold text-text-primary">
              Transfers
            </div>
            {budget.transactions.map((t, i) => (
              <div
                key={`${t.at}-${i}`}
                data-testid="owner-budget-transfer"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-surface-800 px-4 py-2 text-[12px]"
              >
                <span className="w-28 shrink-0 font-mono text-[11px] text-text-dim">{formatWhen(t.at)}</span>
                <span
                  className={`shrink-0 rounded px-1.5 font-mono text-[10px] ${
                    t.kind === "cut" ? "bg-red-950/40 text-red-300" : "bg-surface-800 text-text-secondary"
                  }`}
                >
                  {t.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-secondary">
                  {t.fromTitle} → {t.toTitle}
                  <span className="text-text-dim"> by {t.by}</span>
                </span>
                <span className="shrink-0 font-mono text-text-primary">{t.amount}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function formatWhen(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Gives the root a Budget tab beside its terminal; any other session renders its content alone. */
export function RootBudgetFrame({
  session,
  sessions,
  children,
}: {
  session: SessionResponse | null | undefined;
  sessions: readonly SessionResponse[];
  children: ReactNode;
}) {
  // The tab belongs to one root: opening another session and coming back starts on the terminal.
  const [picked, setPicked] = useState<{ id: string; tab: "terminal" | "budget" } | null>(null);
  const isRoot = session?.owner?.role === "root";
  const tab = isRoot && picked?.id === session.id ? picked.tab : "terminal";
  const setTab = (t: "terminal" | "budget") => session && setPicked({ id: session.id, tab: t });
  const tabClass = (t: typeof tab) =>
    `h-8 cursor-pointer rounded-md px-3 text-[12px] transition-colors ${
      tab === t ? "bg-surface-800 text-text-primary" : "text-text-muted hover:text-text-secondary"
    }`;
  // One element tree for every session, so switching to or from the root never remounts the terminals.
  return (
    <>
      {isRoot && (
        <div
          role="tablist"
          aria-label="Root view"
          className="flex shrink-0 items-center gap-1 border-b border-surface-700/60 px-2 py-1"
        >
          <button
            role="tab"
            type="button"
            aria-selected={tab === "terminal"}
            className={tabClass("terminal")}
            onClick={() => setTab("terminal")}
          >
            Terminal
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={tab === "budget"}
            className={tabClass("budget")}
            onClick={() => setTab("budget")}
          >
            Budget
          </button>
        </div>
      )}
      {/* The terminal stays mounted under the Budget tab so it keeps its connection and scrollback. */}
      <div className={tab === "terminal" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "hidden"}>{children}</div>
      {isRoot && tab === "budget" && <BudgetPane root={session} sessions={sessions} />}
    </>
  );
}
