# Inbox: where to go next

The **Inbox** is the "go here next" list: only the sessions that need you, the
one to open first on top, each with one line saying why. You read the line
instead of opening the session to find out; clicking an entry opens the session
it came from.

Viktor, 2026-10-28: "I would prefer if this system just knew me and would be,
like, able to tell, okay, this session needs your attention, this session needs
your attention, go here, go here, go here now". And: "once I go to a session and
I read it already, it should obviously disappear automatically."

## What is listed

A session is in the Inbox while both hold:

1. Its [effective priority](session-priority.md) is above 0. A running,
   archived, snoozed or trashed session, or one whose agent scored 0, is never
   listed.
2. It is **unread**: its turn ended after you last viewed it. Viewing a session
   (opening it in the dashboard or attaching in the TUI) clears the marker, so
   the entry disappears once you have been there. The Inbox follows the unread
   marker, so it needs the unread indicator setting on (the default).

Nothing else is listed: no session that is working, finished something you have
already seen, or does not need you.

## Order

Highest effective priority first. The top entry is shown as **Next**. Among
equal priorities the session that stopped earliest (`idle_entered_at`) comes
first, since it has waited longest; a session without that time comes after
those with one. Priorities come from each session's own score,
which agents set against your current focus (`personal/focus.md` on Viktor's
machine) and which a focus re-ranking rewrites with
`aoe session priority <n> --session <id>`, so when your preferences change the
order follows without anything in the Inbox changing.

## The why line

Each entry shows the **reason** the agent gave with its score:

```sh
aoe session priority 8 "Approve the 40 EUR ad budget"
```

That line is what the session has for you: the answer you asked it to tell you,
or the decision, login or review it is waiting on. It is plain text, one line,
at most 300 characters; whitespace runs are collapsed to one space. The reason
belongs to the score and shares its lifetime (see
[session-priority.md](session-priority.md)): once the session runs again it no
longer counts. With no current reason the entry falls back to the session's
status: "Waiting for you", "Finished" or "Error".

A separate "notify" command was considered and left out: agents already score
every turn, so one call carries both the rank and the message, and a session's
long final reply is not a line you can read at a glance.

## Where it shows

- **Dock tab** "Inbox" beside Context and Timeline, present in every session's
  layout like Timeline (closing it is remembered; the activity bar reopens it).
- **Home screen** (no session selected) shows the same list under the counts.
- **Mobile**: an entry in the pane picker; tapping an entry opens that session
  in the agent view.

CityHall client mode has no Inbox, as it has no Timeline. The list is derived in the browser from the session list the dashboard already
polls; it has no endpoint or storage of its own, and works in read-only mode.

## Phone

Status pushes ([Push notifications](../push-notifications.md)) carry the reason:
the body is `<session title>: <reason>` when the session has a current reason,
so the phone says why before you open anything.
