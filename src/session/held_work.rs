//! Whether a session holds scheduled work that tearing down its agent process
//! would destroy: a pending in-session wake or a running background job.
//!
//! Claude Code keeps session-only crons, `/loop` wakeups, background shells
//! and background agents inside its own process. Idle auto-stop and LRU
//! hibernation both kill that process, so both consult
//! [`holds_scheduled_work`] before parking a session. The rules are the
//! "Scheduled work keeps a session live" section of
//! `docs/guides/configuration.md`.

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::Value;

use super::Instance;

/// Claude expires a recurring session-only cron this long after creating it.
const RECURRING_CRON_LIFETIME: chrono::Duration = chrono::Duration::days(7);

/// Whether a Claude transcript (JSONL) shows a wake still pending at `now`.
pub fn transcript_holds_wake<R: BufRead>(transcript: R, now: DateTime<Utc>) -> bool {
    // CronCreate tool_use id -> creation time, until its result names the job.
    let mut creating: HashMap<String, DateTime<Utc>> = HashMap::new();
    // Job id -> the moment it stops holding the session.
    let mut jobs: HashMap<String, DateTime<Utc>> = HashMap::new();
    let mut wake: Option<DateTime<Utc>> = None;
    for line in transcript.split(b'\n') {
        let Ok(line) = line else { break };
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
        };
        if !(line.contains("CronCreate")
            || line.contains("CronDelete")
            || line.contains("ScheduleWakeup")
            || line.contains("nextFireAt"))
        {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let at = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc));
        let Some(blocks) = entry.pointer("/message/content").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let input = block.get("input").unwrap_or(&Value::Null);
                    match block.get("name").and_then(Value::as_str) {
                        Some("CronCreate") => {
                            if let (Some(id), Some(at)) =
                                (block.get("id").and_then(Value::as_str), at)
                            {
                                creating.insert(id.to_string(), at);
                            }
                        }
                        Some("CronDelete") => {
                            if let Some(job) = input.get("id").and_then(Value::as_str) {
                                jobs.remove(job);
                            }
                        }
                        Some("ScheduleWakeup") => {
                            if input.get("stop").and_then(Value::as_bool) == Some(true) {
                                wake = None;
                            } else if let (Some(at), Some(delay)) =
                                (at, input.get("delaySeconds").and_then(Value::as_f64))
                            {
                                wake = Some(at + chrono::Duration::seconds(delay as i64));
                            }
                        }
                        _ => {}
                    }
                }
                Some("tool_result") => {
                    let Some(created) = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .and_then(|id| creating.remove(id))
                    else {
                        continue;
                    };
                    let result = entry.get("toolUseResult").unwrap_or(&Value::Null);
                    let Some(job) = result.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let until = if result.get("recurring").and_then(Value::as_bool) == Some(true) {
                        Some(created + RECURRING_CRON_LIFETIME)
                    } else {
                        result
                            .get("nextFireAt")
                            .and_then(Value::as_i64)
                            .and_then(DateTime::from_timestamp_millis)
                    };
                    if let Some(until) = until {
                        jobs.insert(job.to_string(), until);
                    }
                }
                _ => {}
            }
        }
    }
    wake.is_some_and(|w| w > now) || jobs.values().any(|&until| until > now)
}

/// Whether a Claude pane's visible text shows a running background shell or
/// background agent.
pub fn pane_shows_background_job(pane: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?m)· \d+ shells?\b|^\s*◯ .*↓ [\d.]+k? tokens|Waiting for \d+ background agents?\b",
        )
        .expect("static regex")
    })
    .is_match(pane)
}

/// Whether `inst` holds scheduled work (I/O: reads its transcripts and pane).
pub fn holds_scheduled_work(inst: &Instance) -> bool {
    let pane = inst
        .tmux_session()
        .ok()
        .and_then(|s| s.capture_pane(0).ok())
        .unwrap_or_default();
    if pane_shows_background_job(&crate::tmux::utils::strip_ansi(&pane)) {
        return true;
    }
    let now = Utc::now();
    crate::session::conversation_carry::claude_transcript_paths(inst)
        .into_iter()
        .filter_map(|path| std::fs::File::open(path).ok())
        .any(|file| transcript_holds_wake(std::io::BufReader::new(file), now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn ts(t: DateTime<Utc>) -> String {
        t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn cron_create(
        at: DateTime<Utc>,
        use_id: &str,
        job: &str,
        recurring: bool,
        fire: DateTime<Utc>,
    ) -> String {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{t}\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"id\":\"{use_id}\",\"name\":\"CronCreate\",\"input\":{{\"cron\":\"1 2 3 4 *\",\"recurring\":{recurring},\"prompt\":\"x\"}}}}]}}}}\n\
             {{\"type\":\"user\",\"timestamp\":\"{t}\",\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"{use_id}\",\"content\":\"Scheduled\"}}]}},\"toolUseResult\":{{\"id\":\"{job}\",\"recurring\":{recurring},\"durable\":false,\"nextFireAt\":{fire}}}}}\n",
            t = ts(at),
            fire = fire.timestamp_millis(),
        )
    }

    fn cron_delete(at: DateTime<Utc>, job: &str) -> String {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{}\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"id\":\"d1\",\"name\":\"CronDelete\",\"input\":{{\"id\":\"{job}\"}}}}]}}}}\n",
            ts(at)
        )
    }

    fn wakeup(at: DateTime<Utc>, delay_secs: i64, stop: bool) -> String {
        let input = if stop {
            "{\"stop\":true}".to_string()
        } else {
            format!("{{\"delaySeconds\":{delay_secs},\"prompt\":\"p\",\"reason\":\"r\"}}")
        };
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{}\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"id\":\"w1\",\"name\":\"ScheduleWakeup\",\"input\":{input}}}]}}}}\n",
            ts(at)
        )
    }

    #[test]
    fn transcript_pending_wake_rule() {
        let now = Utc::now();
        let h = Duration::hours(1);
        let cases: Vec<(&str, String, bool)> = vec![
            ("empty transcript", String::new(), false),
            (
                "garbage lines are ignored",
                "not json\n{\"name\":\"CronCreate\"\n".into(),
                false,
            ),
            (
                // The 2e370f46 case: a one-shot measurement set for later.
                "one-shot cron still ahead holds",
                cron_create(now - h, "u1", "j1", false, now + h),
                true,
            ),
            (
                "one-shot cron that already fired does not",
                cron_create(now - h * 2, "u1", "j1", false, now - h),
                false,
            ),
            (
                "cancelled cron does not",
                cron_create(now - h, "u1", "j1", false, now + h) + &cron_delete(now - h / 2, "j1"),
                false,
            ),
            (
                "cancelling a different job keeps the first",
                cron_create(now - h, "u1", "j1", false, now + h) + &cron_delete(now - h / 2, "zz"),
                true,
            ),
            (
                "recurring cron holds past its first fire",
                cron_create(
                    now - Duration::days(1),
                    "u1",
                    "j1",
                    true,
                    now - Duration::hours(20),
                ),
                true,
            ),
            (
                "recurring cron expires after 7 days",
                cron_create(
                    now - Duration::days(8),
                    "u1",
                    "j1",
                    true,
                    now - Duration::days(8),
                ),
                false,
            ),
            (
                "wakeup still ahead holds",
                wakeup(now - Duration::minutes(5), 1200, false),
                true,
            ),
            (
                "wakeup that fired does not",
                wakeup(now - h, 600, false),
                false,
            ),
            (
                "a stop after a wakeup ends the loop",
                wakeup(now - Duration::minutes(5), 1200, false)
                    + &wakeup(now - Duration::minutes(1), 0, true),
                false,
            ),
            (
                "a later wakeup replaces an earlier one",
                wakeup(now - Duration::minutes(30), 3600, false)
                    + &wakeup(now - Duration::minutes(20), 60, false),
                false,
            ),
        ];
        for (name, transcript, want) in cases {
            assert_eq!(
                transcript_holds_wake(transcript.as_bytes(), now),
                want,
                "{name}"
            );
        }
    }

    #[test]
    fn pane_background_job_rule() {
        let cases = [
            ("  ⏵⏵ bypass permissions on · 1 shell", true),
            ("  ⏵⏵ bypass permissions on · 3 shells", true),
            (
                "  ● main\n  ◯ general-purpose  Sampling RSS peaks … 4m 30s · ↓ 84.5k tokens",
                true,
            ),
            ("✻ Waiting for 1 background agent to finish", true),
            ("✻ Waiting for 2 background agents to finish", true),
            ("❯ \n  ⏵⏵ bypass permissions on", false),
            // A finished task's notice is not a running job.
            (
                "Background task update waiting while this panel is open",
                false,
            ),
            // Prose that merely mentions a shell is not the footer.
            ("I ran 1 shell script to check it", false),
            ("", false),
        ];
        for (pane, want) in cases {
            assert_eq!(pane_shows_background_job(pane), want, "{pane:?}");
        }
    }
}
