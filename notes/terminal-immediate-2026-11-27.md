# The terminal is immediate (27 Nov 2026)

Viktor, 27 Nov 2026: "can you speed up aoe vcihal.com/aoe claude code and codex terminal
seems like it's still laggy and often delayed.. so look into it and make sure it's always
immediate only thing that's then loading is the sending itself.." and "do a huge
architecture change if needed but i want th ewhole terminal to be immedieate".

Rules: docs/guides/web/terminal.md, "Typing echoes locally" and "Keys never queue on the
server". Branch `fix/terminal-immediate`, on top of `fix/terminal-fills-width` f6f0e4584.

## What was measured before the change

- The box is in Nuremberg, his browser in San Francisco: round trip 162 ms at best
  (`ss -ti` on the Caddy connection), so anything not drawn locally waits at least that.
- The daemon (5 days up, 4 GB mapped, 530 MB of it in swap) started every tmux command by
  `fork`, because `tmux_command()` added a `pre_exec` hook. Each fork took 32 ms (median,
  42 ms p90, `strace -T`), 12 a second while idle, and over half of the daemon's CPU was
  the kernel copying and tearing down page tables (`perf`: `zap_pte_range` 28%,
  `copy_present_pte` 25%). Every key is one `tmux send-keys -H`, so every key paid it.
- Probe: headless Chromium types into a real Claude prompt through the live dashboard, with
  81 ms added each way to stand in for San Francisco; a MutationObserver times each
  character from keydown to on screen (script kept in the session's scratch, not in the repo).
  - Short prompt (29 letters): first letter 286 ms, second 164 ms, the rest 4 ms.
  - Prompt of 60 words (3 rows): the first row 3 ms a letter; from the second row on,
    741 ms rising to 2458 ms. Median 971 ms, 166 of 240 letters over 50 ms, 16 never shown
    before the run ended. Two causes: nothing was predicted on a continuation row (its
    "prompt" had never echoed), and the server took about 116 ms a key against 110 ms
    between keys, so keys queued.
  - With no added delay the first key still took 239 ms: the server's own share.

## What changed

1. `reset_signals_on_exec` adds its hook only in a process that ignores SIGINT/SIGQUIT (the
   TUI). The daemon and the CLI get none, so std uses `posix_spawn`.
2. The daemon's sockets set `TCP_NODELAY`.
3. Prediction: an agent pane is trusted from the first key; trust carries from a row to
   the next while only plain typing is sent; Claude's word wrap is predicted onto the row
   below; a device that does not own the terminal's size predicts too.

Claude Code 2.1.331 wraps its input at pane width minus 4 (2 of prompt, 2 kept free): a
full row keeps the cursor on it at column width minus 2; the next letter moves the last
word down to column 2, or breaks a one-word row; a space at a full row is swallowed and
the cursor goes to column 2 of the next row. Codex 0.162.1 keeps 1 column free and moves
the cursor to the next row as soon as a row is full, then pulls the last word down on the
next letter. Codex's wrap is not predicted yet (it needs the row above the cursor).

## After the change

Same probe, changed dashboard source served by Vite against the old daemon:
short prompt median 8 ms, worst 19 ms; 60 words median 7 ms, p90 9 ms, worst 111 ms,
8 of 240 letters over 50 ms (about 70 ms each, one every 3 seconds; cause not found yet).

## The 3 second freeze

A second probe logged long tasks and requests. Every 3.3 s the page fetched `/api/sessions`
(1,746,959 bytes, 131 KB gzipped, 1,191 sessions of which 987 trashed; 200 to 480 ms on
the server) and `/api/plugins/ui-state` (59 bytes). Both handed React new objects holding
the same data (two polls 3.3 s apart differed in no field), and everything rendered again:
long tasks of 60 to 70 ms per poll on the production bundle (115 to 186 ms on the dev
bundle), during which keys and frames waited. Docs: docs/guides/web/dashboard.md, "A
refresh that changes nothing costs nothing". Fix: `useSessions` keeps the object of every
unchanged session and the list itself when nothing changed; `usePluginUiState` keeps its
entries and revisions the same way.

Production bundles, same probe (120 letters over 2 rows, 81 ms each way):
deployed f6f0e4584: median 3 ms, p90 343 ms, worst 602 ms, 40 letters over 50 ms, a 60 to
70 ms long task every 3.4 s. This branch's bundle against the same daemon: median 3 ms,
p90 6 ms, worst 23 ms, none over 50 ms, one long task (73 ms) in the run.

Still open: a poll that does change a session re-derives the whole sidebar (the lists are
rebuilt from all 1,191 sessions), and the server spends 200 ms or more building the list
for every tab every 3 s.

## Installed

27 Nov 2026 15:10 PST: first build (server fix and prediction) installed, previous binary
kept as `~/.local/bin/aoe.prev-f6f0e4584`. On the live daemon every tmux command then
started with `CLONE_VFORK` (166 of 166 in 10 s), each spawn syscall took 0.2 ms (median,
2.9 ms worst), and the daemon's CPU fell from about 90% to under 10%.

27 Nov 2026 15:50 PST: aab1b3ddf installed (adds the refresh fix; the first build kept as
`~/.local/bin/aoe.prev-build1-terminal-immediate`). Same probe against the live dashboard,
81 ms each way: 60 words median 3 ms, p90 5 ms, worst 11 ms, no letter over 50 ms and no
long task in the run; 29 letters median 3 ms, worst 7 ms. Daemon CPU 3.8%.
`aoe session verify-pointers` clean after both restarts.

Live Playwright specs against the new binary: session-open-stays-at-tail and
session-switch-keeps-scroll pass (8 of 8). In live-terminal.spec.ts four tests fail the
same way on the binary installed before (f6f0e4584) and on this one: "scrollback remains
available through the web capture limit", the two "size ownership" tests, and "HTTP sends
normalize trailing breaks".
