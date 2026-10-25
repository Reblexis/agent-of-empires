//! On-demand "what is happening here" recap for terminal (tmux) sessions.
//!
//! Mirrors [`crate::session::conversation_summary`] for sessions that have no
//! ACP event store: the transcript source is the tmux pane's full scrollback
//! (ANSI-stripped, head+tail bounded), and the result is cached in daemon
//! memory rather than published as an event. The web "Context" pane reads the
//! cache via `GET /api/sessions/{id}/terminal-context` and regenerates via the
//! `POST` twin; generation is on-demand only, so an unopened pane costs
//! nothing.
//!
//! The one-shot runs the same utility agent smart-rename resolves
//! (`smart_rename_agent`, empty = the session's own agent) on the cheap model
//! tier: a recap is read once at a glance, so it should not bill the frontier
//! model the way the structured-view summary deliberately does.

use crate::agents;
use crate::session::smart_rename::{resolve_rename_tool, truncate_bytes, SkipReason};
use serde::Serialize;
use std::collections::HashMap;

// Preserve the opening goal as well as recent activity within the argv budget.
const CONTEXT_HEAD_BYTES: usize = 16 * 1024;
const CONTEXT_TAIL_BYTES: usize = 16 * 1024;

/// A recap reads ~32 KiB of transcript on the cheap tier; standalone calls
/// finish well under a minute, and the pane shows a spinner meanwhile.
pub const CONTEXT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Only one recap one-shot runs at a time process-wide, for the same reason
/// `conversation_summary` pins one: a large-transcript call must not starve
/// smart-rename's snappy title pool.
pub const MAX_CONCURRENT: usize = 1;

/// One cached recap. `generated_at` lets the pane decide staleness against
/// the session's `idle_entered_at`: a turn that ended after generation makes
/// the recap stale.
#[derive(Debug, Clone, Serialize)]
pub struct ContextSnapshot {
    pub text: String,
    pub generated_at: chrono::DateTime<chrono::Utc>,
}

/// Stable identity prefix, also recognized in older one-shot transcripts.
pub(crate) const INSTRUCTION: &str =
    "You are given the terminal scrollback of a coding-agent session.";

/// Resolve the agent for a terminal-context one-shot and gate it: terminal
/// sessions only, one-shot-capable, not sandboxed, not command-overridden.
/// The inverted `structured` gate aside, semantics match
/// [`crate::session::conversation_summary::resolve_summary_agent`].
pub fn resolve_context_agent(
    structured: bool,
    session_tool: &str,
    utility_setting: &str,
    sandboxed: bool,
    session_command: &str,
    overrides: &HashMap<String, String>,
) -> Result<&'static agents::AgentDef, SkipReason> {
    if structured {
        // Structured sessions already have the event-store summary
        // (`/summarize`); this path is for panes tmux can capture.
        return Err(SkipReason::NotStructured);
    }
    if sandboxed {
        return Err(SkipReason::Sandboxed);
    }
    let context_tool = resolve_rename_tool(session_tool, utility_setting);
    let Some(agent) = agents::get_agent(context_tool) else {
        return Err(SkipReason::NoOneshot);
    };
    if agent.oneshot_flag.is_none() {
        return Err(SkipReason::NoOneshot);
    }
    let (command, override_in_cfg) = if context_tool == session_tool {
        (session_command, overrides.contains_key(session_tool))
    } else {
        ("", overrides.contains_key(context_tool))
    };
    if override_in_cfg || (!command.is_empty() && command != agent.binary) {
        return Err(SkipReason::CommandOverridden);
    }
    Ok(agent)
}

pub fn build_context_prompt(title: &str, previous: Option<&str>, transcript: &str) -> String {
    let mut prompt = format!(
        "{INSTRUCTION}\n{}\n\nSession title (a hint):\n{}",
        crate::session::conversation_summary::RECAP_FORMAT,
        truncate_bytes(title.trim(), 256)
    );
    if let Some(previous) = previous.filter(|text| !text.trim().is_empty()) {
        prompt.push_str(
            "\n\nPrevious recap (retain its overall goal unless the user clearly replaced it):\n",
        );
        prompt.push_str(truncate_bytes(previous.trim(), 4096));
    }
    prompt.push_str("\n\nScrollback (opening conversation, then latest activity):\n");
    prompt.push_str(&bound_transcript(transcript.trim()));
    prompt
}

/// Bounded head + `...` + tail on char boundaries; whole string if it fits.
/// Same shape as smart-rename's private `head_tail`, at recap-sized budgets.
pub fn bound_transcript(s: &str) -> String {
    if s.len() <= CONTEXT_HEAD_BYTES + CONTEXT_TAIL_BYTES {
        return s.to_string();
    }
    let head = truncate_bytes(s, CONTEXT_HEAD_BYTES);
    let mut start = s.len().saturating_sub(CONTEXT_TAIL_BYTES);
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("{head}\n...\n{}", &s[start..])
}

/// Working directory for the recap one-shot: the shared isolated one-shot
/// directory, never the session's project path, so a recap transcript can never
/// land where a tab's conversation lives (docs/guides/session-resume.md).
pub(crate) use crate::session::smart_rename::oneshot_cwd;

pub use serve::try_terminal_context;

mod serve {
    use super::*;
    use crate::server::AppState;
    use crate::session::conversation_summary::sanitize_summary;
    use crate::session::smart_rename::{resolve_title_model_args, strip_ansi, OneshotModel};
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    /// Marks a session's recap one-shot as in flight so the pane's refresh
    /// button and its stale-on-open trigger cannot spawn concurrent
    /// generators. Removed on drop, so every exit path releases it. Same
    /// shape as `conversation_summary`'s guard.
    struct InflightGuard<'a> {
        set: &'a Mutex<HashSet<String>>,
        id: String,
    }

    impl<'a> InflightGuard<'a> {
        fn acquire(set: &'a Mutex<HashSet<String>>, id: &str) -> Option<Self> {
            let mut guard = set.lock().expect("terminal_context_inflight poisoned");
            let id = id.to_string();
            if !guard.insert(id.clone()) {
                return None;
            }
            Some(Self { set, id })
        }
    }

    impl Drop for InflightGuard<'_> {
        fn drop(&mut self) {
            if let Ok(mut guard) = self.set.lock() {
                guard.remove(&self.id);
            }
        }
    }

    /// Best-effort recap generation for a terminal session. Spawn detached
    /// from the POST endpoint; every failure just leaves the previous (or no)
    /// snapshot in place, and the pane keeps polling GET until `inflight`
    /// clears.
    pub async fn try_terminal_context(state: Arc<AppState>, session_id: String) {
        let Some((profile, tool, title, command, project_path, sandboxed, structured)) = ({
            let instances = state.instances.read().await;
            instances.iter().find(|i| i.id == session_id).map(|i| {
                (
                    i.source_profile.clone(),
                    i.tool.clone(),
                    i.title.clone(),
                    i.command.clone(),
                    i.project_path.clone(),
                    i.is_sandboxed(),
                    i.is_structured(),
                )
            })
        }) else {
            return;
        };

        let resolved = crate::session::resolve_config_with_repo_or_warn(
            &profile,
            std::path::Path::new(&project_path),
        );
        let agent = match resolve_context_agent(
            structured,
            &tool,
            &resolved.session.smart_rename_agent,
            sandboxed,
            &command,
            &resolved.session.agent_command_override,
        ) {
            Ok(agent) => agent,
            Err(reason) => {
                tracing::debug!(target: "terminal_context", session = %session_id, reason = reason.as_str(), "skip");
                return;
            }
        };

        let Some(_guard) = InflightGuard::acquire(&state.terminal_context_inflight, &session_id)
        else {
            return;
        };

        // Capture off the async runtime: capture_pane_full shells out to tmux.
        let tmux_id = session_id.clone();
        let tmux_title = title.clone();
        let captured = tokio::task::spawn_blocking(move || {
            crate::tmux::Session::new(&tmux_id, &tmux_title)
                .ok()
                .and_then(|s| s.capture_pane_full().ok())
        })
        .await
        .ok()
        .flatten();
        let Some(raw_pane) = captured else {
            tracing::debug!(target: "terminal_context", session = %session_id, "skip: pane capture failed");
            return;
        };
        let cleaned = strip_ansi(&raw_pane);
        let trimmed = cleaned.trim();
        if !trimmed.chars().any(|c| c.is_alphabetic()) {
            tracing::debug!(target: "terminal_context", session = %session_id, "skip: unusable pane capture");
            return;
        }
        let previous = state
            .terminal_context
            .lock()
            .expect("terminal_context poisoned")
            .get(&session_id)
            .map(|snapshot| snapshot.text.clone());
        let prompt = build_context_prompt(&title, previous.as_deref(), trimmed);
        let model = OneshotModel::Title(resolve_title_model_args(
            agent,
            &resolved.session.smart_rename_model,
        ));
        let Some(argv) = crate::session::smart_rename::build_oneshot_argv(agent, &prompt, model)
        else {
            return;
        };

        let raw = {
            let Ok(_permit) = state.terminal_context_semaphore.acquire().await else {
                return;
            };
            // Isolated cwd, never the project path: a recap transcript in
            // the session's project dir gets adopted by the session-id
            // poller as the session's conversation. See `oneshot_cwd`.
            crate::session::smart_rename::run_oneshot(
                &session_id,
                &argv,
                &oneshot_cwd(),
                CONTEXT_TIMEOUT,
            )
            .await
        };
        let Ok(raw) = raw else {
            return;
        };
        let Some(text) = sanitize_summary(&raw) else {
            tracing::debug!(target: "terminal_context", session = %session_id, "skip: agent output not a usable recap");
            return;
        };

        tracing::info!(target: "terminal_context", session = %session_id, "generated terminal context recap");
        state
            .terminal_context
            .lock()
            .expect("terminal_context poisoned")
            .insert(
                session_id,
                ContextSnapshot {
                    text,
                    generated_at: chrono::Utc::now(),
                },
            );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_context_agent_gates() {
        let overrides = HashMap::new();
        // Structured sessions are rejected: they have the event-store summary.
        assert_eq!(
            resolve_context_agent(true, "claude", "", false, "", &overrides).err(),
            Some(SkipReason::NotStructured)
        );
        // Terminal claude resolves.
        assert_eq!(
            resolve_context_agent(false, "claude", "", false, "", &overrides)
                .map(|a| a.name)
                .ok(),
            Some("claude")
        );
        // Sandboxed rejected.
        assert_eq!(
            resolve_context_agent(false, "claude", "", true, "", &overrides).err(),
            Some(SkipReason::Sandboxed)
        );
        // A launch-command override of the resolved agent disqualifies it.
        let mut ov = HashMap::new();
        ov.insert("claude".to_string(), "/opt/custom".to_string());
        assert_eq!(
            resolve_context_agent(false, "claude", "", false, "", &ov).err(),
            Some(SkipReason::CommandOverridden)
        );
        // A different utility agent ignores the session agent's override.
        assert_eq!(
            resolve_context_agent(
                false,
                "codex",
                "claude",
                false,
                "custom-codex",
                &HashMap::new()
            )
            .map(|a| a.name)
            .ok(),
            Some("claude")
        );
    }

    #[test]
    fn bound_transcript_keeps_head_and_tail() {
        let long = format!("opening goal{}latest progress", "é".repeat(40 * 1024));
        let bounded = bound_transcript(&long);
        assert!(bounded.len() < long.len());
        assert!(bounded.starts_with("opening goal"));
        assert!(bounded.ends_with("latest progress"));
        assert!(bounded.contains("\n...\n"));
        let short = "hello world";
        assert_eq!(bound_transcript(short), short);
    }

    #[test]
    fn recap_oneshot_cwd_is_isolated_from_any_project_path() {
        let a = oneshot_cwd();
        assert_eq!(a, oneshot_cwd(), "one-shot cwd must be stable");
        assert!(std::path::Path::new(&a).is_absolute());
        assert!(
            a.ends_with("oneshot") || a.ends_with("aoe-oneshot"),
            "got {a}"
        );
        assert!(std::path::Path::new(&a).is_dir(), "created on demand");
    }

    #[test]
    fn context_prompt_keeps_goal_evidence_when_recent_work_changes() {
        let transcript = format!(
            "user: make sign-in reliable\n{}\nuser: rerun the redirect test\nagent: test passed",
            "tool output\n".repeat(5000)
        );
        let p = build_context_prompt(
            "Reliable sign-in",
            Some("Goal: Make sign-in reliable.\n\nRedirect handling was fixed."),
            &transcript,
        );
        for evidence in [
            "Reliable sign-in",
            "Goal: Make sign-in reliable.",
            "make sign-in reliable",
            "test passed",
        ] {
            assert!(p.contains(evidence), "missing {evidence}");
        }
        assert!(p.len() < 40 * 1024);
        let p = build_context_prompt(&"t".repeat(2000), Some(&"p".repeat(10000)), "latest");
        assert!(!p.contains(&"t".repeat(257)));
        assert!(!p.contains(&"p".repeat(4097)));
        assert!(p.ends_with("latest"));
        assert!(!build_context_prompt("Title", None, "latest").contains("Previous recap ("));
    }
}
