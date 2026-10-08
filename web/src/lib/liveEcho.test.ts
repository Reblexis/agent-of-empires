import { describe, expect, it } from "vitest";
import type { AnsiSegment } from "./ansi";
import { ECHO_CONFIRM_MS, EchoTracker, classifyInput, type EchoRow } from "./liveEcho";

// docs/guides/web/terminal.md, "Typing echoes locally".

const DIM = { dim: true };
const plainRow = (text: string, x: number, width = 20): EchoRow => ({
  segs: [{ text: text.padEnd(width, " "), style: {} }],
  x,
});
const shown = (t: EchoTracker, row: EchoRow) => {
  const r = t.render(row);
  return r && { text: r.segs.map((s) => s.text).join(""), x: r.x };
};
const PROMPT = "❯ ";

/** A tracker whose `❯` row has already echoed this browser's typing. */
function trustedTracker() {
  const t = new EchoTracker();
  t.input("h", plainRow(PROMPT, 2), 0);
  t.reconcile(plainRow(`${PROMPT}h`, 3));
  return t;
}

describe("classifyInput", () => {
  it("predicts plain single-cell characters and Backspace, nothing else", () => {
    const cases: [string, string | null][] = [
      ["a", "a"],
      ["hi there", "hi there"],
      ["\x7f", "<bs>"],
      ["ab\x7f", "ab<bs>"],
      ["é", "é"],
      ["\r", null], // Enter
      ["\t", null],
      ["\x1b", null],
      ["\x1b[A", null], // arrow
      ["\x03", null], // Ctrl+C
      ["\x1b\x7f", null], // Alt+Backspace
      ["\x1b[200~paste\x1b[201~", null],
      ["中", null], // wide
      ["", null],
    ];
    for (const [input, expected] of cases) {
      const evs = classifyInput(input);
      const got = evs && evs.map((e) => (e.kind === "bs" ? "<bs>" : e.ch)).join("");
      expect(got, JSON.stringify(input)).toBe(expected);
    }
  });
});

describe("EchoTracker", () => {
  it("a password prompt never shows what is typed", () => {
    const t = new EchoTracker();
    const row = plainRow("[sudo] password for v: ", 23, 40);
    t.input("s3cret", row, 0);
    expect(shown(t, row)).toBeNull();
    // The server never echoes; the cursor stays put.
    t.reconcile(row);
    expect(shown(t, row)).toBeNull();
  });

  it("the first character on an unproven row waits for the echo, the rest are instant", () => {
    const t = new EchoTracker();
    t.input("h", plainRow(PROMPT, 2), 0);
    expect(shown(t, plainRow(PROMPT, 2))).toBeNull();
    t.reconcile(plainRow(`${PROMPT}h`, 3));
    t.input("i", plainRow(`${PROMPT}h`, 3), 160);
    expect(shown(t, plainRow(`${PROMPT}h`, 3))).toEqual({ text: `${PROMPT}hi`.padEnd(20), x: 4 });
  });

  it("typing on a trusted row shows at once, and the confirming frame gives way to the real screen", () => {
    const t = trustedTracker();
    const row = plainRow(`${PROMPT}h`, 3);
    t.input("ello", row, 20);
    expect(shown(t, row)).toEqual({ text: `${PROMPT}hello`.padEnd(20), x: 7 });
    // The server has processed two of the four so far.
    const partial = plainRow(`${PROMPT}hel`, 5);
    t.reconcile(partial);
    // Progress restarts the confirmation clock.
    expect(t.deadline()).toBeNull();
    t.arm(170);
    expect(t.deadline()).toBe(170 + ECHO_CONFIRM_MS);
    expect(shown(t, partial)).toEqual({ text: `${PROMPT}hello`.padEnd(20), x: 7 });
    const done = plainRow(`${PROMPT}hello`, 7);
    t.reconcile(done);
    expect(shown(t, done)).toBeNull();
  });

  it("Backspace removes at once, including characters the server already drew", () => {
    const t = trustedTracker();
    const row = plainRow(`${PROMPT}hey`, 5);
    t.input("\x7f\x7f", row, 20);
    expect(shown(t, row)).toEqual({ text: `${PROMPT}h`.padEnd(20), x: 3 });
  });

  it("dim placeholder text right of the cursor is cleared, other text moves along", () => {
    const t = trustedTracker();
    const placeholder: EchoRow = {
      segs: [
        { text: PROMPT, style: {} },
        { text: "Try", style: DIM },
        { text: " ", style: {} },
        { text: '"refactor"', style: DIM },
      ],
      x: 2,
    };
    t.input("a", placeholder, 20);
    expect(shown(t, placeholder)).toEqual({ text: `${PROMPT}a`.padEnd(16), x: 3 });

    const midLine = plainRow(`${PROMPT}hllo`, 3);
    const t2 = trustedTracker();
    t2.input("e", midLine, 30);
    expect(shown(t2, midLine)).toEqual({ text: `${PROMPT}hello`.padEnd(20), x: 4 });
  });

  it("keeps the inserted character in the style of the text before it", () => {
    const t = trustedTracker();
    const red = { fg: "red" };
    const row: EchoRow = {
      segs: [{ text: `${PROMPT}ab`, style: red } as AnsiSegment, { text: "   ", style: {} }],
      x: 4,
    };
    t.input("c", row, 20);
    const r = t.render(row)!;
    expect(r.segs[0]).toEqual({ text: `${PROMPT}abc`, style: red });
  });

  it("a contradicting frame drops every prediction at once", () => {
    const t = trustedTracker();
    const row = plainRow(`${PROMPT}h`, 3);
    t.input("i", row, 20);
    // The app autocompleted instead of echoing.
    const other = plainRow(`${PROMPT}help`, 6);
    t.reconcile(other);
    expect(shown(t, other)).toBeNull();
    expect(t.pending()).toBe(false);
  });

  it("an unconfirmed prediction expires and its row has to earn trust again", () => {
    const t = trustedTracker();
    const row = plainRow(`${PROMPT}h`, 3);
    t.input("i", row, 20);
    expect(t.deadline()).toBe(20 + ECHO_CONFIRM_MS);
    t.expire(20 + ECHO_CONFIRM_MS);
    expect(shown(t, row)).toBeNull();
    t.input("j", row, 2000);
    expect(shown(t, row)).toBeNull();
  });

  it("an unpredictable key drops pending predictions", () => {
    const t = trustedTracker();
    const row = plainRow(`${PROMPT}h`, 3);
    t.input("i", row, 20);
    t.input("\r", row, 30);
    expect(shown(t, row)).toBeNull();
    expect(t.pending()).toBe(false);
  });

  it("never predicts past the end of the row", () => {
    const t = trustedTracker();
    const row = plainRow(`${PROMPT}h`, 3, 5);
    t.input("a", row, 20);
    expect(shown(t, row)).toEqual({ text: `${PROMPT}ha `, x: 4 });
    // One more would put the cursor past the last cell (the app may wrap).
    t.input("b", row, 30);
    expect(shown(t, row)).toBeNull();
    expect(t.pending()).toBe(false);
  });

  it("without a cursor row there is nothing to predict on", () => {
    const t = trustedTracker();
    t.input("a", null, 20);
    expect(t.pending()).toBe(false);
  });
});
