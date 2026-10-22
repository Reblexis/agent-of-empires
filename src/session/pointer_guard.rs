//! Safeguards around a tab's recorded conversation (`agent_session_id`).
//!
//! Contract: docs/guides/session-resume.md, "How the conversation ID stays
//! correct". This module holds the pieces every writer shares:
//!
//! - [`conversation_is_oneshot`]: the "never a one-shot" guard, for Claude
//!   transcripts and Codex rollouts.
//! - [`journal`] and [`journal_changes`]: the append-only pointer journal.
//!   Every persisted change is journaled by the storage layer itself
//!   ([`journal_changes`] runs inside `Storage::update`), so no writer can
//!   move a pointer without leaving a line; [`SourceScope`] labels where the
//!   change came from.
//! - [`check`]: the invariant verifier behind `aoe session verify-pointers`
//!   and the daemon's periodic check.

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::capture::{
    canonicalize_or_raw, claude_home_for_host_environment, encode_claude_project_path,
};

/// File name of the pointer journal inside the AoE app dir.
pub(crate) const JOURNAL_FILE: &str = "pointer-journal.jsonl";

/// Whether `sid` names one of AoE's own one-shot runs rather than a real
/// conversation. `transcript` is the transcript path the agent published for
/// it, when known; otherwise the path is derived from the agent's store.
/// Unknown or unreadable means `false`: the guard never hides a real
/// conversation because a file could not be read.
pub(crate) fn conversation_is_oneshot(
    tool: &str,
    project_path: &str,
    sid: &str,
    host_env: &[String],
    transcript: Option<&Path>,
) -> bool {
    match tool {
        "claude" => {
            if let Some(path) = transcript {
                if transcript_is_aoe_oneshot(path) {
                    return true;
                }
            }
            let Ok(home) = claude_home_for_host_environment(None, host_env) else {
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
            if let Some(path) = transcript {
                if codex_rollout_is_oneshot(path) {
                    return true;
                }
            }
            let Some(home) = codex_home(host_env) else {
                return false;
            };
            codex_rollout_path(&home, sid).is_some_and(|p| codex_rollout_is_oneshot(&p))
        }
        _ => false,
    }
}

/// `CODEX_HOME` from the session's host environment, then AoE's own, then
/// `~/.codex`.
fn codex_home(host_env: &[String]) -> Option<PathBuf> {
    host_env
        .iter()
        .rev()
        .find_map(|kv| kv.strip_prefix("CODEX_HOME="))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
}

/// Whether a Claude transcript was written by one of aoe's own one-shot
/// prompts (see [`crate::session::smart_rename::oneshot_prompt_prefixes`]).
/// Reads only the head of the file and the first user message; any parse
/// trouble is "not a one-shot" so a real transcript is never wrongly hidden.
pub(crate) fn transcript_is_aoe_oneshot(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = vec![0u8; 16 * 1024];
    let Ok(n) = f.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    for line in head.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let text: String = match content {
            Some(serde_json::Value::String(t)) => t.clone(),
            Some(serde_json::Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            _ => return false,
        };
        return starts_with_oneshot_prompt(text.trim_start());
    }
    false
}

/// Locate the rollout file for `sid` under `<codex_home>/sessions`
/// (`YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`).
pub(crate) fn codex_rollout_path(codex_home: &Path, sid: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: usize, sid: &str) -> Option<PathBuf> {
        let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
        // Newest date directories first: a live tab's rollout is recent.
        entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if depth < 3 && name.bytes().all(|b| b.is_ascii_digit()) && path.is_dir() {
                if let Some(found) = walk(&path, depth + 1, sid) {
                    return Some(found);
                }
            } else if name.starts_with("rollout-") && name.ends_with(&format!("{sid}.jsonl")) {
                return Some(path);
            }
        }
        None
    }
    walk(&codex_home.join("sessions"), 0, sid)
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

/// Journal reason for a refused one-shot.
pub(crate) const REFUSED_ONESHOT: &str = "one-shot run, not a conversation";
/// Journal reason for a conversation another tab already records.
pub(crate) const REFUSED_HELD: &str = "held by another tab";
/// Journal reason for one conversation claimed by several tabs in one poll.
pub(crate) const REFUSED_CONTESTED: &str = "claimed by several tabs at once";

/// The tab's agent: its resolved native agent when it has one, else its tool.
fn agent_of(inst: &crate::session::Instance) -> &str {
    inst.capture_agent_name().unwrap_or(inst.tool.as_str())
}

/// The environment the one-shot check resolves the agent's store from: the
/// tab's host environment, with the store an execution binding recorded taking
/// precedence.
fn store_env(
    inst: &crate::session::Instance,
    execution: Option<&crate::session::ExecutionBinding>,
) -> Vec<String> {
    let mut env = inst.resolved_host_environment();
    if let Some(store) = execution.and_then(|e| e.stores.first()) {
        let var = match agent_of(inst) {
            "claude" => Some("CLAUDE_CONFIG_DIR"),
            "codex" => Some("CODEX_HOME"),
            _ => None,
        };
        if let Some(var) = var {
            env.push(format!("{var}={}", store.display()));
        }
    }
    env
}

/// Whether `observation` names one of AoE's one-shot runs for tab `inst`.
pub(crate) fn observation_is_oneshot(
    inst: &crate::session::Instance,
    observation: &crate::session::poller::SessionIdObservation,
) -> bool {
    conversation_is_oneshot(
        agent_of(inst),
        &inst.project_path,
        &observation.sid,
        &store_env(inst, observation.source()),
        observation.transcript_path.as_deref(),
    )
}

/// Whether tab `inst`'s recorded conversation is one of AoE's one-shot runs.
pub(crate) fn recorded_is_oneshot(inst: &crate::session::Instance) -> bool {
    let Some(sid) = inst.agent_session_id.as_deref() else {
        return false;
    };
    let binding = inst
        .agent_session_binding
        .as_ref()
        .filter(|b| b.session_id == sid);
    conversation_is_oneshot(
        agent_of(inst),
        &inst.project_path,
        sid,
        &store_env(inst, binding.and_then(|b| b.execution.as_ref())),
        binding.and_then(|b| b.transcript_path.as_deref()),
    )
}

/// The journal source of a captured observation: the tab's own sidecar is a
/// hook report; anything else came from the agent's store.
pub(crate) fn observation_source(
    observation: &crate::session::poller::SessionIdObservation,
) -> Source {
    match observation.guard {
        crate::session::poller::SessionIdGuard::InstanceSidecar { .. } => Source::Hook,
        _ => Source::Scan,
    }
}

/// Where a pointer change came from. Serialized into the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    /// The ID AoE handed the agent when it started the pane.
    Launch,
    /// The tab's own hook sidecar.
    Hook,
    /// An agent's isolated per-session store (sandboxed and other non-hook
    /// capture paths).
    Scan,
    /// `aoe session set-session-id`.
    User,
    /// Anything else that rewrote the row: fork, import, an engine swap, a
    /// migration, or a peer process reconciling its copy.
    Repair,
}

thread_local! {
    static CURRENT_SOURCE: Cell<Option<Source>> = const { Cell::new(None) };
}

/// Labels every pointer change persisted on this thread while it lives.
/// Nests: dropping restores the outer label.
#[must_use]
pub(crate) struct SourceScope(Option<Source>);

impl SourceScope {
    pub(crate) fn new(source: Source) -> Self {
        Self(CURRENT_SOURCE.with(|c| c.replace(Some(source))))
    }
}

impl Drop for SourceScope {
    fn drop(&mut self) {
        CURRENT_SOURCE.with(|c| c.set(self.0));
    }
}

fn current_source() -> Source {
    CURRENT_SOURCE.with(Cell::get).unwrap_or(Source::Repair)
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
        Ok(dir) => journal_logged(&dir, entry),
        Err(e) => {
            tracing::warn!(target: "session.pointer_journal", "no app dir for journal: {e}")
        }
    }
}

fn journal_logged(dir: &Path, entry: &JournalEntry<'_>) {
    if let Err(e) = journal_in(dir, entry) {
        tracing::warn!(target: "session.pointer_journal", "journal write failed: {e}");
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

/// Each row's recorded conversation before a storage write, by instance id.
pub(crate) type PointerSnapshot = HashMap<String, Option<String>>;

pub(crate) fn snapshot(instances: &[crate::session::Instance]) -> PointerSnapshot {
    instances
        .iter()
        .map(|i| (i.id.clone(), i.agent_session_id.clone()))
        .collect()
}

/// Journal, into `app_dir`, every row whose recorded conversation differs
/// from `before`, labelled with the current [`SourceScope`]. A row that first
/// appears with a conversation is journaled with `old: null`; a removed row
/// is not a pointer change.
pub(crate) fn journal_changes(
    app_dir: &Path,
    before: &PointerSnapshot,
    after: &[crate::session::Instance],
) {
    let source = current_source();
    for inst in after {
        let old = match before.get(&inst.id) {
            Some(old) => old.as_deref(),
            None if inst.agent_session_id.is_none() => continue,
            None => None,
        };
        if old == inst.agent_session_id.as_deref() {
            continue;
        }
        journal_logged(
            app_dir,
            &JournalEntry::new(
                &inst.id,
                &inst.title,
                old,
                inst.agent_session_id.as_deref(),
                source,
            ),
        );
    }
}

/// Journal a refused pointer change once per (tab, sid, reason) for the life
/// of the process: a poller keeps re-reporting a refused value, and the
/// journal records decisions, not ticks.
pub(crate) fn journal_refusal(
    inst: &crate::session::Instance,
    sid: &str,
    source: Source,
    reason: &'static str,
) {
    type RefusalKey = (String, String, &'static str);
    static SEEN: std::sync::OnceLock<std::sync::Mutex<HashSet<RefusalKey>>> =
        std::sync::OnceLock::new();
    let key = (inst.id.clone(), sid.to_string(), reason);
    let fresh = SEEN
        .get_or_init(Default::default)
        .lock()
        .map(|mut seen| seen.insert(key))
        .unwrap_or(true);
    if !fresh {
        return;
    }
    tracing::warn!(
        target: "session.pointer_journal",
        instance = %inst.id,
        sid = %sid,
        reason,
        "refused a conversation pointer change",
    );
    journal(
        &JournalEntry::new(
            &inst.id,
            &inst.title,
            inst.agent_session_id.as_deref(),
            Some(sid),
            source,
        )
        .refused(reason),
    );
}

/// What the verifier needs to know about one non-archived tab.
#[derive(Debug, Clone)]
pub(crate) struct TabView {
    pub id: String,
    pub sid: Option<String>,
    /// The conversation ID the tab's running agent process was launched
    /// with (`--session-id X`, `--resume X`, `codex resume X`), when a pane
    /// is running.
    pub launched_with: Option<String>,
    /// Whether the tab's own hook has reported an ID since the pane launched
    /// (the current launch's sidecar exists).
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
                write!(
                    f,
                    "conversation {sid} is recorded on {} tabs: {}",
                    tabs.len(),
                    tabs.join(", ")
                )
            }
            Violation::OneShot { tab, sid } => {
                write!(f, "tab {tab} records one-shot run {sid} as its conversation")
            }
            Violation::LaunchMismatch {
                tab,
                recorded,
                running,
            } => write!(
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
    let tabs: Vec<&crate::session::Instance> = instances
        .iter()
        .filter(|i| {
            i.archived_at.is_none() && !i.is_trashed() && matches!(agent_of(i), "claude" | "codex")
        })
        .collect();
    let views: Vec<TabView> = tabs
        .iter()
        .map(|i| {
            let tmux_name = i
                .tmux_session()
                .ok()
                .filter(|s| s.exists())
                .map(|s| s.name().to_string());
            TabView {
                id: i.id.clone(),
                sid: i.agent_session_id.clone(),
                launched_with: tmux_name.as_deref().and_then(running_launch_sid),
                hook_reported: i.hook_reported_since_launch(),
            }
        })
        .collect();
    let by_id: HashMap<&str, &crate::session::Instance> =
        tabs.iter().map(|i| (i.id.as_str(), *i)).collect();
    check(&views, |tab, _sid| {
        by_id
            .get(tab.id.as_str())
            .is_some_and(|inst| recorded_is_oneshot(inst))
    })
}

/// Pull the conversation ID out of an agent's argv. `--session-id` names the
/// conversation the process writes (for a fork it is the child, while
/// `--resume` names the parent), so it wins; otherwise the value after
/// `--resume`, `-r`, or the `resume` subcommand.
pub(crate) fn launch_sid_from_argv(argv: &[String]) -> Option<String> {
    let value_after = |flags: &[&str]| {
        argv.windows(2).find_map(|w| {
            flags
                .contains(&w[0].as_str())
                .then(|| w[1].clone())
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        })
    };
    value_after(&["--session-id"]).or_else(|| value_after(&["--resume", "resume", "-r"]))
}

/// The conversation ID the agent under tmux session `tmux_name` was launched
/// with. Linux only (reads `/proc`); `None` elsewhere or when not running.
pub(crate) fn running_launch_sid(tmux_name: &str) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let pane_pid = crate::process::get_pane_pid(tmux_name)?;
        let mut frontier = vec![pane_pid];
        if let Some(sid) = proc_argv(pane_pid).and_then(|argv| launch_sid_from_argv(&argv)) {
            return Some(sid);
        }
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
                if let Some(sid) = proc_argv(pid).and_then(|argv| launch_sid_from_argv(&argv)) {
                    return Some(sid);
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

#[cfg(target_os = "linux")]
fn proc_argv(pid: u32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        raw.split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smart-rename title prompt, as the agent receives it.
    fn title_prompt() -> String {
        crate::session::smart_rename::build_prompt("fix the login page")
    }

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
    fn codex_title_rollout_is_never_a_tabs_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "01a0c993-e5af-7013-b5f4-c673e2ab4d64";
        let title = title_prompt();
        let path = codex_rollout(
            tmp.path(),
            sid,
            "cli",
            &[
                "<environment_context>x</environment_context>",
                "# AGENTS.md instructions",
                &title,
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
    fn codex_one_shot_is_found_through_the_tabs_codex_home() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "01a0c993-e5af-7013-b5f4-c673e2ab4d66";
        codex_rollout(tmp.path(), sid, "exec", &["x"]);
        let env = vec![format!("CODEX_HOME={}", tmp.path().display())];
        assert!(conversation_is_oneshot("codex", "/p", sid, &env, None));
    }

    #[test]
    fn unreadable_conversation_is_not_treated_as_a_one_shot() {
        assert!(!codex_rollout_is_oneshot(Path::new(
            "/nonexistent/rollout.jsonl"
        )));
        assert!(!transcript_is_aoe_oneshot(Path::new(
            "/nonexistent/x.jsonl"
        )));
        assert!(!conversation_is_oneshot("gemini", "/p", "x", &[], None));
    }

    #[test]
    fn claude_title_transcript_is_never_a_tabs_conversation() {
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
        let title = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let real = "11111111-2222-3333-4444-555555555555";
        std::fs::write(
            dir.join(format!("{title}.jsonl")),
            claude_line(&title_prompt()) + "\n",
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
        assert!(conversation_is_oneshot("claude", p, title, &env, None));
        assert!(!conversation_is_oneshot("claude", p, real, &env, None));
        // A published transcript path is checked directly.
        let published = dir.join(format!("{title}.jsonl"));
        assert!(conversation_is_oneshot(
            "claude",
            "/elsewhere",
            title,
            &[],
            Some(&published)
        ));
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
        assert_eq!(lines[0]["title"], "Fix login");
        assert_eq!(lines[0]["old"], "old");
        assert_eq!(lines[0]["new"], "new");
        assert_eq!(lines[0]["source"], "hook");
        assert!(lines[0]["ts"].as_str().is_some());
        assert!(lines[0].get("refused").is_none());
        assert_eq!(lines[1]["refused"], "one-shot");
    }

    #[test]
    fn source_scope_labels_changes_and_restores_the_outer_label() {
        assert_eq!(current_source(), Source::Repair);
        {
            let _launch = SourceScope::new(Source::Launch);
            assert_eq!(current_source(), Source::Launch);
            {
                let _hook = SourceScope::new(Source::Hook);
                assert_eq!(current_source(), Source::Hook);
            }
            assert_eq!(current_source(), Source::Launch);
        }
        assert_eq!(current_source(), Source::Repair);
    }

    fn tab(id: &str, sid: Option<&str>) -> TabView {
        TabView {
            id: id.into(),
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
        assert_eq!(
            v[0].to_string(),
            "conversation s1 is recorded on 2 tabs: a, b"
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
        assert_eq!(
            v[0].to_string(),
            "tab a records one-shot run recap as its conversation"
        );
    }

    #[test]
    fn tab_must_record_what_its_pane_was_launched_with_until_a_hook_reports() {
        let mut t = tab("a", Some("recorded"));
        t.launched_with = Some("running".into());
        let v = check(std::slice::from_ref(&t), |_, _| false);
        assert_eq!(
            v,
            vec![Violation::LaunchMismatch {
                tab: "a".into(),
                recorded: Some("recorded".into()),
                running: "running".into()
            }]
        );
        assert_eq!(
            v[0].to_string(),
            "tab a records recorded but its pane runs running and no hook has reported since launch"
        );
        // After /clear the hook reported a new id: the argv is history, not a violation.
        t.hook_reported = true;
        assert!(check(std::slice::from_ref(&t), |_, _| false).is_empty());
        // Launched with what is recorded: fine.
        let mut ok = tab("b", Some("same"));
        ok.launched_with = Some("same".into());
        assert!(check(&[ok], |_, _| false).is_empty());
    }

    #[test]
    fn launch_sid_is_read_from_claude_and_codex_argv() {
        let u = "01a0c93c-2a86-7d21-8c88-f3ea28e12e53";
        let child = "01a0c993-e5af-7013-b5f4-c673e2ab4d64";
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
        // A fork writes the child, not the parent it resumes from.
        assert_eq!(
            launch_sid_from_argv(&argv(&format!(
                "claude --resume {u} --fork-session --session-id {child}"
            )))
            .as_deref(),
            Some(child)
        );
        assert_eq!(
            launch_sid_from_argv(&argv("claude --dangerously-skip-permissions")),
            None
        );
        assert_eq!(launch_sid_from_argv(&argv("codex resume --last")), None);
    }
}
