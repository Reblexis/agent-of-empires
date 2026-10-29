//! Ask page read (docs/guides/session-inbox.md).

use super::*;

/// The HTML page of a session's current Inbox ask: `404` when the session does
/// not exist, has no current ask, or its ask has no page. Written only by the
/// agent through `aoe session priority --page`.
pub async fn get_ask_page(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let has_page = state
        .instances
        .read()
        .await
        .iter()
        .find(|i| i.id == id)
        .and_then(|i| i.priority_ask())
        .is_some_and(|ask| ask.page);
    if !has_page {
        return api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            "No ask page for this session",
        );
    }
    match tokio::task::spawn_blocking(move || crate::session::ask_page::read_page(&id)).await {
        Ok(Ok(Some(html))) => (
            [
                (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            html,
        )
            .into_response(),
        Ok(Ok(None)) => api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            "No ask page for this session",
        ),
        Ok(Err(e)) => {
            tracing::warn!(target: "server.inbox", "reading ask page failed: {e:#}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::warn!(target: "server.inbox", "ask page read task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// One ask page event from the dashboard (docs/guides/session-inbox.md,
/// "Measuring").
#[derive(Debug, serde::Deserialize)]
pub struct AskEventRequest {
    pub event: crate::session::inbox_log::Event,
    pub posted_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub form: Option<crate::session::inbox_log::Form>,
    #[serde(default)]
    pub ms_open: Option<u64>,
}

/// Append an `opened`, `answered` or `dismissed` line for the session's
/// current ask. `400` for another event or a malformed one, `404` without the
/// session, `409` when `posted_at` is not the current ask's, `403` read-only.
pub async fn post_ask_event(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<AskEventRequest>,
) -> axum::response::Response {
    use crate::session::inbox_log::{self, Entry, Event};
    if let Some(resp) = crate::server::api::read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    if !matches!(
        req.event,
        Event::Opened | Event::Answered | Event::Dismissed
    ) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad_event",
            "Only opened, answered and dismissed come from the dashboard",
        );
    }
    let current = {
        let instances = state.instances.read().await;
        match instances.iter().find(|i| i.id == id) {
            None => return session_not_found(),
            Some(inst) => inst.priority_ask().and_then(|a| a.posted_at),
        }
    };
    if current != Some(req.posted_at) {
        return api_error(
            StatusCode::CONFLICT,
            "not_current",
            "That ask is not the session's current one",
        );
    }
    let entry = Entry {
        at: chrono::Utc::now(),
        event: req.event,
        session_id: id,
        posted_at: req.posted_at,
        form: req.form,
        ms_open: req.ms_open,
    };
    let dismissed = entry.event == Event::Dismissed;
    let session_id = entry.session_id.clone();
    match tokio::task::spawn_blocking(move || inbox_log::append(&entry)).await {
        Ok(Ok(())) => {
            if dismissed {
                super::inbox::clear_on_dismiss(&state, &session_id).await;
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => api_error(StatusCode::BAD_REQUEST, "bad_event", format!("{e:#}")),
        Err(e) => {
            tracing::warn!(target: "server.inbox", "ask event task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
