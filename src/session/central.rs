//! Whether the central agent is `paused` or `running` in aoe: while paused the
//! owners file is ignored. The hook for the new state runs on a switch. Spec:
//! docs/guides/central-pause.md.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "central";
const HOOK_DIR: &str = "central-hooks";
const HOOK_LOG: &str = "central-hook.log";
const HOOK_TIMEOUT: Duration = Duration::from_secs(120);
/// The hot path (every session poll and TUI frame) reads the file at most this often.
const RECHECK: Duration = Duration::from_secs(1);
const TAIL_LINES: usize = 5;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum State {
    #[default]
    Paused,
    Running,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Paused => "paused",
            State::Running => "running",
        }
    }
}

/// `running` (any case, surrounding whitespace ignored) is running; anything
/// else, including an empty file, is paused.
fn parse(text: &str) -> State {
    if text.trim().eq_ignore_ascii_case("running") {
        State::Running
    } else {
        State::Paused
    }
}

pub fn read_in(dir: &Path) -> State {
    std::fs::read_to_string(dir.join(FILE_NAME))
        .map(|t| parse(&t))
        .unwrap_or_default()
}

/// Run the hook for `state` (when one exists), then record the state. A failed
/// hook leaves the recorded state as it was.
pub fn switch_in(dir: &Path, state: State) -> Result<()> {
    switch_with_timeout(dir, state, HOOK_TIMEOUT)
}

fn switch_with_timeout(dir: &Path, state: State, timeout: Duration) -> Result<()> {
    let hook = dir.join(HOOK_DIR).join(state.as_str());
    if hook.is_file() {
        run_hook(dir, &hook, state, timeout)?;
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    std::fs::write(&tmp, format!("{}\n", state.as_str()))?;
    std::fs::rename(&tmp, dir.join(FILE_NAME))?;
    refresh_now(state);
    Ok(())
}

fn run_hook(dir: &Path, hook: &Path, state: State, timeout: Duration) -> Result<()> {
    let log_path = dir.join(HOOK_LOG);
    let log = std::fs::File::create(&log_path).context("cannot write the state hook log")?;
    let mut child = Command::new(hook)
        .arg(state.as_str())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .with_context(|| format!("cannot run {}", hook.display()))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let ok = status.is_some_and(|s| s.success());
    if ok {
        return Ok(());
    }
    let output = std::fs::read_to_string(&log_path).unwrap_or_default();
    let tail: Vec<&str> = output.lines().rev().take(TAIL_LINES).collect();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
    match status {
        Some(s) => bail!("central hook for {} failed ({s}): {tail}", state.as_str()),
        None => bail!(
            "central hook for {} timed out after {}s: {tail}",
            state.as_str(),
            timeout.as_secs()
        ),
    }
}

static CACHE: RwLock<Option<(State, Instant)>> = RwLock::new(None);

fn refresh_now(state: State) {
    if let Ok(mut c) = CACHE.write() {
        *c = Some((state, Instant::now()));
    }
}

/// The current state. Tests never read the real app dir and see running, so the
/// owner-tree tests keep their file-driven marks.
pub fn current() -> State {
    if cfg!(test) {
        return State::Running;
    }
    if let Some((state, at)) = CACHE.read().ok().and_then(|c| *c) {
        if at.elapsed() < RECHECK {
            return state;
        }
    }
    let state = super::get_app_dir()
        .map(|dir| read_in(&dir))
        .unwrap_or_default();
    refresh_now(state);
    state
}

pub fn switch(state: State) -> Result<()> {
    switch_in(&super::get_app_dir()?, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn hook(dir: &Path, state: &str, script: &str) {
        let path = dir.join(HOOK_DIR);
        std::fs::create_dir_all(&path).unwrap();
        let file = path.join(state);
        std::fs::write(&file, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn missing_or_unknown_file_is_paused() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_in(dir.path()), State::Paused);
        for (text, want) in [
            ("running\n", State::Running),
            ("  RUNNING ", State::Running),
            ("paused", State::Paused),
            ("", State::Paused),
            ("banana", State::Paused),
        ] {
            std::fs::write(dir.path().join(FILE_NAME), text).unwrap();
            assert_eq!(read_in(dir.path()), want, "{text:?}");
        }
    }

    #[test]
    fn switch_without_a_hook_records_the_state() {
        let dir = tempfile::tempdir().unwrap();
        switch_in(dir.path(), State::Running).unwrap();
        assert_eq!(read_in(dir.path()), State::Running);
        switch_in(dir.path(), State::Paused).unwrap();
        assert_eq!(read_in(dir.path()), State::Paused);
    }

    #[test]
    fn hook_gets_the_new_state_and_runs_before_it_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().display();
        // The hook sees the old state on disk while it runs.
        hook(
            dir.path(),
            "running",
            &format!("echo \"$1 old=$(cat {d}/central 2>/dev/null)\" > {d}/seen"),
        );
        std::fs::write(dir.path().join(FILE_NAME), "paused\n").unwrap();
        switch_in(dir.path(), State::Running).unwrap();
        let seen = std::fs::read_to_string(dir.path().join("seen")).unwrap();
        assert_eq!(seen.trim(), "running old=paused");
        assert_eq!(read_in(dir.path()), State::Running);
    }

    #[test]
    fn failing_or_stuck_hook_leaves_the_state_and_reports_why() {
        let dir = tempfile::tempdir().unwrap();
        hook(dir.path(), "running", "echo boom; exit 3");
        let err = switch_in(dir.path(), State::Running)
            .unwrap_err()
            .to_string();
        assert!(err.contains("boom") && err.contains("failed"), "{err}");
        assert_eq!(read_in(dir.path()), State::Paused);

        hook(dir.path(), "running", "echo stuck; sleep 30");
        let err = switch_with_timeout(dir.path(), State::Running, Duration::from_millis(300))
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out") && err.contains("stuck"), "{err}");
        assert_eq!(read_in(dir.path()), State::Paused);
    }
}
