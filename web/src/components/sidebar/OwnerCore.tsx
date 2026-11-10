import { useContext, useState, type MouseEvent } from "react";
import type { SessionResponse } from "../../lib/types";
import {
  formatLeft,
  formatPercent,
  formatShare,
  handedOut,
  meterFill,
  meterTone,
  moduleWorkers,
  OwnedSessionsContext,
  workerCount,
  workerPlan,
  workerTag,
  type MeterTone,
  type OwnerCore,
  type Plan,
} from "../../lib/sessionOwners";
import { getStatusDotClass } from "../../lib/session";
import { sessionRowChromeClass } from "../../lib/sessionRowChrome";
import type { RowActivate } from "./types";

// Meter hue carries meaning (enough left, low, spent), so it uses fixed palette colors (DESIGN.md).
const TONE_BG: Record<MeterTone, string> = { teal: "bg-teal-500", amber: "bg-amber-500", red: "bg-red-500" };
const TONE_TEXT: Record<MeterTone, string> = { teal: "text-text-dim", amber: "text-amber-300", red: "text-red-300" };
const LETTER: Record<Plan, string> = { claude: "C", codex: "X" };
const TAG = "inline-flex shrink-0 items-center rounded border border-teal-700 px-1 font-mono text-[9px] text-teal-300";

function planShares(s: SessionResponse, plan: Plan) {
  const o = s.owner;
  return { left: o?.left[plan] ?? null, granted: o?.granted[plan] ?? null, over: !!o?.over };
}

export function Meter({ session, plan, className = "" }: { session: SessionResponse; plan: Plan; className?: string }) {
  const { left, granted, over } = planShares(session, plan);
  return (
    <div className={`h-[3px] shrink-0 rounded-sm bg-surface-700 ${className}`} aria-hidden="true">
      <div
        className={`h-full rounded-sm ${TONE_BG[meterTone(left, granted, over)]}`}
        style={{ width: `${Math.round(meterFill(left, granted) * 100)}%` }}
      />
    </div>
  );
}

function leftTitle(session: SessionResponse, plan: Plan): string {
  const { left, granted } = planShares(session, plan);
  return `${plan === "claude" ? "Claude" : "Codex"}: ${formatLeft(left)} of ${formatPercent(granted)} granted`;
}

/** `worker · <module>` and what is left of the worker's plan, on the worker's own row elsewhere in the sidebar. */
export function WorkerChip({ session }: { session: SessionResponse }) {
  const byId = useContext(OwnedSessionsContext);
  const tag = workerTag(session, byId);
  if (!tag) return null;
  const plan = workerPlan(session);
  const { left, granted, over } = planShares(session, plan);
  return (
    <span
      data-testid="sidebar-worker-chip"
      title={`${tag}; ${leftTitle(session, plan)}`}
      className="inline-flex shrink-0 items-center gap-1"
    >
      <span className={TAG}>{tag}</span>
      <span className={`font-mono text-[10px] ${TONE_TEXT[meterTone(left, granted, over)]}`}>
        {LETTER[plan]} {formatLeft(left)}
      </span>
    </span>
  );
}

interface TreeProps {
  core: OwnerCore;
  sessions: readonly SessionResponse[];
  workspaceIdOf: ReadonlyMap<string, string>;
  activeWorkspaceId: string | null;
  onActivate: RowActivate;
}

function RowLink({
  session,
  testId,
  props,
  className,
  children,
  depth,
}: {
  session: SessionResponse;
  testId: string;
  props: TreeProps;
  className: string;
  children: React.ReactNode;
  depth?: number;
}) {
  const workspaceId = props.workspaceIdOf.get(session.id);
  const active = workspaceId != null && workspaceId === props.activeWorkspaceId;
  return (
    <a
      href={`/session/${encodeURIComponent(session.id)}`}
      data-testid={testId}
      data-session-id={session.id}
      data-depth={depth}
      title={session.title}
      aria-current={active ? "true" : undefined}
      onClick={(e: MouseEvent) => {
        if (e.button !== 0 || e.altKey || !workspaceId) return;
        e.preventDefault();
        props.onActivate(workspaceId, e, session.id);
      }}
      className={`flex min-w-0 cursor-pointer select-none items-center rounded-md transition-colors duration-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${sessionRowChromeClass(active, false)} ${className}`}
    >
      {children}
    </a>
  );
}

const Dot = ({ session, size }: { session: SessionResponse; size: string }) => (
  <span className={`shrink-0 rounded-full ${size} ${getStatusDotClass(session)}`} aria-hidden="true" />
);

function RootRow({ root, props }: { root: SessionResponse; props: TreeProps }) {
  const left = root.owner?.left;
  return (
    <RowLink
      session={root}
      testId="owner-core-root"
      props={props}
      className="mx-2 my-0.5 flex-col items-stretch gap-1.5 border border-brand-700 bg-surface-700/40 px-2 py-2"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-brand-400" aria-hidden="true">
          ✦
        </span>
        <Dot session={root} size="h-2 w-2" />
        <span className="truncate font-mono text-[13px] font-medium text-text-primary">{root.title}</span>
      </span>
      <span className="flex flex-wrap gap-x-3 pl-6 font-mono text-[11px] text-text-secondary">
        <span>
          left C {formatPercent(left?.claude)} X {formatPercent(left?.codex)}
        </span>
        <span className="text-text-dim">
          out C {formatShare(handedOut(props.sessions, "claude"))} X {formatShare(handedOut(props.sessions, "codex"))}
        </span>
      </span>
      <span className="grid grid-cols-2 gap-2.5 pl-6">
        <Meter session={root} plan="claude" />
        <Meter session={root} plan="codex" />
      </span>
    </RowLink>
  );
}

function PlanCell({
  session,
  plan,
  width,
  suffix,
}: {
  session: SessionResponse;
  plan: Plan;
  width: string;
  suffix?: boolean;
}) {
  const { left } = planShares(session, plan);
  return (
    <span className={`flex shrink-0 flex-col gap-[3px] ${width}`} title={leftTitle(session, plan)}>
      <span className="flex font-mono text-[10px] text-text-secondary">
        <span>{LETTER[plan]}</span>
        <span className="flex-1" />
        <span>{suffix ? formatLeft(left) : formatPercent(left)}</span>
      </span>
      <Meter session={session} plan={plan} />
    </span>
  );
}

function WorkerRow({ session, depth, props }: { session: SessionResponse; depth: number; props: TreeProps }) {
  const plan = workerPlan(session);
  const { left, granted, over } = planShares(session, plan);
  return (
    <RowLink
      session={session}
      testId="owner-core-worker"
      depth={depth}
      props={props}
      className="min-h-[26px] gap-1.5 py-0.5 pr-2"
    >
      <span style={{ paddingLeft: 8 + depth * 14 }} className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={TAG}>worker</span>
        <Dot session={session} size="h-1.5 w-1.5" />
        <span className="truncate text-[12px] text-text-secondary">{session.title}</span>
      </span>
      <span
        className={`shrink-0 font-mono text-[10px] ${TONE_TEXT[meterTone(left, granted, over)]}`}
        title={leftTitle(session, plan)}
      >
        {LETTER[plan]} {formatLeft(left)}
      </span>
      <Meter session={session} plan={plan} className="w-10" />
    </RowLink>
  );
}

function ModuleRow({ module, props }: { module: SessionResponse; props: TreeProps }) {
  const [open, setOpen] = useState(false);
  const count = workerCount(props.sessions, module.id);
  return (
    <div>
      <div className="mr-2 flex items-center">
        <RowLink
          session={module}
          testId="owner-core-module"
          props={props}
          className="min-h-[30px] flex-1 gap-2 px-2 py-1"
        >
          <span className="shrink-0 text-[12px] text-brand-400" aria-hidden="true">
            ✦
          </span>
          <Dot session={module} size="h-[7px] w-[7px]" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary">{module.title}</span>
          <PlanCell session={module} plan="claude" width="w-[72px]" />
          <PlanCell session={module} plan="codex" width="w-[60px]" suffix />
        </RowLink>
        {count > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${count} ${count === 1 ? "worker" : "workers"}`}
            title={`${open ? "Hide" : "Show"} ${count} ${count === 1 ? "worker" : "workers"}`}
            className="ml-1 h-7 min-w-8 shrink-0 cursor-pointer rounded-md px-1 font-mono text-[10px] text-text-dim transition-colors hover:bg-surface-700/40 hover:text-text-secondary"
          >
            {open ? "▾" : "▸"} {count}
          </button>
        )}
      </div>
      {open && (
        <div className="mb-1 ml-[22px] mr-2 border-l border-dashed border-surface-600">
          {moduleWorkers(props.sessions, module.id).map((w) => (
            <WorkerRow key={w.session.id} session={w.session} depth={w.depth} props={props} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The root of an outside agent's tree and its modules, at the top of Favorites (docs/guides/session-owners.md). */
export function OwnerCoreTree(props: TreeProps) {
  const { root, modules } = props.core;
  return (
    <div data-testid="owner-core">
      <div className="flex items-center px-3 pb-1 font-mono text-[10px] text-text-dim">
        <span className="flex-1" />
        <span>left · % of weekly plan</span>
      </div>
      {root && <RootRow root={root} props={props} />}
      {modules.length > 0 && (
        <div className="ml-[22px] border-l border-surface-700 pl-0.5">
          {modules.map((m) => (
            <ModuleRow key={m.id} module={m} props={props} />
          ))}
        </div>
      )}
    </div>
  );
}
