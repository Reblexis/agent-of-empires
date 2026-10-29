// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AskPage } from "../AskPage";
import type { PriorityAsk, SessionResponse } from "../../lib/types";

const api = vi.hoisted(() => ({
  getAskPage: vi.fn((_id: string) => Promise.resolve<string | null>(null)),
  sendSessionMessage: vi.fn((_id: string, _message: string) => Promise.resolve<string | null>(null)),
  setSessionUnread: vi.fn((_id: string, _unread: boolean) => Promise.resolve(null)),
  postAskEvent: vi.fn((_id: string, _event: object) => Promise.resolve()),
}));
vi.mock("../../lib/api", () => api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const POSTED = "2026-10-28T20:00:00Z";
const session = (ask: PriorityAsk, patch: Partial<SessionResponse> = {}): SessionResponse =>
  ({
    id: "s1",
    title: "Ads work",
    status: "Idle",
    unread: true,
    priority: 8,
    priority_ask: { posted_at: POSTED, ...ask },
    ...patch,
  }) as SessionResponse;

const renderPage = (s: SessionResponse, extra: { readOnly?: boolean; followers?: SessionResponse[] } = {}) => {
  const onOpenSession = vi.fn();
  const onDone = vi.fn();
  render(
    <AskPage
      session={s}
      followers={extra.followers ?? []}
      onOpenSession={onOpenSession}
      onDone={onDone}
      readOnly={extra.readOnly}
    />,
  );
  return { onOpenSession, onDone };
};

it("a decide ask offers its options and the pick goes straight back to the session, then the ask closes", async () => {
  const { onDone } = renderPage(
    session({ kind: "decide", text: "Approve the ad budget", minutes: 2, options: ["Approve 40 EUR", "No"] }),
  );
  expect(screen.getByText("Approve the ad budget")).toBeTruthy();
  expect(screen.getByText("2 min")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve 40 EUR" }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(api.sendSessionMessage).toHaveBeenCalledWith("s1", 'Inbox reply to "Approve the ad budget": Approve 40 EUR');
  expect(api.setSessionUnread).toHaveBeenCalledWith("s1", false);
});

it("a decide ask without options offers Yes and No", () => {
  renderPage(session({ kind: "decide", text: "Ship it?" }));
  expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
});

it("the input matches the kind", async () => {
  // (kind, has text box, has Done)
  const cases: [PriorityAsk["kind"], boolean, boolean][] = [
    ["answer", true, false],
    ["evaluate", true, false],
    ["do", false, true],
    ["check", false, true],
    ["learn", false, true],
    [null, false, true],
  ];
  for (const [kind, box, done] of cases) {
    renderPage(session({ kind, text: "Ask" }));
    expect(!!screen.queryByRole("textbox"), `${kind} box`).toBe(box);
    expect(!!screen.queryByRole("button", { name: "Done" }), `${kind} done`).toBe(done);
    cleanup();
  }
});

it("an answer is typed and sent; Done sends done", async () => {
  const first = renderPage(session({ kind: "answer", text: "Which city?" }));
  const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Prague" } });
  fireEvent.click(send);
  await waitFor(() => expect(first.onDone).toHaveBeenCalled());
  expect(api.sendSessionMessage).toHaveBeenLastCalledWith("s1", 'Inbox reply to "Which city?": Prague');
  cleanup();
  const second = renderPage(session({ kind: "check", text: "Look at the chart" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(second.onDone).toHaveBeenCalled());
  expect(api.sendSessionMessage).toHaveBeenLastCalledWith("s1", 'Inbox reply to "Look at the chart": done');
});

it("a failed send keeps the ask open and says why", async () => {
  api.sendSessionMessage.mockResolvedValueOnce("session_not_running");
  const { onDone } = renderPage(session({ kind: "check", text: "Look" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(api.setSessionUnread).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it("the agent's page is shown sandboxed, with no scripts or network", async () => {
  api.getAskPage.mockResolvedValueOnce("<p>40 EUR buys 3k views</p>");
  renderPage(session({ kind: "decide", text: "Budget", page: true }));
  const frame = (await screen.findByTitle("Ask page")) as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("");
  const doc = frame.getAttribute("srcdoc") ?? "";
  expect(doc).toContain("<p>40 EUR buys 3k views</p>");
  expect(doc).toContain("default-src 'none'");
  expect(api.getAskPage).toHaveBeenCalledWith("s1");
});

it("without a page it shows the objective and the link", () => {
  renderPage(session({ kind: "do", text: "Run the test", objective: "Social media", link: "telarchy-newuser-test" }));
  expect(screen.queryByTitle("Ask page")).toBeNull();
  expect(screen.getByText("Social media")).toBeTruthy();
  expect(screen.getByText("telarchy-newuser-test").tagName).toBe("CODE");
  cleanup();
  renderPage(session({ kind: "learn", text: "Read it", link: "https://x.test/note" }));
  expect(screen.getByRole("link", { name: "https://x.test/note" }).getAttribute("target")).toBe("_blank");
});

it("Open session stays available; read-only and structured sessions take no input", () => {
  const { onOpenSession } = renderPage(session({ kind: "check", text: "Look" }));
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  expect(onOpenSession).toHaveBeenCalledWith("s1");
  cleanup();
  renderPage(session({ kind: "check", text: "Look" }), { readOnly: true });
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  cleanup();
  renderPage(session({ kind: "check", text: "Look" }, { view: "structured" } as Partial<SessionResponse>));
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy();
});

it("one answer reaches every session whose ask is merged into this one, and their asks close", async () => {
  const follower = session({ text: "Budget too?", merged_into: "s1" }, { id: "s2" });
  const { onDone } = renderPage(session({ kind: "decide", text: "Budget?" }), { followers: [follower] });
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(["s1", "s2"]));
  expect(api.sendSessionMessage).toHaveBeenCalledWith("s1", 'Inbox reply to "Budget?": Yes');
  expect(api.sendSessionMessage).toHaveBeenCalledWith("s2", 'Inbox reply to "Budget?": Yes');
  expect(api.setSessionUnread).toHaveBeenCalledWith("s2", false);
});

it("the page reports when it was opened and how the answer was given, for the speed metric", async () => {
  renderPage(session({ kind: "answer", text: "Which city?" }));
  await waitFor(() => expect(api.postAskEvent).toHaveBeenCalledWith("s1", { event: "opened", posted_at: POSTED }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Prague" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.postAskEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ event: "answered", posted_at: POSTED, form: "text", ms_open: expect.any(Number) }),
    ),
  );
  // (kind, button, form)
  const cases: [PriorityAsk["kind"], string, string][] = [
    ["decide", "Yes", "option"],
    ["check", "Done", "done"],
  ];
  for (const [kind, button, form] of cases) {
    cleanup();
    vi.clearAllMocks();
    renderPage(session({ kind, text: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() =>
      expect(api.postAskEvent).toHaveBeenCalledWith("s1", expect.objectContaining({ event: "answered", form })),
    );
  }
});
