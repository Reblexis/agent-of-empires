// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FavoritesFirstContext } from "../../lib/sidebarFavorites";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { buildSessionGroups } from "../../lib/sidebarGroups";
import type { SessionResponse, Workspace } from "../../lib/types";
import { makeSession, makeWorkspace } from "./fixtures";

type Props = React.ComponentProps<typeof WorkspaceSidebar>;
const noop = () => {};
const TRASHED = "2026-01-01T00:00:00Z";

const workspace = (id: string, sessions: Partial<SessionResponse>[]) =>
  makeWorkspace(
    id,
    sessions.map((s) => makeSession({ title: "t", project_path: "/repo-a", group_path: "", status: "Stopped", ...s })),
    { projectPath: "/repo-a" },
  );
const trashed = (id: string, ...ids: string[]) =>
  workspace(
    id,
    ids.map((sid) => ({ id: sid, trashed_at: TRASHED })),
  );

/** `groups` holds the workspaces for navigation; the Trash list is passed separately, as App computes it. */
function renderSidebar(workspaces: Workspace[], over: Partial<Props> = {}) {
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
    onRestoreSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onEmptyTrash: vi.fn(),
    sortMode: "lastActivity",
    onSortModeChange: noop,
    pluginSortRef: null,
    onPluginSortChange: noop,
    axis: "group",
    onAxisChange: noop,
    ...over,
  };
  const rendered = render(<WorkspaceSidebar {...props} />);
  return { ...props, ...rendered };
}
const withTrash = (over: Partial<Props> = {}) => {
  const ws = trashed("trashed-ws", "s1");
  return renderSidebar([ws], { trashedWorkspaces: [ws], ...over });
};
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const query = (id: string) => screen.queryByTestId(id);
const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(cleanup);

describe("WorkspaceSidebar Trash control", () => {
  it("opens from the footer and exposes Open, Restore, and Delete", () => {
    const props = withTrash();
    expect(query("sidebar-trash-menu")).toBeNull();
    click("sidebar-trash-toggle");
    expect(query("sidebar-trash-row")).not.toBeNull();

    click("sidebar-trash-open");
    expect(props.onSelect).toHaveBeenCalledWith("trashed-ws", "s1");
    expect(query("sidebar-trash-menu")).toBeNull();

    click("sidebar-trash-toggle");
    click("sidebar-trash-restore");
    expect(props.onRestoreSession).toHaveBeenCalledWith(["s1"]);
    click("sidebar-trash-purge");
    expect(props.onDeleteSession).toHaveBeenCalledWith(["s1"]);
  });

  // #4116: right-clicking a trashed row offers the same actions as its buttons.
  it("right-click on a trashed row opens a menu with Open, Restore, and Delete permanently", () => {
    const props = withTrash();
    const openMenu = () => {
      click("sidebar-trash-toggle");
      fireEvent.contextMenu(screen.getByTestId("sidebar-trash-row"));
    };

    openMenu();
    expect(
      Array.from(screen.getByTestId("sidebar-trash-context-menu").querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["Open", "Restore", "Delete permanently"]);
    // A press inside the portaled menu must not dismiss the panel first.
    fireEvent.mouseDown(screen.getByTestId("sidebar-trash-context-menu-restore"));
    click("sidebar-trash-context-menu-restore");
    expect(props.onRestoreSession).toHaveBeenCalledWith(["s1"]);
    expect(query("sidebar-trash-context-menu")).toBeNull();
    expect(query("sidebar-trash-menu")).not.toBeNull();

    fireEvent.contextMenu(screen.getByTestId("sidebar-trash-row"));
    click("sidebar-trash-context-menu-delete");
    expect(props.onDeleteSession).toHaveBeenCalledWith(["s1"]);
    expect(query("sidebar-trash-menu")).toBeNull();

    openMenu();
    click("sidebar-trash-context-menu-open");
    expect(props.onSelect).toHaveBeenCalledWith("trashed-ws", "s1");
    expect(query("sidebar-trash-menu")).toBeNull();
  });

  it("a second right-click moves the menu to the other row", async () => {
    const a = trashed("a-ws", "a1");
    const b = trashed("b-ws", "b1");
    const props = renderSidebar([a, b], { trashedWorkspaces: [a, b] });
    click("sidebar-trash-toggle");
    const [first, second] = screen.getAllByTestId("sidebar-trash-row");
    fireEvent.contextMenu(first!);
    // The menu arms its document listeners on the next frame.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    fireEvent.contextMenu(second!);
    click("sidebar-trash-context-menu-restore");
    expect(props.onRestoreSession).toHaveBeenCalledTimes(1);
    expect(props.onRestoreSession).toHaveBeenCalledWith([second!.textContent?.startsWith("a-ws") ? "a1" : "b1"]);
  });

  it("offers only Open in the trashed-row menu when read-only", () => {
    withTrash({ readOnly: true });
    click("sidebar-trash-toggle");
    fireEvent.contextMenu(screen.getByTestId("sidebar-trash-row"));
    expect(screen.getByTestId("sidebar-trash-context-menu").textContent).toBe("Open");
  });

  it("orders rows newest-trashed first", () => {
    const older = workspace("older-ws", [{ id: "o1", trashed_at: TRASHED }]);
    const newer = workspace("newer-ws", [{ id: "n1", trashed_at: "2026-06-01T00:00:00Z" }]);
    renderSidebar([older, newer], { trashedWorkspaces: [older, newer] });
    click("sidebar-trash-toggle");
    expect(screen.getAllByTestId("sidebar-trash-row").map((r) => r.textContent?.slice(0, 8))).toEqual([
      "newer-ws",
      "older-ws",
    ]);
  });

  it("puts the count right after the Trash icon, not against Settings (#2574)", () => {
    withTrash();
    const toggle = screen.getByTestId("sidebar-trash-toggle");
    const badge = screen.getByTestId("sidebar-trash-count");
    expect(badge.textContent).toBe("1");
    expect(toggle.contains(badge)).toBe(true);
    const label = Array.from(toggle.querySelectorAll("span")).find((s) => s.textContent === "Trash")!;
    expect(follows(badge, label)).toBe(true);
  });

  it.each([
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["an outside click", () => fireEvent.mouseDown(document.body)],
  ])("closes on %s", (_n, dismiss) => {
    withTrash();
    click("sidebar-trash-toggle");
    dismiss();
    expect(query("sidebar-trash-menu")).toBeNull();
  });

  it("stays reachable while a filter hides every live row (#2512)", () => {
    withTrash();
    fireEvent.click(screen.getByLabelText("Filter sessions"));
    fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "zzz-no-match" } });
    click("sidebar-trash-toggle");
    expect(query("sidebar-trash-row")).not.toBeNull();
  });

  it("hides Restore, Delete, and Empty Trash when read-only", () => {
    withTrash({ readOnly: true });
    click("sidebar-trash-toggle");
    expect(query("sidebar-trash-open")).not.toBeNull();
    for (const id of ["restore", "purge", "empty"]) expect(query(`sidebar-trash-${id}`)).toBeNull();
  });

  it.each([
    [["c1"], "Permanently delete 1 trashed session? This cannot be undone."],
    [["c1", "c2"], "Permanently delete 2 trashed sessions? This cannot be undone."],
  ])("Empty Trash confirm counts sessions %j (#3167)", (ids, expected) => {
    const ws = trashed("multi-ws", ...ids);
    renderSidebar([ws], { trashedWorkspaces: [ws] });
    click("sidebar-trash-toggle");
    click("sidebar-trash-empty");
    expect(screen.getByTestId("empty-trash-dialog").textContent).toContain(expected);
  });

  it("Empty Trash: Cancel is inert, Escape keeps the panel open, one Confirm purges once", () => {
    const props = withTrash();
    click("sidebar-trash-toggle");
    click("sidebar-trash-empty");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(query("empty-trash-dialog")).toBeNull();

    // The confirm portals outside the panel, so Escape must not close the panel too.
    click("sidebar-trash-empty");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(query("empty-trash-dialog")).toBeNull();
    expect(query("sidebar-trash-menu")).not.toBeNull();
    expect(props.onEmptyTrash).not.toHaveBeenCalled();

    click("sidebar-trash-empty");
    click("empty-trash-confirm");
    expect(props.onEmptyTrash).toHaveBeenCalledTimes(1);
  });

  it("omits the control when nothing is trashed, and lists Projects below Snoozed & archived", () => {
    renderSidebar([workspace("archived-ws", [{ id: "a1", archived_at: TRASHED }])]);
    expect(query("sidebar-trash-toggle")).toBeNull();
    expect(follows(screen.getByTestId("sidebar-sunk-section"), screen.getByTestId("sidebar-projects-section"))).toBe(
      true,
    );
  });
});

describe("WorkspaceSidebar row actions on a group slice (#4019)", () => {
  it("stop, start, and delete target only the row's sessions, not the whole workspace", () => {
    const ws = workspace("multi-ws", [
      { id: "a1", title: "alpha", group_path: "alpha" },
      { id: "b1", title: "beta", group_path: "beta", status: "Running" },
      { id: "b2", title: "beta", group_path: "beta", status: "Running" },
    ]);
    const onStopSession = vi.fn();
    const onStartSession = vi.fn();
    const props = renderSidebar([ws], { onStopSession, onStartSession });
    const act = (title: string, item: string) => {
      fireEvent.contextMenu(screen.getAllByTestId("sidebar-session-row").find((r) => r.textContent?.includes(title))!);
      click(`sidebar-context-menu-${item}`);
    };

    // Two running siblings share the row, so Stop asks which one.
    act("beta", "stop");
    expect(onStopSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByTestId("sidebar-context-menu-stop-target")[1]!);
    expect(onStopSession).toHaveBeenCalledWith("b2");
    act("alpha", "start");
    expect(onStartSession).toHaveBeenCalledWith("a1");
    act("beta", "delete");
    expect(props.onDeleteSession).toHaveBeenCalledWith(["b1", "b2"]);
  });

  // #4116: an archived session must be unarchived before it can start.
  it("offers Unarchive but not Start on a stopped archived row", () => {
    renderSidebar([workspace("archived-ws", [{ id: "a1", archived_at: TRASHED }])], { onStartSession: vi.fn() });
    fireEvent.click(screen.getByTestId("sidebar-sunk-toggle"));
    fireEvent.contextMenu(screen.getByTestId("sidebar-session-row"));
    expect(query("sidebar-context-menu-start")).toBeNull();
    expect(screen.getByTestId("sidebar-context-menu-archive").textContent).toBe("Unarchive");
  });
});

function renderFavorites(over: Partial<Props>) {
  return renderSidebar(
    over.workspaces ?? over.groups?.flatMap((g) => g.workspaces.map((v) => v.workspace)) ?? [],
    over,
  );
}

describe("global favorites", () => {
  function models(collapsed = false) {
    const personal = workspace("personal", [
      makeSession({ id: "controller", title: "Personal assistant", favorited: true, group_path: "Personal" }),
    ]);
    const project = workspace("project", [makeSession({ id: "worker", title: "Project work", group_path: "Work" })]);
    const groups = buildSessionGroups([project, personal], {
      idleDecayWindowMs: 60_000,
      sortMode: "attention",
      isCollapsed: () => collapsed,
    });
    return { groups, personal, project };
  }

  it("keeps Personal assistant above projects across collapse, selection, priority and status changes", () => {
    const { groups } = models(true);
    const { rerender, ...props } = renderFavorites({ groups, axis: "repo", sortMode: "attention" });
    const favorites = screen.getByTestId("sidebar-favorites-section");
    const row = screen.getByTestId("sidebar-session-row");
    expect(favorites.contains(row)).toBe(true);
    expect(row.textContent).toContain("Personal assistant");
    fireEvent.click(row);
    expect(props.onSelect).toHaveBeenCalledWith("personal", "controller");
    const changed = groups.map((g) => ({
      ...g,
      collapsed: false,
      workspaces: g.workspaces.map((v) => ({
        ...v,
        workspace: {
          ...v.workspace,
          sessions: v.workspace.sessions.map((s) => ({ ...s, status: "Running" as const, priority: 0 })),
        },
      })),
    }));
    rerender(<WorkspaceSidebar {...props} activeId="project" groups={changed} />);
    expect(screen.getAllByTestId("sidebar-session-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Personal assistant"),
      expect.stringContaining("Project work"),
    ]);
    expect(
      screen
        .getByTestId("sidebar-favorites-section")
        .compareDocumentPosition(screen.getAllByTestId("sidebar-group-header")[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows each favorite once on every axis and applies original-group text filters", () => {
    for (const axis of ["repo", "group", "repo+group", "org"] as const) {
      const { groups } = models();
      renderFavorites({
        groups,
        axis,
        nestedGroups: groups.map((g) => ({ repo: g, subgroups: [g] })),
        orgGroups: [{ org: groups[0]!, repos: groups }],
      });
      expect(screen.getByTestId("sidebar-favorites-section").textContent).toContain("Personal assistant");
      expect(
        screen.getAllByTestId("sidebar-session-row").filter((r) => r.textContent?.includes("Personal assistant")),
      ).toHaveLength(1);
      fireEvent.click(screen.getByLabelText("Filter sessions"));
      fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "Personal" } });
      expect(screen.getByTestId("sidebar-favorites-section").textContent).toContain("Personal assistant");
      fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "zzz-no-match" } });
      expect(screen.queryByTestId("sidebar-favorites-section")).toBeNull();
      cleanup();
    }
  });

  it("restores group placement when favorites_first is disabled and survives remount", () => {
    const { groups } = models();
    const { rerender, ...props } = renderFavorites({ groups });
    expect(screen.getByTestId("sidebar-favorites-section")).toBeTruthy();
    rerender(
      <FavoritesFirstContext.Provider value={false}>
        <WorkspaceSidebar {...props} />
      </FavoritesFirstContext.Provider>,
    );
    expect(screen.queryByTestId("sidebar-favorites-section")).toBeNull();
    expect(screen.getAllByTestId("sidebar-session-row")).toHaveLength(2);
    cleanup();
    renderFavorites({ groups });
    expect(screen.getByTestId("sidebar-favorites-section").textContent).toContain("Personal assistant");
  });

  it("keeps a pinned project header after its only row moves to Favorites", () => {
    for (const axis of ["repo", "repo+group", "org"] as const) {
      const { groups } = models();
      const favoriteGroup = groups.find((g) => g.workspaces.some((v) => v.workspace.id === "personal"))!;
      const pinned = { ...favoriteGroup, kind: "repo" as const, pinned: true };
      renderFavorites({
        groups: [pinned],
        nestedGroups: [{ repo: pinned, subgroups: [{ ...favoriteGroup, pinned: false }] }],
        orgGroups: [{ org: { ...pinned, id: "org" }, repos: [pinned] }],
        axis,
      });
      expect(screen.getAllByTestId("sidebar-group-header").length).toBeGreaterThan(0);
      expect(screen.getAllByTestId("sidebar-session-row")).toHaveLength(1);
      cleanup();
    }
  });

  it("reunites a favorite when the filter matches its nonfavorite group slice", () => {
    const { personal } = models();
    const split = {
      ...personal,
      sessions: [...personal.sessions, makeSession({ id: "sibling", title: "Other session", group_path: "Other" })],
    };
    const groups = buildSessionGroups([split], {
      idleDecayWindowMs: 60_000,
      sortMode: "manual",
      isCollapsed: () => false,
    });
    renderFavorites({ groups, workspaces: [split] });
    fireEvent.click(screen.getByLabelText("Filter sessions"));
    fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "Other" } });
    expect(screen.getByTestId("sidebar-favorites-section").textContent).toContain("Personal assistant");
    expect(screen.getAllByTestId("sidebar-session-row")).toHaveLength(1);
  });

  it("selects a range from a favorite through the visible nested rows", () => {
    const { groups } = models(true);
    const visible = groups.map((g) => ({ ...g, collapsed: false }));
    renderFavorites({ groups, axis: "repo+group", nestedGroups: visible.map((g) => ({ repo: g, subgroups: [g] })) });
    const rows = screen.getAllByTestId("sidebar-session-row");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!, { ctrlKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    expect(rows.map((r) => r.getAttribute("data-selected"))).toEqual(["true", "true"]);
  });

  it("orders multiple favorites by identity and excludes every sink state", () => {
    const states = [null, "archived_at", "snoozed_until", "trashed_at"] as const;
    const workspaces = states.map((field, i) =>
      workspace(`fav-${i}`, [
        makeSession({
          id: `s-${i}`,
          title: `Favorite ${i}`,
          favorited: true,
          ...(field ? { [field]: "2026-01-01T00:00:00Z" } : {}),
        }),
      ]),
    );
    workspaces.push(workspace("aaa", [makeSession({ id: "s-a", title: "First favorite", favorited: true })]));
    renderFavorites({
      groups: buildSessionGroups(workspaces.reverse(), {
        idleDecayWindowMs: 60_000,
        sortMode: "attention",
        isCollapsed: () => false,
      }),
    });
    const favorites = screen.getByTestId("sidebar-favorites-section");
    expect(
      Array.from(favorites.querySelectorAll('[data-testid="sidebar-session-row"]')).map((r) => r.textContent),
    ).toEqual([expect.stringContaining("First favorite"), expect.stringContaining("Favorite 0")]);
  });
});
