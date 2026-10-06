//! End-to-end coverage for `aoe session forecast` (docs/guides/session-forecast.md).
//!
//! Drives the real binary as a subprocess: the card goes in on stdin, comes
//! back out of `show`, lives outside `sessions.json`, survives the trash, and
//! goes away when the session is purged. The exit codes and the exact
//! no-session message are the contract a writer script depends on, which a
//! unit test cannot pin.

use serial_test::parallel;

use crate::harness::TuiTestHarness;

const CARD: &str = r#"{"verdict":"continue","headline":"+150 EUR revenue",
  "metrics":[{"name":"Monthly revenue (EUR)","stopped":1200,"continued":1350,"unit":"EUR"}]}"#;

fn sessions_json(h: &TuiTestHarness) -> Vec<u8> {
    std::fs::read(crate::harness::app_dir_in(h.home_path()).join("profiles/default/sessions.json"))
        .expect("sessions.json")
}

fn session_id(h: &TuiTestHarness, title: &str) -> String {
    let v: serde_json::Value = serde_json::from_slice(&sessions_json(h)).unwrap();
    v.as_array()
        .unwrap()
        .iter()
        .find(|s| s["title"] == title)
        .and_then(|s| s["id"].as_str())
        .expect("session row")
        .to_string()
}

fn card_file(h: &TuiTestHarness, id: &str) -> std::path::PathBuf {
    crate::harness::app_dir_in(h.home_path()).join(format!("session-forecasts/{id}.json"))
}

fn ok(out: &std::process::Output, what: &str) -> String {
    assert!(
        out.status.success(),
        "{what} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
#[parallel]
fn forecast_cli_set_show_clear_and_delete() {
    let mut h = TuiTestHarness::new("forecast_cli");
    // The test may itself run inside an aoe session; an empty value counts as
    // unset, so the env cannot leak a real target in.
    h.set_env("AOE_INSTANCE_ID", "");
    ok(
        &h.run_cli(&["add", "--scratch", "-t", "Pricing"]),
        "aoe add",
    );
    let id = session_id(&h, "Pricing");

    // No target at all: non-zero with the documented message.
    let none = h.run_cli_with_stdin(&["session", "forecast", "set"], CARD);
    assert!(!none.status.success());
    assert!(
        String::from_utf8_lossy(&none.stderr)
            .contains("no session: run inside an aoe session or pass --session"),
        "stderr: {}",
        String::from_utf8_lossy(&none.stderr)
    );

    // show/clear with no card: exit 0, nothing printed.
    let shown = ok(
        &h.run_cli(&["session", "forecast", "show", "--session", "Pricing"]),
        "show",
    );
    assert_eq!(shown, "", "show without a card prints nothing");
    ok(
        &h.run_cli(&["session", "forecast", "clear", "--session", "Pricing"]),
        "clear",
    );

    // set from stdin by title; sessions.json is never written.
    let registry = sessions_json(&h);
    ok(
        &h.run_cli_with_stdin(
            &["session", "forecast", "set", "--session", "Pricing"],
            CARD,
        ),
        "set",
    );
    assert_eq!(
        sessions_json(&h),
        registry,
        "a forecast write never touches sessions.json"
    );
    assert!(card_file(&h, &id).is_file());
    let shown = ok(
        &h.run_cli(&["session", "forecast", "show", "--session", &id]),
        "show",
    );
    let card: serde_json::Value = serde_json::from_str(&shown).expect("show prints JSON");
    assert_eq!(card["headline"], "+150 EUR revenue");
    assert!(card["updated_at"].is_string());

    // A refused set exits non-zero, names the field, keeps the old card.
    let before = std::fs::read(card_file(&h, &id)).unwrap();
    let bad = h.run_cli_with_stdin(
        &["session", "forecast", "set", "--session", "Pricing"],
        r#"{"verdict":"maybe","headline":"x"}"#,
    );
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("verdict"));
    assert_eq!(std::fs::read(card_file(&h, &id)).unwrap(), before);

    // From inside the session: the target comes from $AOE_INSTANCE_ID.
    h.set_env("AOE_INSTANCE_ID", &id);
    ok(
        &h.run_cli_with_stdin(
            &["session", "forecast", "set"],
            r#"{"verdict":"stop","headline":"-20 EUR"}"#,
        ),
        "set from env",
    );
    let shown = ok(
        &h.run_cli(&["session", "forecast", "show"]),
        "show from env",
    );
    assert!(shown.contains("-20 EUR"), "{shown}");

    // The trash keeps the card; a purge removes it.
    ok(&h.run_cli(&["rm", "Pricing"]), "rm to trash");
    assert!(
        card_file(&h, &id).is_file(),
        "a trashed session keeps its card"
    );
    ok(&h.run_cli(&["rm", "--purge", "Pricing"]), "rm --purge");
    assert!(
        !card_file(&h, &id).exists(),
        "deleting the session removes its card"
    );
}
