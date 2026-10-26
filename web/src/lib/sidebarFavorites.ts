import { createContext } from "react";
import type { Workspace } from "./types";

export const FavoritesFirstContext = createContext(true);

export function parseFavoritesFirst(settings: Record<string, unknown> | null | undefined): boolean {
  const session = settings?.session;
  return !session || typeof session !== "object" || (session as Record<string, unknown>).favorites_first !== false;
}

/** Full workspace objects retain their original session order and route. */
export function collectSidebarFavorites(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces
    .filter((ws) =>
      ws.sessions.some((s) => s.favorited && s.archived_at == null && s.snoozed_until == null && s.trashed_at == null),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}
