//! Session owners: sessions an outside agent marks as its own, shown among the
//! favorites with the owner, usage and limit on the row. The writer replaces
//! `<app_dir>/session-owners.json` whole; aoe rereads it when its mtime moves
//! and computes nothing. Spec: docs/guides/session-owners.md.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE_NAME: &str = "session-owners.json";
const MAX_OWNER_CHARS: usize = 24;
const MAX_DETAIL_CHARS: usize = 40;
/// The file is stat'ed at most this often, however many rows ask.
const RECHECK: Duration = Duration::from_secs(1);

/// One session's mark, as `GET /api/sessions` carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct OwnerMark {
    pub owner: String,
    pub usage: Option<String>,
    pub limit: Option<String>,
}

impl OwnerMark {
    /// `owner · usage · limit`, leaving out what was not given.
    pub fn rendered(&self) -> String {
        todo!()
    }
}

/// Every valid entry of an owners file. A file that does not parse yields
/// nothing; an entry that breaks the rules is dropped alone.
pub fn parse(bytes: &[u8]) -> HashMap<String, OwnerMark> {
    let _ = bytes;
    HashMap::new()
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
        let _ = path;
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

/// The mark the owners file gives session `id`, if any.
pub fn mark(id: &str) -> Option<OwnerMark> {
    refresh();
    CACHE
        .read()
        .ok()
        .and_then(|c| c.as_ref().and_then(|c| c.marks.get(id).cloned()))
}

/// Whether the owners file lists session `id`.
pub fn is_owned(id: &str) -> bool {
    refresh();
    CACHE
        .read()
        .ok()
        .is_some_and(|c| c.as_ref().is_some_and(|c| c.marks.contains_key(id)))
}

/// Every mark, for the session list's one overlay per poll.
pub fn marks() -> HashMap<String, OwnerMark> {
    refresh();
    CACHE
        .read()
        .ok()
        .and_then(|c| c.as_ref().map(|c| c.marks.clone()))
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn set_marks_for_test(marks: HashMap<String, OwnerMark>) {
    *CACHE.write().unwrap() = Some(Cache {
        marks,
        ..Cache::default()
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(owner: &str, usage: Option<&str>, limit: Option<&str>) -> OwnerMark {
        OwnerMark {
            owner: owner.into(),
            usage: usage.map(Into::into),
            limit: limit.map(Into::into),
        }
    }

    #[test]
    fn owners_file_entries_follow_the_rules() {
        let long_owner = "o".repeat(MAX_OWNER_CHARS + 1);
        let long_usage = "u".repeat(MAX_DETAIL_CHARS + 1);
        let file = serde_json::json!({ "sessions": {
            "full": { "owner": "central", "usage": "4.2M tok today", "limit": "64% of 5h" },
            // Empty and null details read as not given.
            "bare": { "owner": "central", "usage": "", "limit": null },
            "no_owner": { "usage": "1 tok" },
            "empty_owner": { "owner": "" },
            "long_owner": { "owner": long_owner },
            "long_usage": { "owner": "central", "usage": long_usage },
            "not_an_object": "central",
            "numeric_usage": { "owner": "central", "usage": 5 },
        }});
        let marks = parse(file.to_string().as_bytes());
        assert_eq!(
            marks.get("full"),
            Some(&mark("central", Some("4.2M tok today"), Some("64% of 5h")))
        );
        assert_eq!(marks.get("bare"), Some(&mark("central", None, None)));
        assert_eq!(marks.len(), 2, "every broken entry is dropped: {marks:?}");

        for broken in [&b"not json"[..], b"[]", b"{}", br#"{"sessions": []}"#] {
            assert!(parse(broken).is_empty(), "{:?}", String::from_utf8_lossy(broken));
        }
    }

    #[test]
    fn mark_renders_owner_then_usage_then_limit() {
        let cases = [
            (mark("central", None, None), "central"),
            (mark("central", Some("4.2M tok today"), None), "central · 4.2M tok today"),
            (mark("central", None, Some("64% of 5h")), "central · 64% of 5h"),
            (
                mark("central", Some("4.2M tok today"), Some("64% of 5h")),
                "central · 4.2M tok today · 64% of 5h",
            ),
        ];
        for (m, expected) in cases {
            assert_eq!(m.rendered(), expected);
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

#[allow(unused)]
fn _value_is_used(_: Value) {}
