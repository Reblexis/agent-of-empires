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
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
    /// How much doing it moves the objective times the objective's
    /// importance, 0 to 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<u8>,
    /// Estimated minutes of the user's attention, 1 to 480.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u16>,
    /// When doing it stops being worth as much: `YYYY-MM-DD` or RFC 3339.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    /// The choices of a `decide` ask; empty means Yes and No.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// Whether the session posted an ask page (`session::ask_page`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub page: bool,
    /// When the session posted this ask: the request's identity, which a
    /// refine must name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub posted_at: Option<DateTime<Utc>>,
    /// When the input/output agent last refined it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refined_at: Option<DateTime<Utc>>,
    /// The session whose current ask this one is the same as.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into: Option<String>,
}

/// What `aoe session refine` replaces on a current ask; absent fields stay.
#[derive(Debug, Default, Clone, Copy)]
pub struct Refine<'a> {
    pub kind: Option<AskKind>,
    pub text: Option<&'a str>,
    pub objective: Option<&'a str>,
    pub link: Option<&'a str>,
    pub value: Option<u8>,
    pub minutes: Option<u16>,
    pub due: Option<&'a str>,
    pub options: &'a [String],
    pub page: bool,
    pub merge_into: Option<&'a str>,
}

/// The ask fields as given on the command line, before validation.
#[derive(Debug, Default, Clone, Copy)]
pub struct AskInput<'a> {
    pub kind: Option<AskKind>,
    pub text: Option<&'a str>,
    pub objective: Option<&'a str>,
    pub link: Option<&'a str>,
    pub value: Option<u8>,
    pub minutes: Option<u16>,
    pub due: Option<&'a str>,
    pub options: &'a [String],
    pub page: bool,
}

/// What `aoe session rank` sets on a current ask; absent fields stay.
#[derive(Debug, Default, Clone, Copy)]
pub struct Rank<'a> {
    pub value: Option<u8>,
    pub minutes: Option<u16>,
    pub due: Option<&'a str>,
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
pub const MAX_OPTIONS: usize = 6;
pub const MAX_OPTION_CHARS: usize = 40;

/// Build the ask from the CLI parts: each text part is trimmed with
/// whitespace runs collapsed, an empty part is absent, an over-long or
/// out-of-range one is refused, and any field without text is refused.
/// Nothing given is no ask.
pub fn parse_ask(input: AskInput<'_>) -> Result<Option<Ask>> {
    let objective = one_line(input.objective, "objective", MAX_OBJECTIVE_CHARS)?;
    let link = one_line(input.link, "link", MAX_LINK_CHARS)?;
    let Some(text) = one_line(input.text, "ask", MAX_ASK_TEXT_CHARS)? else {
        if input.kind.is_some()
            || objective.is_some()
            || link.is_some()
            || input.value.is_some()
            || input.minutes.is_some()
            || input.due.is_some()
            || !input.options.is_empty()
            || input.page
        {
            bail!("an ask needs its one line saying what to do");
        }
        return Ok(None);
    };
    Ok(Some(Ask {
        kind: input.kind,
        text,
        objective,
        link,
        options: parse_options(input.kind, input.options)?,
        page: input.page,
        value: check_value(input.value)?,
        minutes: check_minutes(input.minutes)?,
        due: check_due(input.due)?,
        ..Ask::default()
    }))
}

fn check_value(value: Option<u8>) -> Result<Option<u8>> {
    if let Some(v) = value.filter(|v| *v > 100) {
        bail!("value must be 0 to 100, got {v}");
    }
    Ok(value)
}

fn check_minutes(minutes: Option<u16>) -> Result<Option<u16>> {
    if let Some(m) = minutes.filter(|m| !(1..=480).contains(m)) {
        bail!("minutes must be 1 to 480, got {m}");
    }
    Ok(minutes)
}

fn check_due(due: Option<&str>) -> Result<Option<String>> {
    let Some(due) = due.map(str::trim).filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    let parses = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").is_ok()
        || DateTime::parse_from_rfc3339(due).is_ok();
    if !parses {
        bail!("due must be YYYY-MM-DD or an RFC 3339 time, got {due:?}");
    }
    Ok(Some(due.to_string()))
}

fn parse_options(kind: Option<AskKind>, raw: &[String]) -> Result<Vec<String>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    if kind != Some(AskKind::Decide) {
        bail!("options belong to a decide ask");
    }
    if raw.len() > MAX_OPTIONS {
        bail!(
            "a decide ask has at most {MAX_OPTIONS} options, got {}",
            raw.len()
        );
    }
    raw.iter()
        .map(|o| match one_line(Some(o), "option", MAX_OPTION_CHARS)? {
            Some(o) => Ok(o),
            None => bail!("an option must not be empty"),
        })
        .collect()
}

/// `aoe session rank`: set the given estimates on the current ask, leaving the
/// rest and the score's stamp alone. Refuses when nothing is given, when a
/// field is out of range, or when there is no current ask.
pub fn rank_ask(
    stored: Option<&PriorityScore>,
    run_started_at: Option<DateTime<Utc>>,
    rank: Rank<'_>,
) -> Result<PriorityScore> {
    if rank.value.is_none() && rank.minutes.is_none() && rank.due.is_none() {
        bail!("give at least one of --value, --minutes, --due");
    }
    let value = check_value(rank.value)?;
    let minutes = check_minutes(rank.minutes)?;
    let due = check_due(rank.due)?;
    let Some(mut score) = stored
        .filter(|s| is_current(s, run_started_at) && s.ask.is_some())
        .cloned()
    else {
        bail!("no current ask to rank: the session posted none, or ran since");
    };
    let ask = score.ask.as_mut().expect("filtered on ask above");
    ask.value = value.or(ask.value);
    ask.minutes = minutes.or(ask.minutes);
    ask.due = due.or(ask.due.take());
    Ok(score)
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
    let posted = ask.map(|ask| Ask {
        posted_at: Some(now),
        ..ask
    });
    value.map(|value| PriorityScore {
        value,
        set_at: now,
        ask: posted.or_else(kept),
    })
}

/// `aoe session refine`: replace the given fields of the current ask posted at
/// `posted_at`, stamping `refined_at`. Refuses when there is no current ask,
/// when it was posted at another time (a newer request replaced it), and on
/// any field `parse_ask` would refuse. The merge target's validity needs the
/// other sessions and is checked by the caller.
pub fn refine_ask(
    stored: Option<&PriorityScore>,
    run_started_at: Option<DateTime<Utc>>,
    posted_at: DateTime<Utc>,
    refine: Refine<'_>,
    now: DateTime<Utc>,
) -> Result<PriorityScore> {
    let Some(mut score) = stored
        .filter(|s| is_current(s, run_started_at) && s.ask.is_some())
        .cloned()
    else {
        bail!("no current ask to refine: the session posted none, or ran since");
    };
    let ask = score.ask.as_mut().expect("filtered on ask above");
    if ask.posted_at != Some(posted_at) {
        bail!(
            "the session replaced that request: refine the ask posted at {:?}",
            ask.posted_at
        );
    }
    let nothing = refine.kind.is_none()
        && refine.text.is_none()
        && refine.objective.is_none()
        && refine.link.is_none()
        && refine.value.is_none()
        && refine.minutes.is_none()
        && refine.due.is_none()
        && refine.options.is_empty()
        && !refine.page
        && refine.merge_into.is_none();
    if nothing {
        bail!("nothing to refine: give at least one field");
    }
    let kind = refine.kind.or(ask.kind);
    if let Some(text) = one_line(refine.text, "ask", MAX_ASK_TEXT_CHARS)? {
        ask.text = text;
    }
    if let Some(objective) = one_line(refine.objective, "objective", MAX_OBJECTIVE_CHARS)? {
        ask.objective = Some(objective);
    }
    if let Some(link) = one_line(refine.link, "link", MAX_LINK_CHARS)? {
        ask.link = Some(link);
    }
    ask.value = check_value(refine.value)?.or(ask.value);
    ask.minutes = check_minutes(refine.minutes)?.or(ask.minutes);
    ask.due = check_due(refine.due)?.or(ask.due.take());
    if !refine.options.is_empty() {
        ask.options = parse_options(kind, refine.options)?;
    }
    ask.kind = kind;
    ask.page = ask.page || refine.page;
    if let Some(into) = refine.merge_into {
        ask.merged_into = Some(into.to_string());
    }
    ask.refined_at = Some(now);
    Ok(score)
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
            value: None,
            minutes: None,
            due: None,
            ..Ask::default()
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
    fn an_ask_is_one_concrete_line_with_optional_kind_objective_link_value_minutes_and_due() {
        use AskKind::*;
        let input = |text: &'static str| AskInput {
            text: Some(text),
            ..AskInput::default()
        };
        let umlauts: &'static str = Box::leak("ü".repeat(MAX_ASK_TEXT_CHARS).into_boxed_str());
        let cases: [(AskInput, Option<Ask>); 8] = [
            (AskInput::default(), None),
            (input("  \n "), None),
            (
                input("  Approve the\n\n ad   budget "),
                Some(ask("Approve the ad budget")),
            ),
            (
                AskInput {
                    kind: Some(Learn),
                    objective: Some(" YouTube  creators product "),
                    link: Some("https://example.com/note "),
                    value: Some(72),
                    minutes: Some(5),
                    due: Some("2026-10-29"),
                    ..input("Read the creator pricing note")
                },
                Some(Ask {
                    kind: Some(Learn),
                    objective: Some("YouTube creators product".into()),
                    link: Some("https://example.com/note".into()),
                    value: Some(72),
                    minutes: Some(5),
                    due: Some("2026-10-29".into()),
                    ..ask("Read the creator pricing note")
                }),
            ),
            (
                AskInput {
                    kind: Some(Decide),
                    objective: Some(""),
                    link: Some(""),
                    ..input("Pick a date")
                },
                Some(Ask {
                    kind: Some(Decide),
                    ..ask("Pick a date")
                }),
            ),
            (input(umlauts), Some(ask(umlauts))),
            // The range ends are accepted.
            (
                AskInput {
                    value: Some(0),
                    minutes: Some(480),
                    due: Some("2026-10-29T17:00:00-07:00"),
                    ..input("Edges")
                },
                Some(Ask {
                    value: Some(0),
                    minutes: Some(480),
                    due: Some("2026-10-29T17:00:00-07:00".into()),
                    ..ask("Edges")
                }),
            ),
            (
                AskInput {
                    value: Some(100),
                    minutes: Some(1),
                    ..input("Top")
                },
                Some(Ask {
                    value: Some(100),
                    minutes: Some(1),
                    ..ask("Top")
                }),
            ),
        ];
        for (given, expected) in cases {
            assert_eq!(parse_ask(given).unwrap(), expected, "{given:?}");
        }
        let long = |n: usize| -> &'static str { Box::leak("x".repeat(n + 1).into_boxed_str()) };
        let refused: [(AskInput, &str); 10] = [
            (input(long(MAX_ASK_TEXT_CHARS)), "300"),
            (
                AskInput {
                    objective: Some(long(MAX_OBJECTIVE_CHARS)),
                    ..input("ok")
                },
                "80",
            ),
            (
                AskInput {
                    link: Some(long(MAX_LINK_CHARS)),
                    ..input("ok")
                },
                "500",
            ),
            (
                AskInput {
                    value: Some(101),
                    ..input("ok")
                },
                "0 to 100",
            ),
            (
                AskInput {
                    minutes: Some(0),
                    ..input("ok")
                },
                "1 to 480",
            ),
            (
                AskInput {
                    minutes: Some(481),
                    ..input("ok")
                },
                "1 to 480",
            ),
            (
                AskInput {
                    due: Some("tomorrow"),
                    ..input("ok")
                },
                "due",
            ),
            (
                AskInput {
                    kind: Some(Check),
                    ..AskInput::default()
                },
                "one line",
            ),
            (
                AskInput {
                    objective: Some("Objective"),
                    link: Some("https://x"),
                    ..AskInput::default()
                },
                "one line",
            ),
            (
                AskInput {
                    value: Some(50),
                    minutes: Some(5),
                    ..AskInput::default()
                },
                "one line",
            ),
        ];
        for (given, needle) in refused {
            let err = parse_ask(given).expect_err(needle);
            assert!(format!("{err:#}").contains(needle), "{needle}: {err:#}");
        }
    }

    #[test]
    fn a_decide_ask_offers_its_options_and_an_ask_may_carry_a_page() {
        let opts = |v: &[&str]| v.iter().map(|o| o.to_string()).collect::<Vec<_>>();
        let three = opts(&["Approve 40 EUR", " Approve  20 EUR ", "No"]);
        let decided = parse_ask(AskInput {
            kind: Some(AskKind::Decide),
            text: Some("Approve the budget"),
            options: &three,
            page: true,
            ..AskInput::default()
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            decided.options,
            opts(&["Approve 40 EUR", "Approve 20 EUR", "No"])
        );
        assert!(decided.page);
        let seven = opts(&["a", "b", "c", "d", "e", "f", "g"]);
        let long = opts(&[&"x".repeat(MAX_OPTION_CHARS + 1)]);
        let blank = opts(&["Yes", "  "]);
        let yes = opts(&["Yes"]);
        // (kind, options, page, text, error mentions)
        let refused: [(Option<AskKind>, &[String], bool, Option<&str>, &str); 6] = [
            (
                Some(AskKind::Decide),
                &seven,
                false,
                Some("Pick"),
                "at most 6",
            ),
            (Some(AskKind::Decide), &long, false, Some("Pick"), "40"),
            (Some(AskKind::Decide), &blank, false, Some("Pick"), "empty"),
            (Some(AskKind::Answer), &yes, false, Some("Say"), "decide"),
            (None, &yes, false, Some("Say"), "decide"),
            (Some(AskKind::Check), &[], true, None, "one line"),
        ];
        for (kind, options, page, text, needle) in refused {
            let err = parse_ask(AskInput {
                kind,
                options,
                page,
                text,
                ..AskInput::default()
            })
            .expect_err(needle);
            assert!(format!("{err:#}").contains(needle), "{needle}: {err:#}");
        }
    }

    #[test]
    fn posting_an_ask_stamps_when_it_was_posted_and_a_rescore_keeps_it() {
        let posted = next_score(None, Some(8), Some(ask("Pick")), None, t(50)).unwrap();
        assert_eq!(posted.ask.as_ref().unwrap().posted_at, Some(t(50)));
        let kept = next_score(Some(&posted), Some(5), None, None, t(60)).unwrap();
        assert_eq!(
            kept.ask.unwrap().posted_at,
            Some(t(50)),
            "a re-rank is not a new request"
        );
        let replaced = next_score(Some(&posted), Some(5), Some(ask("Other")), None, t(70)).unwrap();
        assert_eq!(replaced.ask.unwrap().posted_at, Some(t(70)));
    }

    #[test]
    fn a_refine_replaces_only_the_given_fields_of_the_request_it_was_worked_out_for() {
        let posted = next_score(
            None,
            Some(8),
            Some(Ask {
                kind: Some(AskKind::Answer),
                objective: Some("Social media".into()),
                ..ask("need a budget number")
            }),
            None,
            t(50),
        )
        .unwrap();
        let options = vec!["40 EUR".to_string(), "20 EUR".to_string()];
        let refined = refine_ask(
            Some(&posted),
            Some(t(10)),
            t(50),
            Refine {
                kind: Some(AskKind::Decide),
                text: Some(" Approve the  LinkedIn ad budget "),
                value: Some(72),
                minutes: Some(2),
                options: &options,
                page: true,
                ..Refine::default()
            },
            t(90),
        )
        .unwrap();
        let a = refined.ask.as_ref().unwrap();
        assert_eq!(a.text, "Approve the LinkedIn ad budget");
        assert_eq!(
            (a.kind, a.value, a.minutes, a.page),
            (Some(AskKind::Decide), Some(72), Some(2), true)
        );
        assert_eq!(a.options, options);
        assert_eq!(
            a.objective.as_deref(),
            Some("Social media"),
            "unnamed fields stay"
        );
        assert_eq!((a.posted_at, a.refined_at), (Some(t(50)), Some(t(90))));
        assert_eq!(
            (refined.value, refined.set_at),
            (posted.value, posted.set_at),
            "score and currency stay"
        );
        let merged = refine_ask(
            Some(&posted),
            None,
            t(50),
            Refine {
                merge_into: Some("other1"),
                ..Refine::default()
            },
            t(91),
        )
        .unwrap();
        assert_eq!(merged.ask.unwrap().merged_into.as_deref(), Some("other1"));
        type Refused<'a> = (
            Option<&'a PriorityScore>,
            Option<DateTime<Utc>>,
            DateTime<Utc>,
            Refine<'a>,
            &'a str,
        );
        // (stored, run_started_at, for, refine, error mentions)
        let stale_run = Some(t(60));
        let refused: [Refused; 6] = [
            (
                None,
                None,
                t(50),
                Refine {
                    value: Some(5),
                    ..Refine::default()
                },
                "no current ask",
            ),
            (
                Some(&posted),
                stale_run,
                t(50),
                Refine {
                    value: Some(5),
                    ..Refine::default()
                },
                "no current ask",
            ),
            // Worked out for an older request: the session has since replaced it.
            (
                Some(&posted),
                None,
                t(40),
                Refine {
                    value: Some(5),
                    ..Refine::default()
                },
                "replaced",
            ),
            (
                Some(&posted),
                None,
                t(50),
                Refine::default(),
                "nothing to refine",
            ),
            (
                Some(&posted),
                None,
                t(50),
                Refine {
                    value: Some(101),
                    ..Refine::default()
                },
                "0 to 100",
            ),
            (
                Some(&posted),
                None,
                t(50),
                Refine {
                    options: &options,
                    ..Refine::default()
                },
                "decide",
            ),
        ];
        for (stored, run, at, refine, needle) in refused {
            let err = refine_ask(stored, run, at, refine, t(99)).expect_err(needle);
            assert!(format!("{err:#}").contains(needle), "{needle}: {err:#}");
        }
    }

    #[test]
    fn the_coordinator_overrides_a_sessions_own_estimates_on_its_current_ask_only() {
        let posted = PriorityScore {
            ask: Some(Ask {
                kind: Some(AskKind::Decide),
                value: Some(30),
                minutes: Some(20),
                due: Some("2026-10-30".into()),
                ..ask("Approve the budget")
            }),
            ..owned(8, 20, None)
        };
        let ranked = rank_ask(
            Some(&posted),
            Some(t(10)),
            Rank {
                value: Some(81),
                minutes: Some(5),
                due: None,
            },
        )
        .unwrap();
        let after = ranked.ask.as_ref().unwrap();
        assert_eq!(
            (after.value, after.minutes, after.due.as_deref()),
            (Some(81), Some(5), Some("2026-10-30"))
        );
        assert_eq!(
            (after.text.as_str(), after.kind),
            ("Approve the budget", Some(AskKind::Decide))
        );
        assert_eq!(
            (ranked.value, ranked.set_at),
            (8, t(20)),
            "the score and its currency stay"
        );
        let due_only = rank_ask(
            Some(&posted),
            None,
            Rank {
                due: Some("2026-10-29"),
                ..Rank::default()
            },
        )
        .unwrap();
        assert_eq!(due_only.ask.unwrap().due.as_deref(), Some("2026-10-29"));
        // (stored, run_started_at, rank, error mentions)
        let stale = owned(8, 20, Some("Old ask"));
        let unasked = owned(8, 20, None);
        let refused: [(Option<&PriorityScore>, Option<DateTime<Utc>>, Rank, &str); 5] = [
            (Some(&posted), None, Rank::default(), "--value"),
            (
                None,
                None,
                Rank {
                    value: Some(50),
                    ..Rank::default()
                },
                "no current ask",
            ),
            (
                Some(&unasked),
                None,
                Rank {
                    value: Some(50),
                    ..Rank::default()
                },
                "no current ask",
            ),
            // The session ran since: its ask was answered.
            (
                Some(&stale),
                Some(t(30)),
                Rank {
                    value: Some(50),
                    ..Rank::default()
                },
                "no current ask",
            ),
            (
                Some(&posted),
                None,
                Rank {
                    value: Some(101),
                    ..Rank::default()
                },
                "0 to 100",
            ),
        ];
        for (stored, run, rank, needle) in refused {
            let err = rank_ask(stored, run, rank).expect_err(needle);
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
