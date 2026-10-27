// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { dockTabs, isActiveTab, usePaneLayout } from "../paneLayout";
import { useWebSettings } from "../../hooks/useWebSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const savedLayout = (active = "context") => ({
  right: [{ tabs: ["diff", "terminal:0", "context", "timeline"], active }],
  bottom: [{ tabs: ["terminal:2"], active: "terminal:2" }],
  nextTerminalIndex: 3,
  closedPlugins: [],
  collapsed: { right: false, bottom: true },
});

it("Diff and Terminal no longer clutter the default dock, but remain opt-in", () => {
  const { result } = renderHook(() => usePaneLayout("fresh"));
  expect(dockTabs(result.current.layout, "right")).toEqual(["context", "timeline"]);
  act(() => result.current.openTab("diff", "right"));
  act(() => result.current.toggleKind("terminal", "right"));
  expect(dockTabs(result.current.layout, "right")).toEqual(["context", "timeline", "diff", "terminal:0"]);
});

it("existing starter tabs disappear once, while additional terminals and reopened tabs survive reload", () => {
  const old = savedLayout();
  localStorage.setItem(
    "aoe-web-settings",
    JSON.stringify({ autoOpenDiffPane: true, autoOpenTerminalPane: true, desktopFontSize: 17 }),
  );
  localStorage.setItem(
    "aoe-pane-layout-v2",
    JSON.stringify({ version: 2, template: old, sessions: { a: old, b: old } }),
  );
  const first = renderHook(({ id }) => usePaneLayout(id), { initialProps: { id: "a" } });
  for (const id of ["a", "b"]) {
    first.rerender({ id });
    expect(dockTabs(first.result.current.layout, "right")).toEqual(["context", "timeline"]);
    expect(dockTabs(first.result.current.layout, "bottom")).toEqual(["terminal:2"]);
    expect(first.result.current.layout.collapsed.bottom).toBe(true);
    expect(first.result.current.layout.nextTerminalIndex).toBe(3);
  }
  act(() => first.result.current.openTab("diff", "right"));
  act(() => first.result.current.openTab("terminal:0", "right"));
  first.unmount();
  const second = renderHook(() => usePaneLayout("b"));
  expect(dockTabs(second.result.current.layout, "right")).toEqual(["context", "timeline", "diff", "terminal:0"]);
  second.unmount();
  const fresh = renderHook(() => usePaneLayout("new"));
  expect(dockTabs(fresh.result.current.layout, "right")).toEqual(["context", "timeline"]);
  expect(JSON.parse(localStorage.getItem("aoe-web-settings")!).desktopFontSize).toBe(17);
  fresh.unmount();
  // A stale server preference snapshot must not restore the old defaults on reload.
  localStorage.setItem("aoe-web-settings", JSON.stringify({ autoOpenDiffPane: true, autoOpenTerminalPane: true }));
  const restored = renderHook(() => usePaneLayout("another"));
  expect(dockTabs(restored.result.current.layout, "right")).toEqual(["context", "timeline"]);
  restored.unmount();
  const prefs = renderHook(() => useWebSettings());
  act(() => prefs.result.current.update({ autoOpenDiffPane: true, autoOpenTerminalPane: true }));
  expect(dockTabs(renderHook(() => usePaneLayout("opted-in")).result.current.layout, "right")).toEqual([
    "diff",
    "terminal:0",
    "context",
    "timeline",
  ]);
});

it("the current open tab persists across new and previously visited sessions and reload", () => {
  const { result, rerender, unmount } = renderHook(({ id }) => usePaneLayout(id), {
    initialProps: { id: "a" as string | null },
  });
  rerender({ id: "b" });
  act(() => result.current.activateTab("right", "timeline"));
  for (const id of [null, "a", "new", "b"]) {
    rerender({ id });
    if (id) expect(isActiveTab(result.current.layout, "timeline")).toBe(true);
    else expect(dockTabs(result.current.layout, "right")).toEqual([]);
  }
  unmount();
  const reloaded = renderHook(() => usePaneLayout("a"));
  expect(isActiveTab(reloaded.result.current.layout, "timeline")).toBe(true);
  act(() => reloaded.result.current.activateTab("right", "context"));
  reloaded.unmount();
  expect(isActiveTab(renderHook(() => usePaneLayout("b")).result.current.layout, "context")).toBe(true);
});

it("remembering a tab preserves per-session placement, collapse, close intent and terminal allocation", () => {
  const { result, rerender } = renderHook(({ id }) => usePaneLayout(id), { initialProps: { id: "a" } });
  act(() => result.current.moveTab("timeline", "bottom"));
  act(() => result.current.setDockCollapsed("bottom", true));
  act(() => result.current.addTerminal("right"));
  rerender({ id: "b" });
  expect(dockTabs(result.current.layout, "right")).not.toContain("terminal:1");
  act(() => result.current.activateTab("right", "timeline"));
  rerender({ id: "a" });
  expect(isActiveTab(result.current.layout, "timeline")).toBe(true);
  expect(result.current.layout.collapsed.bottom).toBe(true);
  expect(dockTabs(result.current.layout, "bottom")).toEqual(["timeline"]);
  act(() => result.current.closeTab("timeline"));
  rerender({ id: "b" });
  act(() => result.current.activateTab("right", "timeline"));
  rerender({ id: "a" });
  expect(dockTabs(result.current.layout, "bottom")).not.toContain("timeline");
  expect(isActiveTab(result.current.layout, "terminal:1")).toBe(true);
  act(() => result.current.addTerminal("right"));
  expect(dockTabs(result.current.layout, "right")).toContain("terminal:2");
});

it("auto-added plugins and invalid tab selections cannot replace the tab the user chose", () => {
  const { result, rerender } = renderHook(({ id }) => usePaneLayout(id), { initialProps: { id: "a" } });
  act(() => result.current.openTab("timeline", "right"));
  act(() => result.current.placeTab("context", { dock: "right", group: 0, index: 0 }));
  expect(isActiveTab(result.current.layout, "timeline")).toBe(true);
  act(() => result.current.syncPlugins([{ id: "plugin:p:test", defaultDock: "right" }]));
  act(() => result.current.activateTab("right", "missing"));
  rerender({ id: "b" });
  expect(isActiveTab(result.current.layout, "timeline")).toBe(true);
});
