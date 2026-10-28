// Built-in dockable panes; plugin panes come from the `pane` UI slot.

import {
  Bot,
  CalendarClock,
  FileDiff,
  FolderTree,
  Inbox,
  ScrollText,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

export type BuiltinPaneId = "diff" | "terminal" | "agents" | "files" | "context" | "timeline" | "inbox";

export type DockLocation = "right" | "bottom";

export interface PaneDescriptor {
  id: BuiltinPaneId;
  title: string;
  icon: LucideIcon;
  defaultDock: DockLocation;
}

export const BUILTIN_PANES: PaneDescriptor[] = [
  { id: "timeline", title: "Timeline", icon: CalendarClock, defaultDock: "right" },
  { id: "inbox", title: "Inbox", icon: Inbox, defaultDock: "right" },
  { id: "diff", title: "Diff", icon: FileDiff, defaultDock: "right" },
  { id: "files", title: "Files", icon: FolderTree, defaultDock: "right" },
  { id: "terminal", title: "Terminal", icon: SquareTerminal, defaultDock: "right" },
  { id: "agents", title: "Sub agents", icon: Bot, defaultDock: "right" },
  // Terminal sessions only: an agent-generated recap of the session so a
  // returning human re-orients without replaying the scrollback.
  { id: "context", title: "Context", icon: ScrollText, defaultDock: "right" },
];

// Terminals are the only multi-instance pane: tab `terminal:<n>` maps to tmux index n.
export const TERMINAL_KIND = "terminal";

// Strict, so a malformed id cannot alias a real tmux index.
const TERMINAL_TAB_ID_RE = /^terminal:(\d+)$/;

export function terminalTabId(index: number): string {
  return `terminal:${index}`;
}

export function isTerminalTabId(id: string): boolean {
  return TERMINAL_TAB_ID_RE.test(id);
}

/** 0 for anything malformed. */
export function terminalIndexOf(id: string): number {
  const m = TERMINAL_TAB_ID_RE.exec(id);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}
