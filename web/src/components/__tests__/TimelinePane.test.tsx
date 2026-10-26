// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelinePane } from "../TimelinePane";
import * as api from "../../lib/api";
vi.mock("../../lib/api", () => ({ getPlannerTimeline: vi.fn() }));
const get = vi.mocked(api.getPlannerTimeline);
const snapshot = {
  tasks: [
    {
      id: "a",
      number: 42,
      title: "Synthetic review",
      status: "open" as const,
      startDate: "2026-10-26T14:00",
      dueDate: "2026-10-26T15:00",
      priority: null,
    },
  ],
  timeZone: "America/Los_Angeles",
  fetchedAt: "2026-10-26T20:30:00Z",
  truncated: false,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T20:30:00Z"));
  get.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

it("shows loading, timezone, now and timed work without a write control", async () => {
  get.mockResolvedValue(snapshot);
  render(<TimelinePane />);
  expect(screen.getByText("Loading timeline...")).toBeTruthy();
  await flush();
  expect(screen.getByText("America/Los_Angeles")).toBeTruthy();
  expect(screen.getByTestId("timeline-now").textContent).toContain("13:30");
  expect(screen.getByText("Synthetic review")).toBeTruthy();
  expect(screen.getByText("Upcoming")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  await act(async () => {
    vi.advanceTimersByTime(30 * 60 * 1000);
  });
  expect(screen.getByTestId("timeline-now").textContent).toContain("14:00");
  expect(screen.getByText("Open now")).toBeTruthy();
});

it("retains stale data on failure and recovers automatically", async () => {
  get
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ ...snapshot, tasks: [] });
  render(<TimelinePane />);
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByText(/Stale/)).toBeTruthy();
  expect(screen.getByText("Synthetic review")).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.queryByText(/Stale/)).toBeNull();
  expect(screen.getByText("No scheduled work")).toBeTruthy();
});

it("distinguishes unavailable from empty and marks incomplete snapshots", async () => {
  get.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...snapshot, truncated: true });
  render(<TimelinePane />);
  await flush();
  expect(screen.getByText("Timeline unavailable")).toBeTruthy();
  expect(screen.queryByText("No scheduled work")).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(screen.getByText("Schedule incomplete")).toBeTruthy();
});

it("does not overlap reads and aborts on unmount", async () => {
  let finish!: (value: typeof snapshot) => void;
  get.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<TimelinePane />);
  await act(async () => {
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("focus"));
  });
  expect(get).toHaveBeenCalledTimes(1);
  const signal = get.mock.calls[0]![0]!;
  expect(signal.aborted).toBe(false);
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(snapshot);
  });
  expect(get).toHaveBeenCalledTimes(1);
});

it("aborts an upstream wait at the client deadline before unmount", async () => {
  get.mockImplementation(() => new Promise(() => {}));
  render(<TimelinePane />);
  const signal = get.mock.calls[0]![0]!;
  await act(async () => {
    vi.advanceTimersByTime(14_999);
  });
  expect(signal.aborted).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(signal.aborted).toBe(true);
});
