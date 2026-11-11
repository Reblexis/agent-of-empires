//! Session owners: an outside agent's tree of the sessions it owns. The core
//! (root and its modules) shows in favorites, deeper entries as workers, each
//! with its usage and limit. The writer replaces `<app_dir>/session-owners.json`
//! whole; aoe rereads it when its mtime moves and computes nothing about money
//! or ownership, it only arranges the tree. Spec: docs/guides/session-owners.md.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE_NAME: &str = "session-owners.json";
const MAX_OWNER_CHARS: usize = 24;
/// The file is stat'ed at most this often, however many rows ask.
const RECHECK: Duration = Duration::from_secs(1);

/// A pair of weekly-plan shares (1 = one account's whole weekly limit);
/// `None` is unknown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Shares {
    pub claude: Option<f64>,
    pub codex: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Module,
    Worker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TransferKind {
    Grant,
    Default,
    Raise,
    AutoRaise,
    Cut,
}

/// One budget transfer between sessions (or from outside the tree).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Transfer {
    pub at: chrono::DateTime<chrono::Utc>,
    pub from: String,
    pub to: String,
    pub claude: Option<f64>,
    pub codex: Option<f64>,
    pub kind: TransferKind,
    pub by: String,
}

/// One session's entry with its place in the tree, as `GET /api/sessions`
/// carries it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct OwnerMark {
    pub owner: String,
    pub parent: Option<String>,
    pub role: Role,
    /// The worker's module (`None` for the root, a module, or an orphan worker).
    pub module: Option<String>,
    pub left: Shares,
    pub granted: Shares,
    pub over: bool,
    pub transactions: Vec<Transfer>,
}

/// How full a fuel gauge is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Low,
    Empty,
}

const MAX_TRANSFERS: usize = 20;
/// A gauge turns amber below this share of its grant left.
const LOW_LEFT: f64 = 0.2;

/// A share as a percent of one account's weekly limit: two decimals, trailing
/// zeros dropped, `?` when unknown.
pub fn pct(share: Option<f64>) -> String {
    let Some(share) = share else {
        return "?".into();
    };
    let s = format!("{:.2}", share * 100.0);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.into()
    }
}

pub fn tone(left: Option<f64>, granted: Option<f64>, over: bool) -> Tone {
    match (left, granted) {
        _ if over => Tone::Empty,
        (Some(l), _) if l <= 0.0 => Tone::Empty,
        (Some(l), Some(g)) if l < g * LOW_LEFT => Tone::Low,
        _ => Tone::Ok,
    }
}

/// `width` cells of `▰` filled by left over granted, the rest `▱`.
pub fn meter(left: Option<f64>, granted: Option<f64>, width: usize) -> String {
    let filled = match (left, granted) {
        (Some(l), Some(g)) if g > 0.0 => {
            ((l / g) * width as f64).round().clamp(0.0, width as f64) as usize
        }
        _ => 0,
    };
    "▰".repeat(filled) + &"▱".repeat(width - filled)
}

/// A title without the owner's own prefix (`Central: ` for owner `central`,
/// any case); any other title is kept whole.
pub fn short_title<'a>(title: &'a str, owner: &str) -> &'a str {
    match title.split_once(": ") {
        Some((prefix, rest)) if prefix.eq_ignore_ascii_case(owner) => rest,
        _ => title,
    }
}

fn shares(v: Option<&Value>, may_be_negative: bool) -> Result<Shares, ()> {
    let Some(obj) = (match v {
        None | Some(Value::Null) => return Ok(Shares::default()),
        Some(Value::Object(o)) => Some(o),
        _ => None,
    }) else {
        return Err(());
    };
    let one = |key: &str| match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(x) if x.is_finite() && (may_be_negative || x >= 0.0) => Ok(Some(x)),
            _ => Err(()),
        },
        _ => Err(()),
    };
    Ok(Shares {
        claude: one("claude")?,
        codex: one("codex")?,
    })
}

fn transfer(v: &Value) -> Option<Transfer> {
    let t: Transfer = serde_json::from_value(v.clone()).ok()?;
    let ok = |x: Option<f64>| x.is_none_or(|x| x.is_finite() && x >= 0.0);
    (ok(t.claude) && ok(t.codex)).then_some(t)
}

/// One entry before its place in the tree is known.
fn parse_entry(v: &Value) -> Result<OwnerMark, ()> {
    let obj = v.as_object().ok_or(())?;
    let owner = match obj.get("owner") {
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= MAX_OWNER_CHARS => {
            s.clone()
        }
        _ => return Err(()),
    };
    let parent = match obj.get("parent") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => return Err(()),
    };
    let over = match obj.get("over") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        _ => return Err(()),
    };
    let transactions = match obj.get("transactions") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(transfer)
            .take(MAX_TRANSFERS)
            .collect(),
        _ => return Err(()),
    };
    Ok(OwnerMark {
        owner,
        parent,
        role: Role::Worker,
        module: None,
        left: shares(obj.get("left"), true)?,
        granted: shares(obj.get("granted"), false)?,
        over,
        transactions,
    })
}

/// Every valid entry of an owners file, placed in the tree. A file that does
/// not parse yields nothing; an entry that breaks the rules is dropped alone.
pub fn parse(bytes: &[u8]) -> HashMap<String, OwnerMark> {
    let Ok(Value::Object(file)) = serde_json::from_slice::<Value>(bytes) else {
        tracing::warn!("session owners file does not parse; no session is owned");
        return HashMap::new();
    };
    let Some(Value::Object(sessions)) = file.get("sessions") else {
        return HashMap::new();
    };
    let mut marks = HashMap::new();
    for (id, v) in sessions {
        match parse_entry(v) {
            Ok(m) => {
                marks.insert(id.clone(), m);
            }
            Err(()) => tracing::warn!("session owners file: entry {id} breaks the rules; dropped"),
        }
    }
    place(&mut marks);
    marks
}

/// Set each entry's role and module from the parent chain. The owner is the
/// root and no entry: an entry whose parent is absent, not in the file, or
/// whose chain loops back is a module (directly under the owner), and every
/// other entry is a worker of the module its chain ends at.
fn place(marks: &mut HashMap<String, OwnerMark>) {
    let placed: Vec<(String, Role, Option<String>)> = marks
        .keys()
        .map(|id| {
            let mut seen = HashSet::from([id.clone()]);
            let mut at = id.clone();
            let mut looped = false;
            while let Some(parent) = marks.get(&at).and_then(|m| m.parent.clone()) {
                if !marks.contains_key(&parent) {
                    break;
                }
                if !seen.insert(parent.clone()) {
                    looped = true;
                    break;
                }
                at = parent;
            }
            if looped || at == *id {
                (id.clone(), Role::Module, None)
            } else {
                (id.clone(), Role::Worker, Some(at))
            }
        })
        .collect();
    for (id, role, module) in placed {
        if let Some(m) = marks.get_mut(&id) {
            m.role = role;
            m.module = module;
        }
    }
}

/// Entries below each module, at any depth.
pub fn worker_counts(marks: &HashMap<String, OwnerMark>) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for m in marks.values() {
        if let Some(module) = &m.module {
            *counts.entry(module.clone()).or_default() += 1;
        }
    }
    counts
}

#[derive(Default)]
struct Cache {
    path: Option<PathBuf>,
    mtime: Option<SystemTime>,
    checked: Option<Instant>,
    marks: HashMap<String, OwnerMark>,
}

impl Cache {
    /// Reread `path` when its mtime differs from the last read; a missing file
    /// empties the marks.
    fn refresh_from(&mut self, path: &Path) {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if mtime.is_none() {
            self.mtime = None;
            self.marks.clear();
            return;
        }
        if mtime == self.mtime {
            return;
        }
        self.mtime = mtime;
        self.marks = std::fs::read(path).map(|b| parse(&b)).unwrap_or_default();
    }
}

static CACHE: RwLock<Option<Cache>> = RwLock::new(None);

fn owners_path() -> Option<PathBuf> {
    super::get_app_dir().ok().map(|dir| dir.join(FILE_NAME))
}

/// Recheck the file when the last check is older than [`RECHECK`]. Tests never
/// read the real app dir: their cache is whatever [`set_marks_for_test`] put.
fn refresh() {
    if cfg!(test) {
        return;
    }
    let due = CACHE
        .read()
        .ok()
        .and_then(|c| c.as_ref().and_then(|c| c.checked))
        .is_none_or(|at| at.elapsed() >= RECHECK);
    if !due {
        return;
    }
    let Ok(mut guard) = CACHE.write() else {
        return;
    };
    let cache = guard.get_or_insert_with(Cache::default);
    cache.checked = Some(Instant::now());
    if cache.path.is_none() {
        cache.path = owners_path();
    }
    if let Some(path) = cache.path.clone() {
        cache.refresh_from(&path);
    }
}

/// The entry the owners file gives session `id`, if any.
pub fn mark(id: &str) -> Option<OwnerMark> {
    refresh();
    CACHE
        .read()
        .ok()
        .and_then(|c| c.as_ref().and_then(|c| c.marks.get(id).cloned()))
}

/// Every entry, for one overlay per poll or frame.
pub fn marks() -> HashMap<String, OwnerMark> {
    refresh();
    CACHE
        .read()
        .ok()
        .and_then(|c| c.as_ref().map(|c| c.marks.clone()))
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn test_file(entries: Value) -> HashMap<String, OwnerMark> {
    parse(
        serde_json::json!({ "sessions": entries })
            .to_string()
            .as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn owners_file_entries_follow_the_rules() {
        let transfer = |kind: &str, claude: f64| {
            json!({ "at": "2026-11-10T18:58:09Z", "from": "viktor", "to": "root",
                    "claude": claude, "codex": null, "kind": kind, "by": "viktor" })
        };
        let mut transfers: Vec<Value> = vec![
            transfer("grant", 0.25),
            transfer("bribe", 0.1),
            transfer("cut", -0.1),
        ];
        transfers.extend((0..30).map(|_| transfer("auto-raise", 0.01)));
        let marks = test_file(json!({
            "root": { "owner": "central", "parent": null,
                      "left": { "claude": -0.01, "codex": null }, "granted": { "claude": 0.25, "codex": 0.1 },
                      "over": true, "transactions": transfers,
                      "usage": "old field", "anything": [1, 2] },
            // left, granted and transactions may be absent.
            "bare": { "owner": "central", "parent": "root" },
            "no_owner": { "left": { "claude": 0.1 } },
            "empty_owner": { "owner": "" },
            "long_owner": { "owner": "o".repeat(MAX_OWNER_CHARS + 1) },
            "negative_grant": { "owner": "central", "granted": { "claude": -0.1 } },
            "text_left": { "owner": "central", "left": { "claude": "lots" } },
            "not_an_object": "central",
            "numeric_parent": { "owner": "central", "parent": 7 },
            "text_over": { "owner": "central", "over": "yes" },
            "transactions_not_a_list": { "owner": "central", "transactions": {} },
        }));
        let root = &marks["root"];
        assert_eq!(
            root.left,
            Shares {
                claude: Some(-0.01),
                codex: None
            },
            "left may be negative"
        );
        assert_eq!(
            root.granted,
            Shares {
                claude: Some(0.25),
                codex: Some(0.1)
            }
        );
        assert!(root.over);
        assert_eq!(
            root.transactions.len(),
            MAX_TRANSFERS,
            "bad transfers dropped, the first 20 kept"
        );
        assert_eq!(root.transactions[0].kind, TransferKind::Grant);
        assert_eq!(root.transactions[1].kind, TransferKind::AutoRaise);
        let bare = &marks["bare"];
        assert_eq!(
            (bare.left, bare.granted, bare.over, bare.transactions.len()),
            (Shares::default(), Shares::default(), false, 0)
        );
        assert_eq!(
            marks.len(),
            2,
            "every broken entry is dropped: {:?}",
            marks.keys()
        );

        for broken in [&b"not json"[..], b"[]", b"{}", br#"{"sessions": []}"#] {
            assert!(
                parse(broken).is_empty(),
                "{:?}",
                String::from_utf8_lossy(broken)
            );
        }
    }

    #[test]
    fn this_is_still_brorken_sessions_without_the_allocator_nest_under_the_owner() {
        let e = |parent: Option<&str>| json!({ "owner": "central", "parent": parent });
        let marks = test_file(json!({
            // The owner is the root and not an entry: every parentless entry is a module.
            "m1": e(None),
            "m2": e(None),
            "w1": e(Some("m1")),
            "w2": e(Some("w1")),
            "w3": e(Some("m2")),
            // A parent that left the file (an archived module owner) puts the entry under the owner.
            "missing_parent": e(Some("gone")),
            "cycle_a": e(Some("cycle_b")),
            "cycle_b": e(Some("cycle_a")),
            "under_missing": e(Some("missing_parent")),
        }));
        let cases = [
            ("m1", Role::Module, None),
            ("m2", Role::Module, None),
            ("w1", Role::Worker, Some("m1")),
            ("w2", Role::Worker, Some("m1")),
            ("w3", Role::Worker, Some("m2")),
            ("missing_parent", Role::Module, None),
            ("cycle_a", Role::Module, None),
            ("cycle_b", Role::Module, None),
            ("under_missing", Role::Worker, Some("missing_parent")),
        ];
        for (id, role, module) in cases {
            assert_eq!(
                (marks[id].role, marks[id].module.as_deref()),
                (role, module),
                "{id}"
            );
        }
        let counts = worker_counts(&marks);
        assert_eq!(
            (counts.get("m1"), counts.get("m2"), counts.get("r")),
            (Some(&2), Some(&1), None)
        );
    }

    #[test]
    fn shares_show_as_percents_and_meters() {
        let pcts = [
            (Some(0.0224), "2.24"),
            (Some(0.08), "8"),
            (Some(1.6), "160"),
            (Some(0.0), "0"),
            (Some(0.00004), "0"),
            (None, "?"),
        ];
        for (share, expected) in pcts {
            assert_eq!(pct(share), expected, "{share:?}");
        }
        let tones = [
            (Some(0.06), Some(0.08), false, Tone::Ok),
            (Some(0.016), Some(0.08), false, Tone::Ok),
            (Some(0.015), Some(0.08), false, Tone::Low),
            (Some(0.0), Some(0.08), false, Tone::Empty),
            (Some(-0.01), Some(0.08), false, Tone::Empty),
            (Some(0.08), Some(0.08), true, Tone::Empty),
            (None, Some(0.08), false, Tone::Ok),
        ];
        for (left, granted, over, expected) in tones {
            assert_eq!(
                tone(left, granted, over),
                expected,
                "{left:?}/{granted:?} over={over}"
            );
        }
        let meters = [
            (Some(0.0576), Some(0.08), "▰▰▰▰▱▱"),
            (Some(0.08), Some(0.08), "▰▰▰▰▰▰"),
            (Some(-0.01), Some(0.08), "▱▱▱▱▱▱"),
            (None, Some(0.08), "▱▱▱▱▱▱"),
            (Some(0.01), Some(0.0), "▱▱▱▱▱▱"),
        ];
        for (left, granted, expected) in meters {
            assert_eq!(meter(left, granted, 6), expected, "{left:?}/{granted:?}");
        }
        for (title, expected) in [
            ("Central: Planner", "Planner"),
            ("central: Ops: Daily", "Ops: Daily"),
            ("Planner", "Planner"),
            // Only the owner's own prefix goes; a task's own words stay.
            ("Telarchy: minimize steps", "Telarchy: minimize steps"),
        ] {
            assert_eq!(short_title(title, "central"), expected, "{title}");
        }
    }

    #[test]
    fn cache_rereads_the_file_when_it_changes_and_empties_when_it_goes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut cache = Cache::default();

        cache.refresh_from(&path);
        assert!(cache.marks.is_empty(), "no file, no owned sessions");

        std::fs::write(&path, r#"{"sessions":{"a":{"owner":"central"}}}"#).unwrap();
        cache.refresh_from(&path);
        assert_eq!(cache.marks.keys().collect::<Vec<_>>(), ["a"]);

        // A rewrite with a new mtime is picked up.
        std::fs::write(&path, r#"{"sessions":{"b":{"owner":"central"}}}"#).unwrap();
        let later = SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(later)
            .unwrap();
        cache.refresh_from(&path);
        assert_eq!(cache.marks.keys().collect::<Vec<_>>(), ["b"]);

        std::fs::remove_file(&path).unwrap();
        cache.refresh_from(&path);
        assert!(cache.marks.is_empty(), "a removed file owns nothing");
    }
}
