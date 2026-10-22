// @vitest-environment jsdom
// Output URLs render as new-tab anchors (#2685); the cursor row is not linkified.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Row } from "../live-terminal/TermRow";
import { computeRowLinks } from "../../lib/liveTermLines";
import type { AnsiSegment } from "../../lib/ansi";

const renderRow = (text: string, cursorCol: number | null = null) =>
  render(<Row segs={[{ text, style: {} }]} cursorCol={cursorCol} />).container;

describe("Row URL linkification", () => {
  it("renders a URL in output as a new-tab anchor", () => {
    const a = renderRow("PR: https://github.com/o/r/pull/1").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://github.com/o/r/pull/1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toBe("https://github.com/o/r/pull/1");
  });

  it.each([["the cursor row", "https://example.com", 0]])("leaves %s without anchors", (_n, text, cursorCol) => {
    const container = renderRow(text, cursorCol);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(text);
  });

  it("anchors glued non-ASCII glyphs while keeping their cell boxes (#3342)", () => {
    const container = renderRow("voir https://github.com/o/r를 suite");
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://github.com/o/r를");
    expect(a.textContent).toBe("https://github.com/o/r를");
    expect(a.querySelector("span[style*='inline-block']")!.textContent).toBe("를");
    expect(container.textContent).toBe("voir https://github.com/o/r를 suite");
  });

  it("links a URL split across styled segments with the full href", () => {
    const segs: AnsiSegment[] = [
      { text: "see ", style: { fg: "gray" } },
      { text: "https://exam", style: { fg: "blue" } },
      { text: "ple.com/pull/1", style: { fg: "cyan" } },
    ];
    const { container } = render(<Row segs={segs} cursorCol={null} />);
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors.length).toBe(2); // one per styled piece
    expect(anchors.every((a) => a.getAttribute("href") === "https://example.com/pull/1")).toBe(true);
    expect(anchors.map((a) => a.textContent).join("")).toBe("https://example.com/pull/1");
    expect(container.textContent).toBe("see https://example.com/pull/1");
  });

  it("links a wrapped continuation row to the full joined href", () => {
    const first: AnsiSegment[] = [{ text: "see https://a.io/abc", style: {} }]; // fills a 20-col row
    const second: AnsiSegment[] = [{ text: "defgh done", style: {} }];
    const links = computeRowLinks([first, second], 20);
    const { container } = render(<Row segs={second} cursorCol={null} links={links[1]} />);
    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://a.io/abcdefgh");
    expect(anchor.textContent).toBe("defgh");
    expect(container.textContent).toBe("defgh done");
  });

  it("renders plain text with no anchors when the row has no links", () => {
    const container = renderRow("no links here");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("no links here");
  });
});
