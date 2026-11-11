// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { BudgetFrame } from "../OwnerBudget";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { buildSessionGroups } from "../../lib/sidebarGroups";
import type { SessionOwner, SessionResponse, Workspace } from "../../lib/types";
import { makeSession, makeWorkspace } from "./fixtures";

type Props = React.ComponentProps<typeof WorkspaceSidebar>;
const noop = () => {};

function owner(o: Partial<SessionOwner>): SessionOwner {
  return {
    owner: "central",
    parent: null,
    role: "worker",
    module: null,
    budgeted: true,
    granted: { claude: null, codex: null },
    left: { claude: null, codex: null },
    over: false,
    transactions: [],
    ...o,
  };
}

const ws = (id: string, title: string, o: SessionOwner | null, over: Partial<SessionResponse> = {}): Workspace =>
  makeWorkspace(
    `ws-${id}`,
    [makeSession({ id, title, project_path: "/repo-a", group_path: "", status: "Idle", owner: o, ...over })],
    { projectPath: "/repo-a", displayName: title },
  );

const WORKSPACES = [
  ws("router", "Central: Router", owner({ role: "module", granted: { claude: 0.02, codex: 0.01 } })),
  ws(
    "planner",
    "Central: Planner",
    owner({
      role: "module",
      granted: { claude: 0.08, codex: 0.03 },
      left: { claude: 0.0576, codex: 0.03 },
    }),
  ),
  ws(
    "w1",
    "Make aoe fast",
    owner({
      parent: "planner",
      module: "planner",
      granted: { claude: 0.01, codex: null },
      left: { claude: 0.0057, codex: null },
    }),
  ),
  ws("w1a", "Nested helper", owner({ parent: "w1", module: "planner", left: { claude: null, codex: 0.02 } }), {
    tool: "codex",
  }),
  ws("improver", "Central: Improver", owner({ role: "module", budgeted: false })),
  ws("plain", "Plain session", null),
];

function renderSidebar(workspaces: Workspace[]) {
  const props: Props = {
    workspaces,
    groups: buildSessionGroups(workspaces, {
      idleDecayWindowMs: 60_000,
      sortMode: "lastActivity",
      isCollapsed: () => false,
    }),
    nestedGroups: [],
    orgGroups: [],
    onToggleSubgroup: noop,
    onToggleOrg: noop,
    onToggleOrgRepo: noop,
    onReorderWorkspaces: noop,
    onReorderGroups: noop,
    activeId: null,
    open: true,
    onToggle: noop,
    onSelect: vi.fn(),
    onToggleGroup: noop,
    onUpdateRepoAppearance: noop,
    onNew: noop,
    onCreateSession: noop,
    savedProjects: [],
    onAddProject: noop,
    onEditProject: noop,
    onRemoveProject: noop,
    onSettings: noop,
    sortMode: "lastActivity",
    onSortModeChange: noop,
    pluginSortRef: null,
    onPluginSortChange: noop,
    axis: "group",
    onAxisChange: noop,
  };
  render(<WorkspaceSidebar {...props} />);
  return props;
}

afterEach(cleanup);

describe("owner core in favorites", () => {
  it("shows the modules at the top of Favorites with no favorited workspace", () => {
    renderSidebar(WORKSPACES);
    const favorites = screen.getByTestId("sidebar-favorites-section");
    // The owner is the root and no session: a card named after it, with what it handed out.
    const card = within(favorites).getByTestId("owner-core-card");
    expect(card.textContent).toContain("central");
    expect(card.textContent).toContain("5 sessions");
    expect(card.textContent).toContain("out C 10% X 4%");
    const modules = within(favorites).getAllByTestId("owner-core-module");
    expect(modules.map((m) => m.getAttribute("data-session-id"))).toEqual(["planner", "router", "improver"]);
    // Outside the owner's budget: its title and nothing about budget.
    expect(modules[2].textContent).toBe("✦Improver");
    expect(modules[0].textContent).toContain("C5.76%");
    expect(modules[0].textContent).toContain("X3% left");
    // Module rows name the module without the owner prefix.
    expect(modules[0].textContent).toContain("Planner");
    expect(modules[0].textContent).not.toContain("Central:");
    // A core session shows once, in the tree: not as a favorited workspace, not in its group.
    expect(within(favorites).queryAllByTestId("sidebar-session-row")).toHaveLength(0);
    const rows = screen.queryAllByTestId("sidebar-session-row").map((r) => r.textContent ?? "");
    expect(rows.filter((t) => t.includes("Central:"))).toEqual([]);
  });

  it("shows a core session once even when the person favorited it", () => {
    renderSidebar(WORKSPACES.map((ws) => ({ ...ws, sessions: ws.sessions.map((s) => ({ ...s, favorited: true })) })));
    const favorites = screen.getByTestId("sidebar-favorites-section");
    const rows = within(favorites)
      .queryAllByTestId("sidebar-session-row")
      .map((r) => r.textContent ?? "");
    expect(rows.filter((t) => t.includes("Central:"))).toEqual([]);
    expect(within(favorites).getAllByTestId("owner-core-module")).toHaveLength(3);
  });

  it("opens a module's workers nested by parent, and a click on any core row selects that session", () => {
    const props = renderSidebar(WORKSPACES);
    // Open by default: a module's children show nested under it.
    const workers = screen.getAllByTestId("owner-core-worker");
    expect(workers.map((w) => [w.getAttribute("data-session-id"), w.getAttribute("data-depth")])).toEqual([
      ["w1", "0"],
      ["w1a", "1"],
    ]);
    expect(workers[0].textContent).toContain("C 0.57% left");
    expect(workers[1].textContent).toContain("X 2% left");

    fireEvent.click(workers[1]);
    expect(props.onSelect).toHaveBeenLastCalledWith("ws-w1a", "w1a");
    fireEvent.click(screen.getAllByTestId("owner-core-module")[1]);
    expect(props.onSelect).toHaveBeenLastCalledWith("ws-router", "router");
    fireEvent.click(screen.getByRole("button", { name: /2 workers/ }));
    expect(screen.queryAllByTestId("owner-core-worker")).toHaveLength(0);
  });

  it("shows a worker once, in the tree; while a filter hides the tree its own row carries the worker tag", () => {
    // Its row sits in its group, which the default Active view hides while idle.
    window.localStorage.setItem("aoe-web-settings", JSON.stringify({ sidebarActiveOnly: false }));
    renderSidebar(WORKSPACES);
    const rowTexts = () => screen.queryAllByTestId("sidebar-session-row").map((r) => r.textContent ?? "");
    expect(rowTexts().filter((t) => t.includes("Make aoe fast"))).toEqual([]);
    fireEvent.click(screen.getByLabelText("Filter sessions"));
    fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "aoe fast" } });
    const chips = screen.getAllByTestId("sidebar-worker-chip");
    const chip = chips.find((c) =>
      c.closest("[data-testid=sidebar-session-row]")?.textContent?.includes("Make aoe fast"),
    );
    expect(chip?.textContent).toContain("worker · Planner");
    expect(chip?.textContent).toContain("C 0.57% left");
    expect(chip?.getAttribute("title")).toContain("of 1% granted");
  });

  it("shows no Favorites section when nothing is owned or favorited", () => {
    renderSidebar([ws("plain", "Plain session", null)]);
    expect(screen.queryByTestId("sidebar-favorites-section")).toBeNull();
  });
});

describe("module budget tab", () => {
  const sessions = WORKSPACES.flatMap((w) => w.sessions);
  const planner = sessions.find((s) => s.id === "planner")!;
  const module = {
    ...planner,
    owner: {
      ...planner.owner!,
      transactions: [
        {
          at: "2026-11-10T19:00:00Z",
          from: "planner",
          to: "w1",
          claude: 0.005,
          codex: null,
          kind: "cut",
          by: "central",
        },
        {
          at: "2026-11-10T18:00:00Z",
          from: "central",
          to: "planner",
          claude: 0.08,
          codex: 0.03,
          kind: "default",
          by: "central",
        },
      ],
    },
  } as SessionResponse;
  const all = sessions.map((s) => (s.id === "planner" ? module : s));

  it("gives a module a Budget tab with per-plan grants, its children and its transfers; a worker gets none", () => {
    const { rerender } = render(
      <BudgetFrame session={module} sessions={all}>
        <div data-testid="terminal" />
      </BudgetFrame>,
    );
    expect(screen.queryByTestId("owner-budget")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Budget" }));
    const plans = screen.getAllByTestId("owner-budget-plan");
    expect(plans[0].textContent).toContain("granted 8% of the weekly plan");
    expect(plans[0].textContent).toContain("5.76%left");
    expect(plans[0].textContent).toContain("handed out 1%");
    expect(screen.getAllByTestId("owner-budget-child").map((r) => r.textContent)).toEqual(["Make aoe fast0.57%?1%?1"]);
    const transfers = screen.getAllByTestId("owner-budget-transfer").map((r) => r.textContent);
    expect(transfers[0]).toContain("cutCentral: Planner → Make aoe fast by centralC -0.5%");
    expect(transfers[1]).toContain("central → Central: Planner");
    // The terminal stays mounted under the Budget tab.
    expect(screen.getByTestId("terminal")).toBeTruthy();

    rerender(
      <BudgetFrame session={sessions.find((s) => s.id === "w1")} sessions={all}>
        <div data-testid="terminal" />
      </BudgetFrame>,
    );
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByTestId("owner-budget")).toBeNull();
  });
});
