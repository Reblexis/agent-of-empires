// @vitest-environment jsdom
//
// Row renders http(s) URLs in agent output as clickable anchors so they open
// in one tap instead of a manual select-copy-paste (#2685). Link spans are
// precomputed over the row's joined text by the parent (computeRowLinks) and
// passed in; a Row without spans renders plain text. Only non-cursor rows are
// linkified; the cursor (live input) row keeps its cell-split path.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Row } from "../MobileLiveTerminal";
import { computeRowLinks } from "../../lib/liveTermLines";
import type { AnsiSegment } from "../../lib/ansi";

function seg(text: string): AnsiSegment {
  return { text, style: {} };
}

function linksFor(segs: AnsiSegment[]) {
  return computeRowLinks([segs], 80)[0]!;
}

describe("Row URL linkification", () => {
  it("renders a URL in output as a new-tab anchor", () => {
    const segs = [seg("PR: https://github.com/o/r/pull/1")];
    const { container } = render(<Row segs={segs} cursorCol={null} links={linksFor(segs)} />);
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://github.com/o/r/pull/1");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a!.textContent).toBe("https://github.com/o/r/pull/1");
  });

  it("leaves plain output without anchors", () => {
    const { container } = render(<Row segs={[seg("no links here")]} cursorCol={null} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("no links here");
  });

  it("does not linkify the cursor row", () => {
    const segs = [seg("https://example.com")];
    const { container } = render(<Row segs={segs} cursorCol={0} links={linksFor(segs)} />);
    expect(container.querySelector("a")).toBeNull();
  });
});
