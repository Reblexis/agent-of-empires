//! `aoe session forecast set|show|clear`: the CLI that writes, prints, and
//! removes a session's forecast card. Storage and validation live in
//! `session::forecast`; this module resolves which session is meant and moves
//! bytes between stdin/stdout and the store. Spec:
//! docs/guides/session-forecast.md.

use std::io::Read;

use anyhow::{bail, Context, Result};
use clap::{Args, Subcommand};

use crate::session::{forecast, Storage};

#[derive(Subcommand)]
pub enum ForecastCommands {
    /// Replace the session's forecast card with the JSON card on stdin.
    /// Validates first; on any error nothing is written.
    Set(ForecastTargetArgs),
    /// Print the session's stored card as JSON (nothing when it has none).
    Show(ForecastTargetArgs),
    /// Remove the session's card (succeeds when it has none).
    Clear(ForecastTargetArgs),
}

#[derive(Args)]
pub struct ForecastTargetArgs {
    /// Session ID or title. Defaults to `$AOE_INSTANCE_ID`, which aoe sets
    /// inside every session it launches.
    #[arg(long)]
    pub session: Option<String>,
}

pub const NO_SESSION: &str = "no session: run inside an aoe session or pass --session";

/// The instance id a forecast command acts on: `--session` (resolved in
/// `profile` like every other `aoe session` subcommand) wins, else the id in
/// `$AOE_INSTANCE_ID`, which must name a session in some profile.
fn resolve_target(profile: &str, session: Option<&str>, env_id: Option<&str>) -> Result<String> {
    if let Some(identifier) = session {
        let storage = Storage::open_unwatched(profile)?;
        let instances = storage.load()?;
        return Ok(super::resolve_session(identifier, &instances)?.id.clone());
    }
    let Some(id) = env_id.filter(|id| !id.is_empty()) else {
        bail!(NO_SESSION);
    };
    // The env names the session aoe launched this process in, which may sit
    // in any profile; a profile that cannot be read is skipped, not fatal.
    let exists = crate::session::list_profiles()?.iter().any(|p| {
        Storage::open_unwatched(p)
            .and_then(|s| s.load())
            .is_ok_and(|instances| instances.iter().any(|i| i.id == id))
    });
    if !exists {
        bail!("no session with id {id} (from $AOE_INSTANCE_ID); pass --session");
    }
    Ok(id.to_string())
}

fn set_card(
    profile: &str,
    session: Option<&str>,
    env_id: Option<&str>,
    input: &[u8],
) -> Result<()> {
    let id = resolve_target(profile, session, env_id)?;
    forecast::write_card(&id, input)?;
    Ok(())
}

/// The text `show` prints, or `None` when the session has no card.
fn show_card(profile: &str, session: Option<&str>, env_id: Option<&str>) -> Result<Option<String>> {
    let id = resolve_target(profile, session, env_id)?;
    forecast::read_card(&id)?
        .map(|card| serde_json::to_string_pretty(&card).map_err(Into::into))
        .transpose()
}

fn clear_card(profile: &str, session: Option<&str>, env_id: Option<&str>) -> Result<()> {
    let id = resolve_target(profile, session, env_id)?;
    forecast::clear_card(&id)
}

pub async fn run(profile: &str, command: ForecastCommands) -> Result<()> {
    let env_id = std::env::var(crate::tmux::env::AOE_INSTANCE_ID_KEY).ok();
    let env_id = env_id.as_deref();
    match command {
        ForecastCommands::Set(args) => {
            // Read one byte past the cap so an oversized card is refused
            // without buffering an unbounded stdin.
            let mut input = Vec::new();
            std::io::stdin()
                .lock()
                .take(forecast::MAX_CARD_BYTES as u64 + 1)
                .read_to_end(&mut input)
                .context("read the card from stdin")?;
            set_card(profile, args.session.as_deref(), env_id, &input)
        }
        ForecastCommands::Show(args) => {
            if let Some(text) = show_card(profile, args.session.as_deref(), env_id)? {
                println!("{text}");
            }
            Ok(())
        }
        ForecastCommands::Clear(args) => clear_card(profile, args.session.as_deref(), env_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Instance, Storage};

    const CARD: &[u8] = br#"{"verdict":"continue","headline":"+150 EUR revenue"}"#;

    fn seed(profile: &str, id: &str, title: &str) {
        let mut inst = Instance::new(title, "/tmp/forecast-cli");
        inst.id = id.to_string();
        Storage::new_unwatched(profile)
            .unwrap()
            .update(|instances, _| {
                instances.push(inst);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    #[serial_test::serial]
    fn target_comes_from_session_flag_then_env_else_no_session() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        seed("other", "bbbb2222", "elsewhere");

        // (case, --session, $AOE_INSTANCE_ID, Ok(id) or Err(substring))
        // Ok(id) is the resolved target; Err(text) a substring of the error.
        type Case<'a> = (
            &'a str,
            Option<&'a str>,
            Option<&'a str>,
            Result<&'a str, &'a str>,
        );
        let cases: [Case; 8] = [
            ("env id", None, Some("aaaa1111"), Ok("aaaa1111")),
            (
                "env id in another profile",
                None,
                Some("bbbb2222"),
                Ok("bbbb2222"),
            ),
            ("flag by title", Some("pricing work"), None, Ok("aaaa1111")),
            ("flag by id prefix", Some("aaaa"), None, Ok("aaaa1111")),
            (
                "flag wins over env",
                Some("pricing work"),
                Some("bbbb2222"),
                Ok("aaaa1111"),
            ),
            ("neither", None, None, Err(NO_SESSION)),
            ("empty env counts as unset", None, Some(""), Err(NO_SESSION)),
            (
                "env id that names no session",
                None,
                Some("cccc3333"),
                Err("cccc3333"),
            ),
        ];
        for (case, flag, env, expected) in cases {
            let got = resolve_target("default", flag, env);
            match expected {
                Ok(id) => assert_eq!(
                    got.unwrap_or_else(|e| panic!("{case}: {e:#}")),
                    id,
                    "{case}"
                ),
                Err(msg) => {
                    let err = format!("{:#}", got.expect_err(case));
                    assert!(err.contains(msg), "{case}: {err:?} must contain {msg:?}");
                }
            }
        }
        let err = format!(
            "{:#}",
            resolve_target("default", Some("nope"), None).unwrap_err()
        );
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    #[serial_test::serial]
    fn writing_a_card_never_modifies_sessions_json() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let sessions = crate::session::get_app_dir()
            .unwrap()
            .join("profiles/default/sessions.json");
        let before = std::fs::read(&sessions).unwrap();
        let mtime = std::fs::metadata(&sessions).unwrap().modified().unwrap();

        set_card("default", Some("pricing work"), None, CARD).unwrap();
        set_card("default", None, Some("aaaa1111"), CARD).unwrap();
        assert!(set_card("default", None, Some("aaaa1111"), b"{}").is_err());
        show_card("default", None, Some("aaaa1111")).unwrap();
        clear_card("default", None, Some("aaaa1111")).unwrap();

        assert_eq!(std::fs::read(&sessions).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&sessions).unwrap().modified().unwrap(),
            mtime
        );
    }

    #[test]
    #[serial_test::serial]
    fn show_prints_the_stored_card_or_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        assert_eq!(show_card("default", None, Some("aaaa1111")).unwrap(), None);
        clear_card("default", None, Some("aaaa1111")).expect("clear without a card succeeds");

        set_card("default", None, Some("aaaa1111"), CARD).unwrap();
        let shown = show_card("default", None, Some("aaaa1111"))
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&shown).unwrap();
        assert_eq!(parsed["headline"], "+150 EUR revenue");
        assert!(parsed["updated_at"].is_string(), "show includes the stamp");

        // A refused set leaves the shown card as it was.
        assert!(set_card("default", None, Some("aaaa1111"), br#"{"verdict":"maybe"}"#).is_err());
        assert_eq!(
            show_card("default", None, Some("aaaa1111"))
                .unwrap()
                .unwrap(),
            shown
        );

        clear_card("default", None, Some("aaaa1111")).unwrap();
        assert_eq!(show_card("default", None, Some("aaaa1111")).unwrap(), None);
    }
}
