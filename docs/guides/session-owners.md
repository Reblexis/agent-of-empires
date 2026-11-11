# Session owners: an agent's session tree, in favorites

An outside agent that hands work to aoe sessions (an orchestrator, such as a
central agent that spawns sessions and gives them tasks) can mark the sessions
it owns, directly or through the sessions they spawned, as one tree whose
sessions pass budget to each other like a currency. The owner itself is the
tree's root and is not an aoe session. aoe shows the whole tree in
favorites under a card for the owner: the root's children (the modules), and
every deeper session (a worker) nested under its parent, each with the budget
it has left and, for a session with an end, how far its work is, and each
module's budget with what it granted and its transfers.

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
      "granted": { "claude": 0.1029, "codex": 0.02 },
      "progress": 40,
      "work": "w281392d8d5"
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
- An entry with neither `left` nor `granted` is outside the owner's budget
  (such as the owner's own improver and its sessions): its row shows its title
  and nothing about budget, and it counts toward no total.
- `progress` is how far the one piece of work the session holds is, a number
  from 0 to 100, as the writer estimates it (central's Dispatcher, for the
  ledger work the session holds). It is absent on a session without an end
  (such as the owner's own standing agents) and while there is no estimate;
  only a session with a `progress` shows a progress bar. A value outside 0 to
  100 or not a number drops the entry.
- `work` is the writer's id for that piece of work (a ledger id such as
  `w281392d8d5`); aoe only carries it.
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

What is left shows as text, never as a bar, so the only bar on a row is its
progress bar. Each plan is named in full: `Claude 5.76% · Codex 3% left`,
where both numbers are what is left of the share of that plan. The text is
teal while at least 20% of the grant is left, amber below that, red at or
below nothing left or while the entry is `over`. Its hover (web) gives what
was granted: `left of the weekly plan; granted Claude 8% · Codex 3%`.

## Progress

A session with a `progress` shows a progress bar and the percent: `▰▰▰▱▱▱
40%` in the TUI, a thin bar with `40%` in the web dashboard. It fills by the
percent. A session without one shows no bar.

## The tree, in favorites

- The **tree** is every entry, modules first, so every worker shows: idle and
  snoozed sessions stay in it, and the web dashboard's Active view never hides
  it. An archived or trashed session has left the tree and is left out with
  every entry below it.
- The owner heads the tree as a card named after it (`Central` for owner
  `central`), since the owner is no session. Below it come the modules by
  Claude grant, largest first, then by title, and under each session its
  children in the same order, nested.
- A session with children is collapsed by default: its row shows `▸ N`, the
  count of every entry below it at any depth, and its children stay hidden
  until it is expanded, when the count turns `▾ N`. Each session expands and
  collapses on its own, and its children start collapsed. In the web dashboard
  the count is a toggle; in the TUI Right (or `l`) expands the selected row
  and Left (or `h`) collapses it. The choice lasts while aoe runs (in the web
  dashboard, in that browser).
- In the TUI the tree is a section at the top of the session list, above every
  group and in every sort and grouping mode. Its header is the owner's card,
  with the count of sessions in the tree. Rows are indented by depth and draw
  the tree with `├`/`└` guides.
- In the web dashboard the tree sits at the top of the **Favorites** section,
  above the favorited workspaces, in the Active and All views alike. The
  owner's card shows the count of sessions and what the owner handed out per
  plan, the sum of its modules' grants: `handed out Claude 17.5% · Codex 6%`.
- A session in the tree shows once, in the tree: not again in its group, and
  not as a favorited workspace even when the person favorited it.
- A title loses the owner's own prefix (`Central: ` for owner `central`, in
  any case) and keeps any other `: ` prefix, which is part of the task's name.
- In the TUI a row's budget text outranks its title: the title shortens first
  (down to 8 cells), and where even that leaves no room for the full text, the
  row shows only what is left of the share of its plan and its progress
  (`C 5.76%`, `X` for a worker running on Codex, then `40%`).
- The person's own favorites keep pinning as they always have; the mark is not
  the favorite flag, and `aoe session favorite` / `unfavorite` change only the
  person's flag.

### A module row

A module row shows its progress bar, if any, then what is left on both
plans: `Claude 5.76% · Codex 3% left`, then its count toggle when it has
children.

### A worker row

A worker row shows its title, its progress bar, if any, and what is left for
the plan its agent runs on: `Codex 0.5% left` for a Codex session, `Claude
0.64% left` otherwise, then its count toggle when it has children. Where a worker's row shows outside
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
`{"owner", "parent", "role", "module", "left", "granted", "budgeted",
"over", "progress", "work", "transactions"}`, where `progress` and `work` are
`null` when absent, `budgeted` is `false` for an entry outside the
owner's budget. `role` is `"module"` or `"worker"`; `module` is
the id of the worker's module (`null` for a module or a worker of no module); `left` and `granted` are `{"claude", "codex"}`, each value a share
or `null`; `transactions` is the list above.
