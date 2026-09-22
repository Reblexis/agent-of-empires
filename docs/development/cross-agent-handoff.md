# Cross-agent handoff integration

## Behavior

The [session fork guide](../guides/session-fork.md#forking-across-agents) defines the behavior. The dashboard header offers the other agent after a Claude or Codex session has a captured conversation. One click creates and opens a terminal session in the same directory. Its first launch names the source transcript and the corresponding continuation skill. Later launches do not repeat the handoff prompt. The original session remains intact.

The server computes availability and rechecks the source when creating the new session. Unsupported agents, missing conversations, unknown sources, same-agent handoffs, and simultaneous native-fork and handoff requests are refused. CityHall clears the handoff request alongside native forks and imports.

## Integration on 2026-09-22

The feature existed in commits `ef39441d` and `c015ca29` on `cross-agent-fork`, but the installed `local-defaults` build did not include it. This integration ports those two commits to the existing local build without importing unrelated upstream changes. The newer branch's split session and API modules map to this build's `src/session/instance.rs` and `src/server/api/sessions.rs`.

## Verification

- The header regression tests failed before integration because the handoff button was absent, then passed after integration.
- The browser regression fails against the previous installed binary specifically at the missing `Continue in codex` button, and passes the complete handoff against both the integrated debug binary and the installed release binary.
- All 3,732 web unit tests pass. Type checking, formatting, lint, and coverage-matrix validation pass.
- Six Rust handoff tests pass. The persistence test also verifies that the handoff intent becomes the normal resume intent after launch.
- Clippy completes with warnings in unchanged files.
- The full Rust run finishes with 6,346 passed, 10 failed, and 2 existing ignored tests. The failures are outside the handoff tests: Git 2.34.1 does not support `git worktree list -z`; login fixtures inherit group-writable directories under umask 0002; an OMP fixture attempts to access `/home/test/.omp/.env`. All 43 login tests pass when rerun under umask 0077.

The live browser test uses isolated storage and stub agent executables. It checks the actual header button, create request, opened Codex session, received skill and transcript arguments, consumed handoff intent, and preserved source session without asking a real agent to resume user work.

## Installed result

The release binary was installed and the dashboard service restarted on 2026-09-22. All 15 pre-existing tmux sessions remained present. An authenticated browser check of the installed dashboard confirmed the `Continue in codex` button on an existing Claude session. The integration is included in the pushed `local-defaults` branch.
