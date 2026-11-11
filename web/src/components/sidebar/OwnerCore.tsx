import { useContext, useState, type MouseEvent } from "react";
import type { SessionResponse } from "../../lib/types";
import {
  budgetTitle,
  childrenOf,
  formatPercent,
  formatProgress,
  leftParts,
  moduleShortName,
  ownerHandedOut,
  OwnedSessionsContext,
  sessionsBelow,
  workerTag,
  type MeterTone,
} from "../../lib/sessionOwners";
import { getStatusDotClass } from "../../lib/session";
import { sessionRowChromeClass } from "../../lib/sessionRowChrome";
import { safeGetItem, safeSetItem } from "../../lib/safeStorage";
import type { RowActivate } from "./types";

// What is left is tinted by how much is left (enough, low, spent), so it uses fixed palette colors (DESIGN.md).
const TONE_TEXT: Record<MeterTone, string> = { teal: "text-teal-300", amber: "text-amber-300", red: "text-red-300" };
const TAG = "inline-flex shrink-0 items-center rounded border border-teal-700 px-1 font-mono text-[9px] text-teal-300";
const EXPANDED_KEY = "aoe-owner-expanded";

/** `Claude 5.76% · Codex 3% left`: what is left, each plan named in full, as text and never as a bar. */
function LeftText({ session }: { session: SessionResponse }) {
  if (session.owner?.budgeted === false) return null;
  const parts = leftParts(session);
  return (
    <span className="shrink-0 font-mono text-[10px] text-text-dim" title={budgetTitle(session)}>
      {parts.map((p, i) => (
        <span key={p.plan}>
          {i > 0 && " · "}
          {p.plan} <span className={TONE_TEXT[p.tone]}>{p.text}</span>
        </span>
      ))}{" "}
      left
    </span>
  );
}

/** The session's progress bar and percent; nothing for a session without an end or an estimate. */
function Progress({ session }: { session: SessionResponse }) {
  const p = session.owner?.progress;
  if (p == null) return null;
  return (
    <span
      role="progressbar"
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="progress"
      className="flex shrink-0 items-center gap-1"
    >
      <span className="h-[3px] w-10 rounded-sm bg-surface-700" aria-hidden="true">
        <span className="block h-full rounded-sm bg-brand-500" style={{ width: `${p}%` }} />
      </span>
      <span className="font-mono text-[10px] text-text-secondary">{formatProgress(p)}</span>
    </span>
  );
}

/** `worker · <module>` and what is left of the worker's plan, on the worker's own row elsewhere in the sidebar. */
export function WorkerChip({ session }: { session: SessionResponse }) {
  const byId = useContext(OwnedSessionsContext);
  const tag = workerTag(session, byId);
  if (!tag) return null;
  const budgeted = session.owner?.budgeted !== false;
  return (
    <span
      data-testid="sidebar-worker-chip"
      title={budgeted ? `${tag}; ${budgetTitle(session)}` : tag}
      className="inline-flex shrink-0 items-center gap-1"
    >
      <span className={TAG}>{tag}</span>
      <LeftText session={session} />
    </span>
  );
}

interface TreeProps {
  modules: readonly SessionResponse[];
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

function Toggle({ session, props, x }: { session: SessionResponse; props: TreeProps; x: Expansion }) {
  const count = sessionsBelow(props.sessions, session.id).length;
  const open = x.expanded.has(session.id);
  if (count === 0) return null;
  const name = moduleShortName(session.title, session.owner?.owner ?? "");
  return (
    <button
      type="button"
      onClick={() => x.onToggle(session.id)}
      aria-expanded={open}
      aria-label={`${count} ${count === 1 ? "session" : "sessions"} below ${name}`}
      title={`${open ? "Hide" : "Show"} the ${count} ${count === 1 ? "session" : "sessions"} below`}
      className="ml-1 h-6 min-w-8 shrink-0 cursor-pointer rounded-md px-1 font-mono text-[10px] text-text-dim transition-colors hover:bg-surface-700/40 hover:text-text-secondary"
    >
      {open ? "▾" : "▸"} {count}
    </button>
  );
}

interface Expansion {
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

function WorkerRow({
  session,
  depth,
  props,
  x,
}: {
  session: SessionResponse;
  depth: number;
  props: TreeProps;
  x: Expansion;
}) {
  const open = x.expanded.has(session.id);
  return (
    <>
      <div className="flex items-center">
        <RowLink
          session={session}
          testId="owner-core-worker"
          depth={depth}
          props={props}
          className="min-h-[26px] flex-1 gap-1.5 py-0.5 pr-2"
        >
          <span style={{ paddingLeft: 8 + depth * 14 }} className="flex min-w-0 flex-1 items-center gap-1.5">
            <Dot session={session} size="h-1.5 w-1.5" />
            <span className="truncate text-[12px] text-text-secondary">
              {moduleShortName(session.title, session.owner?.owner ?? "")}
            </span>
          </span>
          <Progress session={session} />
          <LeftText session={session} />
        </RowLink>
        <Toggle session={session} props={props} x={x} />
      </div>
      {open &&
        childrenOf(props.sessions, session.id).map((c) => (
          <WorkerRow key={c.id} session={c} depth={depth + 1} props={props} x={x} />
        ))}
    </>
  );
}

function ModuleRow({ module, props, x }: { module: SessionResponse; props: TreeProps; x: Expansion }) {
  const open = x.expanded.has(module.id);
  const budgeted = module.owner?.budgeted !== false;
  return (
    <div>
      <div className="mr-2 flex items-center">
        <RowLink
          session={module}
          testId="owner-core-module"
          props={props}
          className="min-h-[30px] flex-1 flex-wrap gap-x-2 gap-y-1 px-2 py-1"
        >
          <span className="shrink-0 text-[12px] text-brand-400" aria-hidden="true">
            ✦
          </span>
          <Dot session={module} size="h-[7px] w-[7px]" />
          {/* The owner prefix repeats on every module, so the narrow sidebar shows the module's own name. */}
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary">
            {moduleShortName(module.title, module.owner?.owner ?? "")}
          </span>
          {(budgeted || module.owner?.progress != null) && (
            <span className="flex basis-full items-center gap-3 pl-5">
              <Progress session={module} />
              <LeftText session={module} />
            </span>
          )}
        </RowLink>
        <Toggle session={module} props={props} x={x} />
      </div>
      {open && (
        <div className="mb-1 ml-[22px] mr-2 border-l border-dashed border-surface-600">
          {childrenOf(props.sessions, module.id).map((c) => (
            <WorkerRow key={c.id} session={c} depth={0} props={props} x={x} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The owner, the tree's root and no session, as a card at the top of Favorites. */
function OwnerCard({ modules, total }: { modules: readonly SessionResponse[]; total: number }) {
  const owner = modules[0]?.owner?.owner ?? "";
  return (
    <div
      data-testid="owner-core-card"
      className="mx-2 my-0.5 flex flex-col gap-1 rounded-md border border-brand-700 bg-surface-700/40 px-2 py-2"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-brand-400" aria-hidden="true">
          ✦
        </span>
        <span className="truncate font-mono text-[13px] font-medium capitalize text-text-primary">{owner}</span>
        <span className="flex-1" />
        <span className="shrink-0 font-mono text-[10px] text-text-dim">{total} sessions</span>
      </span>
      <span className="pl-6 font-mono text-[11px] text-text-dim">
        handed out Claude {formatPercent(ownerHandedOut(modules, "claude"))} · Codex{" "}
        {formatPercent(ownerHandedOut(modules, "codex"))}
      </span>
    </div>
  );
}

function readExpanded(): Set<string> {
  try {
    const raw: unknown = JSON.parse(safeGetItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** An outside agent's tree at the top of Favorites: the owner's card, its modules, every session below them,
 *  each collapsed until expanded (docs/guides/session-owners.md). */
export function OwnerCoreTree(props: TreeProps) {
  const { modules } = props;
  const [expanded, setExpanded] = useState(readExpanded);
  const onToggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      // Storage may be off; the choice then lasts until the page reloads.
      safeSetItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  const x = { expanded, onToggle };
  const total = modules.reduce((n, m) => n + 1 + sessionsBelow(props.sessions, m.id).length, 0);
  return (
    <div data-testid="owner-core">
      <OwnerCard modules={modules} total={total} />
      <div className="ml-[22px] border-l border-surface-700 pl-0.5">
        {modules.map((m) => (
          <ModuleRow key={m.id} module={m} props={props} x={x} />
        ))}
      </div>
    </div>
  );
}
