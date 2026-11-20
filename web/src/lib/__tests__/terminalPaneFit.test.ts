import { describe, expect, it } from "vitest";

import { columnsScale, paneFit } from "../terminalPaneFit";

const CHAR_W = 8;

describe("the terminal draws the pane's columns in the room it has", () => {
  it("draws at full size when the pane fits exactly", () => {
    expect(paneFit(1000, CHAR_W, 125)).toBe(1);
  });

  it("draws smaller text when the pane is wider than the room", () => {
    const fit = paneFit(800, CHAR_W, 125);
    expect(fit).toBeLessThan(1);
    expect(125 * CHAR_W * fit).toBeLessThanOrEqual(800);
    expect(fit).toBeGreaterThan(0.79);
  });

  it("leaves a margin at full size when the pane is narrower than the room", () => {
    expect(paneFit(1200, CHAR_W, 125)).toBe(1);
  });

  it("stays at full size when the room is a fraction of a cell over the columns", () => {
    expect(paneFit(1003, CHAR_W, 125)).toBe(1);
  });

  it("stays at full size until the pane's columns are known", () => {
    expect(paneFit(800, CHAR_W, 0)).toBe(1);
    expect(paneFit(0, CHAR_W, 125)).toBe(1);
  });

  it("never draws under half size, however wide another device made the pane", () => {
    expect(paneFit(800, CHAR_W, 400)).toBe(0.5);
  });

  it("names the text scale by the font size", () => {
    expect(columnsScale(14)).toBe("14");
    expect(columnsScale(13.5)).toBe("13.5");
  });
});
