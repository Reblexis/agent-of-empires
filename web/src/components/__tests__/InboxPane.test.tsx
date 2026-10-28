// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxPane } from "../InboxPane";
import type { SessionResponse } from "../../lib/types";

afterEach(cleanup);

const row = (id: string, priority: number, reason: string | null = null): SessionResponse =>
  ({
    id,
    title: `Session ${id}`,
    status: "Idle",
    unread: true,
    priority,
    priority_reason: reason,
    idle_entered_at: null,
  }) as SessionResponse;

it("puts the session to open first on top as Next, each entry saying why", () => {
  render(<InboxPane sessions={[row("b", 4), row("a", 8, "Approve the ad budget")]} onOpen={() => {}} />);
  const next = screen.getByTestId("inbox-next");
  expect(within(next).getByText("Next")).toBeTruthy();
  expect(within(next).getByText("Session a")).toBeTruthy();
  expect(within(next).getByText("Approve the ad budget")).toBeTruthy();
  const rest = screen.getAllByTestId("inbox-entry");
  expect(rest.map((e) => within(e).getByText(/^Session /).textContent)).toEqual(["Session b"]);
  expect(within(rest[0]!).getByText("Finished")).toBeTruthy();
});

it("clicking an entry opens the session that sent it", () => {
  const onOpen = vi.fn();
  render(<InboxPane sessions={[row("a", 8), row("b", 4)]} onOpen={onOpen} />);
  fireEvent.click(screen.getByText("Session b"));
  expect(onOpen).toHaveBeenCalledWith("b");
  fireEvent.click(screen.getByText("Session a"));
  expect(onOpen).toHaveBeenLastCalledWith("a");
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
