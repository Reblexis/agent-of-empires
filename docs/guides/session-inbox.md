# Inbox: the user's prompt queue

The **Inbox** is the queue of asks for the user, one concrete ask per entry, the
one to do next on top. The user works like an agent that is prompted: a focus is
set (what to improve), then the asks arrive in the order that reaches it fastest.
Clicking an entry opens the session that asked.

Viktor, 2026-10-28: "actaully lets think of it this way: I'm just an agent that
needs to be prompted properly ... it works like this:
1. its defined what is it we want to focus on/ priority could be improving metrics  whatever..
2. then i just start receiving prompts to do stuff so that the task / desire is
achieved as efficiently as possible - for now we can do it via inbox where there
can be messages what i should check / do / evaluate / answer etc.. does that make sense?"
And: "or when i shoul dlearn something as well ofc."

Earlier the same day: "I would prefer if this system just knew me and would be,
like, able to tell, okay, this session needs your attention, this session needs
your attention, go here, go here, go here now", and "once I go to a session and
I read it already, it should obviously disappear automatically."

## An ask

A session posts its ask with its priority score, at the end of its turn:

```sh
aoe session priority 8 --ask decide --objective "Telarchy social media support" \
  --link https://telarchy.com/x "Approve the 40 EUR LinkedIn ad budget"
```

- **Kind** (`--ask`): one of `check`, `do`, `evaluate`, `answer`, `decide`,
  `learn`. A `learn` ask says what to learn and why it matters for the
  objective, with `--link` naming what to read.
- **Text** (the trailing words): one line saying exactly what to do. Required
  whenever `--ask`, `--objective` or `--link` is given.
- **Objective** (`--objective`): the focus objective the ask serves, at most 80
  characters. On Viktor's machine the objectives are the rows of
  `personal/focus.md`.
- **Link** (`--link`): a URL or a command to run, at most 500 characters.

Text, objective and link are trimmed and their whitespace runs collapse to one
space; text is at most 300 characters. A value over its limit or an unknown kind
exits non-zero and changes nothing.

The ask belongs to the score and shares its lifetime
([session-priority.md](session-priority.md)): once the session runs again (the
user answered it) the ask no longer counts. Setting a score with text replaces
the whole ask; setting one without text keeps the stored ask while the stored
score is current, so a focus re-rank with `--session` never erases it. `clear`
drops score and ask.

## What is listed

A session is in the Inbox while both hold:

1. Its [effective priority](session-priority.md) is above 0. Running, archived,
   snoozed, trashed and 0-scored sessions are never listed.
2. It is **unread**: its turn ended after the user last viewed it. Opening the
   session (dashboard or TUI) clears the marker, and so does the entry's
   **Done** button for an ask done elsewhere. The Inbox follows the unread
   marker, so it needs the unread indicator setting on (the default).

A session that needs the user but posted no ask is listed with a stand-in: kind
`answer` and "Reply to it" when Waiting, otherwise kind `check` and "Read what it
finished" (or "It stopped with an error").

## Order

Highest effective priority first; the top entry is shown as **Do this next**.
The score is the agent's estimate of how much doing the ask now moves its focus
objective, so the agent scores against the current focus. Among equal
priorities the session that stopped earliest (`idle_entered_at`) comes first; a
session without that time comes after those with one. When the user's
priorities change, the focus file changes (Personal assistant keeps it current)
and a focus re-ranking rewrites the scores with
`aoe session priority <n> --session <id>`, so the order follows.

## An entry

Kind, then the one line, then the objective, the link (a URL opens in a new tab;
a command is shown to copy) and the session title. The whole entry opens the
session; Done marks it read without opening it, and is hidden in read-only mode.

## Where it shows

- **Home screen** (no session selected), under the counts.
- **Dock tab** "Inbox" beside Context and Timeline, present in every session's
  layout (closing it is remembered; the activity bar reopens it).
- **Mobile**: the home screen, and an entry in the pane picker; tapping an entry
  opens that session in the agent view.

CityHall client mode has no Inbox. The list is derived in the browser from the
session list the dashboard already polls (`priority` and `priority_ask` on each
session); it has no endpoint or storage of its own.

## Phone

Status pushes ([Push notifications](../push-notifications.md)) carry the ask: the
body is `<session title>: <Kind>: <text>` when the session has a current ask with
a kind, `<session title>: <text>` without one.
