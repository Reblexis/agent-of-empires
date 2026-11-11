# Session owners: an agent's session tree, in favorites

An outside agent that hands work to aoe sessions (an orchestrator, such as a
central agent that spawns sessions and gives them tasks) can mark the sessions
it owns, directly or through the sessions they spawned, as one tree whose
sessions pass budget to each other like a currency. The owner itself is the
tree's root and is not an aoe session. aoe shows the whole tree in
favorites under a card for the owner: the root's children (the modules), and
every deeper session (a worker) nested under its parent, each with the budget
it has left, and each module's budget with what it granted and its transfers.

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
    "c34e98b900a5417d": {
      "owner": "central",
      "parent": null,
      "left": { "claude": 0.0576, "codex": 0.03 },
      "granted": { "claude": 0.08, "codex": 0.03 },
      "over": false,
      "transactions": [
        { "at": "2026-11-10T18:58:09Z", "from": "central", "to": "c34e98b900a5417d",
          "claude": 0.08, "codex": 0.03, "kind": "default", "by": "central" }
      ]
    },
    "0418ec1c8e3444b7": {
      "owner": "central",
      "parent": "c34e98b900a5417d",
      "left": { "claude": 0.0004, "codex": 0.012 },
      "granted": { "claude": 0.1029, "codex": 0.02 }
    }
  }
}
```

- `sessions` maps an aoe instance id to its entry. An id that names no session
  is ignored.
- `owner` is required: 1 to 24 characters.
- `parent` is the id of the entry's parent in the tree, or `null` (or absent)
  when its parent is the owner itself. An entry whose parent is absent, not in
  the file (such as a session that left the tree) or whose parent chain loops
  back is a **module**, directly under the owner; every other entry is a
  **worker** of the module its parent chain ends at.
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

## The tree, in favorites

- The **tree** is every entry, modules first, so every worker shows: idle and
  snoozed sessions stay in it, and the web dashboard's Active view never hides
  it. An archived or trashed session has left the tree and is left out with
  every entry below it.
- The owner heads the tree as a card named after it (`Central` for owner
  `central`), since the owner is no session. Below it come the modules by
  Claude grant, largest first, then by title, and under each session its
  children in the same order, nested.
- In the TUI the tree is a section at the top of the session list, above every
  group and in every sort and grouping mode. Its header is the owner's card,
  with the count of sessions in the tree. Rows are indented by depth and draw
  the tree with `├`/`└` guides.
- In the web dashboard the tree sits at the top of the **Favorites** section,
  above the favorited workspaces, in the Active and All views alike. The
  owner's card shows the count of sessions and what the owner handed out per
  plan, the sum of its modules' grants: `out C 17.5% X 6%`. Each module's
  workers show nested below it; its worker count is a toggle that hides them.
- A session in the tree shows once, in the tree: not again in its group, and
  not as a favorited workspace even when the person favorited it.
- A title loses the owner's own prefix (`Central: ` for owner `central`, in
  any case) and keeps any other `: ` prefix, which is part of the task's name.
- In the TUI a row's budget text outranks its title: the title shortens first
  (down to 8 cells), and where even that leaves no room for the full text, the
  row shows only what is left of the share of its plan (`C 5.76%`; `X` for a
  worker running on Codex).
- The person's own favorites keep pinning as they always have; the mark is not
  the favorite flag, and `aoe session favorite` / `unfavorite` change only the
  person's flag.

### A module row

A module row shows, per plan, a meter and what is left: `C ▰▰▰▰▱▱ 5.76%  X
▰▰▰▰ 3% left`; in the TUI it is followed by its worker count (every entry
below it, at any depth) as `▸ 11`, in the web dashboard by the count toggle.

### A worker row

A worker row shows its title and what is left for the plan its agent runs on:
Codex for a Codex session, Claude otherwise. Where a worker's row shows outside
the tree (the TUI's other rows, or the web dashboard while a filter hides the
tree), it adds a `worker · <module>` tag, where `<module>` is its module's
title. Selecting a worker opens that session.

## A module's budget

In the web dashboard a selected module has a **Budget** tab beside the
terminal (the TUI keeps the module's terminal preview). It shows:

- per plan, what the module was granted, what it has left and what it handed
  out (its direct children's grants), with a bar of handed out and left
  against the grant;
- a table of its direct children: title, Claude left, Codex left, Claude
  granted, Codex granted and, for a child with entries below it, their count;
- the module's transfers, newest first: time, kind, from and to (a session by
  its title, otherwise the name as written), and the shares moved
  (`C +0.5% X +0.2%`, a cut as `-`).

## In the API

`GET /api/sessions` carries the entry per session as `owner`: `null`, or
`{"owner", "parent", "role", "module", "left", "granted", "over",
"transactions"}`. `role` is `"module"` or `"worker"`; `module` is
the id of the worker's module (`null` for a module or a worker of no module); `left` and `granted` are `{"claude", "codex"}`, each value a share
or `null`; `transactions` is the list above.
