import { useEffect, useState } from "react";
import { getPlannerTimeline } from "../lib/api";
import {
  plannerGroups,
  plannerWindow,
  validPlannerSnapshot,
  wallNow,
  type PlannerSnapshot,
  type PlannerTask,
} from "../lib/plannerTimeline";

export function TimelinePane() {
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let disposed = false;
    let inflight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inflight || disposed) return;
      inflight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const value = await getPlannerTimeline(controller.signal);
        if (disposed) return;
        if (!value || !validPlannerSnapshot(value)) {
          setFailed(true);
          return;
        }
        setSnapshot(value);
        setFailed(false);
      } finally {
        clearTimeout(timeout);
        inflight = false;
      }
    };
    void refresh();
    const poll = setInterval(() => {
      void refresh();
    }, 60_000);
    const clock = setInterval(() => setNow(new Date()), 15_000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        setNow(new Date());
        void refresh();
      }
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(poll);
      clearInterval(clock);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const wall = snapshot ? wallNow(now, snapshot.timeZone) : null;
  const groups = snapshot && wall ? plannerGroups(snapshot.tasks, wall) : null;
  const section = (label: string, tasks: PlannerTask[], overdue = false) =>
    tasks.length > 0 && (
      <section aria-label={label} className="mt-4">
        <h3 className="text-[11px] font-medium text-text-dim mb-2">{label}</h3>
        <ol className="border-l border-surface-700 ml-1 space-y-3">
          {tasks.map((task) => (
            <li key={task.id} className="pl-3 min-w-0">
              <div
                className={`text-xs leading-relaxed break-words ${overdue ? "text-status-error" : "text-text-primary"}`}
              >
                <span className="text-text-dim font-mono text-[10px] mr-1.5">#{task.number}</span>
                {task.title}
              </div>
              <div className="text-[11px] text-text-dim mt-0.5 font-mono break-words">{plannerWindow(task)}</div>
            </li>
          ))}
        </ol>
      </section>
    );
  return (
    <div data-testid="planner-timeline" className="flex-1 min-h-0 overflow-y-auto bg-surface-900 text-left px-3 py-3">
      {!snapshot ? (
        <p className="text-xs text-text-secondary" role="status">
          {failed ? "Timeline unavailable" : "Loading timeline..."}
        </p>
      ) : (
        <>
          <div className="text-[10px] text-text-dim break-words">{snapshot.timeZone}</div>
          <div data-testid="timeline-now" className="mt-2 flex items-center gap-2 text-xs text-brand-400 font-medium">
            <span className="h-2 w-2 rounded-full bg-brand-400 shrink-0" aria-hidden />
            <span>Now {wall!.slice(11, 16)}</span>
            <span className="text-text-dim font-normal">{wall!.slice(0, 10)}</span>
            <span className="flex-1 border-t border-brand-400/40" aria-hidden />
          </div>
          {failed && (
            <p role="status" className="text-xs text-status-warning mt-2">
              Stale, updated{" "}
              {new Date(snapshot.fetchedAt).toLocaleTimeString([], {
                timeZone: snapshot.timeZone,
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
              })}
            </p>
          )}
          {snapshot.truncated && (
            <p role="status" className="text-xs text-status-warning mt-2">
              Schedule incomplete
            </p>
          )}
          {groups && (
            <>
              {section("Open now", groups.now)}
              {section("Upcoming", groups.upcoming)}
              {section("Other windows", groups.flexible)}
              {section("Overdue", groups.overdue, true)}
            </>
          )}
          {groups && Object.values(groups).every((rows) => rows.length === 0) && (
            <p className="mt-4 text-xs text-text-secondary">No scheduled work</p>
          )}
        </>
      )}
    </div>
  );
}
