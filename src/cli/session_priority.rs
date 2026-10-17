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
    session: Option<&str>,
    env_id: Option<&str>,
) -> Result<(String, Option<u8>)> {
    let value = priority::parse_priority_arg(value)?;
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
            inst.set_priority(value);
            Ok(inst.title.clone())
        })
    })?;
    Ok((title, value))
}

pub async fn run(profile: &str, args: PriorityArgs) -> Result<()> {
    let env_id = std::env::var(crate::tmux::env::AOE_INSTANCE_ID_KEY).ok();
    let (title, value) = set_priority(
        profile,
        &args.value,
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
        let (title, value) = set_priority("default", "8", None, Some("aaaa1111")).unwrap();
        assert_eq!((title.as_str(), value), ("pricing work", Some(8)));
        let inst = stored("default", "aaaa1111");
        assert_eq!(inst.priority.map(|p| p.value), Some(8));
        assert_eq!(inst.effective_priority(), 8);
    }

    #[test]
    #[serial_test::serial]
    fn the_score_lands_in_the_profile_that_holds_the_session() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "here");
        seed("other", "bbbb2222", "elsewhere");
        set_priority("default", "9", None, Some("bbbb2222")).unwrap();
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
        set_priority("default", "7", Some("pricing work"), Some("cccc3333")).unwrap();
        assert_eq!(
            stored("default", "aaaa1111").priority.map(|p| p.value),
            Some(7)
        );
        assert_eq!(stored("default", "cccc3333").priority, None);
        let (_, value) = set_priority("default", "clear", Some("pricing work"), None).unwrap();
        assert_eq!(value, None);
        assert_eq!(stored("default", "aaaa1111").priority, None);
    }

    #[test]
    #[serial_test::serial]
    fn an_invalid_value_changes_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        seed("default", "aaaa1111", "pricing work");
        set_priority("default", "6", None, Some("aaaa1111")).unwrap();
        for bad in ["11", "-1", "high"] {
            let err = format!(
                "{:#}",
                set_priority("default", bad, None, Some("aaaa1111")).unwrap_err()
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
    fn without_a_target_it_refuses() {
        let _app = crate::session::test_support::isolate_app_dir();
        let err = format!(
            "{:#}",
            set_priority("default", "5", None, None).unwrap_err()
        );
        assert!(
            err.contains(super::super::session_forecast::NO_SESSION),
            "{err}"
        );
    }
}
