//! Pure decision logic for the LRU session cap (`session.hibernate_max_live`).
//!
//! Where `idle_reap` (#1690) stops sessions by *age* ("idle longer than T"),
//! this module parks them by *rank*: only the N most-recently-used plain
//! sessions keep a live tmux/agent process; the rest are hibernated - tmux
//! torn down, row kept in the list as dormant, woken with the agent resumed
//! the moment the user selects them (the existing `/ensure` path). Busy
//! sessions never count as parkable, so the live set may exceed N while
//! agents are actually working.
//!
//! This module owns eligibility only: no tmux calls, no storage writes, no
//! config resolution (mirrors `idle_reap`'s contract). Callers resolve the
//! per-profile cap, gather tmux attach state, then claim each candidate
//! through `Storage::update` so concurrent reapers (TUI + serve daemon on
//! one state file) cannot double-park a session.
//!
//! Hibernation deliberately does NOT use `Status::Stopped`: a Stopped row is
//! inert (the status poller short-circuits on it) and renders as a neutral
//! deliberate stop. A hibernated row keeps `Status::Idle` plus the
//! `idle_dormant_since` marker, renders as dormant, and the poller skips
//! probing its (intentionally absent) tmux the same way it does for
//! archived rows.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::{Instance, Status, Storage};
use crate::file_watch::FileWatchService;

/// A plain session the reaper intends to hibernate, with the profile the
/// caller needs to open the right storage for the claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HibernateCandidate {
    pub session_id: String,
    pub profile: String,
}

/// Whether this session holds (or is about to hold) a live agent process,
/// i.e. whether it occupies one of the N live slots. Rows that already have
/// no process - stopped, errored (tmux gone), already dormant - cost nothing
/// and neither count toward the cap nor can be parked again.
fn holds_live_slot(inst: &Instance) -> bool {
    if inst.is_structured() || inst.is_archived() || inst.is_trashed() || inst.is_idle_dormant() {
        return false;
    }
    !matches!(inst.status, Status::Stopped | Status::Error)
}

/// The recency key for LRU ranking: the last user interaction when known,
/// else creation time (a never-touched session is as recent as its birth).
fn recency(inst: &Instance) -> DateTime<Utc> {
    inst.last_accessed_at.unwrap_or(inst.created_at)
}

/// Select the plain sessions to hibernate so at most `cap` live sessions
/// remain per profile, most-recently-used kept.
///
/// Within each profile (caps resolve per profile, like every session
/// setting), rank the live sessions by [`recency`] and take everything past
/// the first `cap` as the tail - then park only the tail members that are
/// safe to park: currently `Idle` and with no tmux client attached. A busy
/// tail member (`Running`, `Waiting`, `Starting`, ...) is left alone, which
/// is the deliberate overflow: the cap bounds idle agents, never working
/// ones. `attached` is the set of live-client tmux session names from
/// [`crate::tmux::attached_session_names`].
pub fn hibernate_candidates(
    instances: &[Instance],
    attached: &HashSet<String>,
    resolve_cap: impl Fn(&str) -> u32,
) -> Vec<HibernateCandidate> {
    let mut by_profile: HashMap<String, Vec<&Instance>> = HashMap::new();
    for inst in instances {
        if !holds_live_slot(inst) {
            continue;
        }
        by_profile
            .entry(inst.effective_profile())
            .or_default()
            .push(inst);
    }
    let mut candidates = Vec::new();
    for (profile, mut live) in by_profile {
        let cap = resolve_cap(&profile) as usize;
        if cap == 0 || live.len() <= cap {
            continue;
        }
        // Most recent first; ties break on created_at then id so the order
        // (and therefore who gets parked) is deterministic.
        live.sort_by(|a, b| {
            recency(b)
                .cmp(&recency(a))
                .then(b.created_at.cmp(&a.created_at))
                .then(a.id.cmp(&b.id))
        });
        for inst in &live[cap..] {
            if inst.status != Status::Idle {
                continue;
            }
            let is_attached = inst
                .tmux_session()
                .ok()
                .is_some_and(|s| attached.contains(s.name()));
            if is_attached {
                continue;
            }
            candidates.push(HibernateCandidate {
                session_id: inst.id.clone(),
                profile: profile.clone(),
            });
        }
    }
    candidates
}

/// Atomically claim a session for hibernation under the per-profile storage
/// file lock, so concurrent reapers (a standalone TUI and an `aoe serve`
/// daemon on the same state file) cannot double-park it.
///
/// Re-reads the session inside the lock and re-checks that it is still a
/// parkable live row (plain, not archived/trashed, `Idle`, not already
/// dormant). The claim is `mark_idle_dormant()` - persisted BEFORE the
/// caller kills tmux, so a daemon restart between mark and kill cannot
/// resurrect a half-parked session. Returns `Ok(None)` when no longer
/// eligible (peer reaper won, user woke it, it started working, or it is
/// gone).
pub fn claim_hibernate(
    profile: &str,
    file_watch: Arc<FileWatchService>,
    session_id: &str,
) -> anyhow::Result<Option<Instance>> {
    let storage = Storage::new(profile, file_watch)?;
    storage.update(|instances, _groups| {
        let Some(inst) = instances.iter_mut().find(|i| i.id == session_id) else {
            return Ok(None);
        };
        if inst.is_structured()
            || inst.is_archived()
            || inst.is_trashed()
            || inst.is_idle_dormant()
            || inst.status != Status::Idle
        {
            return Ok(None);
        }
        inst.mark_idle_dormant();
        Ok(Some(inst.clone()))
    })
}

/// Roll a failed hibernation back: clear the dormant marker so the session
/// is not permanently blocked from status polling and respawn. Mirrors the
/// acp_reconciler's marker-clear-on-shutdown-failure discipline (#1689).
pub fn clear_hibernate_claim(
    profile: &str,
    file_watch: Arc<FileWatchService>,
    session_id: &str,
) -> anyhow::Result<()> {
    let storage = Storage::new(profile, file_watch)?;
    storage.update(|instances, _groups| {
        if let Some(inst) = instances.iter_mut().find(|i| i.id == session_id) {
            inst.idle_dormant_since = None;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn plain(title: &str, status: Status, accessed_secs_ago: i64) -> Instance {
        let mut inst = Instance::new(title, "/tmp/hibernate-test");
        inst.status = status;
        inst.last_accessed_at = Some(Utc::now() - Duration::seconds(accessed_secs_ago));
        if status == Status::Idle {
            inst.idle_entered_at = Some(Utc::now() - Duration::seconds(accessed_secs_ago));
        }
        inst
    }

    fn ids(candidates: &[HibernateCandidate]) -> Vec<String> {
        candidates.iter().map(|c| c.session_id.clone()).collect()
    }

    #[test]
    fn cap_zero_disables_the_feature() {
        let instances = vec![plain("a", Status::Idle, 300), plain("b", Status::Idle, 200)];
        let got = hibernate_candidates(&instances, &HashSet::new(), |_| 0);
        assert!(got.is_empty());
    }

    #[test]
    fn under_the_cap_nothing_is_parked() {
        let instances = vec![plain("a", Status::Idle, 300), plain("b", Status::Idle, 200)];
        let got = hibernate_candidates(&instances, &HashSet::new(), |_| 2);
        assert!(got.is_empty());
    }

    #[test]
    fn least_recently_used_beyond_the_cap_is_parked() {
        let a = plain("a", Status::Idle, 10);
        let b = plain("b", Status::Idle, 100);
        let c = plain("c", Status::Idle, 1000); // coldest
        let expect = c.id.clone();
        let got = hibernate_candidates(&[a, b, c], &HashSet::new(), |_| 2);
        assert_eq!(ids(&got), vec![expect]);
    }

    #[test]
    fn busy_sessions_overflow_the_cap_instead_of_being_parked() {
        // Cap 1: the running session is older but must survive; the idle one
        // is the most recent so it holds the one live slot. Nothing parks.
        let running = plain("running", Status::Running, 1000);
        let idle = plain("idle", Status::Idle, 10);
        let got = hibernate_candidates(&[running, idle], &HashSet::new(), |_| 1);
        assert!(got.is_empty(), "a working agent must never be parked");
    }

    #[test]
    fn busy_tail_is_spared_while_idle_tail_is_parked() {
        let newest = plain("newest", Status::Idle, 10);
        let working = plain("working", Status::Waiting, 500);
        let coldest = plain("coldest", Status::Idle, 1000);
        let expect = coldest.id.clone();
        let got = hibernate_candidates(&[newest, working, coldest], &HashSet::new(), |_| 1);
        assert_eq!(ids(&got), vec![expect]);
    }

    #[test]
    fn attached_session_is_never_parked() {
        let warm = plain("warm", Status::Idle, 10);
        let cold = plain("cold", Status::Idle, 1000);
        let name = cold.tmux_session().unwrap().name().to_string();
        let mut attached = HashSet::new();
        attached.insert(name);
        let got = hibernate_candidates(&[warm, cold], &attached, |_| 1);
        assert!(
            got.is_empty(),
            "a session with a live tmux client is in use"
        );
    }

    #[test]
    fn processless_rows_do_not_count_toward_the_cap() {
        // Stopped, errored and already-dormant rows hold no live process, so
        // two live idle sessions fit a cap of 2 regardless of how many dead
        // rows sit beside them.
        let a = plain("a", Status::Idle, 10);
        let b = plain("b", Status::Idle, 100);
        let stopped = plain("stopped", Status::Stopped, 5);
        let errored = plain("errored", Status::Error, 5);
        let mut dormant = plain("dormant", Status::Idle, 5);
        dormant.mark_idle_dormant();
        let got = hibernate_candidates(&[a, b, stopped, errored, dormant], &HashSet::new(), |_| 2);
        assert!(got.is_empty());
    }

    #[test]
    fn structured_sessions_are_left_to_their_own_reaper() {
        let mut sv = plain("sv", Status::Idle, 1000);
        sv.view = crate::session::View::Structured;
        let a = plain("a", Status::Idle, 10);
        let got = hibernate_candidates(&[sv, a], &HashSet::new(), |_| 1);
        assert!(got.is_empty());
    }

    #[test]
    fn never_touched_sessions_rank_by_creation_time() {
        let mut old = plain("old", Status::Idle, 0);
        old.last_accessed_at = None;
        old.created_at = Utc::now() - Duration::hours(5);
        let mut fresh = plain("fresh", Status::Idle, 0);
        fresh.last_accessed_at = None;
        fresh.created_at = Utc::now();
        let expect = old.id.clone();
        let got = hibernate_candidates(&[old, fresh], &HashSet::new(), |_| 1);
        assert_eq!(ids(&got), vec![expect]);
    }

    #[test]
    #[serial_test::serial]
    fn claim_is_single_shot_under_storage_lock() {
        let temp = tempfile::tempdir().unwrap();
        let _env = crate::session::test_support::isolate_home(temp.path());

        let inst = plain("claimable", Status::Idle, 1000);
        let id = inst.id.clone();
        let storage = Storage::new_unwatched("test-profile").unwrap();
        storage
            .update(|instances, _groups| {
                instances.push(inst);
                Ok(())
            })
            .unwrap();

        let first = claim_hibernate("test-profile", FileWatchService::noop(), &id).unwrap();
        assert!(first.is_some(), "first claim should win");
        assert!(first.unwrap().is_idle_dormant());

        let second = claim_hibernate("test-profile", FileWatchService::noop(), &id).unwrap();
        assert!(second.is_none(), "second claim must not double-park");

        let stored = storage.load().unwrap();
        assert!(stored[0].is_idle_dormant());
        assert_eq!(
            stored[0].status,
            Status::Idle,
            "hibernation must not masquerade as a deliberate Stop"
        );
    }

    #[test]
    #[serial_test::serial]
    fn claim_refuses_a_session_that_started_working() {
        let temp = tempfile::tempdir().unwrap();
        let _env = crate::session::test_support::isolate_home(temp.path());

        let inst = plain("busy-now", Status::Running, 1000);
        let id = inst.id.clone();
        let storage = Storage::new_unwatched("test-profile").unwrap();
        storage
            .update(|instances, _groups| {
                instances.push(inst);
                Ok(())
            })
            .unwrap();

        let got = claim_hibernate("test-profile", FileWatchService::noop(), &id).unwrap();
        assert!(got.is_none());
        assert!(!storage.load().unwrap()[0].is_idle_dormant());
    }

    #[test]
    #[serial_test::serial]
    fn clear_claim_rolls_the_marker_back() {
        let temp = tempfile::tempdir().unwrap();
        let _env = crate::session::test_support::isolate_home(temp.path());

        let inst = plain("rollback", Status::Idle, 1000);
        let id = inst.id.clone();
        let storage = Storage::new_unwatched("test-profile").unwrap();
        storage
            .update(|instances, _groups| {
                instances.push(inst);
                Ok(())
            })
            .unwrap();

        claim_hibernate("test-profile", FileWatchService::noop(), &id)
            .unwrap()
            .expect("claim should win");
        clear_hibernate_claim("test-profile", FileWatchService::noop(), &id).unwrap();
        assert!(
            !storage.load().unwrap()[0].is_idle_dormant(),
            "a failed hibernation must not leave the session blocked"
        );
    }
}
