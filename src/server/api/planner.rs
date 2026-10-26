//! Read-only planner projection. Credentials and upstream errors stay server-side.
use axum::{
    extract::State,
    http::{header::CACHE_CONTROL, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};

use crate::server::state::AppState;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    number: u64,
    title: String,
    start_date: Option<String>,
    due_date: Option<String>,
    priority: Option<f64>,
    status: String,
    #[serde(default, skip_serializing)]
    is_template: bool,
}

#[derive(Deserialize)]
struct TaskPage {
    tasks: Vec<Task>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Help {
    time_zone: String,
}

async fn read_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &reqwest::Url,
    token: &str,
    query: &[(&str, &str)],
) -> Result<T, ()> {
    let mut response = client
        .get(url.clone())
        .bearer_auth(token)
        .query(query)
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ())
}

async fn snapshot(url: reqwest::Url, token: String) -> Result<serde_json::Value, ()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ())?;
    let (help, open, missed) = tokio::try_join!(
        read_json::<Help>(&client, &url, &token, &[("usage", "1")]),
        read_json::<TaskPage>(
            &client,
            &url,
            &token,
            &[("limit", "500"), ("status", "open")]
        ),
        read_json::<TaskPage>(
            &client,
            &url,
            &token,
            &[("limit", "500"), ("status", "missed")]
        ),
    )?;
    if help.time_zone.is_empty() || help.time_zone.len() > 100 {
        return Err(());
    }
    let truncated = open.tasks.len() >= 500 || missed.tasks.len() >= 500;
    let mut tasks = open.tasks;
    tasks.extend(missed.tasks);
    tasks.retain(|t| !t.is_template && t.status != "done");
    if tasks.iter().any(|t| {
        t.id.is_empty()
            || t.number == 0
            || t.title.is_empty()
            || t.title.len() > 800
            || !matches!(t.status.as_str(), "open" | "missed")
            || t.priority.is_some_and(|p| !(0.0..=10.0).contains(&p))
    }) {
        return Err(());
    }
    let mut seen = std::collections::HashSet::new();
    tasks.retain(|task| seen.insert(task.id.clone()));
    Ok(serde_json::json!({
        "tasks": tasks,
        "timeZone": help.time_zone,
        "fetchedAt": chrono::Utc::now().to_rfc3339(),
        "truncated": truncated,
    }))
}

fn reply(status: StatusCode, body: serde_json::Value) -> Response {
    (status, [(CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

pub async fn get_planner_timeline(State(state): State<Arc<AppState>>) -> Response {
    if state.cityhall_mode {
        return super::cityhall_response();
    }
    let (Ok(endpoint), Ok(token_file)) = (
        std::env::var("AOE_PLANNER_URL"),
        std::env::var("AOE_PLANNER_READ_TOKEN_FILE"),
    ) else {
        return reply(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"error": "planner_not_configured"}),
        );
    };
    if endpoint.is_empty() || token_file.is_empty() {
        return reply(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"error": "planner_not_configured"}),
        );
    }
    let result = async {
        let url = reqwest::Url::parse(&endpoint).map_err(|_| ())?;
        let loopback = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(());
        }
        let token = tokio::fs::read_to_string(token_file)
            .await
            .map_err(|_| ())?;
        let token = token.trim();
        if token.is_empty() || token.contains(['\n', '\r']) {
            return Err(());
        }
        snapshot(url, token.to_owned()).await
    }
    .await;
    match result {
        Ok(body) => reply(StatusCode::OK, body),
        Err(()) => reply(
            StatusCode::BAD_GATEWAY,
            serde_json::json!({"error": "planner_unavailable"}),
        ),
    }
}
