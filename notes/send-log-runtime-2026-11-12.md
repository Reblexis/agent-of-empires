# Send log installed on the 1.21 runtime, 12 Nov 2026 02:54 UTC

- Source: branch fix/send-log-runtime at 7d2715a9b = installed source b6a0b7dc9 (fix/open-session-scroll-runtime) plus a port of 403ff2fe2 (main, PR #20). No PR (the runtime line is not canonical main). Deploying main instead would have dropped the owner tree, the Active/All view and the other runtime-only commits.
- Port: main logs only the terminal-pane path; this line also has the native Codex queue and structured-view paths, and each logs one line. Docs in docs/guides/send-log.md.
- Binary: ~/.local/bin/aoe sha256 67800d8d5832427713fb16f49027217418dcbb96c64435f6a8db0b87c8b13eea (copy: ~/.local/bin/aoe.send-log-7d2715a9b). Previous: bcb642da39a96a43ee126e08364e3886a700ca3d12946ab2d39716eb69be2f8e (kept as ~/.local/bin/aoe.before-send-log). `aoe --version` still prints 1.21.0 (the package version is unchanged); the sha256 identifies the build.
- Before install: a private isolated daemon of the new binary returned 200 for root, all 5 referenced assets and /api/sessions; its entry bundle /assets/index-DGbEYH12.js equals the live one.
- Process: aoe-serve MainPID 712816 to 3543704. Only aoe-serve was restarted.
- Preservation: aoe list 1133 sessions before and after, none missing or new; tmux panes 38 before and after, every pane pid unchanged; aoe session verify-pointers clean.
- Verification: live sends began appending to ~/.config/agent-of-empires/sends.log within seconds of the restart. A test `aoe send` of `/cost` to a throwaway session appended one line whose sha256 equals sha256("/cost") and whose sender is the sending session; the test session was purged.
- Tests: send_log_keeps_time_target_sender_and_hash_but_never_the_text passes; the cli send tests pass. Full Rust suite not run; tui file_watch reload_storage_only_preserves_live_send_state_while_adding_peer_row failed once under parallel load and passed 3/3 alone.
- Rollback: cp ~/.local/bin/aoe.before-send-log ~/.local/bin/aoe.new && mv ~/.local/bin/aoe.new ~/.local/bin/aoe && systemctl --user restart aoe-serve
