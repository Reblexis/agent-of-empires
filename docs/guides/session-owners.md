# Session owners: an agent's session tree, in favorites

An outside agent that hands work to aoe sessions (an orchestrator, such as a
central agent that spawns sessions and gives them tasks) can mark the sessions
it owns, directly or through the sessions they spawned, as one tree. aoe shows
the core of that tree (its root and the root's children) in favorites, and
every deeper session as a worker, each with its usage and its limit, so the
person sees at a glance which sessions the agent runs, what each may spend and
what each has spent.

aoe computes nothing about money or ownership. Which sessions an owner holds,
how usage is counted and what each limit is, are the writer's business; aoe
shows what was written and only arranges it.

## The owners file

The writer keeps one file, `<app_dir>/session-owners.json`, and replaces it
whole (write a temp file and rename it), so a reader never sees half a file:

```json
{
  "sessions": {
    "0f853c5a16d34c56": {
      "owner": "central",
      "parent": null,
      "usage": "used C 4% wk",
      "limit": "limit C 25% X 10% wk",
      "budget": { "claude_share": 0.25, "codex_share": 0.1 },
      "used": { "claude": 0.04, "codex": null },
      "over": false
    },
    "c34e98b900a5417d": {
      "owner": "central",
      "parent": "0f853c5a16d34c56",
      "budget": { "claude_share": 0.08, "codex_share": 0.03 },
      "used": { "claude": 0.0224, "codex": 0.0 }
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
- `budget` and `used` give the entry's limit and its use as shares of the
  weekly plans: `claude_share` and `claude` of the Claude plan, `codex_share`
  and `codex` of the Codex plan, each a number of at least 0, where 1 is one
  account's whole weekly limit. A missing or `null` value is unknown.
- `over` is `true` while the entry is past one of its limits.
- `usage` and `limit` are optional text, up to 40 characters each, shown on
  hover.
- Unknown fields are ignored, so the writer may carry its own bookkeeping.
- A missing file means no session is owned. A file that does not parse yields
  nothing; an entry that breaks the rules above is dropped alone and logged,
  never shown half-read.
- aoe rereads the file when its modification time changes, so a writer may
  rewrite it as often as once a second at no cost to aoe.

## Percentages

Every share shows as a percent of one account's weekly limit: share times 100,
rounded to two decimals with trailing zeros dropped (`0.0224` shows `2.24%`,
`0.08` shows `8%`). A use or limit the file leaves unknown shows `?`.

A share's meter fills by use over limit. It is teal below 80% of the limit,
amber from 80%, red at or past the limit or while the entry is `over`.

## The core, in favorites

- The **core** is the root and the root's children (the modules). Snoozed,
  archived and trashed sessions are left out, as with favorites.
- In the TUI the core is a **Favorites** section at the top of the session
  list, above every group and in every sort and grouping mode. It holds the
  root first and then its modules, by Claude limit, largest first, then by
  title. A core session shows only there, not again in its group. Rows draw
  the tree with `├`/`└` guides.
- In the web dashboard the core sits at the top of the **Favorites** section,
  as the same tree in the same order, above the favorited workspaces.
- The person's own favorites keep pinning as they always have; the mark is not
  the favorite flag, and `aoe session favorite` / `unfavorite` change only the
  person's flag.

### The root row

The root row shows its pool and what it handed out, per plan: `pool C 25% X
10%`, then `out C 17.5 X 6`, where `out` is the sum of its modules' limits.

### A module row

A module row shows, per plan, a meter and `used/limit%`: `C ▰▰▱▱▱▱ 2.24/8%  X
▱▱▱▱ 0/3%`, then its worker count (every entry below it, at any depth). In the
web dashboard the count is a toggle that opens the module's workers below it,
nested by parent; in the TUI the count is shown as `▸ 11`.

## Workers

- A **worker** is an entry below a module, at any depth. Its row stays where
  it is (its group, project or org) and gets a `worker · <module>` tag, where
  `<module>` is its module's title with the owner's `Central: ` style prefix
  (anything up to and including the first `: `) removed, and a meter with
  `used/limit%` for the plan its agent runs on: Codex for a Codex session,
  Claude otherwise.
- A worker with no module (see `parent` above) is tagged `worker`.
- In the web dashboard an open module lists its workers nested by parent, each
  with the `worker` tag and the same meter; selecting one opens that session.

## The root's budget

Selecting the root shows its budget: in the TUI the preview pane, in the web
dashboard a **Budget** tab beside the terminal. Per plan it shows:

- the pool (the root's limit), what the whole tree used (the root's own use
  plus every entry's use; an unknown use counts as nothing), what it handed
  out (its modules' limits) and its reserve (pool minus handed out, never
  below 0), with a bar of used and handed out against the pool;
- a table of the modules: title, Claude limit, Codex limit and worker count.

## In the API

`GET /api/sessions` carries the entry per session as `owner`: `null`, or
`{"owner", "parent", "role", "module", "usage", "limit", "budget", "used",
"over"}`. `role` is `"root"`, `"module"` or `"worker"`; `module` is the id of
the worker's module (`null` for the root, a module, or a worker of no module);
`budget` is `{"claude", "codex"}` and `used` is `{"claude", "codex"}`, each
value a share or `null`.
