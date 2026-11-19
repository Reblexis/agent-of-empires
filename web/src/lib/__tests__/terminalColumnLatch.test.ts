import { describe, expect, it } from "vitest";

import { fitColumns, MIN_FIT } from "../terminalColumnLatch";

const CHAR_W = 8;

describe("the terminal keeps its column count", () => {
  it("takes its columns from the first width it sees, at full size", () => {
    expect(fitColumns(1000, CHAR_W, 0)).toEqual({ cols: 125, fit: 1, latchWidth: 1000 });
  });

  it("keeps the columns and draws smaller when it gets narrower", () => {
    const r = fitColumns(800, CHAR_W, 1000);
    expect(r.cols).toBe(125);
    expect(r.latchWidth).toBe(1000);
    expect(r.fit).toBeLessThan(1);
    expect(r.cols * CHAR_W * r.fit).toBeLessThanOrEqual(800);
    expect(r.fit).toBeGreaterThan(0.79);
  });

  it("returns to full size when the room comes back", () => {
    expect(fitColumns(1000, CHAR_W, 1000)).toEqual({ cols: 125, fit: 1, latchWidth: 1000 });
  });

  it("grows the columns only when wider than it has ever been", () => {
    expect(fitColumns(1200, CHAR_W, 1000)).toEqual({ cols: 150, fit: 1, latchWidth: 1200 });
  });

  it("re-wraps at full size below 70% of the widest width", () => {
    expect(MIN_FIT).toBe(0.7);
    expect(fitColumns(690, CHAR_W, 1000)).toEqual({ cols: 86, fit: 1, latchWidth: 690 });
    expect(fitColumns(700, CHAR_W, 1000).cols).toBe(125);
  });

  it("stays at full size when the width is a fraction of a cell over the columns", () => {
    expect(fitColumns(1003, CHAR_W, 1003)).toEqual({ cols: 125, fit: 1, latchWidth: 1003 });
  });
});
