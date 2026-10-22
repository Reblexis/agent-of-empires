// The session's forecast card: what happens to the numbers the session works
// on if it stops now, against what happens if it continues. The agent inside
// the session writes it with `aoe session forecast set`; this band pins it on
// the session view and the chip carries it on the sidebar row. The dashboard
// shows exactly what was written and how old it is; it computes only the
// difference of a metric row. Spec: docs/guides/session-forecast.md.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getSessionForecast } from "../lib/api";
import { safeGetItem, safeRemoveItem, safeSetItem } from "../lib/safeStorage";
import type { ForecastCard, ForecastMetric, ForecastSummary, ForecastVerdict } from "../lib/types";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const COLLAPSED_KEY_PREFIX = "aoe.forecastBand.collapsed.";

const VERDICT_CLASS: Record<ForecastVerdict, string> = {
  continue: "border-status-running/40 bg-status-running/15 text-status-running",
  stop: "border-status-error/40 bg-status-error/15 text-status-error",
  unpriced: "border-surface-600 bg-surface-700/40 text-text-dim",
};

function verdictClass(verdict: string): string {
  return VERDICT_CLASS[verdict as ForecastVerdict] ?? VERDICT_CLASS.unpriced;
}

/** "as of 12 min ago" style age, coarse on purpose. */
function formatAge(updatedAt: string, now: number): string {
  const ms = now - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function isStale(updatedAt: string, now: number): boolean {
  return now - new Date(updatedAt).getTime() > STALE_AFTER_MS;
}

/** Deadline in the viewer's local time: "18:00" today, "Oct 7 18:00" later. */
function formatDecideBy(iso: string, now: number): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function formatNumber(n: number): string {
  return numberFormat.format(n);
}

/** Signed difference continued minus stopped: "+15.5", "-20", "0". Plain
 *  ASCII signs, never a typographic minus. */
function formatDiff(diff: number): string {
  const rounded = Math.round(diff * 100) / 100;
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : "-"}${formatNumber(Math.abs(rounded))}`;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s/?#]+/i.test(url);
}

// Storage can be blocked (private window, cleared site data); the safe
// helpers swallow that, so the toggle still works, it just is not remembered.
function readCollapsed(sessionId: string): boolean {
  return safeGetItem(COLLAPSED_KEY_PREFIX + sessionId) === "1";
}

function writeCollapsed(sessionId: string, collapsed: boolean): void {
  if (collapsed) safeSetItem(COLLAPSED_KEY_PREFIX + sessionId, "1");
  else safeRemoveItem(COLLAPSED_KEY_PREFIX + sessionId);
}

/** Re-render on an interval so the age label keeps moving. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function MetricLine({ metric }: { metric: ForecastMetric }) {
  const stopped = metric.stopped ?? null;
  const continued = metric.continued ?? null;
  const known = stopped !== null && continued !== null;
  return (
    <li data-testid="forecast-metric" className="flex flex-wrap items-baseline gap-x-2 text-left">
      <span className="text-text-secondary">
        {metric.name}
        {metric.date && <span className="ml-1 text-text-dim">({metric.date})</span>}
      </span>
      <span className="font-mono tabular-nums text-text-primary">
        {stopped === null ? "?" : formatNumber(stopped)} → {continued === null ? "?" : formatNumber(continued)}
      </span>
      {known && (
        <span
          data-testid="forecast-diff"
          className={`font-mono font-semibold tabular-nums ${
            continued > stopped ? "text-status-running" : continued < stopped ? "text-status-error" : "text-text-dim"
          }`}
        >
          {formatDiff(continued - stopped)}
        </span>
      )}
      {metric.unit && <span className="text-text-dim">{metric.unit}</span>}
      {metric.traders != null && (
        <span className="text-text-dim">
          {metric.traders} trader{metric.traders === 1 ? "" : "s"}
        </span>
      )}
      {metric.depth != null && <span className="text-text-dim">depth {formatNumber(metric.depth)}</span>}
    </li>
  );
}

/**
 * The band pinned at the top of the session view. Renders nothing while the
 * session has no card. The list summary drives it: when its `updated_at`
 * moves, the full card is fetched again, so a new `set` shows within one
 * session-list refresh.
 */
export function ForecastBand({
  sessionId,
  summary,
}: {
  sessionId: string;
  summary: ForecastSummary | null | undefined;
}) {
  const [card, setCard] = useState<ForecastCard | null>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(sessionId));
  const now = useNow(30_000);
  const updatedAt = summary?.updated_at ?? null;

  // Callers key the band by session, so `collapsed` and `card` start fresh
  // for each session. A card fetched for an older summary is never shown
  // (see `current` below), so nothing needs clearing when the summary goes.
  useEffect(() => {
    if (!updatedAt) return;
    let cancelled = false;
    void getSessionForecast(sessionId).then((fetched) => {
      if (!cancelled) setCard(fetched);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, updatedAt]);

  if (!summary) return null;

  // Until the full card for this summary lands, the first line comes from
  // the summary so the band never flashes stale content from an older card.
  const current = card && card.updated_at === summary.updated_at ? card : null;
  const head: ForecastSummary = current ?? summary;
  const stale = isStale(head.updated_at, now);
  const decideBy = current?.decide_by ? formatDecideBy(current.decide_by, now) : null;
  const source = current?.source && isHttpUrl(current.source.url) ? current.source : null;
  const metrics = current?.metrics ?? [];
  const toggle = () => {
    setCollapsed((was) => {
      writeCollapsed(sessionId, !was);
      return !was;
    });
  };

  return (
    <section
      data-testid="forecast-band"
      aria-label="Session forecast"
      className="shrink-0 border-b border-surface-700 bg-surface-850 px-3 py-1.5 text-left text-[13px] leading-snug"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-left">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand forecast" : "Collapse forecast"}
          className="-ml-1 inline-flex shrink-0 items-center rounded p-0.5 text-text-dim hover:bg-surface-700/60 hover:text-text-primary"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        <span
          data-testid="forecast-verdict"
          data-verdict={head.verdict}
          className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0 font-mono text-[11px] font-semibold ${verdictClass(head.verdict)}`}
        >
          {head.verdict}
        </span>
        <span className="font-semibold text-text-primary">{head.headline}</span>
        {source && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-500 underline-offset-2 hover:underline"
          >
            {source.label}
          </a>
        )}
        {decideBy && (
          <span data-testid="forecast-decide-by" className="text-text-secondary">
            decide by {decideBy}
          </span>
        )}
        <span
          data-testid="forecast-age"
          data-stale={stale ? "true" : undefined}
          title={new Date(head.updated_at).toLocaleString()}
          className={stale ? "font-medium text-status-warning" : "text-text-dim"}
        >
          as of {formatAge(head.updated_at, now)}
        </span>
      </div>
      {!collapsed && current && (metrics.length > 0 || current.note) && (
        <div className="mt-1 pl-5 text-left">
          {metrics.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {metrics.map((metric, i) => (
                <MetricLine key={`${i}-${metric.name}`} metric={metric} />
              ))}
            </ul>
          )}
          {current.note && <p className="mt-0.5 text-left text-text-secondary">{current.note}</p>}
        </div>
      )}
    </section>
  );
}

/** The sidebar row's chip: verdict color and headline. Hover names the
 *  verdict, the headline, and the age (what the list summary carries). */
export function ForecastChip({ summary }: { summary: ForecastSummary }) {
  const now = useNow(60_000);
  const age = formatAge(summary.updated_at, now);
  return (
    <span
      data-testid="sidebar-forecast-chip"
      data-verdict={summary.verdict}
      title={`${summary.verdict} · ${summary.headline} · as of ${age}`}
      className={`inline-block min-w-0 max-w-[9rem] shrink truncate rounded border px-1 py-0 text-[10px] font-medium ${verdictClass(summary.verdict)}`}
    >
      {summary.headline}
    </span>
  );
}
