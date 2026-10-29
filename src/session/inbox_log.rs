//! The Inbox event log: one JSON line per ask event in
//! `<app_dir>/inbox-log.jsonl`, stamped with the writer's clock, from which the
//! input/output agent measures turnaround and the user's attention.
//! Spec: docs/guides/session-inbox.md, "Measuring".

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "inbox-log.jsonl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    Posted,
    Refined,
    Opened,
    Answered,
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Form {
    Option,
    Text,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub at: DateTime<Utc>,
    pub event: Event,
    pub session_id: String,
    pub posted_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<Form>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms_open: Option<u64>,
}

pub fn log_path() -> Result<PathBuf> {
    Ok(super::get_app_dir()?.join(FILE_NAME))
}

/// Append one entry. `answered` needs its form; only `answered` carries a
/// form or the open time.
pub fn append_to(path: &Path, entry: &Entry) -> Result<()> {
    use std::io::Write;
    let answered = entry.event == Event::Answered;
    if answered != entry.form.is_some() || (!answered && entry.ms_open.is_some()) {
        bail!("only an answered event carries a form and an open time, and it needs its form");
    }
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    // One write per line, so concurrent appenders never interleave a line.
    file.write_all(&line)?;
    Ok(())
}

pub fn append(entry: &Entry) -> Result<()> {
    append_to(&log_path()?, entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(event: Event, form: Option<Form>, ms_open: Option<u64>) -> Entry {
        Entry {
            at: DateTime::from_timestamp(1_800_000_100, 0).unwrap(),
            event,
            session_id: "aaaa1111".into(),
            posted_at: DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
            form,
            ms_open,
        }
    }

    #[test]
    fn every_ask_event_is_one_json_line_appended_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE_NAME);
        let events = [
            entry(Event::Posted, None, None),
            entry(Event::Opened, None, None),
            entry(Event::Answered, Some(Form::Option), Some(8400)),
        ];
        for e in &events {
            append_to(&path, e).unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Entry> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines, events);
        assert!(text
            .lines()
            .nth(2)
            .unwrap()
            .contains(r#""event":"answered""#));
        assert!(text.lines().nth(2).unwrap().contains(r#""form":"option""#));
    }

    #[test]
    fn only_an_answer_carries_its_form_and_open_time_and_an_answer_needs_its_form() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(FILE_NAME);
        let refused = [
            entry(Event::Answered, None, Some(10)),
            entry(Event::Opened, Some(Form::Done), None),
            entry(Event::Dismissed, None, Some(10)),
        ];
        for e in &refused {
            assert!(append_to(&path, e).is_err(), "{e:?}");
        }
        assert!(!path.exists(), "a refused entry writes nothing");
    }
}
