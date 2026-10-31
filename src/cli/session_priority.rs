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
    /// Text or Markdown file with the material behind the request, at most
    /// 256 KiB, for the input/output agent to write the page from.
    #[arg(long)]
    pub context: Option<std::path::PathBuf>,
    /// Session ID or title. Defaults to `$AOE_INSTANCE_ID`, which aoe sets
    /// inside every session it launches.
    #[arg(long)]
    pub session: Option<String>,
}

#[derive(Args)]
pub struct RefineArgs {
    /// Session ID or title whose current ask to refine.
    #[arg(long)]
    pub session: String,
    /// The ask's `posted_at` (RFC 3339, as `aoe session asks` prints it): the
    /// request this refine was worked out for.
    #[arg(long = "for")]
    pub posted_at: String,
    #[arg(long)]
    pub text: Option<String>,
    #[arg(long = "ask", value_enum)]
    pub kind: Option<priority::AskKind>,
    #[arg(long)]
    pub objective: Option<String>,
    #[arg(long)]
    pub link: Option<String>,
    #[arg(long)]
    pub value: Option<u8>,
    #[arg(long)]
    pub minutes: Option<u16>,
    #[arg(long)]
    pub due: Option<String>,
    /// Replaces the options as a set.
    #[arg(long = "option")]
    pub options: Vec<String>,
    #[arg(long)]
    pub page: Option<std::path::PathBuf>,
    /// The session whose current ask this one is the same as.
    #[arg(long = "merge-into")]
    pub merge_into: Option<String>,
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
    context: Option<&str>,
    session: Option<&str>,
    env_id: Option<&str>,
) -> Result<(String, Option<u8>)> {
    use crate::session::{ask_page, inbox_log};
    let value = priority::parse_priority_arg(value)?;
    let ask = priority::parse_ask(priority::AskInput {
        page: page.is_some(),
        ..ask
    })?;
    if context.is_some() && ask.is_none() {
        anyhow::bail!("an ask needs its one line saying what to do");
    }
    let (home, id) = resolve_home(profile, session, env_id)?;
    let (title, posted_at) = Storage::new_unwatched(&home)?.update(|instances, _groups| {
        super::patch_instance(instances, &id, |inst| {
            let stored_post = |inst: &crate::session::Instance| {
                inst.priority
                    .as_ref()
                    .and_then(|p| p.ask.as_ref())
                    .and_then(|a| a.posted_at)
            };
            let before = stored_post(inst);
            let given = ask.is_some();
            inst.set_priority(value, ask);
            let posted_at = stored_post(inst).filter(|at| given && Some(*at) != before);
            Ok((inst.title.clone(), posted_at))
        })
    })?;
    // The same ask posted again keeps its page and context.
    let replaces = posted_at.is_some() || value.is_none();
    match page {
        Some(html) => ask_page::write_page(&id, html)?,
        None if replaces => ask_page::clear_page(&id)?,
        None => {}
    }
    match context {
        Some(text) => ask_page::write_context(&id, text)?,
        None if replaces => ask_page::clear_context(&id)?,
        None => {}
    }
    if let Some(posted_at) = posted_at {
        log_event(&id, posted_at, inbox_log::Event::Posted);
    }
    Ok((title, value))
}

/// The log is for measuring; a failed append never fails the command.
fn log_event(
    id: &str,
    posted_at: chrono::DateTime<chrono::Utc>,
    event: crate::session::inbox_log::Event,
) {
    let entry = crate::session::inbox_log::Entry {
        at: chrono::Utc::now(),
        event,
        session_id: id.to_string(),
        posted_at,
        form: None,
        ms_open: None,
    };
    if let Err(e) = crate::session::inbox_log::append(&entry) {
        tracing::warn!(target: "session.inbox", "inbox log not written: {e:#}");
    }
}

/// Replace fields of the session's current ask for the input/output agent.
/// Returns the session's title.
fn refine(
    profile: &str,
    session: &str,
    posted_at: &str,
    refine: priority::Refine<'_>,
    page: Option<&[u8]>,
) -> Result<String> {
    use anyhow::Context;
    let refine = priority::Refine {
        page: refine.page || page.is_some(),
        ..refine
    };
    let posted_at = chrono::DateTime::parse_from_rfc3339(posted_at)
        .with_context(|| format!("--for must be the ask's posted_at, got {posted_at:?}"))?
        .with_timezone(&chrono::Utc);
    let (home, id) = resolve_home(profile, Some(session), None)?;
    let title = Storage::new_unwatched(&home)?.update(|instances, _groups| {
        if let Some(into) = refine.merge_into {
            crate::session::inbox::check_merge(instances, &id, into)?;
        }
        super::patch_instance(instances, &id, |inst| {
            inst.priority = Some(priority::refine_ask(
                inst.priority.as_ref(),
                inst.run_started_at,
                posted_at,
                refine,
                chrono::Utc::now(),
            )?);
            Ok(inst.title.clone())
        })
    })?;
    if let Some(html) = page {
        crate::session::ask_page::write_page(&id, html)?;
    }
    log_event(&id, posted_at, crate::session::inbox_log::Event::Refined);
    Ok(title)
}

/// Every current ask, as `aoe session asks` prints it.
fn asks_json(
    instances: &[crate::session::Instance],
    context: impl Fn(&str) -> Option<String>,
) -> Vec<serde_json::Value> {
    instances
        .iter()
        .filter_map(|inst| crate::session::inbox::ask_json(inst, context(&inst.id)))
        .collect()
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
    let context = args
        .context
        .as_deref()
        .map(crate::session::ask_page::read_context_source)
        .transpose()?;
    let (title, value) = set_priority(
        profile,
        &args.value,
        ask,
        page.as_deref(),
        context.as_deref(),
        args.session.as_deref(),
        env_id.as_deref(),
    )?;
    match value {
        Some(v) => println!("✓ Set priority for '{title}': {v}"),
        None => println!("✓ Cleared priority for '{title}'"),
    }
    Ok(())
}

pub async fn run_refine(profile: &str, args: RefineArgs) -> Result<()> {
    let page = args
        .page
        .as_deref()
        .map(crate::session::ask_page::read_source)
        .transpose()?;
    let title = refine(
        profile,
        &args.session,
        &args.posted_at,
        priority::Refine {
            kind: args.kind,
            text: args.text.as_deref(),
            objective: args.objective.as_deref(),
            link: args.link.as_deref(),
            value: args.value,
            minutes: args.minutes,
            due: args.due.as_deref(),
            options: &args.options,
            page: page.is_some(),
            merge_into: args.merge_into.as_deref(),
        },
        page.as_deref(),
    )?;
    println!("✓ Refined the ask of '{title}'");
    Ok(())
}

pub async fn run_asks() -> Result<()> {
    let mut asks = Vec::new();
    for profile in crate::session::list_profiles()? {
        let instances = Storage::open_unwatched(&profile)?.load()?;
        asks.extend(asks_json(&instances, |id| {
            crate::session::ask_page::read_context(id).ok().flatten()
        }));
    }
    println!("{}", serde_json::to_string_pretty(&asks)?);
    Ok(())
}

#[derive(clap::Subcommand)]
pub enum InboxKeyCommands {
    /// Write a new key and print it; the old one stops working at once.
    Rotate,
    /// Print the current key.
    Show,
}

pub fn run_inbox_key(command: InboxKeyCommands) -> Result<()> {
    let key = match command {
        InboxKeyCommands::Rotate => crate::session::inbox::rotate_key()?,
        InboxKeyCommands::Show => crate::session::inbox::read_key()?.ok_or_else(|| {
            anyhow::anyhow!("no Inbox key yet: run `aoe session inbox-key rotate`")
        })?,
    };
    println!("{key}");
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
        set_priority("default", "8", decide, None, None, None, Some("aaaa1111")).unwrap();
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
            set_priority("default", "9", bad, None, None, None, Some("aaaa1111")).unwrap_err();
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
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert!(stored_page().is_some());
        // A new ask without a page drops the old page.
        set_priority(
            "default",
            "6",
            page("Other"),
            None,
            None,
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert_eq!(stored_page(), None);
        assert!(!stored("default", "aaaa1111").priority_ask().unwrap().page);
        set_priority(
            "default",
            "8",
            page("Pick"),
            Some(b"<p>x</p>"),
            None,
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
        set_priority("default", "8", posted, None, None, None, Some("aaaa1111")).unwrap();
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

    fn post(id: &str, text: &str) -> chrono::DateTime<chrono::Utc> {
        let ask = priority::AskInput {
            kind: Some(priority::AskKind::Answer),
            text: Some(text),
            ..priority::AskInput::default()
        };
        set_priority("default", "8", ask, None, Some("the notes"), None, Some(id)).unwrap();
        stored("default", id)
            .priority_ask()
            .unwrap()
            .posted_at
            .unwrap()
    }

    #[test]
    #[serial_test::serial]
    fn a_request_carries_its_context_logs_that_it_was_posted_and_a_new_ask_drops_old_context() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let posted_at = post("aaaa1111", "need a number");
        assert_eq!(
            crate::session::ask_page::read_context("aaaa1111")
                .unwrap()
                .as_deref(),
            Some("the notes")
        );
        let log = std::fs::read_to_string(crate::session::inbox_log::log_path().unwrap()).unwrap();
        let entry: crate::session::inbox_log::Entry =
            serde_json::from_str(log.lines().last().unwrap()).unwrap();
        assert_eq!(
            (entry.event, entry.session_id.as_str(), entry.posted_at),
            (
                crate::session::inbox_log::Event::Posted,
                "aaaa1111",
                posted_at
            )
        );
        // A re-rank is not a new request: no context change, no posted line.
        set_priority(
            "default",
            "5",
            priority::AskInput::default(),
            None,
            None,
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(crate::session::inbox_log::log_path().unwrap())
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert!(crate::session::ask_page::read_context("aaaa1111")
            .unwrap()
            .is_some());
        let plain = priority::AskInput {
            text: Some("other"),
            ..priority::AskInput::default()
        };
        set_priority("default", "6", plain, None, None, None, Some("aaaa1111")).unwrap();
        assert_eq!(
            crate::session::ask_page::read_context("aaaa1111").unwrap(),
            None
        );
        let bare = set_priority(
            "default",
            "6",
            priority::AskInput::default(),
            None,
            Some("x"),
            None,
            Some("aaaa1111"),
        );
        assert!(
            format!("{:#}", bare.unwrap_err()).contains("one line"),
            "context needs an ask"
        );
    }

    #[test]
    #[serial_test::serial]
    fn posting_the_same_ask_again_keeps_its_page_and_context_and_logs_no_new_request() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let posted_at = post("aaaa1111", "need a number");
        crate::session::ask_page::write_page("aaaa1111", b"<p>refined</p>").unwrap();
        let same = priority::AskInput {
            kind: Some(priority::AskKind::Answer),
            text: Some("need  a number "),
            ..priority::AskInput::default()
        };
        set_priority("default", "6", same, None, None, None, Some("aaaa1111")).unwrap();
        let ask = stored("default", "aaaa1111")
            .priority_ask()
            .cloned()
            .unwrap();
        assert_eq!(
            (ask.posted_at, ask.text.as_str()),
            (Some(posted_at), "need a number")
        );
        assert_eq!(
            crate::session::ask_page::read_page("aaaa1111")
                .unwrap()
                .as_deref(),
            Some(&b"<p>refined</p>"[..]),
            "the page stays"
        );
        assert_eq!(
            crate::session::ask_page::read_context("aaaa1111")
                .unwrap()
                .as_deref(),
            Some("the notes"),
            "the context stays"
        );
        let posted_lines = || {
            std::fs::read_to_string(crate::session::inbox_log::log_path().unwrap())
                .unwrap()
                .lines()
                .count()
        };
        assert_eq!(posted_lines(), 1, "no second posted line");
        set_priority(
            "default",
            "6",
            same,
            None,
            Some("newer notes"),
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        assert_eq!(
            crate::session::ask_page::read_context("aaaa1111")
                .unwrap()
                .as_deref(),
            Some("newer notes"),
            "a context given with it replaces the stored one"
        );
        assert_eq!(
            stored("default", "aaaa1111")
                .priority_ask()
                .unwrap()
                .posted_at,
            Some(posted_at)
        );
        assert_eq!(posted_lines(), 1);
    }

    #[test]
    #[serial_test::serial]
    fn a_refine_lands_only_on_the_request_it_was_worked_out_for() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        let first = post("aaaa1111", "need a number");
        let fields = priority::Refine {
            text: Some("Approve 40 EUR?"),
            value: Some(70),
            minutes: Some(2),
            ..priority::Refine::default()
        };
        refine(
            "default",
            "aaaa1111",
            &first.to_rfc3339(),
            fields,
            Some(b"<p>page</p>"),
        )
        .unwrap();
        let ask = stored("default", "aaaa1111")
            .priority_ask()
            .cloned()
            .unwrap();
        assert_eq!(
            (ask.text.as_str(), ask.value, ask.page),
            ("Approve 40 EUR?", Some(70), true)
        );
        assert!(ask.refined_at.is_some());
        assert_eq!(
            crate::session::ask_page::read_page("aaaa1111")
                .unwrap()
                .as_deref(),
            Some(&b"<p>page</p>"[..])
        );
        let log = std::fs::read_to_string(crate::session::inbox_log::log_path().unwrap()).unwrap();
        assert!(log.lines().last().unwrap().contains(r#""event":"refined""#));
        // The session posts a newer request; a refine for the first is refused.
        std::thread::sleep(std::time::Duration::from_millis(5));
        post("aaaa1111", "newer request");
        let late = refine("default", "aaaa1111", &first.to_rfc3339(), fields, None).unwrap_err();
        assert!(format!("{late:#}").contains("replaced"), "{late:#}");
        assert_eq!(
            stored("default", "aaaa1111").priority_ask().unwrap().text,
            "newer request"
        );
        assert!(refine("default", "aaaa1111", "not a time", fields, None).is_err());
    }

    #[test]
    #[serial_test::serial]
    fn a_merge_needs_another_session_with_a_current_unmerged_ask() {
        let _app = crate::session::test_support::isolate_app_dir();
        for (id, title) in [
            ("aaaa1111", "a"),
            ("bbbb2222", "b"),
            ("cccc3333", "c"),
            ("dddd4444", "d"),
        ] {
            seed("default", id, title);
        }
        let a = post("aaaa1111", "budget?");
        let b = post("bbbb2222", "budget too?");
        let c = post("cccc3333", "budget three?");
        let merge = |into| priority::Refine {
            merge_into: Some(into),
            ..priority::Refine::default()
        };
        refine(
            "default",
            "bbbb2222",
            &b.to_rfc3339(),
            merge("aaaa1111"),
            None,
        )
        .unwrap();
        assert_eq!(
            stored("default", "bbbb2222")
                .priority_ask()
                .unwrap()
                .merged_into
                .as_deref(),
            Some("aaaa1111")
        );
        // (session, its posted_at, target, why refused)
        for (id, at, into, why) in [
            ("aaaa1111", a, "aaaa1111", "itself"),
            ("cccc3333", c, "dddd4444", "the target has no ask"),
            ("cccc3333", c, "bbbb2222", "the target is itself merged"),
            ("cccc3333", c, "zzzz9999", "no such session"),
        ] {
            assert!(
                refine("default", id, &at.to_rfc3339(), merge(into), None).is_err(),
                "{why}"
            );
        }
        assert_eq!(
            stored("default", "cccc3333")
                .priority_ask()
                .unwrap()
                .merged_into,
            None
        );
    }

    #[test]
    fn asks_lists_every_current_ask_with_its_context_running_sessions_included() {
        let mut asking = Instance::new("pricing work", "/tmp/asks");
        asking.id = "aaaa1111".into();
        asking.status = Status::Idle;
        asking.set_priority(
            Some(8),
            Some(priority::Ask {
                text: "Pick".into(),
                ..priority::Ask::default()
            }),
        );
        let mut running = Instance::new("busy", "/tmp/asks");
        running.id = "bbbb2222".into();
        running.status = Status::Running;
        running.run_started_at = Some(chrono::Utc::now() - chrono::Duration::minutes(5));
        running.set_priority(
            Some(9),
            Some(priority::Ask {
                text: "Check the answers".into(),
                ..priority::Ask::default()
            }),
        );
        let mut stale = Instance::new("ran since", "/tmp/asks");
        stale.id = "cccc3333".into();
        stale.status = Status::Running;
        stale.set_priority(
            Some(8),
            Some(priority::Ask {
                text: "stale".into(),
                ..priority::Ask::default()
            }),
        );
        stale.run_started_at = Some(chrono::Utc::now() + chrono::Duration::seconds(1));
        let silent = Instance::new("quiet", "/tmp/asks");
        let asks = asks_json(&[asking, running, stale, silent], |id| {
            (id == "aaaa1111").then(|| "notes".to_string())
        });
        assert_eq!(asks.len(), 2, "{asks:?}");
        // 2026-10-31: the YC W27 session posted its priority 9 ask, kept
        // running, and `aoe session asks` left it out.
        let busy = asks.iter().find(|a| a["session_id"] == "bbbb2222").unwrap();
        assert_eq!(busy["status"], "running");
        // io ranks a running session's ask by what it posted, not its 0.
        assert_eq!(
            (busy["priority"].clone(), busy["score"].clone()),
            (0.into(), 9.into())
        );
        assert_eq!(busy["ask"]["text"], "Check the answers");
        let asks: Vec<_> = asks
            .into_iter()
            .filter(|a| a["session_id"] == "aaaa1111")
            .collect();
        let a = &asks[0];
        assert_eq!(a["session_id"], "aaaa1111");
        assert_eq!(a["title"], "pricing work");
        assert_eq!(a["status"], "idle");
        assert_eq!(a["priority"], 8);
        assert_eq!(a["score"], 8);
        assert_eq!(a["ask"]["text"], "Pick");
        assert!(a["ask"]["posted_at"].is_string());
        assert_eq!(a["context"], "notes");
        assert!(a.get("profile").is_some());
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
