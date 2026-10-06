// @vitest-environment jsdom
//
// Forecast band contract (docs/guides/session-forecast.md): pinned on the
// session view whenever the session has a card; first line is the verdict
// pill, headline, source link, decide-by and age; one line per metric
// (stopped -> continued with the signed difference, `?` for an unknown side);
// the note last. Collapsible, remembered per session; a card older than 24
// hours shows its age in a warning color. Refetches when the list summary's
// `updated_at` moves, so a second `set` shows without a reload.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ForecastBand, ForecastChip } from "../ForecastBand";
import * as api from "../../lib/api";
import type { ForecastCard, ForecastSummary } from "../../lib/types";

vi.mock("../../lib/api", () => ({
  getSessionForecast: vi.fn(),
}));

const getMock = vi.mocked(api.getSessionForecast);

const NOW = new Date("2026-10-06T12:00:00Z").getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function card(over: Partial<ForecastCard> = {}): ForecastCard {
  return {
    verdict: "continue",
    headline: "+150 EUR revenue",
    updated_at: minutesAgo(12),
    metrics: [
      {
        name: "Monthly revenue",
        date: "2026-11-01",
        stopped: 120,
        continued: 135.5,
        unit: "EUR",
        traders: 3,
        depth: 400,
      },
    ],
    note: "Next round: rewrite the pricing page.",
    source: { label: "Telarchy market", url: "https://telarchy.com/acme/proposals/12" },
    decide_by: "2026-10-06T18:00:00Z",
    ...over,
  };
}

function summaryOf(c: ForecastCard): ForecastSummary {
  return { verdict: c.verdict, headline: c.headline, updated_at: c.updated_at };
}

async function mount(c: ForecastCard, sessionId = "s1") {
  getMock.mockResolvedValue(c);
  const view = render(<ForecastBand sessionId={sessionId} summary={summaryOf(c)} />);
  await screen.findByTestId("forecast-band");
  // Wait for the full card (metric rows or the note) to land.
  await waitFor(() => expect(getMock).toHaveBeenCalledWith(sessionId));
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  getMock.mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ForecastBand", () => {
  it("renders nothing and fetches nothing when the session has no card", () => {
    const { container } = render(<ForecastBand sessionId="s1" summary={null} />);
    expect(container.innerHTML).toBe("");
    expect(getMock).not.toHaveBeenCalled();
  });

  it.each([
    ["continue", "status-running"],
    ["stop", "status-error"],
    ["unpriced", "text-dim"],
  ] as const)("shows the %s verdict as its own colored pill", async (verdict, colorToken) => {
    await mount(card({ verdict }));
    const pill = screen.getByTestId("forecast-verdict");
    expect(pill.textContent).toBe(verdict);
    expect(pill.getAttribute("data-verdict")).toBe(verdict);
    expect(pill.className).toContain(colorToken);
  });

  it("shows the first line: headline, source link, decide-by and age", async () => {
    await mount(card());
    expect(screen.getByText("+150 EUR revenue")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Telarchy market" });
    expect(link.getAttribute("href")).toBe("https://telarchy.com/acme/proposals/12");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("forecast-decide-by").textContent).toMatch(/^decide by /);
    expect(screen.getByTestId("forecast-age").textContent).toBe("as of 12 min ago");
  });

  it("shows each metric as stopped -> continued with the signed difference and its details", async () => {
    await mount(
      card({
        metrics: [
          {
            name: "Monthly revenue",
            date: "2026-11-01",
            stopped: 120,
            continued: 135.5,
            unit: "EUR",
            traders: 3,
            depth: 400,
          },
          { name: "Churned users", stopped: 50, continued: 30 },
          { name: "Flat", stopped: 7, continued: 7 },
        ],
      }),
    );
    const rows = await screen.findAllByTestId("forecast-metric");
    expect(rows).toHaveLength(3);
    const first = rows[0].textContent ?? "";
    expect(first).toContain("Monthly revenue");
    expect(first).toContain("2026-11-01");
    expect(first).toContain("120 → 135.5");
    expect(first).toContain("+15.5");
    expect(first).toContain("EUR");
    expect(first).toContain("3 traders");
    expect(first).toContain("depth 400");
    expect(rows[1].querySelector("[data-testid=forecast-diff]")?.textContent).toBe("-20");
    expect(rows[1].textContent).not.toContain("traders");
    expect(rows[1].textContent).not.toContain("depth");
    expect(rows[2].querySelector("[data-testid=forecast-diff]")?.textContent).toBe("0");
    expect(screen.getByText("Next round: rewrite the pricing page.")).toBeTruthy();
  });

  it("shows an unknown side as ? and computes no difference", async () => {
    await mount(
      card({
        metrics: [
          { name: "Signups", stopped: null, continued: 40 },
          { name: "Trials", stopped: 12 },
        ],
      }),
    );
    const rows = await screen.findAllByTestId("forecast-metric");
    expect(rows[0].textContent).toContain("? → 40");
    expect(rows[1].textContent).toContain("12 → ?");
    for (const row of rows) {
      expect(row.querySelector("[data-testid=forecast-diff]")).toBeNull();
    }
  });

  it("collapses to the first line and remembers it per session", async () => {
    const view = await mount(card(), "s1");
    await screen.findAllByTestId("forecast-metric");
    const toggle = screen.getByRole("button", { name: "Collapse forecast" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId("forecast-metric")).toHaveLength(0);
    expect(screen.queryByText("Next round: rewrite the pricing page.")).toBeNull();
    // The first line stays.
    expect(screen.getByTestId("forecast-verdict")).toBeTruthy();
    expect(screen.getByText("+150 EUR revenue")).toBeTruthy();
    view.unmount();

    // Same session again: still collapsed.
    await mount(card(), "s1");
    expect(screen.getByRole("button", { name: "Expand forecast" })).toBeTruthy();
    expect(screen.queryAllByTestId("forecast-metric")).toHaveLength(0);
    cleanup();

    // Another session is not affected.
    await mount(card(), "s2");
    expect(await screen.findAllByTestId("forecast-metric")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Collapse forecast" })).toBeTruthy();
  });

  it("still works when browser storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await mount(card());
    await screen.findAllByTestId("forecast-metric");
    fireEvent.click(screen.getByRole("button", { name: "Collapse forecast" }));
    expect(screen.queryAllByTestId("forecast-metric")).toHaveLength(0);
  });

  it("shows the age of a card older than 24 hours in a warning color", async () => {
    await mount(card({ updated_at: minutesAgo(25 * 60) }));
    const stale = screen.getByTestId("forecast-age");
    expect(stale.textContent).toBe("as of 1 d ago");
    expect(stale.getAttribute("data-stale")).toBe("true");
    expect(stale.className).toContain("text-status-warning");
    cleanup();

    await mount(card({ updated_at: minutesAgo(23 * 60) }));
    const fresh = screen.getByTestId("forecast-age");
    expect(fresh.getAttribute("data-stale")).toBeNull();
    expect(fresh.className).not.toContain("text-status-warning");
  });

  it("picks up a changed card when the summary moves, without a reload", async () => {
    const first = card();
    const { rerender } = await mount(first);
    expect(await screen.findByText(/120 → 135.5/)).toBeTruthy();

    const second = card({
      verdict: "stop",
      headline: "-20 EUR",
      updated_at: minutesAgo(1),
      metrics: [{ name: "Monthly revenue", stopped: 120, continued: 100 }],
      note: null,
    });
    getMock.mockResolvedValue(second);
    await act(async () => {
      rerender(<ForecastBand sessionId="s1" summary={summaryOf(second)} />);
    });
    expect(await screen.findByText(/120 → 100/)).toBeTruthy();
    expect(screen.getByTestId("forecast-verdict").textContent).toBe("stop");
    expect(screen.getByText("-20 EUR")).toBeTruthy();
    expect(screen.queryByText("Next round: rewrite the pricing page.")).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("keeps every line left-aligned", async () => {
    const { container } = await mount(card());
    await screen.findAllByTestId("forecast-metric");
    expect(container.querySelector(".text-center")).toBeNull();
    expect(screen.getByTestId("forecast-band").className).toContain("text-left");
  });

  it("never links a source that is not http or https", async () => {
    await mount(card({ source: { label: "Sneaky", url: "javascript:alert(1)" } }));
    expect(screen.queryByRole("link", { name: "Sneaky" })).toBeNull();
  });
});

describe("ForecastChip", () => {
  it("shows the verdict color and headline; hover names verdict, headline and age", () => {
    render(<ForecastChip summary={{ verdict: "stop", headline: "-20 EUR revenue", updated_at: minutesAgo(5) }} />);
    const chip = screen.getByTestId("sidebar-forecast-chip");
    expect(chip.textContent).toBe("-20 EUR revenue");
    expect(chip.getAttribute("data-verdict")).toBe("stop");
    expect(chip.className).toContain("status-error");
    expect(chip.className).toContain("truncate");
    expect(chip.getAttribute("title")).toBe("stop · -20 EUR revenue · as of 5 min ago");
  });
});
