# Session owners: an agent's session tree, in favorites

An outside agent that hands work to aoe sessions (an orchestrator, such as a
central agent that spawns sessions and gives them tasks) can mark the sessions
it owns, directly or through the sessions they spawned, as one tree whose
sessions pass budget to each other like a currency. aoe shows the core of that
tree (its root and the root's children) in favorites and every deeper session
as a worker, each with the budget it has left, and the root's budget with what
it granted and its transfers.

aoe computes nothing about money or ownership. Which sessions an owner holds,
what each was granted and what it has left are the writer's business; aoe
shows what was written and only arranges it. It never shows how much was used
out of a limit, only what is left.

## The owners file

The writer keeps one file, `<app_dir>/session-owners.json`, and replaces it
whole (write a temp file and rename it), so a reader never sees half a file:

```json
{
  "sessions": {
    "0f853c5a16d34c56": {
      "owner": "central",
      "parent": null,
      "left": { "claude": 0.21, "codex": 0.1 },
      "granted": { "claude": 0.25, "codex": 0.1 },
      "over": false,
      "transactions": [
        { "at": "2026-11-10T18:58:09Z", "from": "viktor", "to": "0f853c5a16d34c56",
          "claude": 0.25, "codex": 0.1, "kind": "grant", "by": "viktor" }
      ]
    },
    "c34e98b900a5417d": {
      "owner": "central",
      "parent": "0f853c5a16d34c56",
      "left": { "claude": 0.0576, "codex": 0.03 },
      "granted": { "claude": 0.08, "codex": 0.03 }
    }
  }
}
```

- `sessions` maps an aoe instance id to its entry. An id that names no session
  is ignored.
- `owner` is required: 1 to 24 characters.
- `parent` is the id of the entry's parent in the tree, or `null` (or absent)
  for the root. The tree has one root: the first entry without a parent, by
  id, is the root, and any other parentless entry, or an entry whose parent
  chain does not reach the root (a missing parent, a cycle), is shown as a
  worker of no module.
- `left` is the budget the entry has left this week and `granted` the total
  transferred to it this week, net of cuts, each as shares of the weekly
  plans: `claude` of the Claude plan and `codex` of the Codex plan, where 1 is
  one account's whole weekly limit. `granted` is at least 0; `left` may be
  negative (spent past its budget). A missing or `null` value is unknown.
- `over` is `true` while the entry is held for being past its budget.
- `transactions` lists the entry's latest transfers, newest first: `at` (an
  RFC 3339 time), `from` and `to` (session ids, or a name such as `viktor` for
  money from outside the tree), `claude` and `codex` (the shares moved, at
  least 0, `null` for none), `kind` (`grant`, `default`, `raise`, `auto-raise`
  or `cut`, where a cut moves budget back to the parent) and `by` (who made
  it). aoe keeps the first 20 and drops a transfer that breaks these rules.
- Unknown fields are ignored, so the writer may carry its own bookkeeping.
- A missing file means no session is owned. A file that does not parse yields
  nothing; an entry that breaks the rules above is dropped alone and logged,
  never shown half-read.
- aoe rereads the file when its modification time changes, so a writer may
  rewrite it as often as once a second at no cost to aoe.

## Percentages

Every share shows as a percent of one account's weekly limit: share times 100,
rounded to two decimals with trailing zeros dropped (`0.0576` shows `5.76%`,
`0.08` shows `8%`). A share the file leaves unknown shows `?`.

A share's meter is a fuel gauge: it fills by left over granted, so a full
meter has spent nothing. It is teal while at least 20% of the grant is left,
amber below that, red at or below nothing left or while the entry is `over`.

## The core, in favorites

- The **core** is the root and the root's children (the modules). Snoozed,
  archived and trashed sessions are left out, as with favorites.
- In the TUI the core is a **Favorites** section at the top of the session
  list, above every group and in every sort and grouping mode. It holds the
  root first and then its modules, by Claude grant, largest first, then by
  title. A core session shows only there, not again in its group. Rows draw
  the tree with `├`/`└` guides.
- In the web dashboard the core sits at the top of the **Favorites** section,
  as the same tree in the same order, above the favorited workspaces.
- The person's own favorites keep pinning as they always have; the mark is not
  the favorite flag, and `aoe session favorite` / `unfavorite` change only the
  person's flag.

### The root row

The root row shows what it has left and what it handed out, per plan: `left C
21% X 10%`, then `out C 17.5 X 6`, where `out` is the sum of its modules'
grants.

### A module row

A module row shows, per plan, a meter and what is left: `C ▰▰▰▰▱▱ 5.76%  X
▰▰▰▰ 3% left`, then its worker count (every entry below it, at any depth). In
the web dashboard the count is a toggle that opens the module's workers below
it, nested by parent; in the TUI the count is shown as `▸ 11`.

## Workers

- A **worker** is an entry below a module, at any depth. Its row stays where
  it is (its group, project or org) and gets a `worker · <module>` tag, where
  `<module>` is its module's title with the owner's `Central: ` style prefix
  (anything up to and including the first `: `) removed, then a meter and what
  is left for the plan its agent runs on: Codex for a Codex session, Claude
  otherwise.
- A worker with no module (see `parent` above) is tagged `worker`.
- In the web dashboard an open module lists its workers nested by parent, each
  with the `worker` tag and the same meter; selecting one opens that session.

## The root's budget

Selecting the root shows its budget: in the TUI the preview pane, in the web
dashboard a **Budget** tab beside the terminal. It shows:

- per plan, what the root was granted, what it has left and what it handed out
  (its modules' grants), with a bar of handed out and left against the grant;
- a table of the modules: title, Claude left, Codex left, Claude granted,
  Codex granted and worker count;
- the root's transfers, newest first: time, kind, from and to (a session by
  its title), and the shares moved (`C +0.5% X +0.2%`, a cut as `-`).

## In the API

`GET /api/sessions` carries the entry per session as `owner`: `null`, or
`{"owner", "parent", "role", "module", "left", "granted", "over",
"transactions"}`. `role` is `"root"`, `"module"` or `"worker"`; `module` is
the id of the worker's module (`null` for the root, a module, or a worker of
no module); `left` and `granted` are `{"claude", "codex"}`, each value a share
or `null`; `transactions` is the list above.
