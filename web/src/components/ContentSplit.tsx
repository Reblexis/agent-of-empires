import { useCallback, useEffect, useRef, useState } from "react";

import { safeGetItem, safeSetItem } from "../lib/safeStorage";

const SPLIT_STORAGE_KEY = "aoe-split-ratio";
const DEFAULT_DIFF_WIDTH = 380;
const MIN_TERMINAL_WIDTH = 400;
const MIN_DIFF_WIDTH = 280;
const HANDLE_WIDTH = 4;

interface Props {
  left: React.ReactNode;
  right: React.ReactNode;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Lay the right pane over the left one instead of beside it. Used for terminal sessions: a terminal whose width
   *  changes makes tmux re-wrap its history and the agent redraw on top of it, which leaves duplicated, broken lines
   *  in the scrollback. Overlaid, the terminal keeps its column count whatever the dock does. */
  overlay?: boolean;
}

function loadSavedWidth(): number {
  const saved = safeGetItem(SPLIT_STORAGE_KEY);
  if (saved) {
    const w = parseInt(saved, 10);
    if (w >= MIN_DIFF_WIDTH) return w;
  }
  return DEFAULT_DIFF_WIDTH;
}

export function ContentSplit({ left, right, collapsed, onToggleCollapse, overlay = false }: Props) {
  const [diffWidth, setDiffWidth] = useState(loadSavedWidth);
  // Publish the live width so the TopBar's right zone can size itself to match the panel column and extend the
  // divider up through the header, mirroring the sidebar.
  useEffect(() => {
    document.documentElement.style.setProperty("--aoe-right-panel-width", `${diffWidth}px`);
  }, [diffWidth]);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newDiffWidth = rect.right - e.clientX;
      const terminalWidth = rect.width - newDiffWidth;

      if (newDiffWidth >= MIN_DIFF_WIDTH && terminalWidth >= MIN_TERMINAL_WIDTH) {
        setDiffWidth(newDiffWidth);
      }
    };

    const handleMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist
      setDiffWidth((w) => {
        safeSetItem(SPLIT_STORAGE_KEY, String(w));
        return w;
      });
      // Trigger resize for terminal fit
      window.dispatchEvent(new Event("resize"));
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Re-fit terminal when collapsed state changes
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [collapsed]);

  // What the right pane hides of the left one. Children that pin controls to their right edge (the terminal's
  // Back-to-live button) read it so the control stays visible beside the dock.
  const covered = overlay && !collapsed ? diffWidth + HANDLE_WIDTH : 0;

  return (
    <div
      ref={containerRef}
      className="flex-1 flex min-h-0 overflow-hidden relative"
      data-content-split={overlay ? "overlay" : "inline"}
    >
      {/* Terminal pane */}
      <div
        className="flex-1 flex flex-col min-w-0 min-h-0"
        style={{ "--aoe-covered-right": `${covered}px` } as React.CSSProperties}
      >
        {left}
      </div>

      {!collapsed && (
        <>
          {/* Drag handle (desktop) */}
          <div
            data-testid="content-split-resize-handle"
            onMouseDown={handleMouseDown}
            onDoubleClick={onToggleCollapse}
            style={overlay ? { right: diffWidth } : undefined}
            className={`hidden md:block w-1 cursor-col-resize shrink-0 hover:bg-brand-600/50 transition-colors duration-75 ${
              overlay ? "absolute inset-y-0 z-30 bg-surface-700/40" : ""
            }`}
          />

          {/* Right pane: beside the left one, or over its right edge. */}
          <div
            style={{ width: diffWidth }}
            className={`flex shrink-0 flex-col min-h-0 overflow-hidden ${
              overlay ? "absolute inset-y-0 right-0 z-30 bg-surface-900 shadow-2xl" : ""
            }`}
          >
            {right}
          </div>
        </>
      )}
    </div>
  );
}
