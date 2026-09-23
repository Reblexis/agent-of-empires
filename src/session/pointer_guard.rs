//! Safeguards around a tab's recorded conversation (`agent_session_id`).
//!
//! Contract: docs/guides/session-resume.md, "How the conversation ID stays
//! correct". This module holds the pieces every writer shares:
//!
//! - [`conversation_is_oneshot`]: the "never a one-shot" guard, for Claude
//!   transcripts and Codex rollouts.
//! - [`journal`]: the append-only pointer journal.
//! - [`check`]: the invariant verifier behind `aoe session verify-pointers`
//!   and the daemon's periodic check.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::capture::{
    canonicalize_or_raw, claude_home_for_host_environment, collect_codex_sessions,
    encode_claude_project_path, extract_codex_uuid_from_filename, resolve_agent_home,
    transcript_is_aoe_oneshot,
};

/// File name of the pointer journal inside the AoE app dir.
pub(crate) const JOURNAL_FILE: &str = "pointer-journal.jsonl";

/// Whether `sid` names one of AoE's own one-shot runs rather than a real
/// conversation. Unknown or unreadable means `false`: the guard never hides a
/// real conversation because a file could not be read.
pub(crate) fn conversation_is_oneshot(
    tool: &str,
    project_path: &str,
    sid: &str,
    host_env: &[String],
) -> bool {
    match tool {
        "claude" => {
            let Ok(home) = claude_home_for_host_environment(host_env) else {
                return false;
            };
            let canonical = canonicalize_or_raw(project_path);
            let path = home
                .join("projects")
                .join(encode_claude_project_path(&canonical.to_string_lossy()))
                .join(format!("{sid}.jsonl"));
            transcript_is_aoe_oneshot(&path)
        }
        "codex" => {
            let Ok(home) = resolve_agent_home(Some("CODEX_HOME"), ".codex") else {
                return false;
            };
            codex_rollout_path(&home, sid).is_some_and(|p| codex_rollout_is_oneshot(&p))
        }
        _ => false,
    }
}

/// Locate the rollout file for `sid` under `<codex_home>/sessions`.
pub(crate) fn codex_rollout_path(codex_home: &Path, sid: &str) -> Option<PathBuf> {
    let mut entries = Vec::new();
    collect_codex_sessions(&codex_home.join("sessions"), &mut entries).ok()?;
    entries
        .into_iter()
        .map(|(p, _)| p)
        .find(|p| extract_codex_uuid_from_filename(p).as_deref() == Some(sid))
}

/// A Codex rollout is a one-shot when Codex recorded it as a non-interactive
/// `codex exec` run, or when its first real user message is one of AoE's
/// one-shot prompts. Injected context (`<environment_context>`, AGENTS.md
/// instructions, plugin lists) is not a user message and is skipped.
pub(crate) fn codex_rollout_is_oneshot(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    for line in std::io::BufReader::new(file).lines().take(200) {
        let Ok(line) = line else {
            return false;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let payload = v.get("payload");
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_meta") => {
                let source = payload
                    .and_then(|p| p.get("source"))
                    .and_then(|s| s.as_str());
                if source == Some("exec") {
                    return true;
                }
            }
            Some("response_item") => {
                let Some(p) = payload else { continue };
                if p.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                let texts: Vec<&str> = p
                    .get("content")
                    .and_then(|c| c.as_array())
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                            .map(str::trim_start)
                            .filter(|t| !is_injected_codex_context(t))
                            .collect()
                    })
                    .unwrap_or_default();
                let Some(first) = texts.first() else {
                    continue;
                };
                return starts_with_oneshot_prompt(first);
            }
            _ => {}
        }
    }
    false
}

fn is_injected_codex_context(text: &str) -> bool {
    text.is_empty() || text.starts_with('<') || text.starts_with("# AGENTS.md")
}

fn starts_with_oneshot_prompt(text: &str) -> bool {
    crate::session::smart_rename::oneshot_prompt_prefixes()
        .iter()
        .any(|p| {
            let n = p.len().min(48);
            let n = if p.is_char_boundary(n) { n } else { p.len() };
            text.starts_with(&p[..n])
        })
}

/// Where a pointer change came from. Serialized into the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    Launch,
    Hook,
    Scan,
    User,
}

/// One line of the pointer journal.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct JournalEntry<'a> {
    pub ts: String,
    pub instance_id: &'a str,
    pub title: &'a str,
    pub old: Option<&'a str>,
    pub new: Option<&'a str>,
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<&'a str>,
}

impl<'a> JournalEntry<'a> {
    pub(crate) fn new(
        instance_id: &'a str,
        title: &'a str,
        old: Option<&'a str>,
        new: Option<&'a str>,
        source: Source,
    ) -> Self {
        Self {
            ts: chrono::Utc::now().to_rfc3339(),
            instance_id,
            title,
            old,
            new,
            source,
            refused: None,
        }
    }

    pub(crate) fn refused(mut self, reason: &'a str) -> Self {
        self.refused = Some(reason);
        self
    }
}

/// Append `entry` to the journal in the AoE app dir. Never fails the caller:
/// a journal write error is logged and the pointer change stands.
pub(crate) fn journal(entry: &JournalEntry<'_>) {
    match crate::session::get_app_dir() {
        Ok(dir) => {
            if let Err(e) = journal_in(&dir, entry) {
                tracing::warn!(target: "session.pointer_journal", "journal write failed: {e}");
            }
        }
        Err(e) => {
            tracing::warn!(target: "session.pointer_journal", "no app dir for journal: {e}")
        }
    }
}

pub(crate) fn journal_in(dir: &Path, entry: &JournalEntry<'_>) -> std::io::Result<()> {
    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(JOURNAL_FILE))?;
    // One write call per line: O_APPEND keeps concurrent writers' lines whole.
    f.write_all(line.as_bytes())
}

/// What the verifier needs to know about one non-archived tab.
#[derive(Debug, Clone)]
pub(crate) struct TabView {
    pub id: String,
    pub tool: String,
    pub project_path: String,
    pub sid: Option<String>,
    /// The conversation ID the tab's running agent process was launched
    /// with (`--resume X`, `--session-id X`, `codex resume X`), when a pane
    /// is running.
    pub launched_with: Option<String>,
    /// Whether the tab's own hook has reported an ID since the pane launched
    /// (its sidecar exists; the launch deletes it).
    pub hook_reported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Violation {
    Shared {
        sid: String,
        tabs: Vec<String>,
    },
    OneShot {
        tab: String,
        sid: String,
    },
    LaunchMismatch {
        tab: String,
        recorded: Option<String>,
        running: String,
    },
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Violation::Shared { sid, tabs } => {
                write!(f, "conversation {sid} is recorded on {} tabs: {}", tabs.len(), tabs.join(", "))
            }
            Violation::OneShot { tab, sid } => {
                write!(f, "tab {tab} records one-shot run {sid} as its conversation")
            }
            Violation::LaunchMismatch { tab, recorded, running } => write!(
                f,
                "tab {tab} records {} but its pane runs {running} and no hook has reported since launch",
                recorded.as_deref().unwrap_or("nothing")
            ),
        }
    }
}

/// Check the pointer invariants over every non-archived tab.
pub(crate) fn check(
    tabs: &[TabView],
    is_oneshot: impl Fn(&TabView, &str) -> bool,
) -> Vec<Violation> {
    let mut out = Vec::new();
    let mut holders: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for tab in tabs {
        if let Some(sid) = tab.sid.as_deref() {
            holders.entry(sid).or_default().push(tab.id.clone());
            if is_oneshot(tab, sid) {
                out.push(Violation::OneShot {
                    tab: tab.id.clone(),
                    sid: sid.to_string(),
                });
            }
        }
        if let Some(running) = tab.launched_with.as_deref() {
            if !tab.hook_reported && tab.sid.as_deref() != Some(running) {
                out.push(Violation::LaunchMismatch {
                    tab: tab.id.clone(),
                    recorded: tab.sid.clone(),
                    running: running.to_string(),
                });
            }
        }
    }
    for (sid, ids) in holders {
        if ids.len() > 1 {
            out.push(Violation::Shared {
                sid: sid.to_string(),
                tabs: ids,
            });
        }
    }
    out
}

/// Build the verifier's view of every non-archived Claude/Codex tab and run
/// [`check`] over it. Reads tmux, `/proc`, hook sidecars and transcripts, so
/// call it off the async runtime.
pub(crate) fn verify_instances(instances: &[crate::session::Instance]) -> Vec<Violation> {
    let tabs: Vec<(TabView, Vec<String>)> = instances
        .iter()
        .filter(|i| i.archived_at.is_none() && matches!(i.tool.as_str(), "claude" | "codex"))
        .map(|i| {
            let tmux_name = i
                .tmux_session()
                .ok()
                .filter(|s| s.exists())
                .map(|s| s.name().to_string());
            (
                TabView {
                    id: i.id.clone(),
                    tool: i.tool.clone(),
                    project_path: i.project_path.clone(),
                    sid: i.agent_session_id.clone(),
                    launched_with: tmux_name.as_deref().and_then(running_launch_sid),
                    hook_reported: crate::hooks::read_hook_session_id_any_age(&i.id).is_some(),
                },
                i.resolved_host_environment(),
            )
        })
        .collect();
    let envs: std::collections::HashMap<String, Vec<String>> = tabs
        .iter()
        .map(|(t, env)| (t.id.clone(), env.clone()))
        .collect();
    let views: Vec<TabView> = tabs.into_iter().map(|(t, _)| t).collect();
    check(&views, |tab, sid| {
        conversation_is_oneshot(
            &tab.tool,
            &tab.project_path,
            sid,
            envs.get(&tab.id).map(Vec::as_slice).unwrap_or(&[]),
        )
    })
}

/// Pull the conversation ID out of an agent's argv: the value after
/// `--resume`, `--session-id`, or the `resume` subcommand.
pub(crate) fn launch_sid_from_argv(argv: &[String]) -> Option<String> {
    argv.windows(2).find_map(|w| {
        matches!(w[0].as_str(), "--resume" | "--session-id" | "resume" | "-r")
            .then(|| w[1].clone())
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
    })
}

/// The conversation ID the agent under tmux session `tmux_name` was launched
/// with. Linux only (reads `/proc`); `None` elsewhere or when not running.
pub(crate) fn running_launch_sid(tmux_name: &str) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("tmux")
            .args(["list-panes", "-t", tmux_name, "-F", "#{pane_pid}"])
            .output()
            .ok()?;
        let pane_pid: u32 = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .parse()
            .ok()?;
        let mut frontier = vec![pane_pid];
        // Breadth-first over the pane's descendants; the agent is usually a
        // direct child of the pane shell, a node wrapper at most one deeper.
        for _ in 0..4 {
            let mut next = Vec::new();
            for entry in std::fs::read_dir("/proc").ok()?.flatten() {
                let Some(pid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|s| s.parse::<u32>().ok())
                else {
                    continue;
                };
                let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                    continue;
                };
                // ppid is the 2nd field after the parenthesised comm.
                let Some(after) = stat.rsplit_once(')').map(|(_, a)| a) else {
                    continue;
                };
                let ppid: u32 = after
                    .split_whitespace()
                    .nth(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                if !frontier.contains(&ppid) {
                    continue;
                }
                if let Ok(raw) = std::fs::read(entry.path().join("cmdline")) {
                    let argv: Vec<String> = raw
                        .split(|b| *b == 0)
                        .filter(|s| !s.is_empty())
                        .map(|s| String::from_utf8_lossy(s).into_owned())
                        .collect();
                    if let Some(sid) = launch_sid_from_argv(&argv) {
                        return Some(sid);
                    }
                }
                next.push(pid);
            }
            if next.is_empty() {
                return None;
            }
            frontier = next;
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = tmux_name;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECAP: &str =
        "You are given the terminal scrollback of a coding-agent session. Write a short recap";

    fn claude_line(text: &str) -> String {
        serde_json::json!({"type":"user","message":{"content":[{"type":"text","text":text}]}})
            .to_string()
    }

    fn codex_rollout(dir: &Path, sid: &str, source: &str, user_texts: &[&str]) -> PathBuf {
        let day = dir.join("sessions").join("2026").join("09").join("22");
        std::fs::create_dir_all(&day).unwrap();
        let path = day.join(format!("rollout-2026-09-22T13-09-44-{sid}.jsonl"));
        let mut body = serde_json::json!({"type":"session_meta","payload":{"id":sid,"cwd":"/p","source":source}}).to_string();
        body.push('\n');
        let content: Vec<_> = user_texts
            .iter()
            .map(|t| serde_json::json!({"type":"input_text","text":t}))
            .collect();
        body.push_str(
            &serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":content}}).to_string(),
        );
        body.push('\n');
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn codex_recap_rollout_is_never_a_tabs_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "01a0c993-e5af-7013-b5f4-c673e2ab4d64";
        let path = codex_rollout(
            tmp.path(),
            sid,
            "cli",
            &[
                "<environment_context>x</environment_context>",
                "# AGENTS.md instructions",
                RECAP,
            ],
        );
        assert!(codex_rollout_is_oneshot(&path));
    }

    #[test]
    fn codex_exec_rollout_is_never_a_tabs_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let path = codex_rollout(
            tmp.path(),
            "01a0c993-e5af-7013-b5f4-c673e2ab4d65",
            "exec",
            &["anything at all"],
        );
        assert!(codex_rollout_is_oneshot(&path));
    }

    #[test]
    fn codex_interactive_rollout_is_a_real_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let path = codex_rollout(
            tmp.path(),
            "01a0c93c-2a86-7d21-8c88-f3ea28e12e53",
            "cli",
            &[
                "<environment_context>x</environment_context>",
                "we were working on the handoff button",
            ],
        );
        assert!(!codex_rollout_is_oneshot(&path));
    }

    #[test]
    fn codex_rollout_is_found_by_its_id() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "01a0c93c-2a86-7d21-8c88-f3ea28e12e53";
        let path = codex_rollout(tmp.path(), sid, "cli", &["hi"]);
        codex_rollout(
            tmp.path(),
            "01a0c993-e5af-7013-b5f4-c673e2ab4d64",
            "cli",
            &["other"],
        );
        assert_eq!(codex_rollout_path(tmp.path(), sid), Some(path));
        assert_eq!(
            codex_rollout_path(tmp.path(), "01a0c000-0000-7000-8000-000000000000"),
            None
        );
    }

    #[test]
    fn unreadable_conversation_is_not_treated_as_a_one_shot() {
        assert!(!codex_rollout_is_oneshot(Path::new(
            "/nonexistent/rollout.jsonl"
        )));
        assert!(!conversation_is_oneshot("gemini", "/p", "x", &[]));
    }

    #[test]
    #[serial_test::serial]
    fn claude_recap_transcript_is_never_a_tabs_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let canonical = canonicalize_or_raw(project.to_str().unwrap());
        let dir = tmp
            .path()
            .join("claude")
            .join("projects")
            .join(encode_claude_project_path(&canonical.to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        let recap = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let real = "11111111-2222-3333-4444-555555555555";
        std::fs::write(
            dir.join(format!("{recap}.jsonl")),
            claude_line(RECAP) + "\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(format!("{real}.jsonl")),
            claude_line("fix the login page") + "\n",
        )
        .unwrap();
        let env = vec![format!(
            "CLAUDE_CONFIG_DIR={}",
            tmp.path().join("claude").display()
        )];
        let p = project.to_str().unwrap();
        assert!(conversation_is_oneshot("claude", p, recap, &env));
        assert!(!conversation_is_oneshot("claude", p, real, &env));
    }

    #[test]
    fn journal_appends_one_line_per_change_and_never_rewrites() {
        let tmp = tempfile::tempdir().unwrap();
        let a = JournalEntry::new("tab1", "Fix login", Some("old"), Some("new"), Source::Hook);
        let b = JournalEntry::new("tab2", "Other", Some("x"), Some("y"), Source::Hook)
            .refused("one-shot");
        journal_in(tmp.path(), &a).unwrap();
        journal_in(tmp.path(), &b).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(JOURNAL_FILE)).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["instance_id"], "tab1");
        assert_eq!(lines[0]["old"], "old");
        assert_eq!(lines[0]["new"], "new");
        assert_eq!(lines[0]["source"], "hook");
        assert!(lines[0].get("refused").is_none());
        assert_eq!(lines[1]["refused"], "one-shot");
    }

    fn tab(id: &str, sid: Option<&str>) -> TabView {
        TabView {
            id: id.into(),
            tool: "claude".into(),
            project_path: "/p".into(),
            sid: sid.map(Into::into),
            launched_with: None,
            hook_reported: false,
        }
    }

    #[test]
    fn two_tabs_never_share_a_conversation() {
        let tabs = vec![
            tab("a", Some("s1")),
            tab("b", Some("s1")),
            tab("c", Some("s2")),
        ];
        let v = check(&tabs, |_, _| false);
        assert_eq!(
            v,
            vec![Violation::Shared {
                sid: "s1".into(),
                tabs: vec!["a".into(), "b".into()]
            }]
        );
    }

    #[test]
    fn verifier_flags_a_tab_recording_a_one_shot() {
        let tabs = vec![tab("a", Some("recap")), tab("b", Some("real"))];
        let v = check(&tabs, |_, sid| sid == "recap");
        assert_eq!(
            v,
            vec![Violation::OneShot {
                tab: "a".into(),
                sid: "recap".into()
            }]
        );
    }

    #[test]
    fn tab_must_record_what_its_pane_was_launched_with_until_a_hook_reports() {
        let mut t = tab("a", Some("recorded"));
        t.launched_with = Some("running".into());
        assert_eq!(
            check(std::slice::from_ref(&t), |_, _| false),
            vec![Violation::LaunchMismatch {
                tab: "a".into(),
                recorded: Some("recorded".into()),
                running: "running".into()
            }]
        );
        // After /clear the hook reported a new id: the argv is history, not a violation.
        t.hook_reported = true;
        assert!(check(std::slice::from_ref(&t), |_, _| false).is_empty());
        // Launched with what is recorded: fine.
        let mut ok = tab("b", Some("same"));
        ok.launched_with = Some("same".into());
        assert!(check(&[ok], |_, _| false).is_empty());
    }

    fn hook_base() -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("aoe-hooks");
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        crate::hooks::override_base_for_test(base.clone());
        crate::hooks::reset_for_test();
        (tmp, base)
    }

    #[test]
    #[serial_test::serial]
    fn relaunch_never_swaps_a_tab_onto_the_newest_transcript_in_its_folder() {
        let (_hooks_tmp, base) = hook_base();
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let canonical = canonicalize_or_raw(project.to_str().unwrap());
        let dir = tmp
            .path()
            .join("claude/projects")
            .join(encode_claude_project_path(&canonical.to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        let mine = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let newest = "11111111-2222-3333-4444-555555555555";
        std::fs::write(
            dir.join(format!("{mine}.jsonl")),
            claude_line("mine") + "\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(format!("{newest}.jsonl")),
            claude_line("someone else") + "\n",
        )
        .unwrap();
        let _env = crate::session::test_support::EnvGuard::set(&[(
            "CLAUDE_CONFIG_DIR",
            tmp.path().join("claude"),
        )]);

        let mut inst = crate::session::Instance::new("relaunch", project.to_str().unwrap());
        inst.tool = "claude".into();
        inst.agent_session_id = Some(mine.into());
        assert_eq!(inst.try_retroactive_capture(), None);
        assert_eq!(inst.capture_freshest_session_id(), None);

        // What the tab's own hook reported wins, whatever its age.
        use std::os::unix::fs::PermissionsExt;
        let d = base.join(&inst.id);
        std::fs::create_dir(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cleared = "cccccccc-2222-3333-4444-555555555555";
        std::fs::write(d.join("session_id"), cleared).unwrap();
        std::fs::File::options()
            .write(true)
            .open(d.join("session_id"))
            .unwrap()
            .set_times(
                std::fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(3600),
                ),
            )
            .unwrap();
        assert_eq!(inst.capture_freshest_session_id().as_deref(), Some(cleared));
        crate::hooks::clear_base_override_for_test();
        crate::hooks::reset_for_test();
    }

    #[test]
    fn launch_sid_is_read_from_claude_and_codex_argv() {
        let u = "01a0c93c-2a86-7d21-8c88-f3ea28e12e53";
        let argv = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(
            launch_sid_from_argv(&argv(&format!(
                "claude --dangerously-skip-permissions --resume {u}"
            )))
            .as_deref(),
            Some(u)
        );
        assert_eq!(
            launch_sid_from_argv(&argv(&format!("claude --session-id {u}"))).as_deref(),
            Some(u)
        );
        assert_eq!(
            launch_sid_from_argv(&argv(&format!("node /bin/codex resume {u} --yolo"))).as_deref(),
            Some(u)
        );
        assert_eq!(
            launch_sid_from_argv(&argv("claude --dangerously-skip-permissions")),
            None
        );
        assert_eq!(launch_sid_from_argv(&argv("codex resume --last")), None);
    }
}
