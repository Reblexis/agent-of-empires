# Session owners: sessions another agent owns, in favorites

An outside agent that hands work to aoe sessions (an orchestrator, such as a
central agent that spawns sessions and gives them tasks) can mark the sessions
it owns. aoe shows every marked session among the favorites, with the owner's
name, its usage and its limit on the row, so the person sees at a glance which
sessions the agent runs and what they cost.

aoe computes nothing. Which sessions an owner holds (directly, or through
sessions they spawned), how usage is counted and what the limit is, are the
writer's business; aoe shows exactly what was written.

## The owners file

The writer keeps one file, `<app_dir>/session-owners.json`, and replaces it
whole (write a temp file and rename it), so a reader never sees half a file:

```json
{
  "sessions": {
    "e2d14ef62b814b86": {
      "owner": "central",
      "usage": "4.2M tok today",
      "limit": "64% of 5h"
    }
  }
}
```

- `sessions` maps an aoe instance id to its mark. An id that names no session
  is ignored.
- `owner` is required: 1 to 24 characters.
- `usage` and `limit` are optional: up to 40 characters each. Absent, `null`
  or empty means not shown.
- A missing file means no session is owned. A file that does not parse, or an
  entry that breaks the rules above, is ignored whole (a broken entry drops
  only that entry) and logged, never shown half-read.
- aoe rereads the file when its modification time changes, so a writer may
  rewrite it as often as once a second at no cost to aoe.

## How a marked session shows

- A marked session counts as a favorite wherever favorites pin: it gets the
  favorite marker and pins exactly as a favorited session does, in the TUI and
  in the web dashboard's **Favorites** section. Snoozed, archived and trashed
  sessions do not qualify, as with favorites.
- The mark is not the favorite flag. `aoe session favorite` / `unfavorite` and
  the favorite key change only the person's own flag; the session stays
  pinned while the owner lists it and drops out of favorites when the owner
  stops listing it (unless the person favorited it too).
- The row shows the mark after its title: the owner, then ` · <usage>`, then
  ` · <limit>` when given (`central · 4.2M tok today · 64% of 5h`). In the TUI
  it takes the title's suffix slot, dimmed, before the row tag; on the web it
  is a chip after the label, with the same text on hover.
- `GET /api/sessions` carries the mark per session as `owner`: `null`, or
  `{"owner", "usage", "limit"}` (the last two `null` when not given).
