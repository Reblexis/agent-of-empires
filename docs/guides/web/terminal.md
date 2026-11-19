# Terminal View

For tmux-backed sessions the dashboard renders the agent's pane as a live terminal, plus an optional paired shell. For ACP sessions, see the [structured view](../../structured-view.md).

![The agent terminal rendered in the browser](../../assets/web/terminal.png)

## Agent terminal

The server renders the pane and pushes its rows over a WebSocket; the dashboard draws them as real text, so scrolling, selection, and zoom are the browser's own. There is no xterm.js and no PTY attach.

Where it can, the server renders from the [VT live transport](../live-mode.md#the-vt-live-transport) and otherwise falls back to `capture-pane` snapshots on a 50 ms cadence with `tmux send-keys` for input. The fallback cannot withhold a half-drawn repaint. Add `?livedebug=1` to the URL to see which transport a session uses, plus frame rate and arrival-to-paint latency. When the view moves up by more than a row although you did not scroll up (no upward wheel, press, or touch on the terminal in the last half second), the dashboard logs a `live-terminal.jump` warning with the scroll geometry and follow state to the daemon's debug log, at most once per 10 seconds, so a reported jump can be traced.

Scrolling up into history surfaces a **Back to live** button; scrolling back to the bottom returns to the live tail. At the live tail the view follows new output until you scroll up again; a scroll down that stops within about a line of the bottom counts as reaching it. Nothing else takes you off the live tail: not a session still loading, not the terminal changing height (a banner, a panel, a smaller window), and not an agent printing its whole history again after its pane was resized. The live tail is the bottom of the pane; only while a soft keyboard covers it is it the prompt's row. The pane's rows come from the tallest the terminal has been at its current width, so a shorter window, a banner, or the soft keyboard never shrinks the agent's pane; a width change starts over from the current height. The agent keeps running while you read. Clicking inside the terminal while you read history keeps your place; typing (or, on touch, opening the soft keyboard) returns you to the live prompt. Each session remembers where you were reading: open another session and come back, and the terminal opens on the same lines, not at the live tail (until the page reloads). A session you left at the live tail reopens at the live tail.

### Scrollback is local

Scrolling never waits on the server:

- When a session's terminal opens, the dashboard downloads the pane's scrollback in the background (the last 4000 lines at most) and keeps that copy current from the live stream, which itself carries only the screen and a little history above it.
- Scrolling through the copy is the browser's own scroll, with no request to the server. History not downloaded yet (the first round trip after opening) shows as blank lines that fill in when it lands.
- The copy is downloaded again whenever it can no longer be shown to match the pane: the history was cleared, the pane's width changed (tmux re-wraps its history), or more output arrived between two frames than a frame covers, at most once every 2 seconds. A copy that matches is never thrown away, including across a reconnect.

A full-screen app on the alternate screen keeps its history inside the app, not in tmux, so there is nothing to download, and each scroll step is forwarded to the app and waits a round trip. Claude Code (with `"tui": "fullscreen"`) and Codex (by default) are such apps. To keep their history in tmux, and so get local scrolling and local typing echo for them, turn on `claude_inline_tui` and `codex_inline_tui`: aoe then starts Claude with its inline renderer and Codex with `--no-alt-screen`, without touching your own agent settings. Either applies when the session's agent starts or restarts.

```toml
[session]
claude_inline_tui = true
codex_inline_tui = true
```

### Typing echoes locally

What you type shows up at once, without waiting for the server to echo it, the way mosh does it:

- A printable character appears at the cursor the moment you press it, and Backspace removes the character before the cursor at once. Dim text to the right of the cursor (an input placeholder, such as Claude's `Try "..."`) is cleared as you type; other text to the right moves along. When the server's next frame arrives, the prediction gives way to the real screen; when they agree, nothing visibly changes.
- Only plain single-cell characters and Backspace are predicted, on the normal screen (not a full-screen app), at the live edge, while this browser owns the terminal, and only up to the end of the cursor's row. Any other key (Enter, Tab, Esc, arrows, Ctrl or Alt chords, a paste carrying control characters, a wide character) drops every pending prediction and waits for the server, like before.
- A prediction is shown at once only on a row whose prompt has already echoed this browser's typing (the row's text up to the first space after its first word: Claude's `❯`, your shell prompt). On any other row the first character waits for the server's echo, and once it arrives the rest of that row is predicted again. A row that never echoes, such as a password prompt, never shows your input.
- A prediction the server contradicts (the cursor or the text left of it ends up somewhere else) is dropped as soon as that frame arrives, and one the server has not confirmed within 1.5 s is dropped and its row has to earn trust again. The cost of a wrong guess is that for up to one round trip you see a character the app then draws differently or not at all.
- Prediction can only ever add a preview; it never stands between a key and the session. Every key is sent exactly as if prediction were off, and a key the pane did not receive drops every prediction. A row prediction cannot reason about is simply not predicted, never an error: the cursor past the row's last visible character (the screen does not keep trailing spaces, so this is the normal state right after typing a space), an empty row, a window split into panes (whose cursor row carries the other pane's text). If predicting fails anyway, the predictions are dropped and the view shows the server's screen as it is.

### Switching sessions

Opening a session shows a screen at once instead of a "Starting session..." placeholder:

- The browser remembers the last screen of the 32 sessions it showed most recently, per terminal (agent pane, each paired shell), for as long as the page stays open. Opening one of them draws that screen immediately while the session is started (if it was stopped) and its live stream connects, which takes a few round trips to the server; the live stream then replaces it. The scrollback copy (see above) of the 8 most recently shown sessions is remembered too, so their history scrolls at once; for the others scrolling up waits for the download.
- Resting the pointer on a session in the sidebar fetches its current agent screen in the background (at most once every 10 seconds per session), so a session not yet opened in this page also appears at once when clicked.
- Without a remembered or prefetched screen (the first open on a touch device, say), the placeholder shows until the stream connects.
- A session never draws at another size than this browser's terminal. A remembered or prefetched screen stands in only when it was drawn at the size the terminal has now; one from a narrower window or another device is skipped, and so is any prefetched screen before this page has opened its first session. The live stream's first screen is the pane already resized to this browser: the wait is at most 0.6 seconds, and the screen shows as it is when another device controls the size. Text an agent printed while the pane was narrower keeps its line breaks.

## Width

On a desktop the agent terminal keeps its column count. The count comes from the widest the terminal has been in this browser on this screen at the chosen font size. When the terminal gets narrower (the session sidebar opens or is dragged wider, the browser window shrinks) the text is drawn smaller so the same columns still fit, and returns to full size when the room comes back; tmux is not resized and the agent does not redraw. Rows are held the same way. The right dock never changes the terminal's width by opening or closing: its room stays set aside beside a terminal session (see [Dashboard](dashboard.md)).

The columns change only when the terminal becomes wider than it has ever been, when it becomes narrower than 70% of that width (the text would be too small, so it re-wraps at full size), when the font size setting changes, or when another device takes the session over. Paired terminals in the dock and touch devices size to the space they have.

## Copy and scroll

The terminal uses tmux for scrollback and selection, so no modifier keys are involved. Scroll with the wheel or a one-finger swipe. Select by click-dragging; dragging past the top edge scrolls into scrollback and extends the selection, and releasing copies to your system clipboard automatically. While the mouse button is held over the text the view does not follow new output, so the text stays under the pointer.

URLs in the output open in a new tab. A URL styled in several colors, or wrapped across full-width rows, links every visible part to the whole address; an OSC 8 hyperlink opens the target the program gave it, whatever its visible text. A wrapped URL continues on the next row when that row starts at column 0 (a tmux wrap) or at the text indent of the URL's row (an agent such as Claude Code hard-wrapping its indented reply, list item or tool output), and only with characters a URL can contain.

While a selection touches the terminal the pane stops repainting, so the agent cannot rewrite the text under it mid-gesture, and newly captured history loads in above the held rows. A full-screen mouse agent also gives up its grip on touch gestures while a selection is live, so the handles stay draggable. Such an agent copies through OSC 52 instead, which AoE forwards to the same browser clipboard path.

A paste made while nothing editable has focus (after ending a selection or clicking a link) goes to the terminal you last clicked or typed in, or to the agent terminal before you have touched either, and focus returns to it.

Copy relies on the browser Clipboard API, which needs a secure context: HTTPS or `http://localhost`. On a plain-HTTP LAN origin the selection stays visible but is not copied. Firefox is best-effort; Chromium and Safari copy reliably.

## Paired terminal

Each session can open a **paired terminal**: a host shell (or, for a sandboxed session, one inside the container) rooted at the session's working directory. On desktop it shares the split with the agent terminal; on mobile it is one of the right-panel views. It stays alive in the background when you switch away. Its terminal 1 is the same shell the TUI opens with `T`, in the matching Host or Container mode.

The **Container** tab launches the container user's preferred shell, resolved inside the container from the passwd entry, then `$SHELL`, then bash or sh. Candidates must be regular executables that either have a recognized shell name or appear in `/etc/shells`; known-compatible shells run in login mode.

## Multiple devices

- Every connected dashboard receives the same terminal output. Typing, paste, and mouse input work on every device without a takeover prompt, including before the size-owner response arrives.
- One connection controls the shared terminal dimensions. Other connections keep their own scroll position and render that same screen; opening, typing in, or reconnecting another device never steals the size lock or resizes the pane repeatedly.
- Input queued while connecting is sent once, in order, when that connection opens. Session changes discard unsent input for the previous session. The pending queue stays bounded.
- Read-only servers still reject all terminal input from every device.

## Reconnect

If the WebSocket drops (network blip, tunnel re-auth, daemon restart), the terminal redials on a fast ladder (200 ms through 10 s) and then every 10 s until it is back; it never gives up on a network failure. What you type meanwhile is queued and sent, in order, when the connection opens. A drop that heals within a second shows no banner.

| Code | Reason | What the terminal does |
| ---- | ------ | ---------------------- |
| 1001 | `server shutdown` | Redials until the daemon is back. |
| 1013 | `tmux_not_ready`, `capture_failed` | The pane could not be read. Redials on the ladder; after seven refusals in a row it stops and offers Restart, which starts the session again. |
| 4001 | `pty_dead` | The agent exited. Offers Restart. |
| 4002 | `session_renamed` | Redials at once, without a banner. |

Renaming a session while its terminal is open (the smart rename of a new session, `aoe session rename`, the dashboard) never costs input: the key or paste that found the old name gone is delivered to the session under its new name, and the terminal reconnects to that name by itself.

A connection never stays open without a working terminal behind it. When the server can no longer read the pane it closes the connection, so the browser redials. The server also sends a heartbeat every 3 seconds; a browser that hears nothing for 10 seconds treats the connection as dead and redials at once, and it runs the same check the moment the tab becomes visible or the network returns. A connection attempt that has not opened within 8 seconds is abandoned and retried.

A network interruption can leave the old connection open on the server while the browser reconnects. The server pings each live connection every five seconds and releases its terminal ownership after 15 seconds without a pong. A visible viewer at the live edge then reclaims the vacant size lock automatically; typing on other devices does not wait for that recovery. A healthy idle browser answers pings without any typing.

Under `aoe serve --read-only` the terminal renders the stream but drops keystrokes, and the session-row delete and triage actions are hidden.

## On mobile

The phone renders the same live view, tuned for touch:

- **Scrolling** is the browser's own, over the pane's real scrollback. For a full-screen agent, whose scrollback lives inside the app, a drag is forwarded as wheel input, one line at a time and paced to the app's redraws.
- **Selection** is native: long-press to select and copy.
- **Typing** goes back over the same WebSocket. A paste of any length arrives whole: it is split across several `send-keys` calls of at most 512 bytes each, because tmux 3.7 rejects a command with more than 1000 arguments ("command too long") and each byte is one argument. Tapping the terminal opens the soft keyboard, except in a full-screen app with mouse support, where a tap is a click; the floating keyboard button toggles it either way. The key row adds Esc, Tab, a `Ctrl` toggle, paste, and compose by default, and ends with Enter while the soft keyboard is closed if the row has room; pick and order its keys under Settings > Terminal. Toolbar key sequences consume the one-shot Ctrl modifier, including Enter, Ctrl+C, and held repeats. Drag the joystick above the keyboard button for arrow keys. Compose opens a text box for dictation, autocorrect, and long-press paste, and sends the text as one paste. Opening the keyboard never resizes the agent's pane.
- **Pinch** adjusts the font size, resizing the pane once the gesture ends.

A "Back to live" pill appears while you are scrolled up, and the pane stays mounted across view switches so the connection and scroll position survive.
