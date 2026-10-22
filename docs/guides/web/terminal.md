# Terminal View

For tmux-backed sessions the dashboard renders the agent's pane as a live terminal, plus an optional paired shell. For ACP sessions, see the [structured view](../../structured-view.md).

![The agent terminal rendered in the browser](../../assets/web/terminal.png)

## Agent terminal

The server renders the pane and pushes its rows over a WebSocket; the dashboard draws them as real text, so scrolling, selection, and zoom are the browser's own. There is no xterm.js and no PTY attach.

Where it can, the server renders from the [VT live transport](../live-mode.md#the-vt-live-transport) and otherwise falls back to `capture-pane` snapshots on a 50 ms cadence with `tmux send-keys` for input. The fallback cannot withhold a half-drawn repaint. Add `?livedebug=1` to the URL to see which transport a session uses, plus frame rate and arrival-to-paint latency.

Scrolling up into history widens the window the server sends and surfaces a **Back to live** button; scrolling back to the bottom returns to the live tail. The agent keeps running while you read.

### Typing echoes locally

What you type shows up at once, without waiting for the server to echo it, the way mosh does it:

- A printable character appears at the cursor the moment you press it, and Backspace removes the character before the cursor at once. Dim text to the right of the cursor (an input placeholder, such as Claude's `Try "..."`) is cleared as you type; other text to the right moves along. When the server's next frame arrives, the prediction gives way to the real screen; when they agree, nothing visibly changes.
- Only plain single-cell characters and Backspace are predicted, on the normal screen (not a full-screen app), at the live edge, while this browser owns the terminal, and only up to the end of the cursor's row. Any other key (Enter, Tab, Esc, arrows, Ctrl or Alt chords, a paste carrying control characters, a wide character) drops every pending prediction and waits for the server, like before.
- A prediction is shown at once only on a row whose prompt has already echoed this browser's typing (the row's text up to the first space after its first word: Claude's `❯`, your shell prompt). On any other row the first character waits for the server's echo, and once it arrives the rest of that row is predicted again. A row that never echoes, such as a password prompt, never shows your input.
- A prediction the server contradicts (the cursor or the text left of it ends up somewhere else) is dropped as soon as that frame arrives, and one the server has not confirmed within 1.5 s is dropped and its row has to earn trust again. The cost of a wrong guess is that for up to one round trip you see a character the app then draws differently or not at all.
- Prediction can only ever add a preview; it never stands between a key and the session. Every key is sent exactly as if prediction were off, and a key the pane did not receive drops every prediction. A row prediction cannot reason about is simply not predicted, never an error: the cursor past the row's last visible character (the screen does not keep trailing spaces, so this is the normal state right after typing a space), an empty row, a window split into panes (whose cursor row carries the other pane's text). If predicting fails anyway, the predictions are dropped and the view shows the server's screen as it is.

### Switching sessions

Opening a session shows a screen at once instead of a "Starting session..." placeholder:

- The browser remembers the last screen of the 32 sessions it showed most recently, per terminal (agent pane, each paired shell), for as long as the page stays open. Opening one of them draws that screen immediately while the session is started (if it was stopped) and its live stream connects, which takes a few round trips to the server; the live stream then replaces it. Only the screen is remembered: scrolling up waits for the live stream.
- Resting the pointer on a session in the sidebar fetches its current agent screen in the background (at most once every 10 seconds per session), so a session not yet opened in this page also appears at once when clicked.
- Without a remembered or prefetched screen (the first open on a touch device, say), the placeholder shows until the stream connects.

## Copy and scroll

The terminal uses tmux for scrollback and selection, so no modifier keys are involved. Scroll with the wheel or a one-finger swipe. Select by click-dragging; dragging past the top edge scrolls into scrollback and extends the selection, and releasing copies to your system clipboard automatically.

While a selection touches the terminal the pane stops repainting, so the agent cannot rewrite the text under it mid-gesture, and newly captured history loads in above the held rows. A full-screen mouse agent also gives up its grip on touch gestures while a selection is live, so the handles stay draggable. Such an agent copies through OSC 52 instead, which AoE forwards to the same browser clipboard path.

Copy relies on the browser Clipboard API, which needs a secure context: HTTPS or `http://localhost`. On a plain-HTTP LAN origin the selection stays visible but is not copied. Firefox is best-effort; Chromium and Safari copy reliably.

## Paired terminal

Each session can open a **paired terminal**: a host shell (or, for a sandboxed session, one inside the container) rooted at the session's working directory. On desktop it shares the split with the agent terminal; on mobile it is one of the right-panel views. It stays alive in the background when you switch away. Its terminal 1 is the same shell the TUI opens with `T`, in the matching Host or Container mode.

The **Container** tab launches the container user's preferred shell, resolved inside the container from the passwd entry, then `$SHELL`, then bash or sh. Candidates must be regular executables that either have a recognized shell name or appear in `/etc/shells`; known-compatible shells run in login mode.

## Reconnect

If the WebSocket drops (network blip, tunnel re-auth, daemon restart), the terminal retries on a fast ladder (200 ms through 10 s), so transient warm-up failures recover in well under five seconds. A banner shows the state, and a permanently dead pane offers a manual retry instead of looping. The banner names the close code the server returned:

| Code | Reason | Meaning |
| ---- | ------ | ------- |
| 1001 | `server shutdown` | Daemon is shutting down; retries normally. |
| 1013 | `tmux_not_ready` | Pane was not capturable within 2s, usually a benign warm-up; retries normally. |
| 4001 | `pty_dead` | The pane permanently exited; shows a retry banner. |

Under `aoe serve --read-only` the terminal renders the stream but drops keystrokes, and the session-row delete and triage actions are hidden.

## On mobile

The phone renders the same live view, tuned for touch:

- **Scrolling** is the browser's own, over the pane's real scrollback. For a full-screen agent, whose scrollback lives inside the app, a drag is forwarded as wheel input, one line at a time and paced to the app's redraws.
- **Selection** is native: long-press to select and copy.
- **Typing** goes back over the same WebSocket. Tapping the terminal opens the soft keyboard, except in a full-screen app with mouse support, where a tap is a click; the floating keyboard button toggles it either way. The key row adds Esc, Tab, a `Ctrl` toggle, paste, and compose by default, and ends with Enter while the soft keyboard is closed if the row has room; pick and order its keys under Settings > Terminal. Toolbar key sequences consume the one-shot Ctrl modifier, including Enter, Ctrl+C, and held repeats. Drag the joystick above the keyboard button for arrow keys. Compose opens a text box for dictation, autocorrect, and long-press paste, and sends the text as one paste. Opening the keyboard never resizes the agent's pane.
- **Pinch** adjusts the font size, resizing the pane once the gesture ends.

A "Back to live" pill appears while you are scrolled up, and the pane stays mounted across view switches so the connection and scroll position survive.
