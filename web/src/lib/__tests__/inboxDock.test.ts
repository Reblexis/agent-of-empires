// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { dockTabs, usePaneLayout } from "../paneLayout";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("inbox is in every session's dock without stealing focus, and a close is remembered", () => {
  const legacy = {
    right: [{ tabs: ["diff", "context", "timeline"], active: "diff" }],
    bottom: [],
    nextTerminalIndex: 1,
    closedPlugins: [],
    collapsed: { right: false, bottom: false },
  };
  localStorage.setItem(
    "aoe-pane-layout-v2",
    JSON.stringify({ version: 2, starterTabsRemoved: true, template: legacy, sessions: { a: legacy } }),
  );
  const first = renderHook(() => usePaneLayout("a"));
  expect(dockTabs(first.result.current.layout, "right")).toContain("inbox");
  expect(first.result.current.layout.right[0]!.active).toBe("diff");
  act(() => first.result.current.closeTab("inbox"));
  first.unmount();
  const second = renderHook(() => usePaneLayout("a"));
  expect(dockTabs(second.result.current.layout, "right")).not.toContain("inbox");
  act(() => second.result.current.toggleKind("inbox", "right"));
  expect(dockTabs(second.result.current.layout, "right")).toContain("inbox");
});
