// @vitest-environment jsdom
//
// Presentational contract test for TopBar. TopBar is a pure prop-driven
// component (it pulls no data on its own), so this suite renders it
// directly with the prop permutations we care about and asserts the
// surface badges/buttons match. The full mounted topbar is exercised
// end-to-end in web/tests/top-bar.spec.ts; that suite covers menu
// interaction but cannot exercise the dev-build badge without mocking
// `/api/about`, which is what this Vitest file does instead.
//
// Part of #1055 (DEV build badge so concurrently-running debug/release
// instances on ports 8081 / 8080 are visually distinguishable).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TopBar } from "../TopBar";
import { createSession } from "../../lib/api";
import { requestOpenSession } from "../../lib/sessionRoute";

vi.mock("../../lib/api", () => ({ createSession: vi.fn() }));
vi.mock("../../lib/sessionRoute", () => ({ requestOpenSession: vi.fn() }));
import type { SessionResponse, Workspace } from "../../lib/types";

afterEach(() => {
  cleanup();
});

function renderTopBar(
  overrides: {
    isDevBuild?: boolean;
    isOffline?: boolean;
    activeWorkspace?: Workspace;
    activeSession?: SessionResponse | null;
    onOpenTips?: () => void;
  } = {},
) {
  return render(
    <TopBar
      activeWorkspace={overrides.activeWorkspace}
      activeSession={overrides.activeSession ?? null}
      onToggleSidebar={vi.fn()}
      onOpenPalette={vi.fn()}
      onToggleDiff={vi.fn()}
      paneIds={["diff", "terminal"]}
      paneDescriptor={(id) => ({ title: id, icon: (() => null) as never })}
      isPaneOpen={() => true}
      onTogglePane={vi.fn()}
      onOpenHelp={vi.fn()}
      onOpenAbout={vi.fn()}
      onStartTutorial={vi.fn()}
      onLogout={vi.fn()}
      loginRequired={false}
      isOffline={overrides.isOffline ?? false}
      isDevBuild={overrides.isDevBuild ?? false}
      onOpenTips={overrides.onOpenTips ?? vi.fn()}
      onGoDashboard={vi.fn()}
      sidebarColumnVisible={false}
      rightColumnVisible={false}
    />,
  );
}

describe("TopBar", () => {
  it("renders the DEV badge when isDevBuild=true", () => {
    const { getByLabelText, getByText } = renderTopBar({ isDevBuild: true });
    const badge = getByLabelText("Debug build");
    expect(badge).toBeTruthy();
    expect(getByText("DEV")).toBeTruthy();
  });

  it("does not render the DEV badge when isDevBuild=false", () => {
    const { queryByLabelText, queryByText } = renderTopBar({
      isDevBuild: false,
    });
    expect(queryByLabelText("Debug build")).toBeNull();
    expect(queryByText("DEV")).toBeNull();
  });

  it("does not render the workspace/repo breadcrumb even with an active workspace and session", () => {
    const workspace = {
      id: "ws-1",
      branch: null,
      projectPath: "/home/user/breadcrumb-repo",
      displayName: "breadcrumb-feature",
      agents: [],
      primaryAgent: "claude",
      status: "idle",
      sessions: [],
    } as unknown as Workspace;
    const { queryByText } = renderTopBar({
      activeWorkspace: workspace,
      activeSession: {} as SessionResponse,
    });
    // The old breadcrumb rendered the repo name (last path segment) and the
    // workspace display name; both must be gone now that #1456 removed it.
    expect(queryByText("breadcrumb-repo")).toBeNull();
    expect(queryByText("breadcrumb-feature")).toBeNull();
  });

  it("renders the offline badge independent of the DEV badge", () => {
    const { getByText, getByLabelText } = renderTopBar({
      isDevBuild: true,
      isOffline: true,
    });
    expect(getByText("offline")).toBeTruthy();
    expect(getByLabelText("Debug build")).toBeTruthy();
  });

  // The handoff button is the one-click "continue this session in the other
  // agent" control: visible only when the server says a handoff is possible,
  // and it creates a session of that agent seeded from this one, then opens it.
  it("offers the handoff button only when the server lists a target", () => {
    const workspace = { id: "w1", name: "W" } as unknown as Workspace;
    const base = {
      id: "s1",
      project_path: "/src/demo",
      group_path: "demo",
      tool: "claude",
    } as unknown as SessionResponse;

    const withoutTarget = renderTopBar({
      activeWorkspace: workspace,
      activeSession: base,
    });
    expect(withoutTarget.queryByTestId("topbar-handoff")).toBeNull();
    cleanup();

    const { getByTestId } = renderTopBar({
      activeWorkspace: workspace,
      activeSession: { ...base, handoff_targets: ["codex"] } as SessionResponse,
    });
    expect(getByTestId("topbar-handoff").getAttribute("aria-label")).toBe("Continue in codex");
  });

  it("hands the session over to the named agent and opens the new one", async () => {
    vi.mocked(createSession).mockResolvedValue({ ok: true, session: { id: "s2" } as SessionResponse });
    const { getByTestId } = renderTopBar({
      activeWorkspace: { id: "w1", name: "W" } as unknown as Workspace,
      activeSession: {
        id: "s1",
        project_path: "/src/demo",
        group_path: "demo",
        tool: "claude",
        handoff_targets: ["codex"],
      } as unknown as SessionResponse,
    });
    fireEvent.click(getByTestId("topbar-handoff"));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(vi.mocked(createSession).mock.calls[0][0]).toMatchObject({
      path: "/src/demo",
      tool: "codex",
      view: "terminal",
      handoff_from_session: "s1",
    });
    await vi.waitFor(() => expect(requestOpenSession).toHaveBeenCalledWith("s2"));
  });

  it("exposes a Tips entry in the overflow menu that fires onOpenTips", () => {
    const onOpenTips = vi.fn();
    const { getByRole } = renderTopBar({ onOpenTips });
    fireEvent.click(getByRole("button", { name: "More options" }));
    fireEvent.click(getByRole("menuitem", { name: "Tips" }));
    expect(onOpenTips).toHaveBeenCalledTimes(1);
  });
});
