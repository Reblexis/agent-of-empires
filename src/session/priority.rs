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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriorityScore {
    pub value: u8,
    pub set_at: DateTime<Utc>,
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
    score: Option<PriorityScore>,
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
        Some(score) if run_started_at.is_none_or(|run| score.set_at > run) => score.value,
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

    fn score(value: u8, at: i64) -> Option<PriorityScore> {
        Some(PriorityScore {
            value,
            set_at: t(at),
        })
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
                effective_priority(status, false, false, score(9, 10), None),
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
                effective_priority(status, true, false, score(9, 10), None),
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
            effective_priority(Status::Unknown, false, false, score(9, 10), None),
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
            effective_priority(Status::Idle, false, true, score(2, 20), Some(t(10))),
            2
        );
    }

    #[test]
    fn a_current_score_replaces_the_default_in_either_direction() {
        // Set during the run that ended in this stop: current.
        for status in [Status::Waiting, Status::Idle, Status::Error] {
            assert_eq!(
                effective_priority(status, false, false, score(9, 20), Some(t(10))),
                9
            );
            assert_eq!(
                effective_priority(status, false, false, score(0, 20), Some(t(10))),
                0
            );
        }
        // Never seen running (no stamp): the score counts.
        assert_eq!(
            effective_priority(Status::Idle, false, false, score(8, 20), None),
            8
        );
    }

    #[test]
    fn a_score_set_before_the_session_last_started_running_no_longer_counts() {
        // Agent scored 9, the user replied, the session ran again and stopped
        // without a new score: the default applies, not the stale 9.
        assert_eq!(
            effective_priority(Status::Idle, false, false, score(9, 10), Some(t(20))),
            3
        );
        assert_eq!(
            effective_priority(Status::Waiting, false, false, score(9, 10), Some(t(20))),
            5
        );
        assert_eq!(
            effective_priority(Status::Error, false, false, score(9, 10), Some(t(20))),
            4
        );
        // Same instant is not "after": stale.
        assert_eq!(
            effective_priority(Status::Idle, false, false, score(9, 10), Some(t(10))),
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
