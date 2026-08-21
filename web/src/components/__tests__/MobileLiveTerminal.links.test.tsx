// @vitest-environment jsdom
//
// Row renders link spans precomputed over the row's JOINED text (see
// computeRowLinks), so a URL styled as several ANSI segments becomes anchors
// that all carry the FULL href, and a URL wrapped from a previous row links
// its fragment to the full joined href too. The per-segment matcher this
// replaced linkified only fragments (partial highlight, truncated href on
// ctrl/cmd+click).

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Row } from "../MobileLiveTerminal";
import { computeRowLinks } from "../../lib/liveTermLines";
import type { AnsiSegment } from "../../lib/ansi";

function seg(text: string, fg?: string): AnsiSegment {
  return { text, style: fg ? { fg } : {} };
}

describe("Row link rendering", () => {
  it("links a URL split across styled segments with the full href", () => {
    const segs = [seg("see ", "gray"), seg("https://exam", "blue"), seg("ple.com/pull/1", "cyan")];
    const links = computeRowLinks([segs], 80)[0]!;
    const { container } = render(<Row segs={segs} cursorCol={null} links={links} />);
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors.length).toBe(2); // one per styled segment piece
    expect(anchors.every((a) => a.getAttribute("href") === "https://example.com/pull/1")).toBe(true);
    expect(anchors.map((a) => a.textContent).join("")).toBe("https://example.com/pull/1");
    // Text outside the URL stays plain.
    expect(container.textContent).toBe("see https://example.com/pull/1");
  });

  it("links a wrapped continuation row to the full joined href", () => {
    const first = [seg("see https://a.io/abc")]; // fills a 20-col row exactly
    const second = [seg("defgh done")];
    const links = computeRowLinks([first, second], 20);
    const { container } = render(<Row segs={second} cursorCol={null} links={links[1]} />);
    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://a.io/abcdefgh");
    expect(anchor.textContent).toBe("defgh");
    expect(container.textContent).toBe("defgh done");
  });

  it("renders plain text with no anchors when the row has no links", () => {
    const segs = [seg("no links here")];
    const { container } = render(<Row segs={segs} cursorCol={null} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("no links here");
  });
});
