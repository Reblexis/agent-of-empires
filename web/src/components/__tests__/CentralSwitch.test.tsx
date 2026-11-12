// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CentralSwitch } from "../CentralSwitch";

function serve(initial: string, post: (state: string) => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return post(JSON.parse(String(init.body)).state);
    return new Response(JSON.stringify({ state: initial }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CentralSwitch", () => {
  it("shows whether central is paused and resumes it in one click", async () => {
    const fetchMock = serve("paused", (s) => new Response(JSON.stringify({ state: s })));
    render(<CentralSwitch />);
    expect((await screen.findByRole("button", { name: "central paused" })).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "central running" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "central running" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/central", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the state and shows the hook's failure when the switch fails", async () => {
    serve(
      "paused",
      () => new Response(JSON.stringify({ error: "central hook for running failed: boom" }), { status: 500 }),
    );
    render(<CentralSwitch />);
    fireEvent.click(await screen.findByRole("button", { name: "central running" }));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.getByRole("button", { name: "central paused" }).getAttribute("aria-pressed")).toBe("true");
  });
});
