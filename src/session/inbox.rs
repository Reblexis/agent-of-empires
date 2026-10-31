//! The Inbox's server-side rules, shared by the HTTP API the input/output agent
//! calls: which asks are listed and in what order, who an answer reaches, the
//! reply typed into a session, and the Inbox key. The dashboard derives the same
//! list in the browser (`web/src/lib/inbox.ts`).
//! Spec: docs/guides/session-inbox.md.

use std::path::Path;

use anyhow::{bail, Result};

use super::Instance;

const KEY_FILE: &str = "inbox.key";
/// One line: the id of the session the queue's input box writes to.
pub const ROUTER_FILE: &str = "inbox-router";

/// Whether the session passes "What is listed": unread, effective priority above
/// 0, and its ask not merged into another's.
pub fn is_listed(inst: &Instance) -> bool {
    inst.is_unread()
        && crate::session::unread_enabled()
        && inst.effective_priority() > 0
        && inst.priority_ask().is_some_and(|a| a.merged_into.is_none())
}

/// Value per minute, or `None` when the ask lacks either estimate.
fn per_minute(inst: &Instance) -> Option<f64> {
    let ask = inst.priority_ask()?;
    match (ask.value, ask.minutes) {
        (Some(v), Some(m)) if m > 0 => Some(f64::from(v) / f64::from(m)),
        _ => None,
    }
}

/// A due as an instant: a date counts from its UTC midnight, as the browser
/// reads it.
fn due_instant(inst: &Instance) -> Option<chrono::DateTime<chrono::Utc>> {
    let due = inst.priority_ask()?.due.as_deref()?;
    chrono::DateTime::parse_from_rfc3339(due)
        .map(|t| t.with_timezone(&chrono::Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|t| t.and_utc())
        })
}

/// Earlier first; a missing time after every present one.
fn by_time<T: Ord>(a: Option<T>, b: Option<T>) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a, b) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Less,
        (None, Some(_)) => Greater,
        (None, None) => Equal,
    }
}

/// The Order rules of docs/guides/session-inbox.md.
fn compare(a: &Instance, b: &Instance) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let order = match (per_minute(a), per_minute(b)) {
        (Some(ra), Some(rb)) => rb
            .partial_cmp(&ra)
            .unwrap_or(Equal)
            .then_with(|| by_time(due_instant(a), due_instant(b))),
        (Some(_), None) => Less,
        (None, Some(_)) => Greater,
        (None, None) => b.effective_priority().cmp(&a.effective_priority()),
    };
    order.then_with(|| by_time(a.idle_entered_at, b.idle_entered_at))
}

/// Every session with a current ask, in Inbox order: listed ones first by the
/// Order rules, then the rest in the same order. Pairs each with `listed`.
pub fn queue(instances: &[Instance]) -> Vec<(&Instance, bool)> {
    let mut asks: Vec<&Instance> = instances
        .iter()
        .filter(|i| i.priority_ask().is_some())
        .collect();
    asks.sort_by(|a, b| compare(a, b));
    let (listed, rest): (Vec<_>, Vec<_>) = asks.into_iter().partition(|i| is_listed(i));
    listed
        .into_iter()
        .map(|i| (i, true))
        .chain(rest.into_iter().map(|i| (i, false)))
        .collect()
}

/// One current ask as `aoe session asks` and `GET /api/inbox/asks` print it.
pub fn ask_json(inst: &Instance, context: Option<String>) -> Option<serde_json::Value> {
    let ask = inst.priority_ask()?;
    Some(serde_json::json!({
        "session_id": inst.id,
        "title": inst.title,
        "profile": inst.source_profile,
        "status": inst.status.as_str(),
        "priority": inst.effective_priority(),
        "ask": ask,
        "context": context,
    }))
}

/// The sessions one answer to `id`'s ask reaches: `id` first, then every
/// session whose current ask is merged into it.
pub fn answer_targets(instances: &[Instance], id: &str) -> Vec<String> {
    std::iter::once(id.to_string())
        .chain(
            instances
                .iter()
                .filter(|i| i.priority_ask().and_then(|a| a.merged_into.as_deref()) == Some(id))
                .map(|i| i.id.clone()),
        )
        .collect()
}

/// A merge of `id`'s ask into `into`'s: another session with a current,
/// unmerged ask.
pub fn check_merge(instances: &[Instance], id: &str, into: &str) -> Result<()> {
    if into == id {
        bail!("an ask cannot be merged into itself");
    }
    match instances
        .iter()
        .find(|i| i.id == into)
        .and_then(|t| t.priority_ask())
    {
        Some(ask) if ask.merged_into.is_none() => Ok(()),
        Some(_) => bail!("session {into}'s ask is itself merged; merge into the one it names"),
        None => bail!("session {into} has no current ask to merge into"),
    }
}

/// What an answer types into the session.
pub fn reply_message(ask_text: &str, input: &str) -> String {
    format!("Inbox reply to \"{ask_text}\": {input}")
}

/// What the queue's input box types into the router: the text, then each
/// image path the way the dashboard terminal pastes one.
pub fn message_text(text: &str, paths: &[String]) -> String {
    let mut parts = vec!["Message from Viktor via vcihal.com/io:".to_string()];
    let text = text.trim();
    if !text.is_empty() {
        parts.push(text.to_string());
    }
    parts.extend(paths.iter().map(|p| p.replace(' ', "\\ ")));
    parts.join(" ")
}

/// The router session's id, or `None` when no router is set.
pub fn read_router_in(dir: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(dir.join(ROUTER_FILE)) {
        Ok(id) => Ok(Some(id.trim().to_string()).filter(|i| !i.is_empty())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => bail!("read the Inbox router: {e}"),
    }
}

pub fn read_router() -> Result<Option<String>> {
    read_router_in(&super::get_app_dir()?)
}

/// Write a new random key, owner-only, replacing the old one. Returns it.
pub fn rotate_key_in(dir: &Path) -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| anyhow::anyhow!("no randomness for the Inbox key: {e}"))?;
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(dir)?;
    // Owner-only from the first byte: the app dir itself may be world-readable.
    let tmp = dir.join(format!("{KEY_FILE}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        use std::io::Write;
        let mut file = options.open(&tmp)?;
        file.write_all(key.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(KEY_FILE))?;
    Ok(key)
}

/// The current key, or `None` when none was ever written.
pub fn read_key_in(dir: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(dir.join(KEY_FILE)) {
        Ok(key) => Ok(Some(key.trim().to_string()).filter(|k| !k.is_empty())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => bail!("read the Inbox key: {e}"),
    }
}

pub fn rotate_key() -> Result<String> {
    rotate_key_in(&super::get_app_dir()?)
}

pub fn read_key() -> Result<Option<String>> {
    read_key_in(&super::get_app_dir()?)
}

/// Constant-time comparison of a presented bearer with the key.
pub fn key_matches(presented: &str, key: &str) -> bool {
    use subtle::ConstantTimeEq;
    !key.is_empty()
        && presented.len() == key.len()
        && bool::from(presented.as_bytes().ct_eq(key.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::priority::Ask;
    use crate::session::Status;

    #[test]
    fn a_message_names_its_source_then_the_text_then_each_image_path() {
        assert_eq!(
            message_text("call Max at 5", &["/w/.aoe-pasted-images/a.png".into()]),
            "Message from Viktor via vcihal.com/io: call Max at 5 /w/.aoe-pasted-images/a.png"
        );
        assert_eq!(
            message_text("  ", &["/w/a.png".into(), "/w/b.jpg".into()]),
            "Message from Viktor via vcihal.com/io: /w/a.png /w/b.jpg"
        );
        assert_eq!(
            message_text("x", &["/my dir/a.png".into()]),
            "Message from Viktor via vcihal.com/io: x /my\\ dir/a.png",
            "a space in a path is escaped as the dashboard paste does"
        );
    }

    #[test]
    fn the_router_is_the_one_line_of_its_file_and_none_without_it() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_router_in(dir.path()).unwrap(), None);
        std::fs::write(dir.path().join(ROUTER_FILE), "  \n").unwrap();
        assert_eq!(read_router_in(dir.path()).unwrap(), None);
        std::fs::write(dir.path().join(ROUTER_FILE), "9c9fc9e9bdc5479c\n").unwrap();
        assert_eq!(
            read_router_in(dir.path()).unwrap(),
            Some("9c9fc9e9bdc5479c".to_string())
        );
    }

    fn asking(id: &str, value: Option<u8>, minutes: Option<u16>, priority: u8) -> Instance {
        let mut inst = Instance::new(id, "/tmp/inbox");
        inst.id = id.to_string();
        inst.status = Status::Idle;
        inst.unread = true;
        inst.set_priority(
            Some(priority),
            Some(Ask {
                text: format!("ask {id}"),
                value,
                minutes,
                ..Ask::default()
            }),
        );
        inst
    }

    #[test]
    fn the_queue_lists_unread_unmerged_asks_by_value_per_minute_then_the_rest() {
        crate::session::set_unread_enabled(true);
        let mut read = asking("read", Some(100), Some(1), 9);
        read.unread = false;
        let mut merged = asking("merged", Some(100), Some(1), 9);
        merged
            .priority
            .as_mut()
            .unwrap()
            .ask
            .as_mut()
            .unwrap()
            .merged_into = Some("quick".into());
        let mut zero = asking("zero", Some(100), Some(1), 0);
        zero.unread = true;
        let instances = vec![
            asking("slow", Some(90), Some(30), 5), // 3 per minute
            read,
            asking("unestimated", None, None, 9), // after every estimated ask
            asking("quick", Some(40), Some(2), 5), // 20 per minute
            merged,
            zero,
        ];
        let order: Vec<(&str, bool)> = queue(&instances)
            .iter()
            .map(|(i, l)| (i.id.as_str(), *l))
            .collect();
        assert_eq!(
            order,
            vec![
                ("quick", true),
                ("slow", true),
                ("unestimated", true),
                ("read", false),
                ("merged", false),
            ],
            "a 0-scored session has no current ask and is left out"
        );
    }

    #[test]
    fn an_answer_reaches_the_asker_and_every_session_merged_into_it() {
        let mut dup = asking("dup", None, None, 5);
        dup.priority
            .as_mut()
            .unwrap()
            .ask
            .as_mut()
            .unwrap()
            .merged_into = Some("main".into());
        let mut stale_dup = asking("staledup", None, None, 5);
        stale_dup
            .priority
            .as_mut()
            .unwrap()
            .ask
            .as_mut()
            .unwrap()
            .merged_into = Some("main".into());
        stale_dup.status = Status::Running;
        stale_dup.run_started_at = Some(chrono::Utc::now() + chrono::Duration::seconds(1));
        let instances = vec![
            dup,
            asking("main", None, None, 5),
            stale_dup,
            asking("other", None, None, 5),
        ];
        assert_eq!(
            answer_targets(&instances, "main"),
            vec!["main".to_string(), "dup".to_string()]
        );
        assert_eq!(
            reply_message("Approve the budget?", "Yes"),
            r#"Inbox reply to "Approve the budget?": Yes"#
        );
    }

    #[test]
    fn the_inbox_key_is_random_owner_only_and_rotating_replaces_it() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_key_in(tmp.path()).unwrap(), None);
        let first = rotate_key_in(tmp.path()).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(
            read_key_in(tmp.path()).unwrap().as_deref(),
            Some(first.as_str())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tmp.path().join(KEY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let second = rotate_key_in(tmp.path()).unwrap();
        assert_ne!(first, second);
        assert!(key_matches(&second, &second));
        assert!(!key_matches(&first, &second), "the old key stops working");
        assert!(!key_matches("", &second));
        assert!(!key_matches(&second[..63], &second));
    }
}
