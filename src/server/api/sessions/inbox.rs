//! The Inbox API the input/output agent calls with the Inbox key: the queue,
//! refining an ask, answering it, and the event log. Spec:
//! docs/guides/session-inbox.md, "The Inbox API and its key".

use super::*;

#[derive(Debug, serde::Deserialize)]
pub struct RefineRequest {
    #[serde(rename = "for")]
    pub posted_at: chrono::DateTime<chrono::Utc>,
    pub text: Option<String>,
    pub ask: Option<crate::session::priority::AskKind>,
    pub objective: Option<String>,
    pub link: Option<String>,
    pub value: Option<u8>,
    pub minutes: Option<u16>,
    pub due: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    pub page_html: Option<String>,
    pub merge_into: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct AnswerRequest {
    #[serde(rename = "for")]
    pub posted_at: chrono::DateTime<chrono::Utc>,
    pub form: crate::session::inbox_log::Form,
    pub input: String,
    #[serde(default)]
    pub ms_open: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
pub struct MessageRequest {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub images: Vec<MessageImage>,
}

#[derive(Debug, serde::Deserialize)]
pub struct MessageImage {
    pub data: String,
}

const MAX_MESSAGE_IMAGES: usize = 10;
/// Images from the input box outlive the one-hour paste TTL: the router may be
/// mid-turn for a while before it reads them.
const MESSAGE_IMAGE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

#[derive(Debug, serde::Deserialize)]
pub struct LogQuery {
    pub since: Option<chrono::DateTime<chrono::Utc>>,
}

/// Every current ask in Inbox order, each with `listed` and `has_page`.
pub async fn get_inbox_asks(State(state): State<Arc<AppState>>) -> axum::response::Response {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let instances = state.instances.read().await.clone();
    let rows = tokio::task::spawn_blocking(move || {
        crate::session::inbox::queue(&instances)
            .into_iter()
            .filter_map(|(inst, listed)| {
                let context = crate::session::ask_page::read_context(&inst.id)
                    .ok()
                    .flatten();
                let mut row = crate::session::inbox::ask_json(inst, context)?;
                row["listed"] = listed.into();
                row["has_page"] = inst.priority_ask().is_some_and(|a| a.page).into();
                Some(row)
            })
            .collect::<Vec<_>>()
    })
    .await;
    match rows {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(target: "server.inbox", "inbox queue task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The current ask's `posted_at`, or the response refusing the request: `404`
/// without the session, `409` when `posted_at` is not the current ask's.
async fn current_ask(
    state: &AppState,
    id: &str,
    posted_at: chrono::DateTime<chrono::Utc>,
) -> Result<(Instance, Vec<Instance>), axum::response::Response> {
    let instances = state.instances.read().await;
    let Some(inst) = instances.iter().find(|i| i.id == id) else {
        return Err(session_not_found());
    };
    if inst.priority_ask().and_then(|a| a.posted_at) != Some(posted_at) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "not_current",
            "That ask is not the session's current one",
        ));
    }
    Ok((inst.clone(), instances.clone()))
}

/// Claim the answer to `id`'s ask posted at `posted_at` on disk, under the
/// storage lock, before anything is typed: the daemon reloads its rows from
/// disk at any time, so only the stored claim refuses a second answer. The
/// stored score is mirrored into memory. Returns the ask's text and the
/// sessions, or the refusal: `404` without the session, `409` `answered` or
/// `not_current`.
pub(super) async fn claim(
    state: &AppState,
    id: &str,
    posted_at: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(String, Vec<Instance>), axum::response::Response> {
    use crate::session::priority::{claim_answer, Unanswerable};
    let outcome = std::sync::Arc::new(std::sync::Mutex::new(None));
    let stored = std::sync::Arc::clone(&outcome);
    let claimed = mirror_stored_score(state, id, move |score| {
        *stored.lock().unwrap() = Some(claim_answer(score, posted_at, now));
    })
    .await?;
    let result = outcome.lock().unwrap().take();
    match result {
        _ if !claimed => Err(session_not_found()),
        Some(Ok(text)) => Ok((text, state.instances.read().await.clone())),
        Some(Err(Unanswerable::Answered)) => Err(api_error(
            StatusCode::CONFLICT,
            "answered",
            "That ask already took its answer",
        )),
        Some(Err(Unanswerable::Gone)) | None => Err(api_error(
            StatusCode::CONFLICT,
            "not_current",
            "That ask is not the session's current one",
        )),
    }
}

/// Undo a claim whose answer could not be delivered.
pub(super) async fn release_claim(
    state: &AppState,
    id: &str,
    posted_at: chrono::DateTime<chrono::Utc>,
) {
    let released = mirror_stored_score(state, id, move |score| {
        crate::session::priority::unclaim_answer(score, posted_at)
    })
    .await;
    if released.is_err() {
        tracing::warn!(target: "server.inbox", session = %id, "answer claim not released");
    }
}

/// Apply `f` to `id`'s score on disk and copy the stored score into memory.
/// `Ok(false)` when the row is not on disk; `Err` is the response to return.
async fn mirror_stored_score(
    state: &AppState,
    id: &str,
    f: impl FnOnce(Option<&mut crate::session::priority::PriorityScore>) + Send + 'static,
) -> Result<bool, axum::response::Response> {
    let Some(profile) = state
        .instances
        .read()
        .await
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.source_profile.clone())
    else {
        return Err(session_not_found());
    };
    let after = std::sync::Arc::new(std::sync::Mutex::new(None));
    let seen = std::sync::Arc::clone(&after);
    let persist_id = id.to_string();
    let persisted = persist_session_update(
        profile,
        "inbox answer",
        state.file_watch.clone(),
        move |rows| {
            if let Some(row) = rows.iter_mut().find(|i| i.id == persist_id) {
                f(row.priority.as_mut());
                *seen.lock().unwrap() = Some(row.priority.clone());
            }
        },
    )
    .await;
    if persisted.is_err() {
        return Err(persist_failed_response());
    }
    let Some(score) = after.lock().unwrap().take() else {
        return Ok(false);
    };
    if let Some(inst) = state
        .instances
        .write()
        .await
        .iter_mut()
        .find(|i| i.id == id)
    {
        inst.priority = score;
    }
    Ok(true)
}

/// Mark a session read, on disk and in memory, as `PATCH .../unread` does.
async fn mark_read(state: &AppState, id: &str) -> bool {
    let lock = state.instance_lock(id).await;
    let _guard = lock.lock().await;
    let Some(profile) = state
        .instances
        .read()
        .await
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.source_profile.clone())
    else {
        return false;
    };
    let persist_id = id.to_string();
    let persisted = persist_session_update(
        profile,
        "inbox read",
        state.file_watch.clone(),
        move |rows| {
            if let Some(inst) = rows.iter_mut().find(|i| i.id == persist_id) {
                inst.mark_read();
            }
        },
    )
    .await;
    if persisted.is_err() {
        return false;
    }
    if let Some(inst) = state
        .instances
        .write()
        .await
        .iter_mut()
        .find(|i| i.id == id)
    {
        inst.mark_read();
    }
    true
}

fn log(
    id: &str,
    posted_at: chrono::DateTime<chrono::Utc>,
    event: crate::session::inbox_log::Event,
    form: Option<crate::session::inbox_log::Form>,
    ms_open: Option<u64>,
) {
    let entry = crate::session::inbox_log::Entry {
        at: chrono::Utc::now(),
        event,
        session_id: id.to_string(),
        posted_at,
        form,
        ms_open,
    };
    if let Err(e) = crate::session::inbox_log::append(&entry) {
        tracing::warn!(target: "server.inbox", "inbox log not written: {e:#}");
    }
}

pub async fn post_ask_refine(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<RefineRequest>,
) -> axum::response::Response {
    if let Some(resp) = crate::server::api::read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    if req
        .page_html
        .as_ref()
        .is_some_and(|p| p.len() > crate::session::ask_page::MAX_PAGE_BYTES)
    {
        return api_error(
            StatusCode::BAD_REQUEST,
            "bad_refine",
            "An ask page is at most 4 MiB",
        );
    }
    let lock = state.instance_lock(&id).await;
    let _guard = lock.lock().await;
    let (inst, instances) = match current_ask(&state, &id, req.posted_at).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if let Some(into) = req.merge_into.as_deref() {
        if let Err(e) = crate::session::inbox::check_merge(&instances, &id, into) {
            return api_error(StatusCode::BAD_REQUEST, "bad_refine", format!("{e:#}"));
        }
    }
    let refined = crate::session::priority::refine_ask(
        inst.priority.as_ref(),
        inst.run_started_at,
        req.posted_at,
        crate::session::priority::Refine {
            kind: req.ask,
            text: req.text.as_deref(),
            objective: req.objective.as_deref(),
            link: req.link.as_deref(),
            value: req.value,
            minutes: req.minutes,
            due: req.due.as_deref(),
            options: &req.options,
            page: req.page_html.is_some(),
            merge_into: req.merge_into.as_deref(),
        },
        chrono::Utc::now(),
    );
    let score = match refined {
        Ok(score) => score,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, "bad_refine", format!("{e:#}")),
    };
    let posted_at = req.posted_at;
    let persist_id = id.clone();
    let persist_score = score.clone();
    let persisted = persist_session_update(
        inst.source_profile.clone(),
        "ask refine",
        state.file_watch.clone(),
        move |rows| {
            if let Some(row) = rows.iter_mut().find(|i| i.id == persist_id) {
                if row
                    .priority
                    .as_ref()
                    .and_then(|p| p.ask.as_ref())
                    .and_then(|a| a.posted_at)
                    == Some(posted_at)
                {
                    row.priority = Some(persist_score);
                }
            }
        },
    )
    .await;
    if persisted.is_err() {
        return persist_failed_response();
    }
    if let Some(row) = state
        .instances
        .write()
        .await
        .iter_mut()
        .find(|i| i.id == id)
    {
        row.priority = Some(score);
    }
    if let Some(html) = req.page_html {
        let page_id = id.clone();
        match tokio::task::spawn_blocking(move || {
            crate::session::ask_page::write_page(&page_id, html.as_bytes())
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(target: "server.inbox", "ask page not written: {e:#}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            Err(e) => {
                tracing::warn!(target: "server.inbox", "ask page task failed: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }
    log(
        &id,
        posted_at,
        crate::session::inbox_log::Event::Refined,
        None,
        None,
    );
    StatusCode::NO_CONTENT.into_response()
}

pub async fn post_ask_answer(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<AnswerRequest>,
) -> axum::response::Response {
    if let Some(resp) = crate::server::api::read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let input = req.input.trim();
    if input.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "empty_input",
            "An answer needs its input",
        );
    }
    let now = chrono::Utc::now();
    let (text, instances) = match claim(&state, &id, req.posted_at, now).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    let message = crate::session::inbox::reply_message(&text, input);
    let mut answered = Vec::new();
    for (i, target) in crate::session::inbox::answer_targets(&instances, &id)
        .into_iter()
        .enumerate()
    {
        // Never revive a pane to deliver an answer: a stopped session gets 502.
        let sent = send_terminal_message(
            &state.session_service,
            &state.status_tx,
            &target,
            message.clone(),
            false,
        )
        .await;
        match sent {
            Ok(_) => answered.push(target),
            Err(e) if i == 0 => {
                release_claim(&state, &id, req.posted_at).await;
                return api_error(
                    StatusCode::BAD_GATEWAY,
                    "not_delivered",
                    format!("The session could not take the answer: {}", send_error(&e)),
                );
            }
            Err(e) => {
                tracing::warn!(target: "server.inbox", session = %target, "merged session missed the answer: {}", send_error(&e))
            }
        }
    }
    for target in &answered {
        mark_read(&state, target).await;
    }
    log(
        &id,
        req.posted_at,
        crate::session::inbox_log::Event::Answered,
        Some(req.form),
        req.ms_open,
    );
    Json(serde_json::json!({ "answered": answered })).into_response()
}

/// The queue's input box: text and images, typed into the router session only.
pub async fn post_inbox_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MessageRequest>,
) -> axum::response::Response {
    use base64::Engine as _;
    if let Some(resp) = crate::server::api::read_only_block(&state) {
        return resp;
    }
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    if req.text.trim().is_empty() && req.images.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "empty_message",
            "A message needs text or an image",
        );
    }
    if req.images.len() > MAX_MESSAGE_IMAGES {
        return api_error(
            StatusCode::BAD_REQUEST,
            "too_many_images",
            "At most 10 images",
        );
    }
    let mut images = Vec::new();
    for img in &req.images {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(img.data.as_bytes())
        else {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_base64",
                "An image is not base64",
            );
        };
        if bytes.is_empty() || bytes.len() > super::send::MAX_PASTE_IMAGE_BYTES {
            return api_error(
                StatusCode::BAD_REQUEST,
                "image_size",
                "An image is empty or over 5 MB",
            );
        }
        let Some(mime) = crate::server::api::acp::sniff_image_mime(&bytes) else {
            return api_error(StatusCode::BAD_REQUEST, "not_an_image", "Not an image");
        };
        images.push((bytes, super::send::paste_image_extension(mime)));
    }
    let router = match crate::session::inbox::read_router() {
        Ok(Some(id)) => id,
        Ok(None) => {
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "no_router",
                "No Inbox router is set",
            )
        }
        Err(e) => {
            tracing::warn!(target: "server.inbox", "inbox router not read: {e:#}");
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "no_router",
                "No Inbox router is set",
            );
        }
    };
    let Some(inst) = state
        .instances
        .read()
        .await
        .iter()
        .find(|i| i.id == router)
        .cloned()
    else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_router",
            "The Inbox router is not a session",
        );
    };
    let project = inst.project_path.clone();
    let sandboxed = inst.is_sandboxed();
    let written = tokio::task::spawn_blocking(move || {
        images
            .iter()
            .map(|(bytes, ext)| super::send::write_paste_image(&project, bytes, ext))
            .collect::<std::io::Result<Vec<_>>>()
    })
    .await;
    let written = match written {
        Ok(Ok(w)) => w,
        _ => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "write_failed",
                "An image could not be saved",
            )
        }
    };
    let paths: Vec<String> = written
        .iter()
        .map(|(_, name)| super::send::pane_visible_paste_path(&inst.project_path, sandboxed, name))
        .collect();
    let message = crate::session::inbox::message_text(&req.text, &paths);
    let host_paths: Vec<_> = written.into_iter().map(|(p, _)| p).collect();
    // Never revive a pane to deliver a message, like an answer.
    if let Err(e) = send_terminal_message(
        &state.session_service,
        &state.status_tx,
        &router,
        message,
        false,
    )
    .await
    {
        for p in &host_paths {
            let _ = std::fs::remove_file(p);
        }
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_delivered",
            format!("The router could not take the message: {}", send_error(&e)),
        );
    }
    let n = host_paths.len();
    tokio::spawn(async move {
        tokio::time::sleep(MESSAGE_IMAGE_TTL).await;
        for p in host_paths {
            let _ = tokio::fs::remove_file(&p).await;
        }
    });
    Json(serde_json::json!({ "delivered_to": router, "images": n })).into_response()
}

pub async fn get_inbox_log(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<LogQuery>,
) -> axum::response::Response {
    if let Some(resp) = crate::server::api::cityhall_block(&state) {
        return resp;
    }
    let lines = tokio::task::spawn_blocking(
        move || -> anyhow::Result<Vec<crate::session::inbox_log::Entry>> {
            let path = crate::session::inbox_log::log_path()?;
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(e.into()),
            };
            Ok(text
                .lines()
                .filter_map(|l| serde_json::from_str::<crate::session::inbox_log::Entry>(l).ok())
                .filter(|e| query.since.is_none_or(|since| e.at > since))
                .collect())
        },
    )
    .await;
    match lines {
        Ok(Ok(lines)) => Json(lines).into_response(),
        Ok(Err(e)) => {
            tracing::warn!(target: "server.inbox", "inbox log not read: {e:#}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::warn!(target: "server.inbox", "inbox log task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn send_error(e: &SendKeysError) -> &'static str {
    match e {
        SendKeysError::NotFound | SendKeysError::Gone => "session not found",
        SendKeysError::NotRunning => "its pane is not running",
        SendKeysError::ResumeFailed(_) => "resume failed",
        SendKeysError::Transient(_) => "it is starting or stopping",
        SendKeysError::StructuredView => "structured-view sessions take no terminal messages",
        SendKeysError::Blocked(_) => "it is archived or in the trash",
        SendKeysError::Tmux(_) | SendKeysError::Internal => "tmux refused the message",
    }
}

/// `dismissed` from the Inbox API clears the unread marker too (Done on the list).
pub(super) async fn clear_on_dismiss(state: &AppState, id: &str) {
    mark_read(state, id).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::priority::{Ask, AskKind};

    fn asking(id: &str, value: Option<u8>, minutes: Option<u16>) -> Instance {
        let mut inst = Instance::new(id, "/tmp/inbox-api");
        inst.id = id.to_string();
        inst.source_profile = "default".to_string();
        inst.status = Status::Idle;
        inst.unread = true;
        inst.set_priority(
            Some(5),
            Some(Ask {
                kind: Some(AskKind::Answer),
                text: format!("ask {id}"),
                value,
                minutes,
                ..Ask::default()
            }),
        );
        inst
    }

    fn seeded(instances: Vec<Instance>) -> Arc<AppState> {
        Storage::new_unwatched("default")
            .unwrap()
            .update(|rows, _| {
                *rows = instances.clone();
                Ok(())
            })
            .unwrap();
        crate::server::test_support::build_test_app_state(instances)
    }

    async fn body(resp: axum::response::Response) -> (StatusCode, serde_json::Value) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    async fn posted(state: &AppState, id: &str) -> chrono::DateTime<chrono::Utc> {
        state
            .instances
            .read()
            .await
            .iter()
            .find(|i| i.id == id)
            .and_then(|i| i.priority_ask())
            .and_then(|a| a.posted_at)
            .unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_queue_comes_in_inbox_order_with_listed_and_has_page() {
        let _app = crate::session::test_support::isolate_app_dir();
        crate::session::set_unread_enabled(true);
        let mut read = asking("readask", Some(90), Some(1));
        read.unread = false;
        let mut paged = asking("quickask", Some(40), Some(2));
        paged.priority.as_mut().unwrap().ask.as_mut().unwrap().page = true;
        let state = seeded(vec![asking("slowask", Some(90), Some(30)), read, paged]);
        let (status, json) = body(get_inbox_asks(State(state)).await).await;
        assert_eq!(status, StatusCode::OK);
        let rows = json.as_array().unwrap();
        let order: Vec<(&str, bool, bool)> = rows
            .iter()
            .map(|r| {
                (
                    r["session_id"].as_str().unwrap(),
                    r["listed"].as_bool().unwrap(),
                    r["has_page"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            order,
            vec![
                ("quickask", true, true),
                ("slowask", true, false),
                ("readask", false, false)
            ]
        );
        assert_eq!(rows[0]["ask"]["text"], "ask quickask");
        assert!(rows[0].get("context").is_some());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refine_over_http_follows_the_cli_rules() {
        let _app = crate::session::test_support::isolate_app_dir();
        let state = seeded(vec![
            asking("refineme", None, None),
            asking("target", None, None),
        ]);
        let at = posted(&state, "refineme").await;
        let call = |body: serde_json::Value| {
            let state = state.clone();
            async move {
                let req: RefineRequest = serde_json::from_value(body).unwrap();
                post_ask_refine(State(state), Path("refineme".into()), Json(req))
                    .await
                    .status()
            }
        };
        let ok = serde_json::json!({"for": at, "text": "Approve 40 EUR?", "value": 72, "minutes": 2, "page_html": "<p>x</p>"});
        assert_eq!(call(ok).await, StatusCode::NO_CONTENT);
        let stored = Storage::new_unwatched("default").unwrap().load().unwrap();
        let ask = stored
            .iter()
            .find(|i| i.id == "refineme")
            .unwrap()
            .priority_ask()
            .cloned()
            .unwrap();
        assert_eq!(
            (ask.text.as_str(), ask.value, ask.page),
            ("Approve 40 EUR?", Some(72), true)
        );
        assert!(ask.refined_at.is_some());
        assert_eq!(
            crate::session::ask_page::read_page("refineme")
                .unwrap()
                .as_deref(),
            Some(&b"<p>x</p>"[..])
        );
        let memory = state.instances.read().await;
        assert_eq!(
            memory
                .iter()
                .find(|i| i.id == "refineme")
                .unwrap()
                .priority_ask()
                .unwrap()
                .text,
            "Approve 40 EUR?"
        );
        drop(memory);
        let older = at - chrono::Duration::seconds(5);
        // (body, status, why)
        for (b, status, why) in [
            (
                serde_json::json!({"for": older, "value": 5}),
                StatusCode::CONFLICT,
                "for is not the current ask",
            ),
            (
                serde_json::json!({"for": at, "value": 101}),
                StatusCode::BAD_REQUEST,
                "value out of range",
            ),
            (
                serde_json::json!({"for": at}),
                StatusCode::BAD_REQUEST,
                "nothing to refine",
            ),
            (
                serde_json::json!({"for": at, "merge_into": "refineme"}),
                StatusCode::BAD_REQUEST,
                "merged into itself",
            ),
            (
                serde_json::json!({"for": at, "merge_into": "nosuch"}),
                StatusCode::BAD_REQUEST,
                "no such target",
            ),
        ] {
            assert_eq!(call(b).await, status, "{why}");
        }
        let req: RefineRequest =
            serde_json::from_value(serde_json::json!({"for": at, "value": 5})).unwrap();
        assert_eq!(
            post_ask_refine(State(state.clone()), Path("nosession".into()), Json(req))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn an_answer_that_cannot_reach_its_session_clears_and_logs_nothing() {
        let _app = crate::session::test_support::isolate_app_dir();
        crate::session::set_unread_enabled(true);
        let state = seeded(vec![asking("answerme", None, None)]);
        let at = posted(&state, "answerme").await;
        let call = |body: serde_json::Value| {
            let state = state.clone();
            async move {
                let req: AnswerRequest = serde_json::from_value(body).unwrap();
                post_ask_answer(State(state), Path("answerme".into()), Json(req))
                    .await
                    .status()
            }
        };
        let older = at - chrono::Duration::seconds(5);
        // (body, status, why)
        for (b, status, why) in [
            (
                serde_json::json!({"for": older, "form": "done", "input": "done"}),
                StatusCode::CONFLICT,
                "not the current ask",
            ),
            (
                serde_json::json!({"for": at, "form": "text", "input": "  "}),
                StatusCode::BAD_REQUEST,
                "empty input",
            ),
            // No tmux pane behind the test session: the message cannot be typed.
            (
                serde_json::json!({"for": at, "form": "done", "input": "done"}),
                StatusCode::BAD_GATEWAY,
                "unreachable session",
            ),
        ] {
            assert_eq!(call(b).await, status, "{why}");
        }
        assert!(
            state
                .instances
                .read()
                .await
                .iter()
                .find(|i| i.id == "answerme")
                .unwrap()
                .unread
        );
        assert!(
            !crate::session::inbox_log::log_path().unwrap().exists(),
            "nothing logged"
        );
    }

    async fn answer(
        state: &Arc<AppState>,
        id: &str,
        posted_at: chrono::DateTime<chrono::Utc>,
        input: &str,
    ) -> (StatusCode, serde_json::Value) {
        let req: AnswerRequest = serde_json::from_value(
            serde_json::json!({"for": posted_at, "form": "text", "input": input}),
        )
        .unwrap();
        body(post_ask_answer(State(state.clone()), Path(id.into()), Json(req)).await).await
    }

    /// Apply `f` to the session in memory and on disk, as a CLI post and the
    /// daemon's reload would.
    async fn change(state: &AppState, id: &str, f: impl Fn(&mut Instance)) {
        let row = Storage::new_unwatched("default")
            .unwrap()
            .update(|rows, _| {
                let row = rows.iter_mut().find(|i| i.id == id).unwrap();
                f(row);
                Ok(row.clone())
            })
            .unwrap();
        let mut memory = state.instances.write().await;
        *memory.iter_mut().find(|i| i.id == id).unwrap() = row;
    }

    fn reply(text: &str) -> Option<Ask> {
        Some(Ask {
            kind: Some(AskKind::Answer),
            text: text.into(),
            ..Ask::default()
        })
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn an_answer_typed_while_the_session_posts_its_next_ask_is_still_delivered() {
        let _app = crate::session::test_support::isolate_app_dir();
        if !crate::tmux::tmux_command()
            .arg("-V")
            .output()
            .is_ok_and(|o| o.status.success())
        {
            eprintln!("skipping: tmux not available");
            return;
        }
        let inst = asking("answerpane", None, None);
        let name = crate::tmux::Session::generate_name(&inst.id, &inst.title);
        let _kill = crate::tmux::test_helpers::TmuxTestSession::from_name(name.clone());
        let mut args = [
            "new-session",
            "-d",
            "-s",
            &name,
            "-x",
            "200",
            "-y",
            "40",
            "cat",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        crate::tmux::utils::append_pane_base_index_args(&mut args, &name);
        assert!(crate::tmux::tmux_command()
            .args(&args)
            .output()
            .unwrap()
            .status
            .success());
        let cache = crate::tmux::SessionCacheGuard::capture();
        cache.force_present(&[name.as_str()]);
        let pane = crate::tmux::Session::from_name(&name);
        let typed = |needle: String| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !pane.capture_pane(40).unwrap().contains(&needle) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "never typed: {needle}"
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        let state = seeded(vec![inst]);
        let first = posted(&state, "answerpane").await;
        // 2026-10-29 18:22:54 PT: the session posted its next ask in the same
        // second the user sent the answer to the one on screen.
        change(&state, "answerpane", |i| {
            i.set_priority(Some(5), reply("Read the report"))
        })
        .await;
        let (status, json) = answer(&state, "answerpane", first, "Ada").await;
        assert_eq!(
            (status, json["answered"].clone()),
            (StatusCode::OK, serde_json::json!(["answerpane"]))
        );
        typed("Inbox reply to \"ask answerpane\": Ada".into());
        // 2026-10-31 03:19 UTC, live: the daemon reloaded the row while the
        // first answer was typed, and a second answer to the same ask was
        // delivered too.
        let mut stale = state.instances.read().await[0].priority.clone();
        stale
            .as_mut()
            .unwrap()
            .replaced
            .as_mut()
            .unwrap()
            .ask
            .answered_at = None;
        state.instances.write().await[0].priority = stale;
        let (status, json) = answer(&state, "answerpane", first, "again").await;
        assert_eq!(
            (status, json["error"].as_str()),
            (StatusCode::CONFLICT, Some("answered"))
        );
        let disk = Storage::new_unwatched("default").unwrap().load().unwrap();
        let replaced = disk[0]
            .priority
            .as_ref()
            .unwrap()
            .replaced
            .as_ref()
            .unwrap();
        assert!(replaced.ask.answered_at.is_some(), "the stamp is persisted");
        let log = std::fs::read_to_string(crate::session::inbox_log::log_path().unwrap()).unwrap();
        assert!(
            log.lines()
                .map(|l| serde_json::from_str::<crate::session::inbox_log::Entry>(l).unwrap())
                .any(|e| e.event == crate::session::inbox_log::Event::Answered
                    && e.posted_at == first),
            "answered is logged for the ask it answered"
        );

        // Two answers to the same ask at once: one is delivered.
        let second = posted(&state, "answerpane").await;
        let (a, b) = tokio::join!(
            answer(&state, "answerpane", second, "first"),
            answer(&state, "answerpane", second, "second")
        );
        let mut statuses = [a.0, b.0];
        statuses.sort();
        assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);

        // The session started running for another reason: its ask still takes the answer.
        change(&state, "answerpane", |i| {
            i.set_priority(Some(5), reply("Name the file"));
            i.run_started_at = Some(chrono::Utc::now());
        })
        .await;
        let third = state.instances.read().await[0]
            .priority
            .as_ref()
            .unwrap()
            .ask
            .as_ref()
            .unwrap()
            .posted_at
            .unwrap();
        assert_eq!(
            answer(&state, "answerpane", third, "notes.md").await.0,
            StatusCode::OK
        );
        typed("Inbox reply to \"Name the file\": notes.md".into());
        drop(cache);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn an_answered_event_stamps_the_ask_and_reaches_one_just_replaced() {
        let _app = crate::session::test_support::isolate_app_dir();
        let state = seeded(vec![asking("eventask", None, None)]);
        let first = posted(&state, "eventask").await;
        change(&state, "eventask", |i| {
            i.set_priority(Some(5), reply("Next"))
        })
        .await;
        let event = |name: &str| {
            let mut body = serde_json::json!({"event": name, "posted_at": first});
            if name == "answered" {
                body["form"] = "done".into();
            }
            let req: AskEventRequest = serde_json::from_value(body).unwrap();
            let state = state.clone();
            async move {
                post_ask_event(State(state), Path("eventask".into()), Json(req))
                    .await
                    .status()
            }
        };
        assert_eq!(
            event("opened").await,
            StatusCode::NO_CONTENT,
            "a replaced ask is still answerable"
        );
        assert_eq!(event("answered").await, StatusCode::NO_CONTENT);
        assert_eq!(
            event("answered").await,
            StatusCode::CONFLICT,
            "one answer per ask"
        );
        let disk = Storage::new_unwatched("default").unwrap().load().unwrap();
        assert!(disk[0]
            .priority
            .as_ref()
            .unwrap()
            .replaced
            .as_ref()
            .unwrap()
            .ask
            .answered_at
            .is_some());
    }

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    async fn message(state: &Arc<AppState>, body: serde_json::Value) -> StatusCode {
        let req: MessageRequest = serde_json::from_value(body).unwrap();
        post_inbox_message(State(state.clone()), Json(req))
            .await
            .status()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_message_goes_only_to_the_router_and_is_refused_without_one() {
        let app = crate::session::test_support::isolate_app_dir();
        let project = tempfile::tempdir().unwrap();
        let mut router = Instance::new("router", &project.path().to_string_lossy());
        router.id = "routerid".to_string();
        let state = seeded(vec![router]);
        let hi = serde_json::json!({"text": "hi", "images": []});
        assert_eq!(
            message(&state, hi.clone()).await,
            StatusCode::SERVICE_UNAVAILABLE,
            "no router file"
        );
        let dir = crate::session::get_app_dir().unwrap();
        std::fs::write(
            dir.join(crate::session::inbox::ROUTER_FILE),
            "nosuchsession\n",
        )
        .unwrap();
        assert_eq!(
            message(&state, hi.clone()).await,
            StatusCode::SERVICE_UNAVAILABLE,
            "unknown router"
        );
        std::fs::write(dir.join(crate::session::inbox::ROUTER_FILE), "routerid\n").unwrap();
        // (body, status, why)
        for (b, status, why) in [
            (
                serde_json::json!({"text": "  ", "images": []}),
                StatusCode::BAD_REQUEST,
                "no text and no image",
            ),
            (
                serde_json::json!({"text": "x", "images": [{"data": "%%%"}]}),
                StatusCode::BAD_REQUEST,
                "not base64",
            ),
            (
                serde_json::json!({"text": "x", "images": [{"data": "aGVsbG8="}]}),
                StatusCode::BAD_REQUEST,
                "not an image",
            ),
            (
                serde_json::json!({"text": "x", "images": vec![serde_json::json!({"data": PNG}); 11]}),
                StatusCode::BAD_REQUEST,
                "more than 10 images",
            ),
            // No tmux pane behind the test router: nothing can be typed.
            (
                serde_json::json!({"text": "look", "images": [{"data": PNG}]}),
                StatusCode::SERVICE_UNAVAILABLE,
                "router cannot take it",
            ),
        ] {
            assert_eq!(message(&state, b).await, status, "{why}");
        }
        let pasted = project.path().join(".aoe-pasted-images");
        let left: Vec<_> = std::fs::read_dir(&pasted)
            .map(|d| {
                d.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n != ".gitignore")
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            left.is_empty(),
            "an undelivered message leaves no image behind: {left:?}"
        );
        drop(app);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_dismissal_clears_the_unread_marker_without_sending() {
        let _app = crate::session::test_support::isolate_app_dir();
        crate::session::set_unread_enabled(true);
        let state = seeded(vec![asking("dismissme", None, None)]);
        let at = posted(&state, "dismissme").await;
        let req: AskEventRequest =
            serde_json::from_value(serde_json::json!({"event": "dismissed", "posted_at": at}))
                .unwrap();
        assert_eq!(
            post_ask_event(State(state.clone()), Path("dismissme".into()), Json(req))
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert!(
            !state
                .instances
                .read()
                .await
                .iter()
                .find(|i| i.id == "dismissme")
                .unwrap()
                .unread
        );
        let stored = Storage::new_unwatched("default").unwrap().load().unwrap();
        assert!(
            !stored.iter().find(|i| i.id == "dismissme").unwrap().unread,
            "persisted"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_log_returns_the_lines_after_since() {
        use crate::session::inbox_log::{append, Entry, Event};
        let _app = crate::session::test_support::isolate_app_dir();
        let state = seeded(vec![]);
        let t = |s: i64| chrono::DateTime::from_timestamp(1_800_000_000 + s, 0).unwrap();
        for (at, event) in [
            (t(10), Event::Posted),
            (t(20), Event::Opened),
            (t(30), Event::Dismissed),
        ] {
            append(&Entry {
                at,
                event,
                session_id: "s".into(),
                posted_at: t(10),
                form: None,
                ms_open: None,
            })
            .unwrap();
        }
        let get = |since: Option<chrono::DateTime<chrono::Utc>>| {
            let state = state.clone();
            async move {
                body(get_inbox_log(State(state), axum::extract::Query(LogQuery { since })).await)
                    .await
            }
        };
        let (status, all) = get(None).await;
        assert_eq!((status, all.as_array().unwrap().len()), (StatusCode::OK, 3));
        let (_, after) = get(Some(t(15))).await;
        let events: Vec<&str> = after
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event"].as_str().unwrap())
            .collect();
        assert_eq!(events, vec!["opened", "dismissed"]);
        let (_, none) = get(Some(t(30))).await;
        assert_eq!(none.as_array().unwrap().len(), 0, "strictly after");
    }
}
