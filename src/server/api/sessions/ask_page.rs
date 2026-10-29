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
