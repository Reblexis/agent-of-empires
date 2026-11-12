# Central: paused or running

aoe sessions come in two kinds that run side by side.

- **Normal sessions** (every session by default): plain sessions the person
  directs, each setting its own [priority](session-priority.md). Nothing
  outside the person sends them work.
- **Central sessions**: sessions an outside orchestrator (the central agent)
  owns, listed in the [owners file](session-owners.md). The dashboard nests
  them under the owner's card in favorites; every other session stays an
  ordinary row beside it, in the Active view too.

The central agent as a whole is either **paused** (the default) or
**running**, and the person switches it in one step, from the web dashboard or
the command line. aoe itself only decides what it shows; stopping and starting
the orchestrator's services, and everything else that differs, belongs to the
person's setup and runs from a central hook.

## Paused

While central is paused aoe ignores the owners file as if it did not exist: no
owner card, no tree, no budget text, and every session, including those the
file lists, is an ordinary row sorted and filtered like any other. aoe never
changes or deletes the file, so resuming central restores the tree.

## The state

The state is the one word `paused` or `running` in `<app_dir>/central`. A
missing file, or any other content, means `paused`. The web dashboard shows it
in the sidebar header as a two-part switch with the current part marked; the
TUI does not switch it but honors it.

## Switching

- `aoe central` prints the current state.
- `aoe central pause` and `aoe central resume` switch to it.
- The dashboard's switch calls `POST /api/central` with `{"state": "running"}`
  and shows the new state when it answers. `GET /api/central` returns
  `{"state": "paused"}`.

A switch to the state already current still runs the hook, so it can repair a
half-applied earlier switch.

### Central hooks

A switch to state `S` runs the executable `<app_dir>/central-hooks/S` (`paused`
or `running`), if it exists, with the new state as its one argument and no
input. The hook runs first and the state file is written only when it exits
with status 0, so a failed switch leaves the state as it was and reports the
hook's exit status and last output lines (kept in `<app_dir>/central-hook.log`).
A hook that has not exited after 120 seconds is killed and counts as failed. A
state with no hook switches with nothing else to do.

A switch is refused with `read_only` like every other write. Switches never
touch sessions: running sessions keep running either way.

## Which prompt a session gets

aoe does not choose a session's instructions. The person's global prompt is
the normal one for every session; the orchestrator gives a session it owns the
central prompt when it spawns it (for example through the agent's own
appended-prompt option), so a normal session never receives it and no switch
has to swap a shared file.

## In the API

`GET /api/central` answers `{"state": "paused" | "running"}`. `POST
/api/central` takes `{"state": "paused" | "running"}` and answers the same
shape on success, or status 500 with `{"error": "..."}` carrying the hook's
failure; an unknown state is status 400.
