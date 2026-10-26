// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { dockTabs, usePaneLayout } from "../paneLayout";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("timeline stays discoverable across sessions and reload without stealing focus", () => {
  const legacy = {
    right: [{ tabs: ["diff", "context"], active: "diff" }],
    bottom: [],
    nextTerminalIndex: 1,
    closedPlugins: [],
    collapsed: { right: true, bottom: false },
  };
  localStorage.setItem("aoe-pane-layout-v2", JSON.stringify({ version: 2, template: legacy, sessions: { a: legacy } }));
  const { result, rerender, unmount } = renderHook(({ id }) => usePaneLayout(id), { initialProps: { id: "a" } });
  expect(dockTabs(result.current.layout, "right")).toContain("timeline");
  expect(result.current.layout.right[0]!.active).toBe("diff");
  expect(result.current.layout.collapsed.right).toBe(true);
  act(() => result.current.openTab("timeline", "right"));
  rerender({ id: "b" });
  expect(dockTabs(result.current.layout, "right")).toContain("timeline");
  rerender({ id: "a" });
  expect(result.current.layout.right[0]!.active).toBe("timeline");
  act(() => result.current.moveTab("timeline", "bottom"));
  unmount();
  const second = renderHook(() => usePaneLayout("a"));
  expect(dockTabs(second.result.current.layout, "bottom")).toContain("timeline");
  act(() => second.result.current.closeTab("timeline"));
  second.unmount();
  const third = renderHook(() => usePaneLayout("a"));
  expect(dockTabs(third.result.current.layout, "right")).not.toContain("timeline");
  act(() => third.result.current.toggleKind("timeline", "right"));
  expect(dockTabs(third.result.current.layout, "right")).toContain("timeline");
});
