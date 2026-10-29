# Inbox: the user's prompt queue

The **Inbox** is the queue of asks for the user, one concrete ask per entry, the
one worth the most per minute of attention on top. The user works like an agent
that is prompted: a focus is set (what to improve), then the asks arrive in the
order that reaches it fastest. Each ask opens its own **ask page**: only what
the user needs to know for it, then exactly the input it needs, which goes
straight back to the session that asked.

Viktor, 2026-10-28: "actaully lets think of it this way: I'm just an agent that
needs to be prompted properly ... it works like this:
1. its defined what is it we want to focus on/ priority could be improving metrics  whatever..
2. then i just start receiving prompts to do stuff so that the task / desire is
achieved as efficiently as possible - for now we can do it via inbox where there
can be messages what i should check / do / evaluate / answer etc.. does that make sense?"
And: "or when i shoul dlearn something as well ofc."
And: "i wuld really like to just use aoe as an agent so i should just have a queue
of things i should point my attention to and these things should be
hyperoptimized so that we achieve the given goal (ofc. maximizng utility still)
youknow?"
And: "yes but i think it should not lead to like inidvidual sessions but instead
mayb elike html pages hyper optimized to commmunicate necessary information and
get the necessary output yk?"

Earlier the same day: "I would prefer if this system just knew me and would be,
like, able to tell, okay, this session needs your attention, this session needs
your attention, go here, go here, go here now", and "once I go to a session and
I read it already, it should obviously disappear automatically."

## An ask

A session posts its ask with its priority score, at the end of its turn:

```sh
aoe session priority 8 --ask decide --objective "Telarchy social media support" \
  --value 72 --minutes 2 --due 2026-10-29 --page /tmp/ads.html \
  --option "Approve 40 EUR" --option "Approve 20 EUR" --option "No" \
  "Approve the LinkedIn ad budget"
```

- **Kind** (`--ask`): one of `check`, `do`, `evaluate`, `answer`, `decide`,
  `learn`. A `learn` ask says what to learn and why it matters for the
  objective, with `--link` or the page holding what to read.
- **Text** (the trailing words): one line saying exactly what to do. Required
  whenever any other ask field is given.
- **Objective** (`--objective`): the focus objective the ask serves, at most 80
  characters. On Viktor's machine the objectives are the rows of
  `personal/focus.md`.
- **Link** (`--link`): a URL or a command to run, at most 500 characters.
- **Value** (`--value`): an integer 0 to 100, how much doing the ask moves its
  objective (0 to 10) times the objective's importance (0 to 10; on Viktor's
  machine the Importance column of `personal/focus.md`).
- **Minutes** (`--minutes`): an integer 1 to 480, the estimated minutes of the
  user's attention the ask takes.
- **Due** (`--due`): when doing it stops being worth as much, a date
  (`YYYY-MM-DD`) or an RFC 3339 time.
- **Options** (`--option`, repeatable): the choices of a `decide` ask, at most 6,
  each at most 40 characters. A `decide` ask without options offers Yes and No.
  Options on any other kind are refused.
- **Page** (`--page <file>`): the ask page's HTML, at most 4 MiB. Without one the
  dashboard builds the page from the ask's own fields.

Text, objective, link and options are trimmed and their whitespace runs collapse
to one space. A field over its limit or out of its range, an unknown kind, an
unparseable due or an unreadable page exits non-zero and changes nothing.

The ask belongs to the score and shares its lifetime
([session-priority.md](session-priority.md)): once the session runs again (the
user answered it) the ask no longer counts. Setting a score with text replaces
the whole ask, its page included (a new ask without `--page` has none); setting
one without text keeps the stored ask while the stored score is current, so a
focus re-rank with `--session` never erases it. `clear` drops score, ask and
page. aoe stores the page as `<app_dir>/ask-pages/<session id>.html`, outside
`sessions.json`; deleting the session deletes it, and the daemon removes pages
of sessions that no longer exist when it starts.

### Re-ranking from the whole picture

A session estimates its own ask; the coordinator (Personal assistant on Viktor's
machine) sees every session and the focus, and overrides those estimates:

```sh
aoe session rank --session <id> --value 81 [--minutes 5] [--due 2026-10-29]
```

It sets the given fields on the session's current ask and leaves the rest, the
score and its currency untouched. At least one of the three is required. With
no current ask (none posted, or the session ran since) it exits non-zero and
changes nothing. The override lasts as long as the ask: the session's own
re-score without text keeps it, a new ask from the session replaces it.

## What is listed

A session is in the Inbox while both hold:

1. Its [effective priority](session-priority.md) is above 0. Running, archived,
   snoozed, trashed and 0-scored sessions are never listed.
2. It is **unread**: its turn ended after the user last viewed it. Opening the
   session (dashboard or TUI), replying on its ask page, or the entry's **Done**
   button clears the marker. Opening the ask page alone does not. The Inbox
   follows the unread marker, so it needs the unread indicator setting on (the
   default).

A session that needs the user but posted no ask is listed with a stand-in: kind
`answer` and "Reply to it" when Waiting, otherwise kind `check` and "Read what it
finished" (or "It stopped with an error"). A stand-in has no ask page; clicking
it opens the session.

## Order

Value per minute of attention, highest first; the top entry is **Do this next**.

1. Asks carrying both value and minutes, by value divided by minutes. Ties: the
   earlier due first, an ask without due after those with one.
2. Then every other entry (no value or minutes, or a stand-in), by effective
   priority.
3. Any remaining tie: the session that stopped earliest (`idle_entered_at`)
   first, a session without that time after those with one.

When the user's priorities change, the focus file changes (Personal assistant
keeps it current) and the coordinator re-ranks with `aoe session rank`, so the
order follows the whole picture rather than each session's view of itself.

## An entry

Kind, the one line, the minutes estimate, then the objective and the session
title. Clicking an entry with an ask opens its ask page; Done marks it read
without opening anything, and is hidden in read-only mode.

**Do this next** is set apart: larger, its one line in large type, and one
button straight to its ask page (**Go**).

## The ask page

At `/ask/<session id>` in the dashboard, built for a phone:

1. The kind, the one line and the minutes, at the top.
2. What the user needs to know: the agent's page, or without one the objective
   and the link (a URL opens in a new tab; a command is shown to copy).
3. The input, pinned at the bottom, by kind:
   - `decide`: one button per option.
   - `answer`, `evaluate`: a text box and **Send**.
   - `do`: the link or command, and **Done**.
   - `check`, `learn`, and an ask without a kind: **Done**.
4. A small **Open session** link, for the detail.

Sending input types one message into the session, as
`POST /api/sessions/{id}/send` does: `Inbox reply to "<ask text>": <input>`,
where Done sends `done`. Once it is sent the session's unread marker is
cleared, so the ask leaves the Inbox (and the session's next run makes it
stale anyway), and the dashboard returns to the Inbox for the next ask. A
failed send keeps the ask and shows the error. Structured-view sessions do not
take terminal messages, so their ask pages show only Open session. Read-only
mode shows no input.

The agent's page is shown in a sandboxed frame with no scripts, no access to the
dashboard and no network: everything it shows must be inline (inline CSS, inline
SVG for charts, `data:` URIs for screenshots). Write it minimal and
left-aligned, plain words, only what the ask needs.
`GET /api/sessions/{id}/ask/page` returns it (`text/html`, `Cache-Control:
no-store`) while the session has a current ask with a page, else 404; CityHall
mode refuses it.

## Where it shows

- **Home screen** (no session selected), under the counts.
- **Dock tab** "Inbox" beside Context and Timeline, present in every session's
  layout (closing it is remembered; the activity bar reopens it).
- **Mobile**: the home screen, and an entry in the pane picker.

CityHall client mode has no Inbox. The list is derived in the browser from the
session list the dashboard already polls (`priority` and `priority_ask` on each
session).

## Phone

Status pushes ([Push notifications](../push-notifications.md)) carry the ask: the
body is `<session title>: <Kind>: <text>` when the session has a current ask with
a kind, `<session title>: <text>` without one, and tapping it opens the ask page
(`/ask/<id>`) instead of the session.
