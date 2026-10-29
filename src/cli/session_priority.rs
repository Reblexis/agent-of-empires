//! `aoe session priority <0-10|clear>`: the agent's score for how soon its
//! session needs the user. The rules live in `session::priority`; this module
//! resolves the target the way `aoe session forecast` does and writes the
//! score. Spec: docs/guides/session-priority.md.

use anyhow::Result;
use clap::Args;

use crate::session::{priority, Storage};

#[derive(Args)]
pub struct PriorityArgs {
    /// An integer 0 to 10 (higher = needs you sooner), or `clear`.
    pub value: String,
    /// The ask: one line saying exactly what the user should do, at most 300
    /// characters, listed in the web Inbox and carried by status pushes.
    /// Without one, a still-current ask is kept. See docs/guides/session-inbox.md.
    pub text: Vec<String>,
    /// What kind of ask it is.
    #[arg(long = "ask", value_enum)]
    pub kind: Option<priority::AskKind>,
    /// The focus objective the ask serves, at most 80 characters.
    #[arg(long)]
    pub objective: Option<String>,
    /// A URL or a command to run, at most 500 characters.
    #[arg(long)]
    pub link: Option<String>,
    /// How much doing the ask moves its objective times the objective's
    /// importance, 0 to 100. The Inbox orders by value per minute.
    #[arg(long = "value")]
    pub ask_value: Option<u8>,
    /// Estimated minutes of the user's attention, 1 to 480.
    #[arg(long)]
    pub minutes: Option<u16>,
    /// When doing it stops being worth as much: YYYY-MM-DD or RFC 3339.
    #[arg(long)]
    pub due: Option<String>,
    /// A choice of a `decide` ask (repeat, at most 6); none means Yes and No.
    #[arg(long = "option")]
    pub options: Vec<String>,
    /// HTML file for the ask page, at most 4 MiB: only what the user needs to
    /// know for the ask, inline only (no scripts, no network).
    #[arg(long)]
    pub page: Option<std::path::PathBuf>,
    /// Session ID or title. Defaults to `$AOE_INSTANCE_ID`, which aoe sets
    /// inside every session it launches.
    #[arg(long)]
    pub session: Option<String>,
}

#[derive(Args)]
pub struct RankArgs {
    /// Value toward the objective times its importance, 0 to 100.
    #[arg(long)]
    pub value: Option<u8>,
    /// Estimated minutes of the user's attention, 1 to 480.
    #[arg(long)]
    pub minutes: Option<u16>,
    /// When doing it stops being worth as much: YYYY-MM-DD or RFC 3339.
    #[arg(long)]
    pub due: Option<String>,
    /// Session ID or title. Defaults to `$AOE_INSTANCE_ID`.
    #[arg(long)]
    pub session: Option<String>,
}

/// The session id and the profile that holds it. `$AOE_INSTANCE_ID` may name
/// a session in another profile, so the write goes where it lives.
fn resolve_home(
    profile: &str,
    session: Option<&str>,
    env_id: Option<&str>,
) -> Result<(String, String)> {
    let id = super::session_forecast::resolve_target(profile, session, env_id)?;
    let home = if session.is_some() {
        profile.to_string()
    } else {
        crate::session::list_profiles()?
            .into_iter()
            .find(|p| {
                Storage::open_unwatched(p)
                    .and_then(|s| s.load())
                    .is_ok_and(|instances| instances.iter().any(|i| i.id == id))
            })
            .unwrap_or_else(|| profile.to_string())
    };
    Ok((home, id))
}

/// Validate `value` and the ask, resolve the session, and store the score,
/// then the ask page: written when the new ask has one, removed when a new ask
/// or `clear` replaces the stored one. Returns the session's title and the
/// stored value.
fn set_priority(
    profile: &str,
    value: &str,
    ask: priority::AskInput<'_>,
    page: Option<&[u8]>,
    session: Option<&str>,
    env_id: Option<&str>,
) -> Result<(String, Option<u8>)> {
    let value = priority::parse_priority_arg(value)?;
    let ask = priority::parse_ask(priority::AskInput {
        page: page.is_some(),
        ..ask
    })?;
    let replaces = ask.is_some() || value.is_none();
    let (home, id) = resolve_home(profile, session, env_id)?;
    let title = Storage::new_unwatched(&home)?.update(|instances, _groups| {
        super::patch_instance(instances, &id, |inst| {
            inst.set_priority(value, ask);
            Ok(inst.title.clone())
        })
    })?;
    match page {
        Some(html) => crate::session::ask_page::write_page(&id, html)?,
        None if replaces => crate::session::ask_page::clear_page(&id)?,
        None => {}
    }
    Ok((title, value))
}

/// Override the estimates on the session's current ask. Returns its title.
fn rank(
    profile: &str,
    rank: priority::Rank<'_>,
    session: Option<&str>,
    env_id: Option<&str>,
) -> Result<String> {
    let (home, id) = resolve_home(profile, session, env_id)?;
    Storage::new_unwatched(&home)?.update(|instances, _groups| {
        super::patch_instance(instances, &id, |inst| {
            inst.priority = Some(priority::rank_ask(
                inst.priority.as_ref(),
                inst.run_started_at,
                rank,
            )?);
            Ok(inst.title.clone())
        })
    })
}

pub async fn run(profile: &str, args: PriorityArgs) -> Result<()> {
    let env_id = std::env::var(crate::tmux::env::AOE_INSTANCE_ID_KEY).ok();
    let text = (!args.text.is_empty()).then(|| args.text.join(" "));
    let page = args
        .page
        .as_deref()
        .map(crate::session::ask_page::read_source)
        .transpose()?;
    let ask = priority::AskInput {
        kind: args.kind,
        text: text.as_deref(),
        objective: args.objective.as_deref(),
        link: args.link.as_deref(),
        value: args.ask_value,
        minutes: args.minutes,
        due: args.due.as_deref(),
        options: &args.options,
        page: false,
    };
    let (title, value) = set_priority(
        profile,
        &args.value,
        ask,
        page.as_deref(),
        args.session.as_deref(),
        env_id.as_deref(),
    )?;
    match value {
        Some(v) => println!("✓ Set priority for '{title}': {v}"),
        None => println!("✓ Cleared priority for '{title}'"),
    }
    Ok(())
}

pub async fn run_rank(profile: &str, args: RankArgs) -> Result<()> {
    let env_id = std::env::var(crate::tmux::env::AOE_INSTANCE_ID_KEY).ok();
    let title = rank(
        profile,
        priority::Rank {
            value: args.value,
            minutes: args.minutes,
            due: args.due.as_deref(),
        },
        args.session.as_deref(),
        env_id.as_deref(),
    )?;
    println!("✓ Ranked the ask of '{title}'");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Instance, Status};

    fn seed(profile: &str, id: &str, title: &str) {
        let mut inst = Instance::new(title, "/tmp/priority-cli");
        inst.id = id.to_string();
        inst.status = Status::Idle;
        Storage::new_unwatched(profile)
            .unwrap()
            .update(|instances, _| {
                instances.push(inst);
                Ok(())
            })
            .unwrap();
    }

    fn stored(profile: &str, id: &str) -> Instance {
        Storage::open_unwatched(profile)
            .unwrap()
            .load()
            .unwrap()
            .into_iter()
            .find(|i| i.id == id)
            .unwrap()
    }

    #[test]
    #[serial_test::serial]
    fn an_agent_scores_its_own_session_from_the_environment() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let (title, value) = set_priority(
            "default",
            "8",
            priority::AskInput::default(),
            None,
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert_eq!((title.as_str(), value), ("pricing work", Some(8)));
        let inst = stored("default", "aaaa1111");
        assert_eq!(inst.priority.as_ref().map(|p| p.value), Some(8));
        assert_eq!(inst.effective_priority(), 8);
    }

    #[test]
    #[serial_test::serial]
    fn the_score_lands_in_the_profile_that_holds_the_session() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "here");
        seed("other", "bbbb2222", "elsewhere");
        set_priority(
            "default",
            "9",
            priority::AskInput::default(),
            None,
            None,
            Some("bbbb2222"),
        )
        .unwrap();
        assert_eq!(
            stored("other", "bbbb2222").priority.map(|p| p.value),
            Some(9)
        );
        assert_eq!(stored("default", "aaaa1111").priority, None);
    }

    #[test]
    #[serial_test::serial]
    fn session_flag_wins_and_clear_drops_the_score() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        seed("default", "cccc3333", "other work");
        set_priority(
            "default",
            "7",
            priority::AskInput::default(),
            None,
            Some("pricing work"),
            Some("cccc3333"),
        )
        .unwrap();
        assert_eq!(
            stored("default", "aaaa1111").priority.map(|p| p.value),
            Some(7)
        );
        assert_eq!(stored("default", "cccc3333").priority, None);
        let (_, value) = set_priority(
            "default",
            "clear",
            priority::AskInput::default(),
            None,
            Some("pricing work"),
            None,
        )
        .unwrap();
        assert_eq!(value, None);
        assert_eq!(stored("default", "aaaa1111").priority, None);
    }

    #[test]
    #[serial_test::serial]
    fn an_invalid_value_changes_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        set_priority(
            "default",
            "6",
            priority::AskInput::default(),
            None,
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        for bad in ["11", "-1", "high"] {
            let err = format!(
                "{:#}",
                set_priority(
                    "default",
                    bad,
                    priority::AskInput::default(),
                    None,
                    None,
                    Some("aaaa1111")
                )
                .unwrap_err()
            );
            assert!(err.contains("0 to 10"), "{bad}: {err}");
        }
        assert_eq!(
            stored("default", "aaaa1111").priority.map(|p| p.value),
            Some(6)
        );
    }

    #[test]
    #[serial_test::serial]
    fn the_ask_is_stored_with_the_score_and_a_bad_one_changes_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let decide = priority::AskInput {
            kind: Some(priority::AskKind::Decide),
            text: Some("Approve  the\nbudget"),
            objective: Some("Telarchy social media"),
            link: Some("https://example.com"),
            ..priority::AskInput::default()
        };
        set_priority("default", "8", decide, None, None, Some("aaaa1111")).unwrap();
        let text = |inst: Instance| inst.priority.and_then(|p| p.ask).map(|a| a.text);
        let inst = stored("default", "aaaa1111");
        let ask = inst.priority_ask().cloned().unwrap();
        assert_eq!(ask.text, "Approve the budget");
        assert_eq!(ask.kind, Some(priority::AskKind::Decide));
        assert_eq!(ask.objective.as_deref(), Some("Telarchy social media"));
        assert_eq!(ask.link.as_deref(), Some("https://example.com"));
        // A focus re-rank without an ask keeps it.
        set_priority(
            "default",
            "5",
            priority::AskInput::default(),
            None,
            Some("pricing work"),
            None,
        )
        .unwrap();
        assert_eq!(
            text(stored("default", "aaaa1111")).as_deref(),
            Some("Approve the budget")
        );
        let long = "x".repeat(301);
        for bad in [
            priority::AskInput {
                text: Some(&long),
                ..priority::AskInput::default()
            },
            priority::AskInput {
                kind: Some(priority::AskKind::Learn),
                ..priority::AskInput::default()
            },
        ] {
            set_priority("default", "9", bad, None, None, Some("aaaa1111")).unwrap_err();
        }
        let inst = stored("default", "aaaa1111");
        assert_eq!(inst.priority.as_ref().map(|p| p.value), Some(5));
        assert_eq!(text(inst).as_deref(), Some("Approve the budget"));
    }

    #[test]
    #[serial_test::serial]
    fn the_ask_page_lives_and_dies_with_its_ask() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let page = |text| priority::AskInput {
            kind: Some(priority::AskKind::Decide),
            text: Some(text),
            ..priority::AskInput::default()
        };
        let stored_page = || crate::session::ask_page::read_page("aaaa1111").unwrap();
        set_priority(
            "default",
            "8",
            page("Pick"),
            Some(b"<p>40 EUR</p>"),
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert_eq!(stored_page().as_deref(), Some(&b"<p>40 EUR</p>"[..]));
        assert!(stored("default", "aaaa1111").priority_ask().unwrap().page);
        // A re-score without an ask keeps ask and page.
        set_priority(
            "default",
            "5",
            priority::AskInput::default(),
            None,
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert!(stored_page().is_some());
        // A new ask without a page drops the old page.
        set_priority("default", "6", page("Other"), None, None, Some("aaaa1111")).unwrap();
        assert_eq!(stored_page(), None);
        assert!(!stored("default", "aaaa1111").priority_ask().unwrap().page);
        set_priority(
            "default",
            "8",
            page("Pick"),
            Some(b"<p>x</p>"),
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        set_priority(
            "default",
            "clear",
            priority::AskInput::default(),
            None,
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert_eq!(stored_page(), None, "clear drops the page");
    }

    #[test]
    #[serial_test::serial]
    fn rank_overrides_the_estimates_of_the_current_ask_and_refuses_without_one() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let refused = rank(
            "default",
            priority::Rank {
                value: Some(50),
                ..priority::Rank::default()
            },
            Some("pricing work"),
            None,
        )
        .unwrap_err();
        assert!(
            format!("{refused:#}").contains("no current ask"),
            "{refused:#}"
        );
        let posted = priority::AskInput {
            text: Some("Approve the budget"),
            value: Some(30),
            minutes: Some(20),
            ..priority::AskInput::default()
        };
        set_priority("default", "8", posted, None, None, Some("aaaa1111")).unwrap();
        let before = stored("default", "aaaa1111").priority.unwrap();
        let title = rank(
            "default",
            priority::Rank {
                value: Some(81),
                minutes: Some(5),
                ..priority::Rank::default()
            },
            Some("pricing work"),
            None,
        )
        .unwrap();
        assert_eq!(title, "pricing work");
        let after = stored("default", "aaaa1111").priority.unwrap();
        let ask = after.ask.as_ref().unwrap();
        assert_eq!(
            (ask.value, ask.minutes, ask.text.as_str()),
            (Some(81), Some(5), "Approve the budget")
        );
        assert_eq!((after.value, after.set_at), (before.value, before.set_at));
    }

    #[test]
    #[serial_test::serial]
    fn without_a_target_it_refuses() {
        let _app = crate::session::test_support::isolate_app_dir();
        let err = format!(
            "{:#}",
            set_priority(
                "default",
                "5",
                priority::AskInput::default(),
                None,
                None,
                None
            )
            .unwrap_err()
        );
        assert!(
            err.contains(super::super::session_forecast::NO_SESSION),
            "{err}"
        );
    }
}
