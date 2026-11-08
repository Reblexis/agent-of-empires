//! Pure decision logic for count or memory-pressure session hibernation.
//!
//! Where `idle_reap` (#1690) stops sessions by *age* ("idle longer than T"),
//! this module parks them by *rank*: only the N most-recently-used plain
//! sessions keep a live tmux/agent process; the rest are hibernated - tmux
//! torn down, row kept in the list as dormant, woken with the agent resumed
//! the moment the user selects them (the existing `/ensure` path). Busy
//! sessions never count as parkable, so the live set may exceed N while
//! agents are actually working. An enabled memory-pressure threshold replaces
//! the count trigger and reclaims at most one oldest eligible session per sweep.
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
use crate::process::metrics::MemorySample;

/// A plain session the reaper intends to hibernate, with the profile the
/// caller needs to open the right storage for the claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HibernateCandidate {
    pub session_id: String,
    pub profile: String,
}

/// The per-profile trigger for count or memory-pressure hibernation.
#[derive(Clone, Copy, Default)]
pub struct HibernatePolicy {
    pub max_live: u32,
    pub memory_pressure_percent: u8,
}

impl HibernatePolicy {
    /// Whether the current sample permits this profile's hibernation mode.
    pub(crate) fn should_check(self, memory: &MemorySample) -> bool {
        if self.memory_pressure_percent == 0 {
            return self.max_live > 0;
        }
        memory.total_bytes > 0
            && u128::from(memory.used_bytes()) * 100
                >= u128::from(memory.total_bytes) * u128::from(self.memory_pressure_percent)
    }
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

/// Select idle, unattached plain sessions eligible for hibernation.
///
/// Count mode keeps the most recent `max_live` sessions per profile, with
/// working sessions deliberately overflowing the cap. Pressure mode ignores
/// that cap and selects at most one oldest eligible session across all
/// pressure-enabled profiles, only when the supplied memory sample reaches
/// the profile's threshold. The caller supplies a fresh sample each sweep.
/// The protection callback runs last because checking scheduled work does I/O.
/// It can also protect sessions with other obligations, such as a standing role.
pub fn hibernate_candidates(
    instances: &[Instance],
    attached: &HashSet<String>,
    resolve_policy: impl Fn(&str) -> HibernatePolicy,
    is_protected: impl Fn(&Instance) -> bool,
    memory: &MemorySample,
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
    let eligible = |inst: &&Instance| {
        inst.status == Status::Idle
            && !inst
                .tmux_session()
                .ok()
                .is_some_and(|s| attached.contains(s.name()))
            && !is_protected(inst)
    };
    let mut candidates = Vec::new();
    let mut pressure_candidates = Vec::new();
    for (profile, mut live) in by_profile {
        let policy = resolve_policy(&profile);
        if !policy.should_check(memory) {
            continue;
        }
        if policy.memory_pressure_percent > 0 {
            pressure_candidates.extend(live);
            continue;
        }
        let cap = policy.max_live as usize;
        if live.len() <= cap {
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
        for inst in live[cap..].iter().filter(|inst| eligible(inst)) {
            candidates.push(HibernateCandidate {
                session_id: inst.id.clone(),
                profile: profile.clone(),
            });
        }
    }
    // Oldest first, across profiles, so one sweep cannot shed a whole tail
    // from a single pressured sample that predates the first teardown.
    pressure_candidates.sort_by(|a, b| {
        recency(a)
            .cmp(&recency(b))
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
    if let Some(inst) = pressure_candidates.iter().find(|inst| eligible(inst)) {
        candidates.push(HibernateCandidate {
            session_id: inst.id.clone(),
            profile: inst.effective_profile(),
        });
    }
    candidates
}

/// Atomically claim a session for hibernation under the per-profile storage
/// file lock, so concurrent reapers (a standalone TUI and an `aoe serve`
/// daemon on the same state file) cannot double-park it.
///
/// Re-reads the session inside the lock and refuses anything the disk
/// marks as disqualifying: structured, archived, trashed, already dormant,
/// visibly working (`Running`/`Waiting`/...), or mid-lifecycle (an active
/// reservation means an ensure/restart/stop is in flight). It deliberately
/// does NOT require the disk status to equal `Idle`: candidate selection
/// already saw a fresh in-memory `Idle`, while the on-disk status lags (the
/// 2s poller does not persist every transition), so demanding equality
/// silently skips every stale row forever. The claim is
/// `mark_idle_dormant()` - persisted BEFORE the caller kills tmux, so a
/// daemon restart between mark and kill cannot resurrect a half-parked
/// session. Returns `Ok(None)` when disqualified (peer reaper won, user
/// woke it, it started working, or it is gone).
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
            || inst.lifecycle_reservation.is_some()
            || matches!(
                inst.status,
                Status::Running
                    | Status::Waiting
                    | Status::Starting
                    | Status::Creating
                    | Status::Deleting
            )
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
        // A named profile: an empty one resolves the default profile from the
        // global config, which parallel tests swap under HOME, so two rows of
        // one test could land in different profiles.
        inst.source_profile = "test-profile".to_string();
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

    fn count_candidates(
        instances: &[Instance],
        attached: &HashSet<String>,
        resolve_cap: impl Fn(&str) -> u32,
        holds_scheduled_work: impl Fn(&Instance) -> bool,
    ) -> Vec<HibernateCandidate> {
        hibernate_candidates(
            instances,
            attached,
            |profile| HibernatePolicy {
                max_live: resolve_cap(profile),
                memory_pressure_percent: 0,
            },
            holds_scheduled_work,
            &MemorySample::default(),
        )
    }

    #[test]
    fn healthy_memory_does_not_restart_sessions_above_the_live_cap() {
        let instances = [
            plain("newest", Status::Idle, 10),
            plain("older", Status::Idle, 100),
            plain("oldest", Status::Idle, 1000),
        ];
        let cases = [
            ("healthy above cap", 1000, 600, 2, 85, 0),
            ("just below threshold", 1000, 151, 2, 85, 0),
            ("exact threshold above cap", 1000, 150, 2, 85, 1),
            ("pressure below cap", 1000, 100, 5, 85, 1),
            ("pressure without count cap", 1000, 100, 0, 85, 1),
            ("pressure reclaims only one", 1000, 100, 1, 85, 1),
            ("unavailable memory", 0, 0, 1, 85, 0),
            ("invalid memory reading", 1000, 1200, 1, 85, 0),
            ("lowest threshold", 1000, 990, 1, 1, 1),
            ("full occupancy threshold", 1000, 0, 1, 100, 1),
            ("almost full occupancy", 1000, 1, 1, 100, 0),
            ("large memory arithmetic", u64::MAX, 0, 1, 100, 1),
            ("zero preserves count mode", 1000, 600, 1, 0, 2),
            ("both disabled", 1000, 0, 0, 0, 0),
            ("invalid pressure threshold", 1000, 0, 1, 101, 0),
        ];
        let mut failures = Vec::new();
        for (label, total_bytes, available_bytes, max_live, memory_pressure_percent, expected) in
            cases
        {
            let got = hibernate_candidates(
                &instances,
                &HashSet::new(),
                |_| HibernatePolicy {
                    max_live,
                    memory_pressure_percent,
                },
                |_| false,
                &MemorySample {
                    total_bytes,
                    available_bytes,
                    // Neither memory nor disk PSI triggers occupancy-based reclamation.
                    psi_mem_some_avg10: Some(99.0),
                    psi_io_some_avg10: Some(99.0),
                    ..MemorySample::default()
                },
            );
            if got.len() != expected {
                failures.push(format!("{label}: expected {expected}, got {}", got.len()));
            }
            if memory_pressure_percent > 0 && expected == 1 && got.len() == 1 {
                assert_eq!(
                    got[0].session_id, instances[2].id,
                    "{label}: oldest must park"
                );
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn pressure_hibernates_one_oldest_eligible_session_across_profiles() {
        let mut instances = vec![
            plain("eligible", Status::Idle, 100),
            plain("older eligible in another profile", Status::Idle, 200),
            plain("working", Status::Running, 300),
            plain("waiting", Status::Waiting, 400),
            plain("starting", Status::Starting, 500),
            plain("scheduled", Status::Idle, 600),
            plain("attached", Status::Idle, 700),
            plain("dormant", Status::Idle, 800),
            plain("structured", Status::Idle, 900),
            plain("archived", Status::Idle, 1000),
            plain("trashed", Status::Idle, 1100),
            plain("stopped", Status::Stopped, 1200),
            plain("errored", Status::Error, 1300),
        ];
        instances[1].source_profile = "other-profile".to_owned();
        instances[7].mark_idle_dormant();
        instances[8].view = crate::session::View::Structured;
        instances[9].archived_at = Some(Utc::now());
        instances[10].trashed_at = Some(Utc::now());
        let attached = HashSet::from([instances[6].tmux_session().unwrap().name().to_owned()]);
        let memory = MemorySample {
            total_bytes: 1000,
            available_bytes: 100,
            ..MemorySample::default()
        };
        let policy = |_: &str| HibernatePolicy {
            max_live: 50,
            memory_pressure_percent: 85,
        };
        let got = hibernate_candidates(
            &instances,
            &attached,
            policy,
            |i| i.id == instances[5].id,
            &memory,
        );
        assert_eq!(ids(&got), vec![instances[1].id.clone()]);
        let got = hibernate_candidates(
            &instances[..2],
            &attached,
            |profile| HibernatePolicy {
                max_live: 50,
                memory_pressure_percent: if profile == "other-profile" { 95 } else { 85 },
            },
            |_| false,
            &memory,
        );
        assert_eq!(
            ids(&got),
            vec![instances[0].id.clone()],
            "an older healthy profile must not supply the pressure victim"
        );
        let got = hibernate_candidates(
            &instances[2..],
            &attached,
            policy,
            |i| i.id == instances[5].id,
            &memory,
        );
        assert!(
            got.is_empty(),
            "pressure never overrides a session's protection"
        );
        assert!(hibernate_candidates(&[], &attached, policy, |_| false, &memory).is_empty());
    }

    #[test]
    fn protected_role_ids_spare_oldest_newest_and_successors_in_both_hibernation_modes() {
        let instances = [
            plain("newest role", Status::Idle, 10),
            plain("ordinary", Status::Idle, 100),
            plain("oldest role", Status::Idle, 1000),
        ];
        let id = |index: usize| instances[index].id.clone();
        let cases = [
            ("empty", vec![], vec![1, 2], vec![2], vec![0, 1, 2]),
            (
                "oldest protected",
                vec![id(2)],
                vec![1],
                vec![1],
                vec![0, 1],
            ),
            (
                "newest protected",
                vec![id(0)],
                vec![1, 2],
                vec![2],
                vec![1, 2],
            ),
            (
                "both role ages protected",
                vec![id(0), id(2)],
                vec![1],
                vec![1],
                vec![1],
            ),
            (
                "only protected sessions",
                vec![id(0), id(1), id(2)],
                vec![],
                vec![],
                vec![],
            ),
            (
                "retired role id",
                vec!["retired-session-id".to_owned()],
                vec![1, 2],
                vec![2],
                vec![0, 1, 2],
            ),
            (
                "prefix is not a full id",
                vec![id(2)[..8].to_owned()],
                vec![1, 2],
                vec![2],
                vec![0, 1, 2],
            ),
            (
                "title is not an id",
                vec![instances[2].title.clone()],
                vec![1, 2],
                vec![2],
                vec![0, 1, 2],
            ),
        ];
        for (label, protected, count_expected, pressure_expected, idle_expected) in cases {
            let config = super::super::config::SessionConfig {
                hibernate_protected_sessions: protected,
                ..super::super::config::SessionConfig::default()
            };
            for (memory_pressure_percent, expected) in
                [(0, count_expected), (85, pressure_expected)]
            {
                let got = hibernate_candidates(
                    &instances,
                    &HashSet::new(),
                    |_| HibernatePolicy {
                        max_live: 1,
                        memory_pressure_percent,
                    },
                    |inst| config.protects_from_automatic_stop(&inst.id),
                    &MemorySample {
                        total_bytes: 1000,
                        available_bytes: 100,
                        ..MemorySample::default()
                    },
                );
                assert_eq!(
                    ids(&got),
                    expected.into_iter().map(id).collect::<Vec<_>>(),
                    "{label}, pressure={memory_pressure_percent}"
                );
            }
            let idle = crate::session::idle_reap::idle_reap_candidates(
                &instances,
                Utc::now(),
                &HashSet::new(),
                |_| 1,
                |inst| config.protects_from_automatic_stop(&inst.id),
            );
            assert_eq!(
                idle.into_iter()
                    .map(|candidate| candidate.session_id)
                    .collect::<Vec<_>>(),
                idle_expected.into_iter().map(id).collect::<Vec<_>>(),
                "{label}, idle auto-stop"
            );
        }
    }

    #[test]
    fn cap_zero_disables_count_hibernation() {
        let instances = vec![plain("a", Status::Idle, 300), plain("b", Status::Idle, 200)];
        let got = count_candidates(&instances, &HashSet::new(), |_| 0, |_| false);
        assert!(got.is_empty());
    }

    #[test]
    fn under_the_cap_nothing_is_parked() {
        let instances = vec![plain("a", Status::Idle, 300), plain("b", Status::Idle, 200)];
        let got = count_candidates(&instances, &HashSet::new(), |_| 2, |_| false);
        assert!(got.is_empty());
    }

    #[test]
    fn least_recently_used_beyond_the_cap_is_parked() {
        let a = plain("a", Status::Idle, 10);
        let b = plain("b", Status::Idle, 100);
        let c = plain("c", Status::Idle, 1000); // coldest
        let expect = c.id.clone();
        let got = count_candidates(&[a, b, c], &HashSet::new(), |_| 2, |_| false);
        assert_eq!(ids(&got), vec![expect]);
    }

    #[test]
    fn busy_sessions_overflow_the_cap_instead_of_being_parked() {
        // Cap 1: the running session is older but must survive; the idle one
        // is the most recent so it holds the one live slot. Nothing parks.
        let running = plain("running", Status::Running, 1000);
        let idle = plain("idle", Status::Idle, 10);
        let got = count_candidates(&[running, idle], &HashSet::new(), |_| 1, |_| false);
        assert!(got.is_empty(), "a working agent must never be parked");
    }

    #[test]
    fn busy_tail_is_spared_while_idle_tail_is_parked() {
        let newest = plain("newest", Status::Idle, 10);
        let working = plain("working", Status::Waiting, 500);
        let coldest = plain("coldest", Status::Idle, 1000);
        let expect = coldest.id.clone();
        let got = count_candidates(
            &[newest, working, coldest],
            &HashSet::new(),
            |_| 1,
            |_| false,
        );
        assert_eq!(ids(&got), vec![expect]);
    }

    #[test]
    fn attached_session_is_never_parked() {
        let warm = plain("warm", Status::Idle, 10);
        let cold = plain("cold", Status::Idle, 1000);
        let name = cold.tmux_session().unwrap().name().to_string();
        let mut attached = HashSet::new();
        attached.insert(name);
        let got = count_candidates(&[warm, cold], &attached, |_| 1, |_| false);
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
        let got = count_candidates(
            &[a, b, stopped, errored, dormant],
            &HashSet::new(),
            |_| 2,
            |_| false,
        );
        assert!(got.is_empty());
    }

    #[test]
    fn structured_sessions_are_left_to_their_own_reaper() {
        let mut sv = plain("sv", Status::Idle, 1000);
        sv.view = crate::session::View::Structured;
        let a = plain("a", Status::Idle, 10);
        let got = count_candidates(&[sv, a], &HashSet::new(), |_| 1, |_| false);
        assert!(got.is_empty());
    }

    #[test]
    fn session_holding_a_scheduled_wake_is_never_hibernated() {
        // 2e370f46 lost its 19:13 UTC measurement when hibernation killed the
        // process holding its one-shot cron. Cap 1: both cold sessions are
        // past the cap, only the one without scheduled work parks.
        let warm = plain("warm", Status::Idle, 10);
        let held = plain("held", Status::Idle, 500);
        let cold = plain("cold", Status::Idle, 1000);
        let (held_id, expect) = (held.id.clone(), cold.id.clone());
        let got = count_candidates(
            &[warm, held, cold],
            &HashSet::new(),
            |_| 1,
            |i| i.id == held_id,
        );
        assert_eq!(ids(&got), vec![expect]);
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
        let got = count_candidates(&[old, fresh], &HashSet::new(), |_| 1, |_| false);
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
    fn claim_parks_despite_stale_disk_status() {
        // The candidate was selected from the fresh in-memory snapshot; the
        // on-disk row's status lags (the 2s poller does not persist every
        // transition), so a stale Error/Stopped on disk must not veto the
        // claim - only genuinely disqualifying disk state may (working,
        // mid-lifecycle, dormant, archived). Without this, every session
        // whose disk row went stale is silently skipped forever and the
        // fleet never shrinks to the cap.
        let temp = tempfile::tempdir().unwrap();
        let _env = crate::session::test_support::isolate_home(temp.path());

        let mut inst = plain("stale-disk", Status::Idle, 1000);
        inst.status = Status::Error; // what the disk remembers
        let id = inst.id.clone();
        let storage = Storage::new_unwatched("test-profile").unwrap();
        storage
            .update(|instances, _groups| {
                instances.push(inst);
                Ok(())
            })
            .unwrap();

        let got = claim_hibernate("test-profile", FileWatchService::noop(), &id).unwrap();
        assert!(got.is_some(), "a stale disk status must not block parking");
        assert!(storage.load().unwrap()[0].is_idle_dormant());
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
