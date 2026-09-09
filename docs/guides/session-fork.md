# Forking Sessions

Forking a session starts a new, independent AoE session from an existing session's conversation context, so you can take the same history in a different direction. The original session and its transcript are left untouched.

To branch a conversation into a new session rather than continuing the same one in place, fork it. (To continue the same conversation, see [Session Resume](./session-resume.md).)

## How to fork

### TUI

Open the command palette and run **Fork session (resume context, diverge)**, or right-click a session row and choose **Fork session**. There is no keyboard shortcut by design; the palette and the context menu are the two entry points.

The new-session dialog opens prefilled with the source session's working directory and group, with the title defaulted to `<name> (fork)`. Adjust anything you like, then create the session.

### Web dashboard

Open a session's context menu in the sidebar and choose **Fork session**. The option appears for forkable structured sessions.

### CLI

Pass `--fork-from` with the source session's id or title:

```sh
aoe add --fork-from <session-id-or-title>
```

This creates a terminal session that resumes the source's conversation and then runs independently.

The fork inherits the parent's agent by default, so you normally omit `--tool` / `--cmd`. Passing a different agent forks across agents; see below. Because a fork must run in the parent's working directory and filesystem to resolve the prior conversation, `--fork-from` cannot be combined with `--worktree` / `--new-branch`, `--sandbox` / `--sandbox-image`, or a `--cmd` that already carries its own `--resume` flags.

## Forking across agents

Passing a different `--tool` forks the conversation onto the other agent:

```sh
aoe add --fork-from <session-id-or-title> --tool codex
```

A captured conversation is agent-specific: a Claude session id means nothing to Codex,
so this is not a native fork. AoE instead starts a **fresh session of the target agent
in the parent's working directory, seeded with a prompt that points it at the parent's
transcript file** and tells it to read that first and carry on. The new agent starts by
catching up rather than by asking you what to do.

Supported in both directions between `claude` and `codex`, the two agents whose
transcripts AoE can locate on disk. Any other pairing is refused with the agent names,
as is a source session that has not captured a conversation id yet. A cross-agent fork
is a CLI flow: the TUI and web fork actions stay same-agent.

The seeded prompt names the `continue-claude-session` / `continue-codex-session` skill
when the target agent has one installed, and always names the transcript path, so an
agent without that skill can still read the file directly.

Because the target agent starts a brand-new conversation, none of the parent's context
window comes across: only what is written in the transcript. Long sessions therefore
hand over their history, not their working memory.

## What gets inherited

The fork inherits:

- The parent's conversation context, which the fork resumes from.
- The working directory. This is required so the agent can resolve the prior conversation, so the fork runs in the same directory.
- The group.
- The tool (agent).

From there the fork diverges as its own session: it has its own id, shows up separately in the session list, and survives restarts independently of the parent.

## The original is untouched

Forking only reads the parent's conversation. The parent session and its transcript are never modified, so you end up with two independent sessions: the original, exactly as it was, and the new fork.

## Which agents support forking

Forking needs an agent that can branch a conversation:

- **Terminal sessions**: claude, codex, and opencode. Cross-agent forks are limited to
  claude and codex.
- **Structured (ACP) sessions**: the Claude adapter (`claude-agent-acp`).

Resume-only agents (such as gemini, vibe, and copilot) and agents without resume enabled in AoE (such as cursor, droid, kiro, and qwen) cannot fork. For those, the Fork option is hidden or refused.

## Fork vs. resume

Resume continues the same conversation in place; fork branches it into a new, separate one. For resuming a session's own conversation, see [Session Resume](./session-resume.md).
