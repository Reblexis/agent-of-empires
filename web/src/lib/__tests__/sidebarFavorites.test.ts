import { describe, expect, it } from "vitest";
import { collectSidebarFavorites, parseFavoritesFirst } from "../sidebarFavorites";
import type { Workspace, SessionResponse } from "../types";

describe("sidebar favorites", () => {
  it("only an explicit false disables global favorites", () => {
    for (const settings of [
      undefined,
      null,
      {},
      { session: null },
      { session: "bad" },
      { session: { favorites_first: "false" } },
      { session: { favorites_first: true } },
    ]) {
      expect(parseFavoritesFirst(settings)).toBe(true);
    }
    expect(parseFavoritesFirst({ session: { favorites_first: false } })).toBe(false);
  });

  it("preserves the original workspace objects, session order and input order", () => {
    const session = (id: string, favorited: boolean) => ({ id, favorited }) as SessionResponse;
    const one = { id: "b", sessions: [session("a", false), session("b", true)] } as Workspace;
    const two = { id: "a", sessions: [session("c", true)] } as Workspace;
    const source = [one, two];
    expect(collectSidebarFavorites(source)).toEqual([two, one]);
    expect(collectSidebarFavorites(source)[1]).toBe(one);
    expect(source).toEqual([one, two]);
    expect(one.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(collectSidebarFavorites([])).toEqual([]);
    expect(collectSidebarFavorites([{ ...one, sessions: [] }])).toEqual([]);
  });
});
