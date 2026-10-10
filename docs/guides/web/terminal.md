# Terminal View

For tmux-backed sessions the dashboard renders a real terminal in the page: the agent's pane streamed over a WebSocket, plus an optional paired shell. This page covers both terminals, reconnect behavior, and the close codes you may see when a connection fails. For the structured-view rendering used by ACP sessions, see the [Structured view overview](../../structured-view.md).

![The agent terminal rendered in the browser](../../assets/web/terminal.png)

## Agent terminal

The main terminal mirrors the TUI's live mode on every device: the server streams `tmux capture-pane` snapshots of the session's pane over the WebSocket and the dashboard renders them as real text that the browser scrolls natively. Keystrokes go back over the same WebSocket. There is no PTY attach and no tmux copy-mode, and the agent keeps running while you read history.

Scrolling up into history surfaces a **Back to live** button; scrolling back to the bottom (or clicking it) returns to the live tail.

### Scrollback is local

Scrolling never waits on the server, however far away it is:

- When a session's terminal opens, the dashboard downloads the pane's scrollback in the background (the last 4000 lines at most) and keeps that copy current from the live stream, which itself only carries the screen and a little history above it.
- Scrolling through anything already downloaded is the browser's own scroll, with no request to the server. History not downloaded yet (the first round trip after opening) shows as blank lines that fill in when it lands.
- The copy is downloaded again whenever it can no longer be shown to match the pane: the history was cleared, the pane's width changed (tmux re-wraps its history), or more output arrived between two snapshots than a snapshot covers. A copy that matches is never thrown away, including across a reconnect.

A full-screen app on the alternate screen keeps its history inside the app, not in tmux, so there is nothing to download. For a mouse-aware one (Claude Code with `"tui": "fullscreen"`, vim, htop) the wheel is forwarded to the app and each scroll step waits a round trip to the server. To get local scrolling for Claude sessions, turn on **Claude Inline Renderer** (`claude_inline_tui`): aoe then starts Claude with its inline renderer without touching your own Claude settings.

```toml
[session]
claude_inline_tui = true
```

It applies whenever a session's Claude starts or restarts, whatever per-session arguments the session carries, so a running session switches on its next restart.

### Typing echoes locally

What you type shows up at once, without waiting for the server to echo it, the way mosh does it:

- A printable character appears at the cursor the moment you press it, and Backspace removes the character before the cursor at once. Dim text to the right of the cursor (an input placeholder, such as Claude's `Try "..."`) is cleared as you type; other text to the right moves along. When the server's next snapshot arrives, the prediction gives way to the real screen; when they agree, nothing visibly changes.
- Only plain single-cell characters and Backspace are predicted, on the normal screen (not a full-screen app), at the live edge, while this browser owns the terminal, and only up to the end of the cursor's row. Any other key (Enter, Tab, Esc, arrows, Ctrl or Alt chords, a paste carrying control characters, a wide character) drops every pending prediction and waits for the server, like before.
- A prediction is shown at once only on a row whose prompt has already echoed this browser's typing (the row's text up to the first space after its first word: Claude's `❯`, your shell prompt). On any other row the first character waits for the server's echo, and once it arrives the rest of that row is predicted again. A row that never echoes, such as a password prompt, never shows your input.
- A prediction the server contradicts (the cursor or the text left of it ends up somewhere else) is dropped as soon as that snapshot arrives, and one the server has not confirmed within 1.5 s is dropped and its row has to earn trust again. The cost of a wrong guess is that for up to one round trip you see a character the app then draws differently or not at all.
- Prediction can only ever add a preview; it never stands between a key and the session. Every key is sent exactly as if prediction were off, and a row prediction cannot reason about is simply not predicted, never an error: the cursor past the row's last visible character (the screen does not keep trailing spaces, so this is the normal state right after typing a space), an empty row, a window split into panes (whose cursor row carries the other pane's text). If predicting fails anyway, the predictions are dropped and the view shows the server's screen as it is.

### Switching sessions

Opening a session shows a screen at once instead of a "Starting session..." placeholder:

- The browser remembers the last screen, and the downloaded scrollback, of the 32 sessions it showed most recently, for as long as the page stays open. Opening one of them shows that screen immediately while the session is started (if it was stopped) and its live stream connects, which takes a few round trips to the server; the live stream then replaces it. Keys typed meanwhile are delivered once the stream connects.
- Resting the pointer on a session in the sidebar fetches its current screen in the background (at most once every 10 seconds per session), so a session not yet opened in this page also appears at once when clicked.
- Without a remembered or prefetched screen (the first open on a touch device, say), the placeholder shows until the stream connects, as before.

## Copy and scroll

The terminal renders tmux's scrollback as page text, so copy and scroll work with no modifier keys:

- **Scroll** with the mouse wheel (or a one-finger swipe on touch) through the pane's scrollback (see above). Touch scrolling follows the finger like any native list: drag down to look back through history, drag up to head back toward the live tail.
- **Select** by click-dragging across the text. Releasing the drag copies to your system clipboard automatically; no Ctrl/Cmd+C needed.

Mouse-enabled full-screen agents copy through OSC 52 instead: AoE forwards the agent's clipboard event through the live connection to the same browser clipboard path.

Copy relies on the browser Clipboard API, which only works in a secure context: HTTPS (the remote-access tunnel modes) or `http://localhost`. On a plain-HTTP LAN/VPN origin the browser blocks clipboard writes, so the selection stays visible but is not copied. Firefox is best-effort (it lacks the async clipboard write); Chromium and Safari copy reliably.

## Paired terminal

Each session can open a **paired terminal**: a host (or, for sandboxed sessions, in-container) shell rooted at the session's working directory. On desktop it shares the split with the agent terminal; on mobile it is one of the right-panel picker's views. It stays alive in the background when you switch away, preserving scrollback and focus.

For sandboxed sessions, the **Container** tab launches the container user's login shell, resolved inside the container (passwd entry, then `$SHELL`, then bash, sh), so your prompt, aliases, and oh-my-zsh setup load like the Host tab.

## Reconnect

If the WebSocket drops (network blip, tunnel re-auth, daemon restart), the terminal reconnects on a fast-start retry ladder (200ms, 400ms, 800ms, 1.5s, 3s, 6s, 10s) so transient warm-up failures recover in well under five seconds. A disconnect banner shows the current state; a permanently dead pane surfaces a manual retry button instead of looping.

### Terminal WebSocket close codes

When the browser fails to reach a working terminal, the disconnect banner shows the close code returned by the server:

| Code | Reason string         | Meaning                                                                                                | Client behavior            |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- |
| 1001 | `server shutdown`     | Daemon is shutting down (SIGINT/SIGTERM).                                                               | Retry with normal backoff. |
| 1011 | `openpty_failed`      | Server could not allocate a PTY.                                                                        | Retry with normal backoff. |
| 1011 | `attach_spawn_failed` | Server could not spawn the `tmux attach-session` child process.                                        | Retry with normal backoff. |
| 1011 | `pty_reader_failed`   | Server could not clone the PTY reader handle.                                                           | Retry with normal backoff. |
| 1011 | `pty_writer_failed`   | Server could not take the PTY writer handle.                                                            | Retry with normal backoff. |
| 1013 | `tmux_not_ready`      | Pane did not become attachable within 2s. Usually a benign warm-up on first session open.              | Retry with normal backoff. |
| 4001 | `pty_dead`            | PTY relay was running but the pane permanently exited.                                                  | Show "Click retry" banner. |

## Read-only mode

When the server runs with `aoe serve --read-only`, the terminal renders the live stream but drops keystrokes: you can watch sessions but not type into them. The session-row Delete and triage actions are hidden too.

## On mobile

The same live view makes the phone experience native:

- **Scrolling is the browser's own scroll**: momentum, rubber-banding, and finger-true tracking, over the pane's scrollback downloaded as above.
- **Text selection is native**: long-press to select and copy, like any web page.
- **Typing** goes back over the same WebSocket and is delivered with `tmux send-keys`. A paste of any length arrives whole: it is split across several `send-keys` calls of at most 512 bytes each, because tmux 3.7 rejects a command with more than 1000 arguments ("command too long") and each byte is one argument. Tapping anywhere on the terminal brings up the soft keyboard, the floating keyboard button toggles it open and closed, and the terminal toolbar provides arrows, Tab, Esc, a `Ctrl` modifier toggle, interrupt, and paste.
- **Pinch** adjusts the font size; the pane resizes the tmux window to the resulting grid.

A "Back to live" pill appears while you are scrolled up; tapping it (or scrolling to the bottom) returns to the live tail. The pane stays mounted while you switch views so the connection and scroll position survive.
