//! Cross-agent fork: hand one agent's conversation to a different agent.
//!
//! A captured session id is agent-shaped, so `codex` cannot resume a Claude
//! conversation and vice versa (see `fork.rs` for the same-agent path). What
//! both agents *can* do is read the other's transcript off disk, so a
//! cross-agent fork starts a fresh session of the target agent seeded with a
//! prompt naming the source transcript.

use std::path::{Path, PathBuf};

use super::capture::encode_claude_project_path;

/// Why a cross-agent fork was refused, for a user-facing message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HandoffDenied {
    /// AoE cannot locate this agent's transcripts on disk, so there is nothing
    /// to hand over.
    SourceNotSupported,
    /// The target agent takes no prompt on the command line, so the handoff
    /// instruction could not reach it.
    TargetNotSupported,
}

/// Agents whose transcript AoE knows how to find on disk.
fn source_supported(tool: &str) -> bool {
    matches!(tool, "claude" | "codex")
}

/// The skill a handed-to agent is asked to use, when it has it installed.
fn continue_skill(source_tool: &str) -> String {
    format!("continue-{source_tool}-session")
}

/// Decide whether `source_tool`'s conversation can be handed to `target_tool`.
pub(crate) fn cross_agent_handoff(
    source_tool: &str,
    target_tool: &str,
) -> Result<(), HandoffDenied> {
    if !source_supported(source_tool) {
        return Err(HandoffDenied::SourceNotSupported);
    }
    if !crate::agents::get_agent(target_tool).is_some_and(|a| a.accepts_prompt_argument) {
        return Err(HandoffDenied::TargetNotSupported);
    }
    Ok(())
}

/// The agents this tool's conversation can be handed to, for a UI that offers
/// the switch. Empty when nothing can take it (so the affordance hides).
pub(crate) fn handoff_targets(source_tool: &str) -> Vec<&'static str> {
    if !source_supported(source_tool) {
        return Vec::new();
    }
    crate::agents::AGENTS
        .iter()
        .filter(|a| a.accepts_prompt_argument && a.name != source_tool)
        .map(|a| a.name)
        .collect()
}

/// The transcript file for a captured session id, when it is already on disk.
/// `home` is the user's home directory. Returns `None` when the agent has not
/// written the file yet, in which case the prompt falls back to the bare id.
pub(crate) fn locate_transcript(
    source_tool: &str,
    session_id: &str,
    cwd: &str,
    home: &Path,
) -> Option<PathBuf> {
    match source_tool {
        "claude" => {
            let path = home
                .join(".claude/projects")
                .join(encode_claude_project_path(cwd))
                .join(format!("{session_id}.jsonl"));
            path.is_file().then_some(path)
        }
        // Codex files its rollouts under YYYY/MM/DD and names them
        // `rollout-<timestamp>-<uuid>.jsonl`, so the id is a filename suffix
        // and the date is unknown here. Newest first, so a resumed thread's
        // latest rollout wins.
        "codex" => {
            let suffix = format!("-{session_id}.jsonl");
            let mut found: Vec<PathBuf> = Vec::new();
            let mut dirs = vec![home.join(".codex/sessions")];
            while let Some(dir) = dirs.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        dirs.push(path);
                    } else if path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                    {
                        found.push(path);
                    }
                }
            }
            found.sort();
            found.pop()
        }
        _ => None,
    }
}

/// The prompt the target agent launches with. One line, so it survives
/// shell-escaping into a single argv entry.
pub(crate) fn handoff_prompt(
    source_tool: &str,
    session_id: &str,
    transcript: Option<&Path>,
) -> String {
    let skill = continue_skill(source_tool);
    let where_it_is = match transcript {
        Some(path) => format!("Its transcript is {}", path.display()),
        None => format!("Its transcript is the {source_tool} session file for that id"),
    };
    format!(
        "Continue the work from the {source_tool} session {session_id} that ran in this \
         directory. {where_it_is}. Use the {skill} skill if you have it; otherwise read the \
         transcript yourself, oldest first. Catch up before you act, check the working tree \
         against what it says, and carry on from there rather than restarting the task."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_agent_pairs_are_gated_by_both_ends() {
        let cases = [
            ("claude", "codex", Ok(())),
            ("codex", "claude", Ok(())),
            // opencode forks natively but AoE cannot find its transcript.
            ("opencode", "claude", Err(HandoffDenied::SourceNotSupported)),
            // gemini takes no prompt argument AoE has verified.
            ("claude", "gemini", Err(HandoffDenied::TargetNotSupported)),
        ];
        for (source, target, expected) in cases {
            assert_eq!(
                cross_agent_handoff(source, target),
                expected,
                "{source} -> {target}"
            );
        }
    }

    #[test]
    fn targets_are_the_other_prompt_taking_agents() {
        assert_eq!(handoff_targets("claude"), vec!["codex"]);
        assert_eq!(handoff_targets("codex"), vec!["claude"]);
        // Nothing to hand over from an agent whose transcript AoE cannot find.
        assert!(handoff_targets("opencode").is_empty());
        // Every offered target must actually be accepted by the gate, so a UI
        // built from this list cannot offer a create the server then refuses.
        for source in ["claude", "codex"] {
            for target in handoff_targets(source) {
                assert_eq!(
                    cross_agent_handoff(source, target),
                    Ok(()),
                    "{source}->{target}"
                );
            }
        }
    }

    #[test]
    fn transcripts_are_located_per_agent_and_absent_when_unwritten() {
        let home = tempfile::tempdir().unwrap();
        let cwd = "/home/u/src/demo";
        let claude_dir = home
            .path()
            .join(".claude/projects")
            .join(encode_claude_project_path(cwd));
        std::fs::create_dir_all(&claude_dir).unwrap();
        let claude_file = claude_dir.join("11111111-2222-3333-4444-555555555555.jsonl");
        std::fs::write(&claude_file, "{}").unwrap();

        let codex_dir = home.path().join(".codex/sessions/2026/09/09");
        std::fs::create_dir_all(&codex_dir).unwrap();
        let codex_file = codex_dir
            .join("rollout-2026-09-09T11-00-00-01a08618-7139-75e0-aafc-cbee896ad3f9.jsonl");
        std::fs::write(&codex_file, "{}").unwrap();

        assert_eq!(
            locate_transcript(
                "claude",
                "11111111-2222-3333-4444-555555555555",
                cwd,
                home.path()
            ),
            Some(claude_file)
        );
        assert_eq!(
            locate_transcript(
                "codex",
                "01a08618-7139-75e0-aafc-cbee896ad3f9",
                cwd,
                home.path()
            ),
            Some(codex_file),
            "a codex rollout is found under its date directory, by id suffix"
        );
        // Not yet written, and an agent AoE cannot locate at all.
        assert_eq!(
            locate_transcript(
                "claude",
                "99999999-0000-0000-0000-000000000000",
                cwd,
                home.path()
            ),
            None
        );
        assert_eq!(
            locate_transcript("opencode", "whatever", cwd, home.path()),
            None
        );
    }

    #[test]
    fn prompt_carries_everything_the_new_agent_needs() {
        let path = PathBuf::from("/home/u/.claude/projects/-home-u-src-demo/abc.jsonl");
        let prompt = handoff_prompt("claude", "abc", Some(&path));
        for needle in [
            "claude",
            "abc",
            "continue-claude-session",
            "/home/u/.claude/projects/-home-u-src-demo/abc.jsonl",
        ] {
            assert!(
                prompt.contains(needle),
                "{needle:?} missing from {prompt:?}"
            );
        }
        assert!(
            !prompt.contains('\n'),
            "prompt must stay one line to survive shell escaping: {prompt:?}"
        );
        // The other direction names the other skill.
        assert!(handoff_prompt("codex", "abc", None).contains("continue-codex-session"));
        // With no transcript on disk the id still travels.
        let bare = handoff_prompt("codex", "01a0-xyz", None);
        assert!(bare.contains("01a0-xyz"), "{bare:?}");
    }
}
