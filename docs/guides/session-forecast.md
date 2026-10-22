# Session forecast: stop now or continue

A session can carry a **forecast card**: what happens to the numbers the
session is working on if it stops now, against what happens if it continues.
The agent running inside the session writes the card; aoe stores it and shows
it prominently, so the person deciding whether to keep the session going sees
the answer without reading the scrollback.

aoe does not compute anything. Where the numbers come from (a prediction
market, a model, a spreadsheet) is the writer's business; aoe shows exactly
what was written and how old it is. The first writer is the Telarchy
`telarchy-session` skill, which prices the session's continuation on a market.

## Writing a card

```sh
aoe session forecast set < card.json      # from inside the session
aoe session forecast set --session <id> < card.json
aoe session forecast show [--session <id>]   # prints the stored card as JSON
aoe session forecast clear [--session <id>]
```

Inside an aoe session the target defaults to `$AOE_INSTANCE_ID`, which aoe
exports into every session it launches; the id must name an existing session
in any profile, and an empty value counts as unset. `--session` takes an
instance id or a title, resolved the way the other `aoe session` subcommands
resolve one, and wins over the environment. With neither, the command exits
non-zero with `no session: run inside an aoe session or pass --session`.

`set` replaces the whole card. It validates before writing and on any error
exits non-zero, prints which field is wrong, and leaves the previous card
untouched. aoe stamps `updated_at` itself (the writer never sends it; a card
that carries one is refused) and
writes atomically (temp file and rename), so a reader never sees half a card.
`clear` on a session with no card succeeds silently. `show` on a session with
no card prints nothing and exits 0.

## The card

```json
{
  "verdict": "continue",
  "headline": "+150 EUR revenue",
  "metrics": [
    {
      "name": "Monthly revenue (EUR)",
      "date": "2026-11-01",
      "stopped": 1200,
      "continued": 1350,
      "unit": "EUR",
      "traders": 3,
      "depth": 4000
    }
  ],
  "note": "Next round: rewrite the pricing page and email 20 lapsed users.",
  "source": { "label": "Telarchy market", "url": "https://telarchy.com/acme/proposals/12" },
  "decide_by": "2026-10-06T18:00:00Z"
}
```

| Field | Required | Rule |
|---|---|---|
| `verdict` | yes | one of `continue`, `stop`, `unpriced` |
| `headline` | yes | 1 to 32 characters; the chip text |
| `metrics` | no | 0 to 8 rows |
| `metrics[].name` | yes | 1 to 80 characters |
| `metrics[].date` | no | `YYYY-MM-DD`, the date the number is read |
| `metrics[].stopped` | no | number or `null` (unknown) |
| `metrics[].continued` | no | number or `null` (unknown) |
| `metrics[].unit` | no | up to 16 characters |
| `metrics[].traders` | no | integer >= 0 |
| `metrics[].depth` | no | number >= 0, what sits behind the price, in the source's own unit |
| `note` | no | up to 280 characters |
| `source.label` | with `source` | 1 to 40 characters |
| `source.url` | with `source` | `http` or `https` only |
| `decide_by` | no | RFC 3339 instant |

An optional field may be omitted or `null`; both mean "not given". Unknown
fields (top level, in a metric row, or in `source`) are refused, so a typo
fails loudly instead of silently not showing. The card is at most 16 KB
(16384 bytes), both as sent and as stored.

`unpriced` means the source has no answer yet (for a market: nobody has
traded). It is shown as its own state, never as a tie.

## Storage and lifetime

Each card is one file, `<app_dir>/session-forecasts/<instance-id>.json`,
outside `sessions.json`: writing a forecast never touches the session registry,
so it cannot disturb tab tracking ([session-resume.md](session-resume.md)).
Deleting a session for good (purge, or a delete that skips the trash) removes
its card. Moving it to the trash, stopping, restarting, or hibernating it
keeps the card, so a restored session comes back with it. A card whose session no longer exists is ignored and removed
on the daemon's next start.

## Where it shows

**Web dashboard, session view.** A band pinned at the top of the session's main
pane, above the terminal or structured view, whenever the session has a card:

- first line: the verdict as a colored pill (continue: green, stop: red,
  unpriced: grey), the headline, the source link, the deadline when
  `decide_by` is set ("decide by 18:00"), and the age ("as of 12 min ago",
  from `updated_at`);
- one line per metric: name and date, `stopped -> continued`, the difference
  with its sign, the unit, and `traders` and `depth` when present; a `null`
  side shows as `?` and no difference is computed;
- the note, when present, as a last line.

The band is left-aligned text, takes no more than its content, and has a
collapse toggle that hides everything but the first line; the collapsed state
is remembered per session in the browser. A card older than 24 hours shows its
age in a warning color.

**Web dashboard, session list.** The session's row in the sidebar carries a
small chip: the verdict color and the headline, truncated to fit. Hovering
shows the verdict, the headline, and the age (the list summary carries only
those).

The dashboard picks up a new or changed card within one session-list refresh,
with no reload.

## API

- `GET /api/sessions/{id}/forecast`: `200` with the stored card (including
  `updated_at`), `404` when the session has none or does not exist.
- Every session in `GET /api/sessions` carries `forecast`: `null`, or
  `{ "verdict", "headline", "updated_at" }` for the chip.

Both are reads and follow the dashboard's ordinary read authorization. There is
no HTTP write: cards are written through the CLI by the agent on the machine.
