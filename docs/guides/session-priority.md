# Session priority: which session needs you first

Every session carries a **priority**, a whole number from 0 to 10 that says how
soon it should get your attention. Higher means sooner. It updates live with the
session's status: a session that is working and does not need you sits at 0,
and the moment it stops for you it takes the priority its agent gave the ask.
The Attention sort orders sessions by it, and the TUI and web dashboard show
the number on each row, so with several sessions ready at once you see which
one to open first.

## Where the number comes from

The agent in the session scores its own ask at the end of its turn, because it
is the only party that knows what it is waiting on:

```sh
aoe session priority 8                    # from inside the session
aoe session priority 8 --ask decide --objective "<focus objective>" "Approve the ad budget"
aoe session priority 8 --session <id>
aoe session priority clear [--session <id>]
```

The optional **ask** (kind, one line, objective, link) is what the session
wants you to do; the [Inbox](session-inbox.md) lists it and status pushes carry
it. Its fields, limits and keep rule are in [session-inbox.md](session-inbox.md#an-ask).
`clear` drops score and ask together.

The target resolves exactly like `aoe session forecast` (see
[session-forecast.md](session-forecast.md)): `--session` (id or title) wins,
otherwise `$AOE_INSTANCE_ID`, otherwise the command exits non-zero with
`no session: run inside an aoe session or pass --session`. The value must be an
integer 0 to 10 or `clear`; anything else exits non-zero and changes nothing.
You can run the same command by hand to override what an agent set.

The scale, which agents are told to follow:

| Score | Meaning |
|---|---|
| 9-10 | Blocked on you and something is losing: money, a deadline today, a person waiting, a broken production system. |
| 7-8 | Blocked on a decision, login, or approval only you can give; the work stops until you answer. |
| 4-6 | Ready for you to review or pick the next step; nothing is lost by an hour's wait. |
| 1-3 | Finished, a report or FYI; read it when convenient. |
| 0 | Does not need you at all. |

## How the effective priority is computed

What the sort and the badge use is the **effective priority**, derived from the
session's state each time it is read, never stored:

1. A session that does not need you is 0: archived, snoozed, trashed, a dead
   pane, or status `Running`, `Starting`, `Creating`, `Deleting`, `Stopped`.
2. `Unknown` is 1.
3. `Waiting`, `Idle` and `Error` use the agent's score if it is **current**,
   otherwise a default: `Waiting` 5, `Error` 4, `Idle` 3, and an `Idle` or
   `Error` session carrying the unread marker 4. With no scores anywhere this
   reproduces the Attention order aoe had before priorities existed.

A score is current when it was set after the session last entered `Running`
from any other status (aoe records that moment as `run_started_at`). So a score
belongs to one ask: the agent sets it while finishing its turn, it shows while
the session waits for you, and once you reply and the session runs again it
stops counting. If the agent then ends its next turn without scoring, the
default applies rather than the stale number. `clear` drops the score, so the
default applies. The ask is current exactly when its score is.

## Where it shows

- **Attention sort** (TUI and web): within the existing sink and pin rules,
  higher effective priority comes first; the status order (Waiting, Error,
  Idle, Unknown, Running, Stopped, transient) breaks ties, then the existing
  favorite and activity tie-breaks. The `attention-urgent` flag still outranks
  everything. A workspace or group ranks by its highest-priority session.
  On the web dashboard, where a plugin `row-column` entry toned `warn` or
  `danger` ranks a session like Error, such a live session sorts with at least
  the Error default (4), so Waiting stays ahead; its badge still shows the
  session's own number.
- **TUI row**: the effective priority shows as a number before the title when
  it is above 0.
- **Web sidebar row**: a small numeric badge when above 0.
- **API**: `GET /api/sessions` carries `priority` (the effective value) and
  `priority_ask` (the current ask `{kind, text, objective, link, value, minutes, due, options, page, posted_at, request, refined_at, merged_into, answered_at}`, or `null`) on
  each session.
- **Inbox** (web): the unread sessions above 0, highest first, as asks; see
  [session-inbox.md](session-inbox.md).

## Telling agents to score

aoe only stores and ranks. Agents score because their instructions tell them
to; for Claude Code that is a line in the user's `CLAUDE.md`, for example:

> At the end of every turn in an aoe session, run
> `aoe session priority <0-10> --ask <kind> --objective "<focus objective>" "<one line>"`
> scoring how much doing the ask now moves the focus and saying exactly what the
> user should do (scale here, ask in docs/guides/session-inbox.md).
