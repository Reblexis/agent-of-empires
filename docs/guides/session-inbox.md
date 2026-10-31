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

And, naming who owns the queue: "also i would like the queue of inbox/pages made
by agent (it should be made by one agent which is being sent request on what
needs to be figured out... lets call this agent input/output agent its  role is
to maximize input output speed between me and my agents communciation)", and,
approving it: "okay build it.. i guess all that thisagent should be responsible
for is just as efficient communication between my brain and the reset of the
world in general.. i think this general mission it should have but starting only
with my communication with the coding sessions or whatever.. through the html
pages that just come one after another.. it should also preferably measure speed
and learn over time how to maximize input output speed and give suggestions that
would increase it.."

Earlier the same day: "I would prefer if this system just knew me and would be,
like, able to tell, okay, this session needs your attention, this session needs
your attention, go here, go here, go here now", and "once I go to a session and
I read it already, it should obviously disappear automatically."

## An ask

A session posts its ask with its priority score, at the end of its turn. With an
[input/output agent](#the-inputoutput-agent) running, the session sends only the
request (kind, one line, objective, `--context`) and the agent writes the rest;
any field works either way:

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
- **Context** (`--context <file>`): the material behind the request, plain text
  or Markdown, at most 256 KiB: what the input/output agent writes the page
  from. It is never shown to the user as is.

Text, objective, link and options are trimmed and their whitespace runs collapse
to one space. A field over its limit or out of its range, an unknown kind, an
unparseable due or an unreadable page or context exits non-zero and changes
nothing. Posting stamps the ask's `posted_at`, the request's identity, and
keeps the kind, text and options as the session wrote them as the ask's
`request`, which a refine never changes.

**The same ask posted again is not a new one.** A post whose kind, text and
options equal the stored ask's `request` keeps the stored ask exactly as it is:
its `posted_at`, its refine and rank, its page and its context, even when the
session ran since. Only the score is set, which makes the ask current again; a
`--page` or `--context` given with it replaces the stored one. It is a new
request instead when the stored ask was answered or merged. So a loop's wake or
a background task's notice that ends with the same ask changes nothing the user
sees and logs no `posted`. (Measured over 2026-10-29 to 31: 46% of the posts
repeated the session's previous ask word for word; half of all asks were
replaced within 5 minutes. In the first 2 hours after this rule shipped,
2026-10-31 03:45 to 05:50 UTC, 19% were, median life 8.8 minutes against 4.8.)

The ask belongs to the score and shares its lifetime
([session-priority.md](session-priority.md)): once the session runs again (the
user answered it) the ask no longer counts. Setting a score with a different
ask replaces the whole ask, its page and context included (a new ask without
`--page` has none); setting
one without text keeps the stored ask while the stored score is current, so a
focus re-rank with `--session` never erases it. `clear` drops score, ask, page
and context. aoe stores them as `<app_dir>/ask-pages/<session id>.html` and
`<session id>.context`, outside `sessions.json`; deleting the session deletes
them, and the daemon removes those of sessions that no longer exist when it
starts.

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

## The input/output agent

One agent owns the queue: it turns each session's request into the ask the user
sees, and its metric is input/output speed between the user and their agents
(on Viktor's machine, io-agent in the agent economy; its own docs govern how it
decides). aoe gives it three things and keeps the mechanics itself.

**Reading the queue.** `aoe session asks` prints every current ask as JSON, one
object per session: `session_id`, `title`, `profile`, `status`, `priority`, the
`ask` (all fields above plus `posted_at`, `request`, `refined_at`,
`merged_into`, `answered_at`), and the
`context` text or `null`. A request is unrefined while `refined_at` is absent.

**Refining an ask.**

```sh
aoe session refine --session <id> --for <posted_at> [--text "<line>"] [--ask <kind>] \
  [--objective ...] [--link ...] [--value N] [--minutes N] [--due ...] \
  [--option ...]... [--page <file>] [--merge-into <session id>]
```

It replaces only the given fields of that session's current ask, stamps
`refined_at`, and leaves who asked, `posted_at`, the score and its currency
alone. `--for` must equal the ask's `posted_at`: a refine worked out for a
request the session has since replaced exits non-zero and changes nothing, so a
slow refine never overwrites a newer request. Options are replaced as a set when
any is given. With no current ask it exits non-zero.

**Answering.** An answer names its ask by `posted_at` and is delivered while
that ask is **answerable**: it is the session's stored ask, current or not (a
session that started running for another reason still takes the input), or the
ask a new score replaced or dropped at most 5 minutes ago. The reply is typed
with that ask's own text, so the session reads which ask it answers, and the
ask is stamped `answered_at`. An ask takes one answer: a second one, an older
ask, or an ask dropped by `clear` is refused. Before this, an answer typed
while the session posted its next ask was lost (2026-10-29 18:22:54 PT, a
`409` in the same second).

**Merging.** `--merge-into <id>` marks this ask as the same as session `<id>`'s
current ask. A merged ask is not listed; when the user answers the one it is
merged into, the same reply is typed into that session and into every session
whose current ask is merged into it, and all of their unread markers clear. The
target must be another session with a current, unmerged ask; anything else is
refused. A merge ends with the merged ask (the session runs again or posts a new
one).

**Measuring.** aoe appends one JSON line per event to
`<app_dir>/inbox-log.jsonl`, with the server's time: `posted` (a session posted
an ask), `refined`, `opened` (the ask page was first shown in this visit),
`answered` (with the input form: `option`, `text` or `done`, and the
milliseconds the page was open), and `dismissed` (Done on the list, unanswered).
Each line names `session_id` and the ask's `posted_at`. Turnaround is
`answered.at - posted.at`; the user's attention is the answered line's
milliseconds. The dashboard reports page events with
`POST /api/sessions/{id}/ask/events` (`{event, posted_at, form?, ms_open?}`,
refused in read-only mode and for an ask that is not answerable, see
Answering); `answered` stamps the ask's `answered_at`.

### The Inbox API and its key

The input/output agent may run on another machine and its user-facing queue on
another site (on Viktor's machine, io-agent in a fleet body, the queue at
vcihal.com/io). It reaches the daemon over HTTPS with the **Inbox key**: a
bearer token of its own, separate from the login, the passphrase and
`serve.token`.

- `aoe session inbox-key rotate` writes a new random key to
  `<app_dir>/inbox.key` (mode 0600) and prints it; the old key stops working at
  once. `aoe session inbox-key show` prints the current one. With no key file,
  no request is treated as carrying the key.
- A request whose `Authorization: Bearer` is the Inbox key is let through on
  exactly the routes below and refused with `401` on every other, before any
  other check: no session reads, no terminal, no websockets, no settings, and it
  never passes the passphrase wall for anything else. Any other bearer goes on
  through the usual checks. The dashboard's own sign-in reaches the same routes.
- `GET /api/inbox/asks`: the JSON of `aoe session asks`, each object also
  carrying `listed` (it passes "What is listed" below) and `has_page`, in Inbox
  order: listed asks first by the Order rules, then the rest in the same order.
- `GET /api/sessions/{id}/ask/page`: the ask page (above).
- `POST /api/sessions/{id}/ask/refine`: `{for, text?, ask?, objective?, link?,
  value?, minutes?, due?, options?, page_html?, merge_into?}`, the same rules
  and refusals as `aoe session refine` (`for` is the ask's `posted_at`;
  `page_html` the page itself). `409` when `for` is not the current ask's,
  `400` for a refused field, `404` without the session; `204` on success.
- `POST /api/sessions/{id}/ask/answer`: `{for, form, input, ms_open}`, `form`
  one of `option`, `text`, `done`. Exactly what the dashboard's ask page does:
  types `Inbox reply to "<ask text>": <input>` into the session and into every
  session whose current ask is merged into it, clears their unread markers,
  stamps `answered_at` and logs `answered`. `409` when the ask is not
  answerable (Answering, above: code `answered` for one already answered,
  `not_current` otherwise), `400` for an empty input or an unknown form, `502`
  when the session itself could not take the message (nothing is cleared,
  stamped or logged then); two answers at once deliver one and refuse the
  other; `200` with
  `{"answered": [<session ids>]}`, which leaves out a merged session that could
  not take it.
- `POST /api/sessions/{id}/ask/events` (Measuring, above). `dismissed` also
  clears the unread marker, without sending anything, like Done on the list.
- `GET /api/inbox/log?since=<rfc3339>`: the lines of `inbox-log.jsonl` stamped
  after `since` (all of them without it), as a JSON array.
- `POST /api/inbox/message`: `{text, images}`, the user's free input from the
  queue's input box (Viktor, 2026-10-29: "i would also like an input field
  there where i can tell it anything at any time.. thats the input.. pasting
  of pccitures shouold work just like it works int erminal claude session
  etc."). It goes only to the **router session**, whose id is the one line of
  `<app_dir>/inbox-router`, never to a session the caller names. Each of
  `images` (`{data}`, base64, at most 10) is checked and saved exactly like a
  dashboard paste (`POST /api/sessions/{id}/paste-image`: an image, at most
  5 MB, into the router's gitignored `.aoe-pasted-images/`), kept 24 hours
  rather than one, and typed as its path the way the dashboard terminal pastes
  one, so the agent reads it as an image. One message is typed into the router:
  `Message from Viktor via vcihal.com/io: <text> <path> <path>`. `400` for no
  text and no image, a bad image or too many; `503` with no router file, an
  unknown router, or a router that could not take the message (its images are
  deleted then); `200` with `{"delivered_to": <id>, "images": <n>}`.

All of these are refused in read-only and CityHall mode, except the two reads in
read-only mode.

## What is listed

A session is in the Inbox while all hold:

1. Its [effective priority](session-priority.md) is above 0. Running, archived,
   snoozed, trashed and 0-scored sessions are never listed.
2. It is **unread**: its turn ended after the user last viewed it. Opening the
   session (dashboard or TUI), replying on its ask page, or the entry's **Done**
   button clears the marker. Opening the ask page alone does not. The Inbox
   follows the unread marker, so it needs the unread indicator setting on (the
   default).
3. Its ask is not merged into another session's.

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

At `/ask/<session id>` in the dashboard, built for a phone; the URL loads like a
`/session/` one, so a push or a shared link opens it directly:

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
stale anyway), and the dashboard opens the page of the next posted ask in Inbox
order straight away, the pages coming one after another; with none left it
returns to the home screen. A
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
