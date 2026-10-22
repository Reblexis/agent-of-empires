import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_CALL_TIMES_CAP, toolCallTimestamp, toolCallTimesSize } from "./toolCallTimes";

afterEach(() => vi.useRealTimers());

describe("toolCallTimestamp", () => {
  it("returns the same timestamp for a tool call on every render", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = toolCallTimestamp("stable-id");
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    expect(toolCallTimestamp("stable-id")).toBe(first);
  });

  it("caps the map so a long-lived tab does not keep every tool call ever rendered", () => {
    for (let i = 0; i < TOOL_CALL_TIMES_CAP + 500; i += 1) toolCallTimestamp(`bulk-${i}`);
    expect(toolCallTimesSize()).toBe(TOOL_CALL_TIMES_CAP);
    // The newest entry survives; the oldest was evicted first.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(toolCallTimestamp(`bulk-${TOOL_CALL_TIMES_CAP + 499}`)).not.toBe("2030-01-01T00:00:00.000Z");
    expect(toolCallTimestamp("bulk-0")).toBe("2030-01-01T00:00:00.000Z");
  });
});
