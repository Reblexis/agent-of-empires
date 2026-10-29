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
  value: 72,
  minutes: 2,
};

it("puts the ask to do next on top, each with its kind, line, objective and session", () => {
  render(<InboxPane sessions={[row("b", 4), row("a", 8, decide)]} onOpen={() => {}} onOpenAsk={() => {}} />);
  const next = screen.getByTestId("inbox-next");
  expect(within(next).getByText("2 min")).toBeTruthy();
  expect(within(next).getByText("Do this next")).toBeTruthy();
  expect(within(next).getByText("decide")).toBeTruthy();
  expect(within(next).getByText("Approve the 40 EUR ad budget")).toBeTruthy();
  expect(within(next).getByText("Telarchy social media")).toBeTruthy();
  expect(within(next).getByText("Session a")).toBeTruthy();
  const rest = screen.getAllByTestId("inbox-entry");
  expect(rest).toHaveLength(1);
  expect(within(rest[0]!).getByText("check")).toBeTruthy();
  expect(within(rest[0]!).getByText("Read what it finished")).toBeTruthy();
});

it("an ask opens its ask page, Go on the top one included; a stand-in opens its session", () => {
  const onOpen = vi.fn();
  const onOpenAsk = vi.fn();
  render(<InboxPane sessions={[row("a", 8, decide), row("b", 4)]} onOpen={onOpen} onOpenAsk={onOpenAsk} />);
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(onOpenAsk).toHaveBeenLastCalledWith("a");
  fireEvent.click(screen.getByText("Approve the 40 EUR ad budget"));
  expect(onOpenAsk).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText("Session b"));
  expect(onOpen).toHaveBeenCalledWith("b");
  expect(onOpenAsk).toHaveBeenCalledTimes(2);
});

it("Done marks an ask done elsewhere as read without opening its session", () => {
  const onOpen = vi.fn();
  render(<InboxPane sessions={[row("a", 8, decide)]} onOpen={onOpen} onOpenAsk={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(setSessionUnread).toHaveBeenCalledWith("a", false);
  expect(onOpen).not.toHaveBeenCalled();
});

it("read-only mode has no Done", () => {
  render(<InboxPane sessions={[row("a", 8, decide)]} onOpen={() => {}} onOpenAsk={() => {}} readOnly />);
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
});

it("says so when nothing needs you", () => {
  render(<InboxPane sessions={[{ ...row("a", 8), unread: false }]} onOpen={() => {}} onOpenAsk={() => {}} />);
  expect(screen.getByText("Nothing needs you")).toBeTruthy();
  expect(screen.queryByTestId("inbox-next")).toBeNull();
});

it("leaves out the session already open", () => {
  render(
    <InboxPane sessions={[row("a", 8), row("b", 4)]} activeSessionId="a" onOpen={() => {}} onOpenAsk={() => {}} />,
  );
  expect(within(screen.getByTestId("inbox-next")).getByText("Session b")).toBeTruthy();
});
