// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxPane } from "../InboxPane";
import type { SessionResponse } from "../../lib/types";

const setSessionUnread = vi.fn((_id: string, _unread: boolean) => Promise.resolve(null));
vi.mock("../../lib/api", () => ({ setSessionUnread: (id: string, unread: boolean) => setSessionUnread(id, unread) }));

afterEach(() => {
  cleanup();
  setSessionUnread.mockClear();
});

const row = (id: string, priority: number, ask: SessionResponse["priority_ask"] = null): SessionResponse =>
  ({
    id,
    title: `Session ${id}`,
    status: "Idle",
    unread: true,
    priority,
    priority_ask: ask,
    idle_entered_at: null,
  }) as SessionResponse;

const decide = {
  kind: "decide" as const,
  text: "Approve the 40 EUR ad budget",
  objective: "Telarchy social media",
  link: "https://telarchy.test/ads",
};

it("puts the ask to do next on top, each with its kind, line, objective and session", () => {
  render(<InboxPane sessions={[row("b", 4), row("a", 8, decide)]} onOpen={() => {}} />);
  const next = screen.getByTestId("inbox-next");
  expect(within(next).getByText("Do this next")).toBeTruthy();
  expect(within(next).getByText("decide")).toBeTruthy();
  expect(within(next).getByText("Approve the 40 EUR ad budget")).toBeTruthy();
  expect(within(next).getByText("Telarchy social media")).toBeTruthy();
  expect(within(next).getByText("Session a")).toBeTruthy();
  const link = within(next).getByRole("link", { name: "https://telarchy.test/ads" });
  expect(link.getAttribute("href")).toBe("https://telarchy.test/ads");
  expect(link.getAttribute("target")).toBe("_blank");
  const rest = screen.getAllByTestId("inbox-entry");
  expect(rest).toHaveLength(1);
  expect(within(rest[0]!).getByText("check")).toBeTruthy();
  expect(within(rest[0]!).getByText("Read what it finished")).toBeTruthy();
});

it("a command link is shown to copy, not as a web link", () => {
  render(<InboxPane sessions={[row("a", 8, { ...decide, link: "telarchy-newuser-test" })]} onOpen={() => {}} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("telarchy-newuser-test").tagName).toBe("CODE");
});

it("clicking an entry opens the session that asked", () => {
  const onOpen = vi.fn();
  render(<InboxPane sessions={[row("a", 8), row("b", 4)]} onOpen={onOpen} />);
  fireEvent.click(screen.getByText("Session b"));
  expect(onOpen).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getByText("Session a"));
  expect(onOpen).toHaveBeenLastCalledWith("a");
});

it("Done marks an ask done elsewhere as read without opening its session", () => {
  const onOpen = vi.fn();
  render(<InboxPane sessions={[row("a", 8, decide)]} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(setSessionUnread).toHaveBeenCalledWith("a", false);
  expect(onOpen).not.toHaveBeenCalled();
});

it("read-only mode has no Done", () => {
  render(<InboxPane sessions={[row("a", 8, decide)]} onOpen={() => {}} readOnly />);
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
});

it("says so when nothing needs you", () => {
  render(<InboxPane sessions={[{ ...row("a", 8), unread: false }]} onOpen={() => {}} />);
  expect(screen.getByText("Nothing needs you")).toBeTruthy();
  expect(screen.queryByTestId("inbox-next")).toBeNull();
});

it("leaves out the session already open", () => {
  render(<InboxPane sessions={[row("a", 8), row("b", 4)]} activeSessionId="a" onOpen={() => {}} />);
  expect(within(screen.getByTestId("inbox-next")).getByText("Session b")).toBeTruthy();
});
