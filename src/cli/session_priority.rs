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
    /// Why the session needs the user, one line of at most 300 characters,
    /// shown in the web Inbox and status pushes. Without one, a still-current
    /// reason is kept.
    pub reason: Vec<String>,
    /// Session ID or title. Defaults to `$AOE_INSTANCE_ID`, which aoe sets
    /// inside every session it launches.
    #[arg(long)]
    pub session: Option<String>,
}

/// Validate `value`, resolve the session, and store the score. Returns the
/// session's title and the stored value.
fn set_priority(
    profile: &str,
    value: &str,
    reason: Option<&str>,
    session: Option<&str>,
    env_id: Option<&str>,
) -> Result<(String, Option<u8>)> {
    let value = priority::parse_priority_arg(value)?;
    let reason = priority::parse_reason(reason)?;
    let id = super::session_forecast::resolve_target(profile, session, env_id)?;
    // `$AOE_INSTANCE_ID` may name a session in another profile; write where
    // it lives.
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
    let title = Storage::new_unwatched(&home)?.update(|instances, _groups| {
        super::patch_instance(instances, &id, |inst| {
            inst.set_priority(value, reason);
            Ok(inst.title.clone())
        })
    })?;
    Ok((title, value))
}

pub async fn run(profile: &str, args: PriorityArgs) -> Result<()> {
    let env_id = std::env::var(crate::tmux::env::AOE_INSTANCE_ID_KEY).ok();
    let reason = (!args.reason.is_empty()).then(|| args.reason.join(" "));
    let (title, value) = set_priority(
        profile,
        &args.value,
        reason.as_deref(),
        args.session.as_deref(),
        env_id.as_deref(),
    )?;
    match value {
        Some(v) => println!("✓ Set priority for '{title}': {v}"),
        None => println!("✓ Cleared priority for '{title}'"),
    }
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
        let (title, value) = set_priority("default", "8", None, None, Some("aaaa1111")).unwrap();
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
        set_priority("default", "9", None, None, Some("bbbb2222")).unwrap();
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
        set_priority("default", "7", None, Some("pricing work"), Some("cccc3333")).unwrap();
        assert_eq!(
            stored("default", "aaaa1111").priority.map(|p| p.value),
            Some(7)
        );
        assert_eq!(stored("default", "cccc3333").priority, None);
        let (_, value) =
            set_priority("default", "clear", None, Some("pricing work"), None).unwrap();
        assert_eq!(value, None);
        assert_eq!(stored("default", "aaaa1111").priority, None);
    }

    #[test]
    #[serial_test::serial]
    fn an_invalid_value_changes_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        set_priority("default", "6", None, None, Some("aaaa1111")).unwrap();
        for bad in ["11", "-1", "high"] {
            let err = format!(
                "{:#}",
                set_priority("default", bad, None, None, Some("aaaa1111")).unwrap_err()
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
    fn the_reason_is_stored_with_the_score_and_an_over_long_one_changes_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        set_priority(
            "default",
            "8",
            Some("Approve  the\nbudget"),
            None,
            Some("aaaa1111"),
        )
        .unwrap();
        let reason = |inst: Instance| inst.priority.and_then(|p| p.reason);
        assert_eq!(
            reason(stored("default", "aaaa1111")).as_deref(),
            Some("Approve the budget")
        );
        assert_eq!(
            stored("default", "aaaa1111").priority_reason(),
            Some("Approve the budget")
        );
        // A focus re-rank without a reason keeps it.
        set_priority("default", "5", None, Some("pricing work"), None).unwrap();
        assert_eq!(
            reason(stored("default", "aaaa1111")).as_deref(),
            Some("Approve the budget")
        );
        let long = "x".repeat(301);
        let err = format!(
            "{:#}",
            set_priority("default", "9", Some(&long), None, Some("aaaa1111")).unwrap_err()
        );
        assert!(err.contains("300"), "{err}");
        let inst = stored("default", "aaaa1111");
        assert_eq!(inst.priority.as_ref().map(|p| p.value), Some(5));
        assert_eq!(reason(inst).as_deref(), Some("Approve the budget"));
    }

    #[test]
    #[serial_test::serial]
    fn without_a_target_it_refuses() {
        let _app = crate::session::test_support::isolate_app_dir();
        let err = format!(
            "{:#}",
            set_priority("default", "5", None, None, None).unwrap_err()
        );
        assert!(
            err.contains(super::super::session_forecast::NO_SESSION),
            "{err}"
        );
    }
}
