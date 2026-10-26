// @vitest-environment jsdom
//
// Coverage for the WorkspaceSidebar Trash control (#2489, reworked in #2512):
// a workspace whose sessions are all trashed is reachable from a labeled Trash
// control in the sidebar footer next to Settings, which opens a wider panel
// with Open / Restore / Delete actions. Trash is no longer an inline scrolling
// section.
// Also asserts the Projects section renders below "Snoozed & archived" (#2512).
// Vitest (accurate per-file V8) rather than Playwright, whose bundle->source
// remap is lossy for this large file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FavoritesFirstContext } from "../../lib/sidebarFavorites";
import { WorkspaceSidebar } from "../WorkspaceSidebar";
import { buildSessionGroups } from "../../lib/sidebarGroups";
import type { SessionResponse, Workspace } from "../../lib/types";

function session(over: Partial<SessionResponse> = {}): SessionResponse {
  return {
    id: "s1",
    title: "t",
    project_path: "/repo-a",
    group_path: "",
    tool: "claude",
    status: "Stopped",
    yolo_mode: false,
    created_at: "2025-01-01T00:00:00Z",
    last_accessed_at: null,
    idle_entered_at: null,
    last_error: null,
    branch: null,
    main_repo_path: null,
    is_sandboxed: false,
    favorited: false,
    has_managed_worktree: false,
    has_terminal: true,
    profile: "default",
    cleanup_defaults: { delete_worktree: false, delete_branch: false, delete_sandbox: false },
    remote_owner: null,
    notify_on_waiting: null,
    notify_on_idle: null,
    notify_on_error: null,
    claude_fullscreen: false,
    workspace_repos: [],
    scratch: false,
    archived_at: null,
    snoozed_until: null,
    trashed_at: null,
    ...over,
  } as SessionResponse;
}

function workspace(id: string, sessions: SessionResponse[]): Workspace {
  return {
    id,
    branch: null,
    projectPath: "/repo-a",
    displayName: id,
    agents: ["claude"],
    primaryAgent: "claude",
    status: "idle",
    sessions,
  } as unknown as Workspace;
}

const noop = () => {};

function renderSidebar(over: Partial<React.ComponentProps<typeof WorkspaceSidebar>> = {}) {
  const props: React.ComponentProps<typeof WorkspaceSidebar> = {
    workspaces: over.groups?.flatMap((g) => g.workspaces.map((v) => v.workspace)) ?? [],
    groups: buildSessionGroups([], { idleDecayWindowMs: 60_000, sortMode: "lastActivity", isCollapsed: () => false }),
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

afterEach(cleanup);

describe("WorkspaceSidebar Trash control (#2489, #2512)", () => {
  // The Trash list is owned by the parent (App computes it from the full,
  // unsliced workspace set) and passed in as `trashedWorkspaces`; the sidebar
  // no longer derives it from `groups`. See #2533. Tests pass both: `groups`
  // so the workspace exists for navigation, `trashedWorkspaces` to populate
  // the footer popover.
  function trashedWorkspace(): Workspace {
    return workspace("trashed-ws", [session({ id: "s1", trashed_at: "2026-01-01T00:00:00Z" })]);
  }
  function trashedGroups() {
    return buildSessionGroups([trashedWorkspace()], {
      idleDecayWindowMs: 60_000,
      sortMode: "lastActivity",
      isCollapsed: () => false,
    });
  }
  function renderWithTrash(over: Partial<React.ComponentProps<typeof WorkspaceSidebar>> = {}) {
    return renderSidebar({ groups: trashedGroups(), trashedWorkspaces: [trashedWorkspace()], ...over });
  }

  it("reaches a trashed workspace via the footer Trash panel and exposes its actions", () => {
    const props = renderWithTrash();

    // No inline section in the scrolling list; only the footer toggle.
    expect(screen.queryByTestId("sidebar-trash-section")).toBeNull();
    expect(screen.getByTestId("sidebar-trash-toggle").textContent).toContain("Trash");
    // Closed by default: panel and rows hidden until the footer control is clicked.
    expect(screen.queryByTestId("sidebar-trash-menu")).toBeNull();
    expect(screen.queryByTestId("sidebar-trash-row")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    expect(screen.getByTestId("sidebar-trash-menu")).toBeTruthy();
    expect(screen.getByTestId("sidebar-trash-row")).toBeTruthy();
    expect(screen.getByTestId("sidebar-trash-open").textContent).toContain("Open");
    expect(screen.getByTestId("sidebar-trash-restore").textContent).toContain("Restore");
    expect(screen.getByTestId("sidebar-trash-purge").textContent).toContain("Delete");

    fireEvent.click(screen.getByTestId("sidebar-trash-open"));
    expect(props.onSelect).toHaveBeenCalledWith("trashed-ws");
    expect(screen.queryByTestId("sidebar-trash-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-trash-restore"));
    expect(props.onRestoreSession).toHaveBeenCalledWith(["s1"]);

    fireEvent.click(screen.getByTestId("sidebar-trash-purge"));
    expect(props.onDeleteSession).toHaveBeenCalledWith("trashed-ws");
  });

  it("orders the Trash rows newest-trashed first", () => {
    const older = workspace("older-ws", [session({ id: "o1", trashed_at: "2026-01-01T00:00:00Z" })]);
    const newer = workspace("newer-ws", [session({ id: "n1", trashed_at: "2026-06-01T00:00:00Z" })]);
    // Pass oldest-first to prove the panel re-sorts rather than echoing input order.
    renderSidebar({
      groups: buildSessionGroups([older, newer], {
        idleDecayWindowMs: 60_000,
        sortMode: "lastActivity",
        isCollapsed: () => false,
      }),
      trashedWorkspaces: [older, newer],
    });
    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    const rows = screen.getAllByTestId("sidebar-trash-row");
    expect(rows[0].textContent).toContain("newer-ws");
    expect(rows[1].textContent).toContain("older-ws");
  });

  it("renders the count badge next to the Trash icon, not against Settings (#2574)", () => {
    // The badge must sit right after the Trash icon at the left of the control.
    // A `flex-1` label that preceded the badge would shove the count to the
    // button's right edge, where it reads as belonging to the Settings gear.
    renderWithTrash();
    const toggle = screen.getByTestId("sidebar-trash-toggle");
    const badge = screen.getByTestId("sidebar-trash-count");
    expect(badge.textContent).toBe("1");
    // Badge is inside the Trash control, not the Settings button.
    expect(toggle.contains(badge)).toBe(true);
    // The "Trash" label follows the badge in DOM order; the badge is not the
    // right-most child pushed up against Settings.
    const label = Array.from(toggle.querySelectorAll("span")).find((s) => s.textContent === "Trash");
    expect(label).toBeTruthy();
    expect(badge.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes the Trash popover on Escape", () => {
    renderWithTrash();
    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    expect(screen.getByTestId("sidebar-trash-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("sidebar-trash-menu")).toBeNull();
  });

  it("closes the Trash popover on outside click", () => {
    renderWithTrash();
    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    expect(screen.getByTestId("sidebar-trash-menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("sidebar-trash-menu")).toBeNull();
  });

  it("keeps the Trash icon reachable while a filter hides every live row (#2512)", () => {
    // Trash is a global recovery affordance: an active filter that matches no
    // workspace must not strand trashed sessions by hiding the footer icon.
    renderWithTrash();
    fireEvent.click(screen.getByLabelText("Filter sessions"));
    fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "zzz-no-match" } });
    expect(screen.getByTestId("sidebar-trash-toggle").textContent).toContain("Trash");
    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    expect(screen.getByTestId("sidebar-trash-row")).toBeTruthy();
  });

  it("hides Restore/Delete and Empty Trash actions in read-only mode", () => {
    renderWithTrash({ readOnly: true });
    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    expect(screen.getByTestId("sidebar-trash-open")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-trash-restore")).toBeNull();
    expect(screen.queryByTestId("sidebar-trash-purge")).toBeNull();
    expect(screen.queryByTestId("sidebar-trash-empty")).toBeNull();
  });

  it("Empty Trash confirm counts trashed sessions, singular and plural (#3167)", () => {
    // Pluralization is pure count logic (session vs sessions), so a table
    // covers both in jsdom instead of a second Playwright render.
    const cases: Array<{ count: number; expected: string }> = [
      { count: 1, expected: "Permanently delete 1 trashed session? This cannot be undone." },
      { count: 2, expected: "Permanently delete 2 trashed sessions? This cannot be undone." },
    ];
    for (const { count, expected } of cases) {
      const sessions = Array.from({ length: count }, (_, i) =>
        session({ id: `count-${count}-${i}`, trashed_at: "2026-01-01T00:00:00Z" }),
      );
      const ws = workspace(`count-${count}-ws`, sessions);
      renderSidebar({
        groups: buildSessionGroups([ws], {
          idleDecayWindowMs: 60_000,
          sortMode: "lastActivity",
          isCollapsed: () => false,
        }),
        trashedWorkspaces: [ws],
        onEmptyTrash: vi.fn(),
      });
      fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
      fireEvent.click(screen.getByTestId("sidebar-trash-empty"));
      expect(screen.getByTestId("empty-trash-dialog").textContent, `count ${count}`).toContain(expected);
      cleanup();
    }
  });

  it("Empty Trash Cancel is inert and a single Confirm fires onEmptyTrash once (#3167)", () => {
    // One workspace with two trashed sessions exercises the count path; here the
    // focus is the confirm/cancel wiring, not the wording (covered above).
    const twoSession = workspace("multi-ws", [
      session({ id: "m1", trashed_at: "2026-01-01T00:00:00Z" }),
      session({ id: "m2", trashed_at: "2026-01-01T00:00:00Z" }),
    ]);
    const onEmptyTrash = vi.fn();
    renderSidebar({
      groups: buildSessionGroups([twoSession], {
        idleDecayWindowMs: 60_000,
        sortMode: "lastActivity",
        isCollapsed: () => false,
      }),
      trashedWorkspaces: [twoSession],
      onEmptyTrash,
    });

    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-trash-empty"));

    // Cancel closes the open dialog (proving it opened) without purging.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("empty-trash-dialog")).toBeNull();
    expect(onEmptyTrash).not.toHaveBeenCalled();

    // Reopen and confirm: a single confirm click invokes onEmptyTrash once
    // (not zero, not twice). Confirming here unmounts the dialog immediately, so
    // this asserts the single-fire happy path only; the synchronous firedRef
    // re-entry guard is exercised in isolation in EmptyTrashConfirm.test.tsx,
    // where onConfirm does not unmount so a second click can hit the guard.
    fireEvent.click(screen.getByTestId("sidebar-trash-empty"));
    fireEvent.click(screen.getByTestId("empty-trash-confirm"));
    expect(onEmptyTrash).toHaveBeenCalledTimes(1);
  });

  it("Escape on the Empty Trash confirm closes only the dialog, not the Trash panel (#3167)", () => {
    // The confirm portals to document.body, so before the fix the panel's own
    // document Escape listener also fired and closed the panel underneath.
    const ws = workspace("multi-ws", [session({ id: "m1", trashed_at: "2026-01-01T00:00:00Z" })]);
    renderSidebar({
      groups: buildSessionGroups([ws], {
        idleDecayWindowMs: 60_000,
        sortMode: "lastActivity",
        isCollapsed: () => false,
      }),
      trashedWorkspaces: [ws],
      onEmptyTrash: vi.fn(),
    });

    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-trash-empty"));
    expect(screen.getByTestId("empty-trash-dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    // The dialog closes, but the Trash panel stays open.
    expect(screen.queryByTestId("empty-trash-dialog")).toBeNull();
    expect(screen.getByTestId("sidebar-trash-menu")).toBeTruthy();
  });

  it("omits the Trash icon when nothing is trashed", () => {
    renderSidebar({
      groups: buildSessionGroups([workspace("live-ws", [session({ id: "live", status: "Running" })])], {
        idleDecayWindowMs: 60_000,
        sortMode: "lastActivity",
        isCollapsed: () => false,
      }),
    });
    expect(screen.queryByTestId("sidebar-trash-toggle")).toBeNull();
  });

  it("renders the Projects section below 'Snoozed & archived' (#2512)", () => {
    // An archived (sunk) workspace surfaces the sunk section; the Projects
    // section header always renders when CRUD is available. Assert DOM order.
    const archivedWs = workspace("archived-ws", [session({ id: "a1", archived_at: "2026-01-01T00:00:00Z" })]);
    renderSidebar({
      groups: buildSessionGroups([archivedWs], {
        idleDecayWindowMs: 60_000,
        sortMode: "lastActivity",
        isCollapsed: () => false,
      }),
    });
    const sunk = screen.getByTestId("sidebar-sunk-section");
    const projects = screen.getByTestId("sidebar-projects-section");
    expect(sunk.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("global favorites", () => {
  function models(collapsed = false) {
    const personal = workspace("personal", [
      session({ id: "controller", title: "Personal assistant", favorited: true, group_path: "Personal" }),
    ]);
    const project = workspace("project", [session({ id: "worker", title: "Project work", group_path: "Work" })]);
    const groups = buildSessionGroups([project, personal], {
      idleDecayWindowMs: 60_000,
      sortMode: "attention",
      isCollapsed: () => collapsed,
    });
    return { groups, personal, project };
  }

  it("keeps Personal assistant above projects across collapse, selection, priority and status changes", () => {
    const { groups } = models(true);
    const { rerender, ...props } = renderSidebar({ groups, axis: "repo", sortMode: "attention" });
    const favorites = screen.getByTestId("sidebar-favorites-section");
    const row = screen.getByTestId("sidebar-session-row");
    expect(favorites.contains(row)).toBe(true);
    expect(row.textContent).toContain("Personal assistant");
    fireEvent.click(row);
    expect(props.onSelect).toHaveBeenCalledWith("personal");
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
      renderSidebar({
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
    const { rerender, ...props } = renderSidebar({ groups });
    expect(screen.getByTestId("sidebar-favorites-section")).toBeTruthy();
    rerender(
      <FavoritesFirstContext.Provider value={false}>
        <WorkspaceSidebar {...props} />
      </FavoritesFirstContext.Provider>,
    );
    expect(screen.queryByTestId("sidebar-favorites-section")).toBeNull();
    expect(screen.getAllByTestId("sidebar-session-row")).toHaveLength(2);
    cleanup();
    renderSidebar({ groups });
    expect(screen.getByTestId("sidebar-favorites-section").textContent).toContain("Personal assistant");
  });

  it("keeps a pinned project header after its only row moves to Favorites", () => {
    const { groups } = models();
    const favoriteGroup = groups.find((g) => g.workspaces.some((v) => v.workspace.id === "personal"))!;
    renderSidebar({ groups: [{ ...favoriteGroup, kind: "repo", pinned: true }], axis: "repo" });
    expect(screen.getByTestId("sidebar-group-header")).toBeTruthy();
    expect(screen.getAllByTestId("sidebar-session-row")).toHaveLength(1);
  });

  it("reunites a favorite when the filter matches its nonfavorite group slice", () => {
    const { personal } = models();
    const split = {
      ...personal,
      sessions: [...personal.sessions, session({ id: "sibling", title: "Other session", group_path: "Other" })],
    };
    const groups = buildSessionGroups([split], {
      idleDecayWindowMs: 60_000,
      sortMode: "manual",
      isCollapsed: () => false,
    });
    renderSidebar({ groups, workspaces: [split] });
    fireEvent.click(screen.getByLabelText("Filter sessions"));
    fireEvent.change(screen.getByTestId("sidebar-filter-input"), { target: { value: "Other" } });
    expect(screen.getByTestId("sidebar-favorites-section").textContent).toContain("Personal assistant");
    expect(screen.getAllByTestId("sidebar-session-row")).toHaveLength(1);
  });

  it("selects a range from a favorite through the visible nested rows", () => {
    const { groups } = models(true);
    const visible = groups.map((g) => ({ ...g, collapsed: false }));
    renderSidebar({ groups, axis: "repo+group", nestedGroups: visible.map((g) => ({ repo: g, subgroups: [g] })) });
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
        session({
          id: `s-${i}`,
          title: `Favorite ${i}`,
          favorited: true,
          ...(field ? { [field]: "2026-01-01T00:00:00Z" } : {}),
        }),
      ]),
    );
    workspaces.push(workspace("aaa", [session({ id: "s-a", title: "First favorite", favorited: true })]));
    renderSidebar({
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
