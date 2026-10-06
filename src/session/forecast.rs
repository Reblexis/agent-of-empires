//! Session forecast cards: what happens to the numbers a session works on if
//! it stops now, against what happens if it continues. The agent inside the
//! session writes the card (`aoe session forecast set`); aoe validates it,
//! stamps `updated_at`, and stores it as one file per session under
//! `<app_dir>/session-forecasts/`, never in `sessions.json`, so a forecast
//! write cannot disturb the session registry. aoe computes nothing.
//! Spec: docs/guides/session-forecast.md.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The card, as sent and as stored, is at most this many bytes.
pub const MAX_CARD_BYTES: usize = 16 * 1024;
const MAX_METRICS: usize = 8;
const DIR_NAME: &str = "session-forecasts";
const VERDICTS: [&str; 3] = ["continue", "stop", "unpriced"];
const CARD_FIELDS: [&str; 6] = [
    "verdict",
    "headline",
    "metrics",
    "note",
    "source",
    "decide_by",
];
const METRIC_FIELDS: [&str; 7] = [
    "name",
    "date",
    "stopped",
    "continued",
    "unit",
    "traders",
    "depth",
];
const SOURCE_FIELDS: [&str; 2] = ["label", "url"];

/// What the session list carries per session for the sidebar chip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForecastSummary {
    pub verdict: String,
    pub headline: String,
    pub updated_at: String,
}

pub fn forecasts_dir() -> Result<PathBuf> {
    Ok(super::get_app_dir()?.join(DIR_NAME))
}

/// The card file for `id`. The id is checked first, so a card path can never
/// leave the forecasts directory.
fn card_path(dir: &Path, id: &str) -> Result<PathBuf> {
    super::validate_instance_id(id).context("invalid session id for a forecast card")?;
    Ok(dir.join(format!("{id}.json")))
}

/// A field that is absent or `null` counts as not given.
fn given<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    obj.get(key).filter(|v| !v.is_null())
}

fn refuse_unknown(obj: &Map<String, Value>, allowed: &[&str], at: &str) -> Result<()> {
    for key in obj.keys() {
        if key == "updated_at" && at.is_empty() {
            bail!("updated_at: set by aoe, a card must not carry it");
        }
        if !allowed.contains(&key.as_str()) {
            bail!("{at}{key}: unknown field (allowed: {})", allowed.join(", "));
        }
    }
    Ok(())
}

/// A string of `min..=max` characters (not bytes). `required` refuses an
/// absent or null value.
fn check_text(
    obj: &Map<String, Value>,
    key: &str,
    path: &str,
    (min, max): (usize, usize),
    required: bool,
) -> Result<()> {
    let Some(value) = given(obj, key) else {
        if required {
            bail!("{path}: required");
        }
        return Ok(());
    };
    let Some(text) = value.as_str() else {
        bail!("{path}: must be a string");
    };
    let len = text.chars().count();
    if len < min || len > max {
        if min == 0 {
            bail!("{path}: at most {max} characters (got {len})");
        }
        bail!("{path}: {min} to {max} characters (got {len})");
    }
    Ok(())
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn check_metric(row: &Value, i: usize) -> Result<()> {
    let at = format!("metrics[{i}]");
    let Some(row) = row.as_object() else {
        bail!("{at}: must be an object");
    };
    refuse_unknown(row, &METRIC_FIELDS, &format!("{at}."))?;
    check_text(row, "name", &format!("{at}.name"), (1, 80), true)?;
    if let Some(date) = given(row, "date") {
        let ok = date.as_str().is_some_and(|d| {
            d.len() == 10 && chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()
        });
        if !ok {
            bail!("{at}.date: must be a calendar date YYYY-MM-DD");
        }
    }
    for side in ["stopped", "continued"] {
        if given(row, side).is_some_and(|v| !v.is_number()) {
            bail!("{at}.{side}: must be a number or null");
        }
    }
    check_text(row, "unit", &format!("{at}.unit"), (0, 16), false)?;
    if given(row, "traders").is_some_and(|v| v.as_u64().is_none()) {
        bail!("{at}.traders: must be an integer >= 0");
    }
    if given(row, "depth").is_some_and(|v| !v.as_f64().is_some_and(|d| d >= 0.0)) {
        bail!("{at}.depth: must be a number >= 0");
    }
    Ok(())
}

/// Validate a card as sent by a writer. Returns the card object on success;
/// the error names the offending field.
pub fn validate(input: &[u8]) -> Result<Map<String, Value>> {
    if input.len() > MAX_CARD_BYTES {
        bail!(
            "card is larger than 16 KB ({} bytes, max {MAX_CARD_BYTES})",
            input.len()
        );
    }
    let value: Value =
        serde_json::from_slice(input).map_err(|e| anyhow!("card is not valid JSON: {e}"))?;
    let Value::Object(card) = value else {
        bail!("card must be a JSON object");
    };
    refuse_unknown(&card, &CARD_FIELDS, "")?;

    match given(&card, "verdict") {
        None => bail!("verdict: required, one of {}", VERDICTS.join(", ")),
        Some(v) if v.as_str().is_some_and(|s| VERDICTS.contains(&s)) => {}
        Some(_) => bail!("verdict: must be one of {}", VERDICTS.join(", ")),
    }
    check_text(&card, "headline", "headline", (1, 32), true)?;
    if let Some(metrics) = given(&card, "metrics") {
        let Some(rows) = metrics.as_array() else {
            bail!("metrics: must be an array");
        };
        if rows.len() > MAX_METRICS {
            bail!("metrics: at most {MAX_METRICS} rows (got {})", rows.len());
        }
        for (i, row) in rows.iter().enumerate() {
            check_metric(row, i)?;
        }
    }
    check_text(&card, "note", "note", (0, 280), false)?;
    if let Some(source) = given(&card, "source") {
        let Some(source) = source.as_object() else {
            bail!("source: must be an object with label and url");
        };
        refuse_unknown(source, &SOURCE_FIELDS, "source.")?;
        check_text(source, "label", "source.label", (1, 40), true)?;
        match given(source, "url").map(|u| u.as_str()) {
            None => bail!("source.url: required"),
            Some(Some(url)) if is_http_url(url) => {}
            Some(_) => bail!("source.url: must be an http or https URL"),
        }
    }
    if let Some(at) = given(&card, "decide_by") {
        if !at
            .as_str()
            .is_some_and(|s| DateTime::parse_from_rfc3339(s).is_ok())
        {
            bail!("decide_by: must be an RFC 3339 instant, e.g. 2026-10-06T18:00:00Z");
        }
    }
    Ok(card)
}

/// Validate `input`, stamp `updated_at` with `now`, and replace the card
/// atomically. On any error nothing is written. Returns the stored card.
pub fn write_card_in(dir: &Path, id: &str, input: &[u8], now: DateTime<Utc>) -> Result<Value> {
    let path = card_path(dir, id)?;
    let mut card = validate(input)?;
    card.insert(
        "updated_at".to_string(),
        Value::String(now.to_rfc3339_opts(SecondsFormat::Secs, true)),
    );
    let card = Value::Object(card);
    let bytes = serde_json::to_vec(&card)?;
    if bytes.len() > MAX_CARD_BYTES {
        bail!(
            "card is larger than 16 KB once stored ({} bytes, max {MAX_CARD_BYTES})",
            bytes.len()
        );
    }
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    super::atomic_write(&path, &bytes)?;
    Ok(card)
}

pub fn read_card_in(dir: &Path, id: &str) -> Result<Option<Value>> {
    let path = card_path(dir, id)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
            format!("unreadable forecast card {}", path.display())
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

pub fn clear_card_in(dir: &Path, id: &str) -> Result<()> {
    let path = card_path(dir, id)?;
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("remove {}", path.display()))
        }
        _ => Ok(()),
    }
}

/// The instance id a `<id>.json` card file belongs to, or `None` for any
/// other entry (atomic-write temp files, strays).
fn card_id(entry: &std::fs::DirEntry) -> Option<String> {
    let name = entry.file_name();
    let id = name.to_str()?.strip_suffix(".json")?;
    super::validate_instance_id(id).ok()?;
    Some(id.to_string())
}

/// Every readable card's summary, keyed by instance id. A missing directory
/// or an unreadable card is skipped, never an error: the list must load.
pub fn summaries_in(dir: &Path) -> HashMap<String, ForecastSummary> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let id = card_id(&entry)?;
            let bytes = std::fs::read(entry.path()).ok()?;
            let summary = serde_json::from_slice::<ForecastSummary>(&bytes).ok()?;
            Some((id, summary))
        })
        .collect()
}

/// Remove every card whose instance id is not in `live`. Returns how many.
pub fn prune_orphans_in(dir: &Path, live: &HashSet<String>) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| card_id(entry).is_some_and(|id| !live.contains(&id)))
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
}

pub fn write_card(id: &str, input: &[u8]) -> Result<Value> {
    write_card_in(&forecasts_dir()?, id, input, Utc::now())
}

pub fn read_card(id: &str) -> Result<Option<Value>> {
    read_card_in(&forecasts_dir()?, id)
}

pub fn clear_card(id: &str) -> Result<()> {
    clear_card_in(&forecasts_dir()?, id)
}

pub fn summaries() -> HashMap<String, ForecastSummary> {
    forecasts_dir()
        .map(|dir| summaries_in(&dir))
        .unwrap_or_default()
}

/// Every session id in every profile, trashed ones included. Fails when any
/// profile cannot be read, so a partial view never judges a card an orphan.
fn all_session_ids() -> Result<HashSet<String>> {
    let mut ids = HashSet::new();
    for profile in super::list_profiles()? {
        let instances = super::Storage::open_unwatched(&profile)?
            .load()
            .with_context(|| format!("load profile {profile}"))?;
        ids.extend(instances.into_iter().map(|i| i.id));
    }
    Ok(ids)
}

/// Daemon-start cleanup: remove the cards of sessions that no longer exist
/// in any profile. Removes nothing when a profile cannot be read.
pub fn prune_orphans() -> Result<usize> {
    let live = all_session_ids()?;
    Ok(prune_orphans_in(&forecasts_dir()?, &live))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal() -> Value {
        json!({ "verdict": "continue", "headline": "+150 EUR revenue" })
    }

    fn full() -> Value {
        json!({
            "verdict": "continue",
            "headline": "+150 EUR revenue",
            "metrics": [{
                "name": "Monthly revenue (EUR)",
                "date": "2026-11-01",
                "stopped": 1200,
                "continued": 1350,
                "unit": "EUR",
                "traders": 3,
                "depth": 4000
            }],
            "note": "Next round: rewrite the pricing page.",
            "source": { "label": "Telarchy market", "url": "https://telarchy.com/acme/proposals/12" },
            "decide_by": "2026-10-06T18:00:00Z"
        })
    }

    /// `full()` with `patch` applied at the top level (a `null` patch value
    /// removes the key).
    fn with(patch: Value) -> Value {
        let mut card = full();
        for (k, v) in patch.as_object().unwrap() {
            if v.is_null() {
                card.as_object_mut().unwrap().remove(k);
            } else {
                card[k] = v.clone();
            }
        }
        card
    }

    /// `full()` with the first metric row's `field` set to `value` (a JSON
    /// string "<absent>" removes it).
    fn row(field: &str, value: Value) -> Value {
        let mut card = full();
        let r = card["metrics"][0].as_object_mut().unwrap();
        if value == json!("<absent>") {
            r.remove(field);
        } else {
            r.insert(field.to_string(), value);
        }
        card
    }

    fn source(field: &str, value: Value) -> Value {
        let mut card = full();
        let s = card["source"].as_object_mut().unwrap();
        if value == json!("<absent>") {
            s.remove(field);
        } else {
            s.insert(field.to_string(), value);
        }
        card
    }

    fn bytes(v: &Value) -> Vec<u8> {
        serde_json::to_vec(v).unwrap()
    }

    #[test]
    fn validate_enforces_every_field_rule() {
        let rows = |n: usize| {
            let r = full()["metrics"][0].clone();
            with(json!({ "metrics": vec![r; n] }))
        };
        // (case, card, None = accepted / Some(substring the error must name))
        let cases: Vec<(&str, Value, Option<&str>)> = vec![
            ("minimal card", minimal(), None),
            ("full card", full(), None),
            ("verdict stop", with(json!({"verdict": "stop"})), None),
            (
                "verdict unpriced",
                with(json!({"verdict": "unpriced"})),
                None,
            ),
            (
                "verdict missing",
                with(json!({"verdict": null})),
                Some("verdict"),
            ),
            (
                "verdict outside the enum",
                with(json!({"verdict": "maybe"})),
                Some("verdict"),
            ),
            (
                "verdict wrong type",
                with(json!({"verdict": 1})),
                Some("verdict"),
            ),
            (
                "headline missing",
                with(json!({"headline": null})),
                Some("headline"),
            ),
            (
                "headline empty",
                with(json!({"headline": ""})),
                Some("headline"),
            ),
            (
                "headline 32 chars",
                with(json!({"headline": "x".repeat(32)})),
                None,
            ),
            // Characters, not bytes: 32 multi-byte chars still fit.
            (
                "headline 32 multibyte chars",
                with(json!({"headline": "\u{e9}".repeat(32)})),
                None,
            ),
            (
                "headline 33 chars",
                with(json!({"headline": "x".repeat(33)})),
                Some("headline"),
            ),
            ("metrics empty", with(json!({"metrics": []})), None),
            ("metrics 8 rows", rows(8), None),
            ("metrics 9 rows", rows(9), Some("metrics")),
            (
                "metrics not an array",
                with(json!({"metrics": {}})),
                Some("metrics"),
            ),
            (
                "metric row not an object",
                with(json!({"metrics": [1]})),
                Some("metrics[0]"),
            ),
            (
                "metric name missing",
                row("name", json!("<absent>")),
                Some("metrics[0].name"),
            ),
            (
                "metric name empty",
                row("name", json!("")),
                Some("metrics[0].name"),
            ),
            (
                "metric name 80 chars",
                row("name", json!("n".repeat(80))),
                None,
            ),
            (
                "metric name 81 chars",
                row("name", json!("n".repeat(81))),
                Some("metrics[0].name"),
            ),
            ("metric date absent", row("date", json!("<absent>")), None),
            (
                "metric date bad format",
                row("date", json!("2026-11-1")),
                Some("metrics[0].date"),
            ),
            (
                "metric date not a day",
                row("date", json!("2026-02-30")),
                Some("metrics[0].date"),
            ),
            (
                "metric date with time",
                row("date", json!("2026-11-01T00:00:00Z")),
                Some("metrics[0].date"),
            ),
            ("stopped null is unknown", row("stopped", Value::Null), None),
            (
                "continued null is unknown",
                row("continued", Value::Null),
                None,
            ),
            ("stopped absent", row("stopped", json!("<absent>")), None),
            (
                "stopped negative fraction",
                row("stopped", json!(-12.5)),
                None,
            ),
            (
                "stopped a string",
                row("stopped", json!("1200")),
                Some("metrics[0].stopped"),
            ),
            (
                "continued a bool",
                row("continued", json!(true)),
                Some("metrics[0].continued"),
            ),
            ("unit 16 chars", row("unit", json!("u".repeat(16))), None),
            (
                "unit 17 chars",
                row("unit", json!("u".repeat(17))),
                Some("metrics[0].unit"),
            ),
            ("traders zero", row("traders", json!(0)), None),
            (
                "traders negative",
                row("traders", json!(-1)),
                Some("metrics[0].traders"),
            ),
            (
                "traders fractional",
                row("traders", json!(1.5)),
                Some("metrics[0].traders"),
            ),
            ("depth zero", row("depth", json!(0)), None),
            ("depth fractional", row("depth", json!(12.5)), None),
            (
                "depth negative",
                row("depth", json!(-0.5)),
                Some("metrics[0].depth"),
            ),
            ("unknown row field", row("stoped", json!(1)), Some("stoped")),
            (
                "note 280 chars",
                with(json!({"note": "n".repeat(280)})),
                None,
            ),
            (
                "note 281 chars",
                with(json!({"note": "n".repeat(281)})),
                Some("note"),
            ),
            (
                "optional null is absent",
                with(json!({"note": Value::Null})),
                None,
            ),
            (
                "source http",
                source("url", json!("http://example.com/x")),
                None,
            ),
            (
                "source javascript url",
                source("url", json!("javascript:alert(1)")),
                Some("source.url"),
            ),
            (
                "source ftp url",
                source("url", json!("ftp://example.com/x")),
                Some("source.url"),
            ),
            (
                "source url without host",
                source("url", json!("https://")),
                Some("source.url"),
            ),
            (
                "source url with space",
                source("url", json!("https://a b.com")),
                Some("source.url"),
            ),
            (
                "source url missing",
                source("url", json!("<absent>")),
                Some("source.url"),
            ),
            (
                "source label missing",
                source("label", json!("<absent>")),
                Some("source.label"),
            ),
            (
                "source label empty",
                source("label", json!("")),
                Some("source.label"),
            ),
            (
                "source label 41 chars",
                source("label", json!("l".repeat(41))),
                Some("source.label"),
            ),
            (
                "unknown source field",
                source("href", json!("x")),
                Some("href"),
            ),
            (
                "decide_by with offset",
                with(json!({"decide_by": "2026-10-06T20:00:00+02:00"})),
                None,
            ),
            (
                "decide_by a date only",
                with(json!({"decide_by": "2026-10-06"})),
                Some("decide_by"),
            ),
            (
                "decide_by garbage",
                with(json!({"decide_by": "tonight"})),
                Some("decide_by"),
            ),
            (
                "unknown top-level field",
                with(json!({"verdcit": "stop"})),
                Some("verdcit"),
            ),
            // aoe stamps updated_at itself; a writer that sends one is refused.
            (
                "writer sends updated_at",
                with(json!({"updated_at": "2026-10-06T00:00:00Z"})),
                Some("updated_at"),
            ),
            ("not an object", json!(["continue"]), Some("object")),
        ];
        for (case, card, expected) in cases {
            let got = validate(&bytes(&card));
            match expected {
                None => assert!(
                    got.is_ok(),
                    "{case}: expected accepted, got {:?}",
                    got.err()
                ),
                Some(field) => {
                    let err = got
                        .err()
                        .unwrap_or_else(|| panic!("{case}: expected refused"));
                    let msg = format!("{err:#}");
                    assert!(
                        msg.contains(field),
                        "{case}: error {msg:?} must name {field:?}"
                    );
                }
            }
        }
        let err = validate(b"{not json").unwrap_err();
        assert!(
            format!("{err:#}").contains("JSON"),
            "invalid JSON is named as such"
        );
    }

    #[test]
    fn card_larger_than_16_kb_is_refused() {
        // Eight rows of maximal names plus a long note fit; padding the note
        // field past the byte cap with whitespace does not.
        let mut big = bytes(&minimal());
        big.pop();
        big.extend(std::iter::repeat_n(b' ', MAX_CARD_BYTES));
        big.push(b'}');
        assert!(big.len() > MAX_CARD_BYTES);
        let err = validate(&big).unwrap_err();
        assert!(format!("{err:#}").contains("16 KB"), "{err:#}");

        let mut at_cap = bytes(&minimal());
        at_cap.pop();
        let pad = MAX_CARD_BYTES - at_cap.len() - 1;
        at_cap.extend(std::iter::repeat_n(b' ', pad));
        at_cap.push(b'}');
        assert_eq!(at_cap.len(), MAX_CARD_BYTES);
        assert!(validate(&at_cap).is_ok(), "exactly 16384 bytes is allowed");
    }

    #[test]
    fn set_stamps_updated_at_and_replaces_the_whole_card() {
        let dir = tempfile::tempdir().unwrap();
        let t1: DateTime<Utc> = "2026-10-06T10:00:00Z".parse().unwrap();
        let t2: DateTime<Utc> = "2026-10-06T11:30:00Z".parse().unwrap();
        let stored = write_card_in(dir.path(), "abc123", &bytes(&full()), t1).unwrap();
        assert_eq!(stored["updated_at"], json!("2026-10-06T10:00:00Z"));
        assert_eq!(read_card_in(dir.path(), "abc123").unwrap().unwrap(), stored);
        assert_eq!(
            stored["metrics"][0]["stopped"],
            json!(1200),
            "numbers kept as written"
        );

        write_card_in(dir.path(), "abc123", &bytes(&minimal()), t2).unwrap();
        let card = read_card_in(dir.path(), "abc123").unwrap().unwrap();
        assert_eq!(card["updated_at"], json!("2026-10-06T11:30:00Z"));
        assert!(card.get("metrics").is_none(), "set replaces, never merges");
        assert!(card.get("note").is_none(), "set replaces, never merges");
        assert!(dir.path().join("abc123.json").is_file());
    }

    #[test]
    fn failed_set_leaves_the_previous_card_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        write_card_in(dir.path(), "abc123", &bytes(&full()), now).unwrap();
        let before = std::fs::read(dir.path().join("abc123.json")).unwrap();
        for bad in [
            bytes(&with(json!({"verdict": "maybe"}))),
            b"{not json".to_vec(),
            vec![b' '; MAX_CARD_BYTES + 1],
        ] {
            assert!(write_card_in(dir.path(), "abc123", &bad, now).is_err());
            assert_eq!(
                std::fs::read(dir.path().join("abc123.json")).unwrap(),
                before
            );
        }
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names.len(), 1, "no temp files left behind: {names:?}");
    }

    #[test]
    fn write_is_atomic_readers_never_see_half_a_card() {
        // A reader polling the card while a writer alternates a small and a
        // near-cap card must always parse a whole card: never an empty,
        // truncated, or mixed file.
        let dir = tempfile::tempdir().unwrap();
        let small = bytes(&minimal());
        let large = bytes(&with(
            json!({"note": "n".repeat(280), "metrics": vec![full()["metrics"][0].clone(); 8]}),
        ));
        write_card_in(dir.path(), "atomic", &small, Utc::now()).unwrap();
        let path = dir.path().join("atomic.json");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let stop = stop.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                let mut reads = 0u32;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let raw = std::fs::read(&path).expect("card file never disappears");
                    let parsed: Result<Value, _> = serde_json::from_slice(&raw);
                    assert!(
                        parsed.is_ok(),
                        "reader saw a partial card ({} bytes)",
                        raw.len()
                    );
                    reads += 1;
                }
                reads
            })
        };
        for i in 0..400 {
            let input = if i % 2 == 0 { &large } else { &small };
            write_card_in(dir.path(), "atomic", input, Utc::now()).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let reads = reader.join().expect("reader must not panic");
        assert!(reads > 0);
    }

    #[test]
    fn missing_card_reads_as_none_and_clears_silently() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_card_in(dir.path(), "nobody").unwrap(), None);
        clear_card_in(dir.path(), "nobody").expect("clear on a missing card succeeds");
        // Also when the directory itself does not exist yet.
        let missing = dir.path().join("not-created");
        assert_eq!(read_card_in(&missing, "nobody").unwrap(), None);
        clear_card_in(&missing, "nobody").unwrap();

        write_card_in(dir.path(), "someone", &bytes(&minimal()), Utc::now()).unwrap();
        clear_card_in(dir.path(), "someone").unwrap();
        assert_eq!(read_card_in(dir.path(), "someone").unwrap(), None);
    }

    #[test]
    fn card_path_refuses_ids_that_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "../x", "a/b", "..", "a.json"] {
            assert!(card_path(dir.path(), bad).is_err(), "{bad:?}");
            assert!(write_card_in(dir.path(), bad, &bytes(&minimal()), Utc::now()).is_err());
        }
        assert_eq!(
            card_path(dir.path(), "40f204f1f22f422c").unwrap(),
            dir.path().join("40f204f1f22f422c.json")
        );
    }

    #[test]
    fn summaries_carry_verdict_headline_and_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let t: DateTime<Utc> = "2026-10-06T10:00:00Z".parse().unwrap();
        write_card_in(dir.path(), "a1", &bytes(&full()), t).unwrap();
        write_card_in(
            dir.path(),
            "b2",
            &bytes(&with(
                json!({"verdict": "unpriced", "headline": "no trades"}),
            )),
            t,
        )
        .unwrap();
        // A corrupt file and a stray non-card file never break the list.
        std::fs::write(dir.path().join("c3.json"), b"{broken").unwrap();
        std::fs::write(dir.path().join("README"), b"x").unwrap();
        let got = summaries_in(dir.path());
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(
            got["a1"],
            ForecastSummary {
                verdict: "continue".into(),
                headline: "+150 EUR revenue".into(),
                updated_at: "2026-10-06T10:00:00Z".into(),
            }
        );
        assert_eq!(got["b2"].verdict, "unpriced");
        assert!(summaries_in(&dir.path().join("absent")).is_empty());
    }

    #[test]
    fn prune_removes_cards_whose_session_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["live1", "gone1", "gone2"] {
            write_card_in(dir.path(), id, &bytes(&minimal()), Utc::now()).unwrap();
        }
        let live: HashSet<String> = ["live1".to_string()].into();
        assert_eq!(prune_orphans_in(dir.path(), &live), 2);
        assert!(read_card_in(dir.path(), "live1").unwrap().is_some());
        assert!(read_card_in(dir.path(), "gone1").unwrap().is_none());
        assert!(read_card_in(dir.path(), "gone2").unwrap().is_none());
        assert_eq!(prune_orphans_in(&dir.path().join("absent"), &live), 0);
    }

    fn save_sessions(profile: &str, rows: Vec<crate::session::Instance>) {
        crate::session::Storage::new_unwatched(profile)
            .unwrap()
            .update(|instances, _| {
                instances.extend(rows);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    #[serial_test::serial]
    fn daemon_start_prune_keeps_cards_of_sessions_in_any_profile() {
        use crate::session::Instance;
        let _app = crate::session::test_support::isolate_app_dir();
        let mut a = Instance::new("a", "/tmp/forecast-a");
        a.id = "forecastlivea".into();
        let mut b = Instance::new("b", "/tmp/forecast-b");
        b.id = "forecastliveb".into();
        // A trashed session still exists: its card survives the prune.
        b.trash();
        save_sessions("default", vec![a]);
        save_sessions("work", vec![b]);
        for id in ["forecastlivea", "forecastliveb", "forecastgone"] {
            write_card(id, &bytes(&minimal())).unwrap();
        }
        assert_eq!(prune_orphans().unwrap(), 1);
        assert!(read_card("forecastlivea").unwrap().is_some());
        assert!(read_card("forecastliveb").unwrap().is_some());
        assert!(read_card("forecastgone").unwrap().is_none());
        assert!(forecasts_dir().unwrap().ends_with("session-forecasts"));
        assert_eq!(summaries().len(), 2);
        clear_card("forecastlivea").unwrap();
        assert_eq!(summaries().len(), 1);
    }

    #[test]
    #[serial_test::serial]
    fn daemon_start_prune_deletes_nothing_when_a_profile_cannot_be_read() {
        use crate::session::{Instance, Storage};
        let _app = crate::session::test_support::isolate_app_dir();
        let mut a = Instance::new("a", "/tmp/forecast-a");
        a.id = "forecastlivea".into();
        save_sessions("default", vec![a]);
        // A profile whose sessions.json is corrupt: its sessions are unknown,
        // so no card may be judged an orphan.
        Storage::new_unwatched("broken").unwrap();
        let broken = crate::session::get_app_dir()
            .unwrap()
            .join("profiles/broken/sessions.json");
        std::fs::write(&broken, b"{not an array").unwrap();
        write_card("forecastmaybe", &bytes(&minimal())).unwrap();
        assert!(prune_orphans().is_err());
        assert!(read_card("forecastmaybe").unwrap().is_some());
    }
}
