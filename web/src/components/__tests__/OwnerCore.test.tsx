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
    progress: null,
    work: null,
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
      progress: 40,
      work: "w281392d8d5",
    }),
  ),
  ws("w1a", "Central: Nested helper", owner({ parent: "w1", module: "planner", left: { claude: null, codex: 0.02 } }), {
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
    expect(card.textContent).toContain("handed out Claude 10% · Codex 4%");
    const modules = within(favorites).getAllByTestId("owner-core-module");
    expect(modules.map((m) => m.getAttribute("data-session-id"))).toEqual(["planner", "router", "improver"]);
    // Outside the owner's budget: its title and nothing about budget.
    expect(modules[2].textContent).toBe("✦Improver");
    // Each plan named in full, what is left as text and no budget bar: the only bar on a row is its progress.
    expect(modules[0].textContent).toContain("Claude 5.76% · Codex 3% left");
    expect(within(modules[0]).queryByRole("progressbar")).toBeNull();
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

  it("keeps an owned session's children collapsed until its count is clicked, each level on its own", () => {
    window.localStorage.removeItem("aoe-owner-expanded");
    const props = renderSidebar(WORKSPACES);
    const workers = () =>
      screen
        .queryAllByTestId("owner-core-worker")
        .map((w) => [w.getAttribute("data-session-id"), w.getAttribute("data-depth")]);
    expect(workers()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "2 sessions below Planner" }));
    expect(workers()).toEqual([["w1", "0"]]);
    const w1 = screen.getByTestId("owner-core-worker");
    expect(w1.textContent).toContain("Claude 0.57% left");
    // A session with an end shows its progress bar.
    expect(w1.textContent).toContain("40%");
    expect(within(w1).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    fireEvent.click(screen.getByRole("button", { name: "1 session below Make aoe fast" }));
    expect(workers()).toEqual([
      ["w1", "0"],
      ["w1a", "1"],
    ]);
    const w1a = screen.getAllByTestId("owner-core-worker")[1];
    expect(w1a.textContent).toContain("Codex 2% left");
    // A worker's title loses the owner's own prefix too.
    expect(w1a.textContent).not.toContain("Central:");
    expect(within(w1a).queryByRole("progressbar")).toBeNull();

    fireEvent.click(w1a);
    expect(props.onSelect).toHaveBeenLastCalledWith("ws-w1a", "w1a");
    fireEvent.click(screen.getAllByTestId("owner-core-module")[1]);
    expect(props.onSelect).toHaveBeenLastCalledWith("ws-router", "router");

    // The choice lasts in this browser.
    cleanup();
    renderSidebar(WORKSPACES);
    expect(workers()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "2 sessions below Planner" }));
    expect(workers()).toEqual([]);
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
    expect(chip?.textContent).toContain("Claude 0.57% left");
    expect(chip?.getAttribute("title")).toContain("granted Claude 1%");
  });

  it("Active shows only the Central tree; repo groups and other favorites appear only under All", () => {
    const outside = [
      ws("busy", "Running repo session", null, { status: "Running" }),
      ws("fav", "Favorited session", null, { status: "Running", favorited: true }),
    ];
    const rowTexts = () => screen.queryAllByTestId("sidebar-session-row").map((r) => r.textContent ?? "");
    window.localStorage.setItem("aoe-web-settings", JSON.stringify({ sidebarActiveOnly: true }));
    renderSidebar([...WORKSPACES, ...outside]);
    expect(screen.getAllByTestId("owner-core-module")).toHaveLength(3);
    expect(rowTexts()).toEqual([]);
    expect(screen.queryByText("No active sessions")).toBeNull();

    cleanup();
    window.localStorage.setItem("aoe-web-settings", JSON.stringify({ sidebarActiveOnly: false }));
    renderSidebar([...WORKSPACES, ...outside]);
    expect(screen.getAllByTestId("owner-core-module")).toHaveLength(3);
    expect(rowTexts().some((t) => t.includes("Running repo session"))).toBe(true);
    expect(rowTexts().some((t) => t.includes("Favorited session"))).toBe(true);
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
