mod store;
mod schema;

use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, Method, StatusCode, header::{CONTENT_TYPE, HeaderName}},
    response::IntoResponse,
    routing::{delete, get},
};
use schema::{LocalConfig, is_discord_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, error::Error, net::SocketAddr, path::PathBuf, time::Duration};
use store::ConfigStore;
use tokio::time::sleep;
use tower_http::cors::CorsLayer;
use tracing::{error, info};

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
#[serde(deny_unknown_fields)]
struct RegisterPayload {
    owner_id: String,
    base_url: String,
    shared_token: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DesktopCommand {
    ReadConfig { requester_id: String },
    PutConfig { editor_id: String, config: Value },
    AddAllowedEditor { owner_id: String, editor_id: String },
}

#[derive(Clone, Deserialize)]
struct DesktopQueuedRequest {
    request_id: u64,
    #[serde(flatten)]
    command: DesktopCommand,
}

#[derive(Deserialize)]
struct DesktopRequestsResponse {
    requests: Vec<DesktopQueuedRequest>,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct DesktopResponsePayload {
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

    let config_path = std::env::var("KEY_INTERCEPT_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_config_path());
    info!("using config path {}", config_path.display());

    let store = ConfigStore::load_or_create(config_path, owner_discord_id.clone()).await?;

    if let Ok(relay_url) = std::env::var("RELAY_SERVER_URL") {
        let loopback_public_url = std::env::var("LOOPBACK_PUBLIC_URL")
            .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
        let shared_token = std::env::var("LOOPBACK_SHARED_TOKEN").ok();
        tokio::spawn(register_loop(
            relay_url.clone(),
            owner_discord_id,
            loopback_public_url,
            shared_token.clone(),
        ));
        tokio::spawn(relay_sync_loop(relay_url, shared_token, store.clone()));
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

async fn register_loop(
    relay_url: String,
    owner_id: String,
    base_url: String,
    shared_token: Option<String>,
) {
    let register_url = format!("{}/register", relay_url.trim_end_matches('/'));
    let client = reqwest::Client::new();

    loop {
        let payload = RegisterPayload {
            owner_id: owner_id.clone(),
            base_url: base_url.clone(),
            shared_token: shared_token.clone(),
        };

        if let Err(err) = client.post(&register_url).json(&payload).send().await {
            error!(
                "failed to register with relay: {}",
                format_reqwest_error(&err)
            );
        }

        sleep(Duration::from_secs(30)).await;
    }
}

async fn relay_sync_loop(relay_url: String, shared_token: Option<String>, store: ConfigStore) {
    let client = reqwest::Client::new();
    let owner_id = store.get().await.owner_discord_id;
    let requests_url = format!(
        "{}/users/{owner_id}/desktop/requests",
        relay_url.trim_end_matches('/')
    );
    let responses_url = format!(
        "{}/users/{owner_id}/desktop/responses",
        relay_url.trim_end_matches('/')
    );

    loop {
        let mut request = client.get(&requests_url);
        if let Some(token) = &shared_token {
            request = request.header("x-loopback-token", token);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<DesktopRequestsResponse>().await {
                    Ok(payload) => {
                        for queued in payload.requests {
                            let result = process_desktop_command(&store, &queued.command).await;
                            let mut response_request = client.post(&responses_url).json(
                                &DesktopResponsePayload {
                                    request_id: queued.request_id,
                                    status: result.status.as_u16(),
                                    body: result.body,
                                    error: result.error,
                                },
                            );
                            if let Some(token) = &shared_token {
                                response_request =
                                    response_request.header("x-loopback-token", token);
                            }
                            if let Err(err) = response_request.send().await {
                                error!(
                                    "failed sending desktop command response: {}",
                                    format_reqwest_error(&err)
                                );
                            }
                        }
                    }
                    Err(err) => error!(
                        "failed to parse desktop relay requests: {}",
                        format_reqwest_error(&err)
                    ),
                }
            }
            Ok(response) => error!("desktop relay request poll failed with status {}", response.status()),
            Err(err) => error!(
                "failed polling desktop relay requests: {}",
                format_reqwest_error(&err)
            ),
        }
        sleep(Duration::from_secs(2)).await;
    }
}

struct DesktopCommandResult {
    status: StatusCode,
    body: Option<Value>,
    error: Option<String>,
}

async fn process_desktop_command(store: &ConfigStore, command: &DesktopCommand) -> DesktopCommandResult {
    match command {
        DesktopCommand::ReadConfig { requester_id } => {
            let stored = store.get().await;
            let allowed = requester_id == &stored.owner_discord_id
                || stored.allowed_editors.contains(requester_id);
            if !allowed {
                return DesktopCommandResult {
                    status: StatusCode::FORBIDDEN,
                    body: None,
                    error: Some("requester is not allowed to read config".to_string()),
                };
            }
            match serde_json::to_value(stored.config) {
                Ok(value) => DesktopCommandResult {
                    status: StatusCode::OK,
                    body: Some(value),
                    error: None,
                },
                Err(err) => DesktopCommandResult {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    body: None,
                    error: Some(format!("failed serializing config: {err}")),
                },
            }
        }
        DesktopCommand::PutConfig { editor_id, config } => {
            match serde_json::from_value::<LocalConfig>(config.clone()) {
                Ok(parsed) => {
                    if let Err(err) = parsed.validate() {
                        return DesktopCommandResult {
                            status: StatusCode::BAD_REQUEST,
                            body: None,
                            error: Some(err),
                        };
                    }
                    match store.update_config(editor_id, parsed).await {
                        Ok(_) => DesktopCommandResult {
                            status: StatusCode::NO_CONTENT,
                            body: None,
                            error: None,
                        },
                        Err(err) => DesktopCommandResult {
                            status: StatusCode::FORBIDDEN,
                            body: None,
                            error: Some(err.to_string()),
                        },
                    }
                }
                Err(err) => DesktopCommandResult {
                    status: StatusCode::BAD_REQUEST,
                    body: None,
                    error: Some(format!("invalid config payload: {err}")),
                },
            }
        }
        DesktopCommand::AddAllowedEditor { owner_id, editor_id } => {
            if !is_discord_id(editor_id) || !is_discord_id(owner_id) {
                return DesktopCommandResult {
                    status: StatusCode::BAD_REQUEST,
                    body: None,
                    error: Some("owner_id and editor_id must be numeric".to_string()),
                };
            }
            match store.add_editor(owner_id, editor_id.clone()).await {
                Ok(_) => DesktopCommandResult {
                    status: StatusCode::NO_CONTENT,
                    body: None,
                    error: None,
                },
                Err(err) => DesktopCommandResult {
                    status: StatusCode::FORBIDDEN,
                    body: None,
                    error: Some(err.to_string()),
                },
            }
        }
    }
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut details = vec![err.to_string()];

    if let Some(status) = err.status() {
        details.push(format!("status={status}"));
    }
    if let Some(url) = err.url() {
        details.push(format!("url={url}"));
    }
    if err.is_timeout() {
        details.push("timeout=true".to_string());
    }
    if err.is_connect() {
        details.push("connect=true".to_string());
    }
    if err.is_request() {
        details.push("request=true".to_string());
    }
    if err.is_body() {
        details.push("body=true".to_string());
    }
    if err.is_decode() {
        details.push("decode=true".to_string());
    }
    if err.is_redirect() {
        details.push("redirect=true".to_string());
    }

    let mut sources = Vec::new();
    let mut source = err.source();
    while let Some(cause) = source {
        sources.push(cause.to_string());
        source = cause.source();
    }
    if !sources.is_empty() {
        details.push(format!("causes=[{}]", sources.join(" | ")));
    }

    details.join("; ")
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
        info!("PUT /config rejected for requester {}: {}", requester_id, err);
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse { error: err }),
        )
            .into_response();
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
