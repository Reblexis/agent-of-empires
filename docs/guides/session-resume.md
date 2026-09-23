# Session Resume (Claude)

Claude Code sessions launched through AoE resume their prior conversation automatically after a reboot, an `aoe` upgrade, or a `kill-server`. No need to hunt through `/resume` to find the right session.

This is automatic and on by default. Runtime conversation changes (via `/clear`, `--fork-session`, `--continue`, or starting fresh in the pane) are picked up too, in both host and sandboxed (Docker) modes.

To branch a conversation into a new session instead of resuming it in place, see [Forking Sessions](./session-fork.md).

## Pinning or resetting a conversation

Pin a session to a specific Claude conversation:

```sh
aoe session set-session-id <session-name-or-id> <claude-session-uuid>
```

The pin is sticky: every launch passes `--resume <uuid>` until you change it. If AoE cannot prove whether a pinned conversation is invalid and only sees the resumed pane exit, it preserves the pinned ID and reports a recoverable resume failure instead of starting fresh automatically.

Retry after fixing the underlying issue, set a different conversation ID, or explicitly start fresh once with the command below.

Start fresh once:

```sh
aoe session set-session-id <session-name-or-id> ""
```

This is one-shot; the next launch starts fresh, then auto-resume takes over again. To stay fresh every launch, clear before each restart.

Structured-view sessions manage their own conversation through ACP and reject `set-session-id`. Toggle the session out of structured view first, or set the resume target through the structured view UI.

## Importing existing Claude Code sessions (web dashboard)

If you already have Claude Code conversations started outside AoE (plain `claude` in a terminal), you can pull one into a structured-view session from the web dashboard.

In the new-session wizard, open the **Import from Claude** tab. The tab only appears when both Claude Code and its ACP adapter (`claude-agent-acp`) are installed, since the import resumes the conversation through that adapter. It lists the Claude Code sessions found on disk (under `$CLAUDE_CONFIG_DIR` or `~/.claude/projects`), newest first, with each session's first prompt, working directory, and last-used time. Type in the filter box to narrow by title or path.

Pick a session and launch. AoE creates a structured-view session in that conversation's original working directory and resumes it, so the prior transcript shows up in the structured view and you can keep going. The import always uses the recorded working directory and does not create a worktree, because the conversation only resolves in the directory it was started in.

The list only shows conversations worth importing: AoE's own Claude sessions are filtered out, including scratch sessions, sessions AoE already manages, and any conversation living inside an AoE worktree directory (the `*-worktrees` folders AoE creates for sessions). Sessions whose working directory no longer exists are hidden by default, since they cannot be resumed; tick "show missing directories" to see them (they appear disabled).

This reads the existing conversation in place; the original session keeps existing and is not copied.

## How the conversation ID stays correct

Contract: **a tab's recorded conversation (`agent_session_id`) is always the conversation that tab's own agent process is running, and it changes only on evidence produced by that process.** AoE never infers a tab's conversation from which transcript files exist on disk. Applies to Claude and Codex tabs, host and sandboxed.

### The only sources allowed to change it

1. **Launch.** The ID AoE hands the agent when it starts the pane: `--resume <id>` (or `codex resume <id>`), or, for a fresh Claude start, a new UUID passed as `--session-id <uuid>`. It is recorded before the process starts.
2. **The tab's own hook.** Claude's and Codex's `SessionStart` and `UserPromptSubmit` hooks run `aoe __extract-session-id`, which writes the payload's `session_id` to that tab's sidecar (`/tmp/aoe-hooks-<uid>/<instance_id>/session_id`). The hook identifies the tab through `AOE_INSTANCE_ID`, which only the tab's pane environment carries, so AoE's one-shots and any `claude`/`codex` run outside AoE can never write it. This is how `/clear`, `/resume`, `/new` and a fresh Codex start are picked up. A sidecar is valid for as long as its pane process lives, whatever its age.
3. **The user.** `aoe session set-session-id`.

AoE deletes a tab's sidecar immediately before it (re)launches the pane, so a value left by a previous run is never read. While a tab has no evidence yet (the window between launch and the first hook), its recorded ID stays what it was. **No fallback scan exists**: "newest transcript in the project directory" is not a source, and neither is the newest Codex rollout for a cwd.

### Guards on every change

Every write, whatever its source except the user, is checked before it lands. A refused write leaves the pointer unchanged and is logged at WARN with the reason:

- **Never a one-shot.** A transcript whose first user message is one of AoE's own one-shot prompts (smart-rename title, context recap, conversation summary) is refused, for Claude transcripts and Codex rollouts alike. One-shots also run in an isolated scratch directory (`<AoE config dir>/oneshot` on the host, `/tmp` in a sandbox), never the project directory.
- **Never another tab's conversation.** An ID held by another non-archived tab is refused. Two tabs never share a conversation.

### Trackability

- **Pointer journal.** Every change is appended to `<AoE config dir>/pointer-journal.jsonl`, one JSON object per line: `ts`, `instance_id`, `title`, `old`, `new`, `source` (`launch`, `hook`, `user`, `repair`), and `refused` with the reason when a guard rejected it. The file is append-only and never rotated, so any tab's history can be replayed after a reboot.
- **Verifier.** `aoe session verify-pointers` checks every non-archived tab and exits non-zero on any violation: an ID shared by two tabs, an ID whose transcript is a one-shot, or a running pane whose agent process was launched with a different ID than the one recorded while no hook has reported since. The daemon runs the same check at startup and every 5 minutes and logs each violation at ERROR under `session.pointer_invariant`.

Other agents (Gemini, OpenCode, Pi, and the rest) still use their own capture paths and are outside this contract.

## Disabling

There is no toggle. To start fresh once, use `set-session-id ""`. To drop the persisted state entirely, delete the session and recreate it.

## Storage

State lives in `sessions.json` in your AoE config directory:

- **Linux**: `$XDG_CONFIG_HOME/agent-of-empires/profiles/<profile>/sessions.json`
- **macOS/Windows**: `~/.agent-of-empires/profiles/<profile>/sessions.json`

Three relevant fields:

- `agent_session_id`: the observed conversation ID. Auto-managed; do not edit.
- `resume_intent`: your intent (`Default`, `Use(uuid)`, `Cleared`). Set via the CLI above. Absent when `Default`.
- `resume_probe_failed_sid`: the last pinned ID whose resume probe failed ambiguously.
  This loop-breaker prevents startup recovery from retrying that same ID automatically until user action changes the resume state.
