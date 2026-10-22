//! Session forecast card read (docs/guides/session-forecast.md).

use super::*;

/// A session's forecast card as stored (including `updated_at`): `404` when
/// the session does not exist or has no card. A read; there is no HTTP write,
/// cards are written by the agent through `aoe session forecast set`.
pub async fn get_session_forecast(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Some(resp) = cityhall_block_non_structured(&state, &id).await {
        return resp;
    }
    let exists = state.instances.read().await.iter().any(|i| i.id == id);
    if !exists {
        return session_not_found();
    }
    match tokio::task::spawn_blocking(move || crate::session::forecast::read_card(&id)).await {
        Ok(Ok(Some(card))) => Json(card).into_response(),
        Ok(Ok(None)) => api_error(
            StatusCode::NOT_FOUND,
            "not_found",
            "No forecast for this session",
        ),
        Ok(Err(e)) => {
            tracing::warn!(target: "server.forecast", "reading forecast card failed: {e:#}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::warn!(target: "server.forecast", "forecast read task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
