//! Session priority: how soon a session needs the user, 0 to 10. The agent
//! scores its own ask (`aoe session priority <n>`); the effective value is
//! derived from that score and the live status on every read, never stored.
//! Spec: docs/guides/session-priority.md.

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::Status;

pub const MAX_PRIORITY: u8 = 10;

/// An agent's score for its current ask, stamped when it was written so a
/// score from before the session last started running can be ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriorityScore {
    pub value: u8,
    pub set_at: DateTime<Utc>,
    /// What the session asks the user to do, listed in the Inbox and carried
    /// by status pushes. Shares the score's lifetime. See docs/guides/session-inbox.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<Ask>,
}

/// One concrete ask of the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Ask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<AskKind>,
    pub text: String,
    /// The focus objective the ask serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    /// A URL or a command to run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    Check,
    Do,
    Evaluate,
    Answer,
    Decide,
    Learn,
}

impl AskKind {
    /// Capitalized name, as a push body prefixes it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Check => "Check",
            Self::Do => "Do",
            Self::Evaluate => "Evaluate",
            Self::Answer => "Answer",
            Self::Decide => "Decide",
            Self::Learn => "Learn",
        }
    }
}

pub const MAX_ASK_TEXT_CHARS: usize = 300;
pub const MAX_OBJECTIVE_CHARS: usize = 80;
pub const MAX_LINK_CHARS: usize = 500;

/// Build the ask from the CLI parts: each is trimmed with whitespace runs
/// collapsed, an empty part is absent, an over-long one is refused, and kind,
/// objective or link without text is refused. Nothing given is no ask.
pub fn parse_ask(
    kind: Option<AskKind>,
    text: Option<&str>,
    objective: Option<&str>,
    link: Option<&str>,
) -> Result<Option<Ask>> {
    let objective = one_line(objective, "objective", MAX_OBJECTIVE_CHARS)?;
    let link = one_line(link, "link", MAX_LINK_CHARS)?;
    let Some(text) = one_line(text, "ask", MAX_ASK_TEXT_CHARS)? else {
        if kind.is_some() || objective.is_some() || link.is_some() {
            bail!("an ask needs its one line saying what to do");
        }
        return Ok(None);
    };
    Ok(Some(Ask {
        kind,
        text,
        objective,
        link,
    }))
}

/// Trim and collapse whitespace; empty is none, over `max` characters refused.
fn one_line(raw: Option<&str>, what: &str, max: usize) -> Result<Option<String>> {
    let line = raw
        .map(|raw| raw.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty());
    if let Some(line) = &line {
        let chars = line.chars().count();
        if chars > max {
            bail!("{what} must be at most {max} characters, got {chars}");
        }
    }
    Ok(line)
}

/// The score after `aoe session priority`: `value` `None` clears score and
/// ask; a new score without an ask keeps the stored ask only while the stored
/// score is current.
pub fn next_score(
    stored: Option<&PriorityScore>,
    value: Option<u8>,
    ask: Option<Ask>,
    run_started_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Option<PriorityScore> {
    let kept = || {
        stored
            .filter(|s| is_current(s, run_started_at))
            .and_then(|s| s.ask.clone())
    };
    value.map(|value| PriorityScore {
        value,
        set_at: now,
        ask: ask.or_else(kept),
    })
}

/// The ask the Inbox and pushes show: the current score's, and only while
/// that score is what the effective priority uses and it is above 0.
pub fn current_ask(
    status: Status,
    sunk: bool,
    score: Option<&PriorityScore>,
    run_started_at: Option<DateTime<Utc>>,
) -> Option<&Ask> {
    let score = score.filter(|s| is_current(s, run_started_at))?;
    let uses_score = !sunk && matches!(status, Status::Waiting | Status::Idle | Status::Error);
    if !uses_score || score.value == 0 {
        return None;
    }
    score.ask.as_ref()
}

/// A score is current when it was set after the session last started running.
fn is_current(score: &PriorityScore, run_started_at: Option<DateTime<Utc>>) -> bool {
    run_started_at.is_none_or(|run| score.set_at > run)
}

/// Parse the CLI value: an integer 0 to 10 sets a score, `clear` drops it.
pub fn parse_priority_arg(raw: &str) -> Result<Option<u8>> {
    let raw = raw.trim();
    if raw.eq_ignore_ascii_case("clear") {
        return Ok(None);
    }
    match raw.parse::<u8>() {
        Ok(value) if value <= MAX_PRIORITY => Ok(Some(value)),
        _ => bail!("priority must be an integer 0 to 10 or `clear`, got {raw:?}"),
    }
}

/// The priority the sort and the badge use. `sunk` covers archived, snoozed,
/// trashed and dead-pane rows, which never need the user; `unread` is the
/// unread marker with the feature switch already applied.
pub fn effective_priority(
    status: Status,
    sunk: bool,
    unread: bool,
    score: Option<&PriorityScore>,
    run_started_at: Option<DateTime<Utc>>,
) -> u8 {
    if sunk {
        return 0;
    }
    let default = match status {
        Status::Waiting => 5,
        Status::Error => 4,
        Status::Idle if unread => 4,
        Status::Idle => 3,
        Status::Unknown => return 1,
        Status::Running
        | Status::Starting
        | Status::Creating
        | Status::Deleting
        | Status::Stopped => return 0,
    };
    match score {
        Some(score) if is_current(score, run_started_at) => score.value,
        _ => default,
    }
}

/// `run_started_at` after an observed `old -> new` status change at `now`:
/// stamped on entering `Running` from any other status, otherwise unchanged.
pub fn run_started_at_after(
    old: Status,
    new: Status,
    now: DateTime<Utc>,
    current: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    if new == Status::Running && old != Status::Running {
        current.max(Some(now))
    } else {
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + secs, 0).unwrap()
    }

    fn ask(text: &str) -> Ask {
        Ask {
            kind: None,
            text: text.to_string(),
            objective: None,
            link: None,
        }
    }

    fn owned(value: u8, at: i64, text: Option<&str>) -> PriorityScore {
        PriorityScore {
            value,
            set_at: t(at),
            ask: text.map(ask),
        }
    }

    fn score(value: u8, at: i64) -> Option<PriorityScore> {
        Some(owned(value, at, None))
    }

    #[test]
    fn an_ask_is_one_concrete_line_with_an_optional_kind_objective_and_link() {
        use AskKind::*;
        let full = Ask {
            kind: Some(Learn),
            text: "Read the creator pricing note".into(),
            objective: Some("YouTube creators product".into()),
            link: Some("https://example.com/note".into()),
        };
        type Accepted<'a> = (
            Option<AskKind>,
            Option<&'a str>,
            Option<&'a str>,
            Option<&'a str>,
            Option<Ask>,
        );
        // (kind, text, objective, link, expected)
        let cases: [Accepted; 6] = [
            (None, None, None, None, None),
            (None, Some("  \n "), None, None, None),
            (
                None,
                Some("  Approve the\n\n ad   budget "),
                None,
                None,
                Some(ask("Approve the ad budget")),
            ),
            (
                Some(Learn),
                Some("Read the creator pricing note"),
                Some(" YouTube  creators product "),
                Some("https://example.com/note "),
                Some(full),
            ),
            (
                Some(Decide),
                Some("Pick a date"),
                Some(""),
                Some(""),
                Some(Ask {
                    kind: Some(Decide),
                    ..ask("Pick a date")
                }),
            ),
            (
                None,
                Some(&"ü".repeat(MAX_ASK_TEXT_CHARS)),
                None,
                None,
                Some(ask(&"ü".repeat(MAX_ASK_TEXT_CHARS))),
            ),
        ];
        for (kind, text, objective, link, expected) in cases {
            assert_eq!(
                parse_ask(kind, text, objective, link).unwrap(),
                expected,
                "{text:?}"
            );
        }
        let long = |n: usize| "x".repeat(n + 1);
        type Refused<'a> = (
            Option<AskKind>,
            Option<String>,
            Option<String>,
            Option<String>,
            &'a str,
        );
        // (kind, text, objective, link, error mentions)
        let refused: [Refused; 5] = [
            (None, Some(long(MAX_ASK_TEXT_CHARS)), None, None, "300"),
            (
                None,
                Some("ok".into()),
                Some(long(MAX_OBJECTIVE_CHARS)),
                None,
                "80",
            ),
            (
                None,
                Some("ok".into()),
                None,
                Some(long(MAX_LINK_CHARS)),
                "500",
            ),
            (Some(Check), None, None, None, "one line"),
            (
                None,
                None,
                Some("Objective".into()),
                Some("https://x".into()),
                "one line",
            ),
        ];
        for (kind, text, objective, link, needle) in refused {
            let err = parse_ask(kind, text.as_deref(), objective.as_deref(), link.as_deref())
                .expect_err(needle);
            assert!(format!("{err:#}").contains(needle), "{needle}: {err:#}");
        }
    }

    #[test]
    fn rescoring_without_an_ask_never_erases_what_a_current_session_asks() {
        let now = t(100);
        let had = owned(8, 20, Some("Approve the budget"));
        type Case<'a> = (
            Option<&'a PriorityScore>,
            Option<u8>,
            Option<&'a str>,
            Option<DateTime<Utc>>,
            Option<&'a str>,
        );
        // (stored, value, new ask, run_started_at, expected ask)
        let cases: [Case; 6] = [
            // Focus re-rank of a current score keeps its ask.
            (
                Some(&had),
                Some(5),
                None,
                Some(t(10)),
                Some("Approve the budget"),
            ),
            (Some(&had), Some(5), None, None, Some("Approve the budget")),
            // A new ask replaces the old one.
            (
                Some(&had),
                Some(9),
                Some("Pay the invoice"),
                Some(t(10)),
                Some("Pay the invoice"),
            ),
            // The session ran since: the old ask was answered.
            (Some(&had), Some(5), None, Some(t(30)), None),
            (None, Some(5), None, None, None),
            (
                None,
                Some(5),
                Some("Read the report"),
                None,
                Some("Read the report"),
            ),
        ];
        for (stored, value, new, run, expected) in cases {
            let next = next_score(stored, value, new.map(ask), run, now).unwrap();
            assert_eq!(next.value, value.unwrap());
            assert_eq!(next.set_at, now);
            assert_eq!(
                next.ask.as_ref().map(|a| a.text.as_str()),
                expected,
                "{stored:?} {new:?} {run:?}"
            );
        }
        assert_eq!(
            next_score(Some(&had), None, None, None, now),
            None,
            "clear drops both"
        );
    }

    #[test]
    fn an_ask_counts_only_while_its_score_ranks_the_session_above_zero() {
        let why = owned(8, 20, Some("Approve the budget"));
        let zero = owned(0, 20, Some("Nothing needed"));
        // (status, sunk, score, run_started_at, shown)
        let cases: [(Status, bool, &PriorityScore, Option<DateTime<Utc>>, bool); 8] = [
            (Status::Idle, false, &why, Some(t(10)), true),
            (Status::Waiting, false, &why, None, true),
            (Status::Error, false, &why, Some(t(10)), true),
            // Stale: the session ran again after the score.
            (Status::Idle, false, &why, Some(t(30)), false),
            // Running, sunk or Unknown sessions do not use the score.
            (Status::Running, false, &why, Some(t(10)), false),
            (Status::Idle, true, &why, Some(t(10)), false),
            (Status::Unknown, false, &why, Some(t(10)), false),
            // A score of 0 means it does not need you.
            (Status::Idle, false, &zero, Some(t(10)), false),
        ];
        for (status, sunk, score, run, shown) in cases {
            assert_eq!(
                current_ask(status, sunk, Some(score), run).is_some(),
                shown,
                "{status:?} sunk={sunk} {score:?} {run:?}"
            );
        }
    }

    #[test]
    fn cli_accepts_zero_to_ten_and_clear_and_refuses_anything_else() {
        assert_eq!(parse_priority_arg("0").unwrap(), Some(0));
        assert_eq!(parse_priority_arg("7").unwrap(), Some(7));
        assert_eq!(parse_priority_arg("10").unwrap(), Some(10));
        assert_eq!(parse_priority_arg(" 8 ").unwrap(), Some(8));
        assert_eq!(parse_priority_arg("clear").unwrap(), None);
        assert_eq!(parse_priority_arg("CLEAR").unwrap(), None);
        for bad in ["11", "-1", "abc", "", "7.5", "256"] {
            let err = format!("{:#}", parse_priority_arg(bad).unwrap_err());
            assert!(err.contains("0 to 10"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn a_session_that_does_not_need_you_is_zero_whatever_its_score() {
        for status in [
            Status::Running,
            Status::Starting,
            Status::Creating,
            Status::Deleting,
            Status::Stopped,
        ] {
            assert_eq!(
                effective_priority(status, false, false, score(9, 10).as_ref(), None),
                0,
                "{status:?}"
            );
        }
        for status in [
            Status::Waiting,
            Status::Idle,
            Status::Error,
            Status::Unknown,
        ] {
            assert_eq!(
                effective_priority(status, true, false, score(9, 10).as_ref(), None),
                0,
                "sunk {status:?}"
            );
        }
    }

    #[test]
    fn unknown_status_is_one() {
        assert_eq!(
            effective_priority(Status::Unknown, false, false, None, None),
            1
        );
        assert_eq!(
            effective_priority(Status::Unknown, false, false, score(9, 10).as_ref(), None),
            1
        );
    }

    #[test]
    fn an_unscored_ask_falls_back_to_the_status_default() {
        assert_eq!(
            effective_priority(Status::Waiting, false, false, None, None),
            5
        );
        assert_eq!(
            effective_priority(Status::Error, false, false, None, None),
            4
        );
        assert_eq!(
            effective_priority(Status::Idle, false, false, None, None),
            3
        );
    }

    #[test]
    fn an_unread_idle_or_error_defaults_to_four_so_it_keeps_ranking_above_a_read_error() {
        assert_eq!(effective_priority(Status::Idle, false, true, None, None), 4);
        assert_eq!(
            effective_priority(Status::Error, false, true, None, None),
            4
        );
        // Unread never lifts a session that does not need you, nor a Waiting.
        assert_eq!(
            effective_priority(Status::Running, false, true, None, None),
            0
        );
        assert_eq!(
            effective_priority(Status::Waiting, false, true, None, None),
            5
        );
        assert_eq!(
            effective_priority(Status::Unknown, false, true, None, None),
            1
        );
        // A current score still wins over the unread default.
        assert_eq!(
            effective_priority(
                Status::Idle,
                false,
                true,
                score(2, 20).as_ref(),
                Some(t(10))
            ),
            2
        );
    }

    #[test]
    fn a_current_score_replaces_the_default_in_either_direction() {
        // Set during the run that ended in this stop: current.
        for status in [Status::Waiting, Status::Idle, Status::Error] {
            assert_eq!(
                effective_priority(status, false, false, score(9, 20).as_ref(), Some(t(10))),
                9
            );
            assert_eq!(
                effective_priority(status, false, false, score(0, 20).as_ref(), Some(t(10))),
                0
            );
        }
        // Never seen running (no stamp): the score counts.
        assert_eq!(
            effective_priority(Status::Idle, false, false, score(8, 20).as_ref(), None),
            8
        );
    }

    #[test]
    fn a_score_set_before_the_session_last_started_running_no_longer_counts() {
        // Agent scored 9, the user replied, the session ran again and stopped
        // without a new score: the default applies, not the stale 9.
        assert_eq!(
            effective_priority(
                Status::Idle,
                false,
                false,
                score(9, 10).as_ref(),
                Some(t(20))
            ),
            3
        );
        assert_eq!(
            effective_priority(
                Status::Waiting,
                false,
                false,
                score(9, 10).as_ref(),
                Some(t(20))
            ),
            5
        );
        assert_eq!(
            effective_priority(
                Status::Error,
                false,
                false,
                score(9, 10).as_ref(),
                Some(t(20))
            ),
            4
        );
        // Same instant is not "after": stale.
        assert_eq!(
            effective_priority(
                Status::Idle,
                false,
                false,
                score(9, 10).as_ref(),
                Some(t(10))
            ),
            3
        );
    }

    #[test]
    fn entering_running_from_any_other_status_stamps_run_started_at() {
        let now = t(100);
        for old in [
            Status::Waiting,
            Status::Idle,
            Status::Error,
            Status::Unknown,
            Status::Stopped,
            Status::Starting,
        ] {
            assert_eq!(
                run_started_at_after(old, Status::Running, now, Some(t(5))),
                Some(now),
                "{old:?}"
            );
        }
        assert_eq!(
            run_started_at_after(Status::Idle, Status::Running, now, None),
            Some(now)
        );
    }

    #[test]
    fn other_transitions_leave_run_started_at_alone() {
        let now = t(100);
        let prev = Some(t(5));
        assert_eq!(
            run_started_at_after(Status::Running, Status::Idle, now, prev),
            prev
        );
        assert_eq!(
            run_started_at_after(Status::Running, Status::Waiting, now, prev),
            prev
        );
        assert_eq!(
            run_started_at_after(Status::Running, Status::Running, now, prev),
            prev
        );
        assert_eq!(
            run_started_at_after(Status::Idle, Status::Waiting, now, None),
            None
        );
    }

    #[test]
    fn run_started_at_never_moves_backwards() {
        // A slower writer observing an older transition must not rewind the
        // stamp, or a stale score would become current again.
        let later = Some(t(200));
        assert_eq!(
            run_started_at_after(Status::Idle, Status::Running, t(100), later),
            later
        );
    }
}
