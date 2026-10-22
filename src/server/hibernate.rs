//! Hibernating least-recently-used plain sessions past the live cap.

use std::sync::Arc;

use super::idle_reap::{SESSION_IDLE_REAP_INTERVAL, SESSION_IDLE_REAP_MAX_CONCURRENT};
use super::state::AppState;

/// Hibernate least-recently-used plain sessions past the per-profile
/// `session.hibernate_max_live` cap (LRU keep-alive). Same cadence, claim
/// discipline and bounded-concurrency teardown as
/// [`super::idle_reap::reap_idle_sessions`]; the difference is the outcome: a
/// hibernated row keeps `Status::Idle` plus the dormant marker (persisted
/// BEFORE the kill, so a daemon restart cannot resurrect a half-parked
/// session), stays in every list, and is woken with the agent resumed by the
/// ordinary `/ensure` path when selected. A failed teardown clears the marker
/// so the row is never blocked from polling or respawn.
pub(super) async fn hibernate_lru_sessions(
    state: &Arc<AppState>,
    last_run: &mut Option<std::time::Instant>,
) {
    if last_run.is_some_and(|t| t.elapsed() < SESSION_IDLE_REAP_INTERVAL) {
        return;
    }
    *last_run = Some(std::time::Instant::now());

    // Live attach state. If the tmux query fails, skip this pass entirely
    // rather than risk parking a session the user is attached to.
    let attached = match tokio::task::spawn_blocking(crate::tmux::attached_session_names).await {
        Ok(Ok(set)) => set,
        _ => return,
    };

    let instances = { state.instances.read().await.clone() };

    let profiles: Vec<String> = instances
        .iter()
        .filter(|inst| !inst.is_structured())
        .map(|inst| inst.effective_profile())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let caps: std::collections::HashMap<String, u32> = tokio::task::spawn_blocking(move || {
        profiles
            .into_iter()
            .map(|p| {
                let cap = crate::session::config::profile_config::resolve_config_or_warn(&p)
                    .session
                    .hibernate_max_live;
                (p, cap)
            })
            .collect()
    })
    .await
    .unwrap_or_default();

    let candidates = crate::session::hibernate::hibernate_candidates(&instances, &attached, |p| {
        caps.get(p).copied().unwrap_or(0)
    });

    let sem = Arc::new(tokio::sync::Semaphore::new(
        SESSION_IDLE_REAP_MAX_CONCURRENT,
    ));
    for cand in candidates {
        let sem = sem.clone();
        let file_watch = state.file_watch.clone();
        tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let claim = {
                let cand = cand.clone();
                let file_watch = file_watch.clone();
                tokio::task::spawn_blocking(move || {
                    crate::session::hibernate::claim_hibernate(
                        &cand.profile,
                        file_watch,
                        &cand.session_id,
                    )
                })
                .await
            };
            let instance = match claim {
                Ok(Ok(Some(instance))) => instance,
                _ => return,
            };
            let result = tokio::task::spawn_blocking(move || instance.hibernate_stop()).await;
            match result {
                Ok(Ok(())) => {
                    crate::tmux::refresh_session_cache();
                    tracing::info!(
                        target: "server.hibernate",
                        session = %cand.session_id,
                        profile = %cand.profile,
                        "hibernated LRU session past the live cap",
                    );
                }
                _ => {
                    // Teardown failed: tmux/container may still be alive, so
                    // the dormant marker must come off or the poller would
                    // never reconcile the row again.
                    let id = cand.session_id.clone();
                    let profile = cand.profile.clone();
                    let file_watch_for_storage = file_watch.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        crate::session::hibernate::clear_hibernate_claim(
                            &profile,
                            file_watch_for_storage,
                            &id,
                        )
                    })
                    .await;
                    tracing::warn!(
                        target: "server.hibernate",
                        session = %cand.session_id,
                        "hibernation teardown failed; dormant marker rolled back",
                    );
                }
            }
        });
    }
}
