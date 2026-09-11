mod schema;
mod store;

use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{
        HeaderMap, Method, StatusCode,
        header::{CONTENT_TYPE, HeaderName},
    },
    response::IntoResponse,
    routing::{delete, get},
};
use schema::{LocalConfig, is_discord_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, net::SocketAddr, path::PathBuf};
use store::ConfigStore;
use tokio::time::{Duration, Instant, sleep};
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};

#[derive(Clone)]
struct AppState {
    store: ConfigStore,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigPayload {
    config: LocalConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorPayload {
    editor_id: String,
}

#[derive(Serialize)]
struct OwnerResponse {
    owner_discord_id: String,
}

#[derive(Serialize)]
struct AllowedEditorsResponse {
    allowed_editors: Vec<String>,
}

#[derive(Serialize)]
struct RegisterRelayPeerPayload {
    owner_id: String,
    base_url: String,
    shared_token: Option<String>,
}

#[derive(Deserialize)]
struct RelayDesktopRequestsResponse {
    requests: Vec<RelayDesktopQueuedRequest>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RelayDesktopCommand {
    ReadConfig { requester_id: String },
    PutConfig { editor_id: String, config: Value },
    AddAllowedEditor { owner_id: String, editor_id: String },
}

#[derive(Deserialize)]
struct RelayDesktopQueuedRequest {
    request_id: u64,
    #[serde(flatten)]
    command: RelayDesktopCommand,
}

#[derive(Serialize)]
struct RelayDesktopCommandResponsePayload {
    request_id: u64,
    status: u16,
    body: Option<Value>,
    error: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "loopback_server=info,axum=info".to_string()),
        )
        .init();

    let owner_discord_id = std::env::var("OWNER_DISCORD_ID")
        .expect("OWNER_DISCORD_ID must be set (Discord ID that owns this machine config)");
    let port = std::env::var("LOOPBACK_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(35491);
    let relay_server_url = std::env::var("RELAY_SERVER_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());
    let shared_token = std::env::var("LOOPBACK_SHARED_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let config_path = std::env::var("KEY_INTERCEPT_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_config_path());
    info!("using config path {}", config_path.display());

    let store = ConfigStore::load_or_create(config_path, owner_discord_id.clone()).await?;
    if let Some(relay_url) = relay_server_url {
        info!("relay bridge enabled for {}", relay_url);
        tokio::spawn(run_relay_bridge(
            store.clone(),
            owner_discord_id.clone(),
            relay_url,
            shared_token,
            port,
        ));
    } else {
        warn!("relay bridge disabled: RELAY_SERVER_URL is not set");
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/owner", get(owner))
        .route("/config", get(get_config).put(put_config))
        .route(
            "/allowed-editors",
            get(get_allowed_editors).post(add_allowed_editor),
        )
        .route("/allowed-editors/:editor_id", delete(remove_allowed_editor))
        .with_state(AppState { store })
        .layer(discord_cors_layer());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("loopback server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn default_config_path() -> PathBuf {
    let mut base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.push("key-intercept");
    base.push("config.json");
    base
}

async fn health() -> &'static str {
    "ok"
}

async fn owner(State(state): State<AppState>) -> impl IntoResponse {
    let stored = state.store.get().await;
    Json(OwnerResponse {
        owner_discord_id: stored.owner_discord_id,
    })
}

async fn get_config(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let stored = state.store.get().await;

    let Some(requester) = requester_id(&headers, &query) else {
        info!("GET /config denied: missing requester id");
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "missing requester id".to_string(),
            }),
        )
            .into_response();
    };

    if requester != stored.owner_discord_id && !stored.allowed_editors.contains(&requester) {
        info!("GET /config denied for requester {}", requester);
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "requester is not allowed to read config".to_string(),
            }),
        )
            .into_response();
    };

    info!("GET /config success for requester {}", requester);
    Json(stored.config).into_response()
}

async fn put_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ConfigPayload>,
) -> impl IntoResponse {
    let Some(requester_id) = requester_header(&headers) else {
        info!("PUT /config denied: missing x-discord-user-id");
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "missing x-discord-user-id header".to_string(),
            }),
        )
            .into_response();
    };

    if let Err(err) = payload.config.validate() {
        info!(
            "PUT /config rejected for requester {}: {}",
            requester_id, err
        );
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: err })).into_response();
    }

    match state
        .store
        .update_config(&requester_id, payload.config)
        .await
    {
        Ok(_) => {
            info!("PUT /config success for requester {}", requester_id);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(err) => {
            info!("PUT /config denied for requester {}: {}", requester_id, err);
            (
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    error: err.to_string(),
                }),
            )
                .into_response()
        }
    }
}

async fn get_allowed_editors(State(state): State<AppState>) -> impl IntoResponse {
    let mut editors = state
        .store
        .get()
        .await
        .allowed_editors
        .into_iter()
        .collect::<Vec<_>>();
    editors.sort();
    Json(AllowedEditorsResponse {
        allowed_editors: editors,
    })
}

async fn add_allowed_editor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<EditorPayload>,
) -> impl IntoResponse {
    let Some(requester_id) = requester_header(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "missing x-discord-user-id header".to_string(),
            }),
        )
            .into_response();
    };

    if !is_discord_id(&payload.editor_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "editor_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }

    match state
        .store
        .add_editor(&requester_id, payload.editor_id)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn remove_allowed_editor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(editor_id): Path<String>,
) -> impl IntoResponse {
    let Some(requester_id) = requester_header(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "missing x-discord-user-id header".to_string(),
            }),
        )
            .into_response();
    };

    match state.store.remove_editor(&requester_id, &editor_id).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: err.to_string(),
            }),
        )
            .into_response(),
    }
}

fn requester_header(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-discord-user-id")
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned)
}

fn requester_id(headers: &HeaderMap, query: &HashMap<String, String>) -> Option<String> {
    requester_header(headers).or_else(|| query.get("requester_id").cloned())
}

fn discord_cors_layer() -> CorsLayer {
    let origins = [
        "https://discord.com".parse().expect("valid discord origin"),
        "https://ptb.discord.com"
            .parse()
            .expect("valid discord ptb origin"),
        "https://canary.discord.com"
            .parse()
            .expect("valid discord canary origin"),
    ];

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([CONTENT_TYPE, HeaderName::from_static("x-discord-user-id")])
}

async fn run_relay_bridge(
    store: ConfigStore,
    owner_discord_id: String,
    relay_base_url: String,
    shared_token: Option<String>,
    loopback_port: u16,
) {
    let client = reqwest::Client::new();
    let register_url = format!("{relay_base_url}/register");
    let health_url = format!("{relay_base_url}/health");
    let requests_url = format!("{relay_base_url}/users/{owner_discord_id}/desktop/requests");
    let responses_url = format!("{relay_base_url}/users/{owner_discord_id}/desktop/responses");
    let mut registered = false;
    let mut next_health_probe = Instant::now();

    loop {
        if !registered {
            match register_relay_peer(
                &client,
                &register_url,
                &owner_discord_id,
                loopback_port,
                shared_token.as_deref(),
            )
            .await
            {
                Ok(()) => {
                    registered = true;
                    next_health_probe = Instant::now();
                    info!(
                        "registered loopback relay peer for owner {}",
                        owner_discord_id
                    );
                }
                Err(err) => {
                    if Instant::now() >= next_health_probe {
                        let health = probe_relay_health(&client, &health_url).await;
                        warn!(
                            "relay registration failed: {}; relay health probe: {}",
                            err, health
                        );
                        next_health_probe = Instant::now() + Duration::from_secs(15);
                    } else {
                        warn!("relay registration failed: {}", err);
                    }
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
            }

            async fn probe_relay_health(client: &reqwest::Client, health_url: &str) -> String {
                match client.get(health_url).send().await {
                    Ok(response) => {
                        let status = response.status();
                        if status.is_success() {
                            "reachable".to_string()
                        } else {
                            format!("status {}", status)
                        }
                    }
                    Err(err) => format!("request error: {err}"),
                }
            }
        }

        let requests = match pull_relay_desktop_requests(
            &client,
            &requests_url,
            shared_token.as_deref(),
        )
        .await
        {
            Ok(requests) => requests,
            Err(PullRequestsError::NotFound) => {
                warn!("relay peer missing; re-registering");
                registered = false;
                sleep(Duration::from_secs(1)).await;
                continue;
            }
            Err(PullRequestsError::Other(err)) => {
                warn!("relay desktop request pull failed: {}", err);
                sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        if requests.is_empty() {
            sleep(Duration::from_millis(500)).await;
            continue;
        }

        for request in requests {
            let response =
                execute_desktop_command(&store, &owner_discord_id, request.command).await;
            if let Err(err) = push_desktop_command_response(
                &client,
                &responses_url,
                shared_token.as_deref(),
                RelayDesktopCommandResponsePayload {
                    request_id: request.request_id,
                    status: response.0.as_u16(),
                    body: response.1,
                    error: response.2,
                },
            )
            .await
            {
                error!("failed pushing desktop command response: {}", err);
            }
        }
    }
}

async fn register_relay_peer(
    client: &reqwest::Client,
    register_url: &str,
    owner_discord_id: &str,
    loopback_port: u16,
    shared_token: Option<&str>,
) -> Result<()> {
    let payload = RegisterRelayPeerPayload {
        owner_id: owner_discord_id.to_string(),
        base_url: format!("http://127.0.0.1:{loopback_port}"),
        shared_token: shared_token.map(ToOwned::to_owned),
    };
    client
        .post(register_url)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

enum PullRequestsError {
    NotFound,
    Other(anyhow::Error),
}

async fn pull_relay_desktop_requests(
    client: &reqwest::Client,
    requests_url: &str,
    shared_token: Option<&str>,
) -> Result<Vec<RelayDesktopQueuedRequest>, PullRequestsError> {
    let mut request = client.get(requests_url);
    if let Some(token) = shared_token {
        request = request.header("x-loopback-token", token);
    }
    let response = request
        .send()
        .await
        .map_err(|err| PullRequestsError::Other(err.into()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(PullRequestsError::NotFound);
    }
    let response = response
        .error_for_status()
        .map_err(|err| PullRequestsError::Other(err.into()))?;
    let payload = response
        .json::<RelayDesktopRequestsResponse>()
        .await
        .map_err(|err| PullRequestsError::Other(err.into()))?;
    Ok(payload.requests)
}

async fn push_desktop_command_response(
    client: &reqwest::Client,
    responses_url: &str,
    shared_token: Option<&str>,
    payload: RelayDesktopCommandResponsePayload,
) -> Result<()> {
    let mut request = client.post(responses_url).json(&payload);
    if let Some(token) = shared_token {
        request = request.header("x-loopback-token", token);
    }
    request.send().await?.error_for_status()?;
    Ok(())
}

async fn execute_desktop_command(
    store: &ConfigStore,
    owner_discord_id: &str,
    command: RelayDesktopCommand,
) -> (StatusCode, Option<Value>, Option<String>) {
    match command {
        RelayDesktopCommand::ReadConfig { requester_id } => {
            let stored = store.get().await;
            if requester_id != stored.owner_discord_id
                && !stored.allowed_editors.contains(&requester_id)
            {
                return (
                    StatusCode::FORBIDDEN,
                    None,
                    Some("requester is not allowed to read config".to_string()),
                );
            }
            match serde_json::to_value(stored.config) {
                Ok(config) => (StatusCode::OK, Some(config), None),
                Err(err) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    None,
                    Some(format!("failed to serialize config: {err}")),
                ),
            }
        }
        RelayDesktopCommand::PutConfig { editor_id, config } => {
            let parsed = match serde_json::from_value::<LocalConfig>(config) {
                Ok(config) => config,
                Err(err) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        None,
                        Some(format!("invalid config payload: {err}")),
                    );
                }
            };
            if let Err(err) = parsed.validate() {
                return (StatusCode::BAD_REQUEST, None, Some(err));
            }
            match store.update_config(&editor_id, parsed).await {
                Ok(()) => (StatusCode::NO_CONTENT, None, None),
                Err(err) => (StatusCode::FORBIDDEN, None, Some(err.to_string())),
            }
        }
        RelayDesktopCommand::AddAllowedEditor {
            owner_id,
            editor_id,
        } => {
            if owner_id != owner_discord_id {
                return (
                    StatusCode::FORBIDDEN,
                    None,
                    Some("owner_id does not match this loopback owner".to_string()),
                );
            }
            if !is_discord_id(&editor_id) {
                return (
                    StatusCode::BAD_REQUEST,
                    None,
                    Some("editor_id must be numeric".to_string()),
                );
            }
            match store.add_editor(&owner_id, editor_id).await {
                Ok(()) => (StatusCode::NO_CONTENT, None, None),
                Err(err) => (StatusCode::FORBIDDEN, None, Some(err.to_string())),
            }
        }
    }
}
