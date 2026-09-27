use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{
        HeaderName, Method, StatusCode,
        header::{CONTENT_TYPE, ORIGIN},
    },
    response::IntoResponse,
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::sync::{Notify, RwLock, oneshot};
use tokio::time::{Duration, timeout};
use tower_http::cors::{AllowHeaders, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

fn developer_mode_enabled() -> bool {
    cfg!(feature = "developer-build")
        || env_flag("KEY_INTERCEPT_DEVELOPER_MODE")
        || env_flag("KEY_INTERCEPT_DEBUG_MODE")
}

fn default_relay_port() -> u16 {
    if developer_mode_enabled() { 46001 } else { 35491 }
}

#[derive(Clone)]
struct AppState {
    peers: Arc<RwLock<HashMap<String, RegisteredPeer>>>,
    desktop_requests: Arc<RwLock<HashMap<String, Vec<DesktopQueuedRequest>>>>,
    desktop_request_notifiers: Arc<RwLock<HashMap<String, Arc<Notify>>>>,
    desktop_waiters: Arc<RwLock<HashMap<u64, oneshot::Sender<DesktopCommandResponse>>>>,
    next_desktop_request_id: Arc<AtomicU64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RegisterRequest {
    owner_id: String,
    base_url: String,
    shared_token: Option<String>,
}

#[derive(Clone)]
struct RegisteredPeer {
    shared_token: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DesktopCommand {
    ReadConfig { requester_id: String },
    PutConfig {
        editor_id: String,
        config: Value,
        expected_revision: Option<u64>,
    },
    AddAllowedEditor { owner_id: String, editor_id: String },
    RemoveAllowedEditor { owner_id: String, editor_id: String },
    ReadAllowedEditors { requester_id: String },
}

#[derive(Clone, Serialize, Deserialize)]
struct DesktopQueuedRequest {
    request_id: u64,
    #[serde(flatten)]
    command: DesktopCommand,
}

#[derive(Serialize)]
struct DesktopRequestsResponse {
    requests: Vec<DesktopQueuedRequest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopCommandResponsePayload {
    request_id: u64,
    status: u16,
    body: Option<Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct DesktopRequestPullQuery {
    wait_seconds: Option<u64>,
}

#[derive(Clone)]
struct DesktopCommandResponse {
    status: StatusCode,
    body: Option<Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteUpdatePayload {
    editor_id: String,
    config: Value,
    expected_revision: Option<u64>,
}

#[derive(Deserialize)]
struct ConfigReadQuery {
    requester_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessRequestPayload {
    requester_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessRequestApprovalPayload {
    owner_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MobileSnapshotPayload {
    owner_id: String,
    revision: u64,
    last_writer_id: Option<String>,
    config: Value,
    allowed_editors: Vec<String>,
}

#[derive(Deserialize)]
struct MobileSyncQuery {
    requester_id: String,
    after_revision: Option<u64>,
}

#[derive(Serialize)]
struct UsersResponse {
    online_users: Vec<String>,
}

#[derive(Serialize)]
struct AccessRequestsResponse {
    requests: Vec<String>,
    details: Vec<AccessRequestRecord>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AccessRequestStatus {
    RequestCreated,
    Approved,
    Denied,
    Revoked,
}

#[derive(Clone, Serialize, Deserialize)]
struct AccessRequestRecord {
    request_id: u64,
    requester_id: String,
    state: AccessRequestStatus,
    created_revision: u64,
    updated_revision: u64,
    updated_by: String,
}

#[derive(Serialize)]
struct AccessRequestMutationResponse {
    request_id: u64,
    requester_id: String,
    state: AccessRequestStatus,
    synced_to_desktop: bool,
}

#[derive(Serialize)]
struct MobileOperationResponse {
    revision: u64,
    editor_id: String,
    config: Value,
}

#[derive(Serialize)]
struct MobileSyncResponse {
    owner_id: String,
    revision: u64,
    last_writer_id: String,
    config: Value,
    allowed_editors: Vec<String>,
    operations: Vec<MobileOperationResponse>,
    pending_requests: Vec<AccessRequestRecord>,
}

#[derive(Serialize)]
struct CanonicalProfileStateResponse {
    owner_id: String,
    revision: u64,
    last_writer_id: String,
    config: Value,
    allowed_editors: Vec<String>,
    pending_requests: Vec<AccessRequestRecord>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "relay_server=info,axum=info".to_string()),
        )
        .init();

    let port = std::env::var("RELAY_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or_else(default_relay_port);

    let app = Router::new()
        .route("/health", get(health))
        .route("/register", post(register_peer))
        .route("/users", get(list_users))
        .route(
            "/users/:owner_id/config",
            get(get_remote_config).put(put_remote_config),
        )
        .route(
            "/users/:owner_id/access-requests",
            get(list_access_requests).post(create_access_request),
        )
        .route("/users/:owner_id/profile-state", get(get_canonical_profile_state))
        .route(
            "/users/:owner_id/access-requests/:requester_id",
            delete(deny_access_request),
        )
        .route(
            "/users/:owner_id/access-requests/:requester_id/approve",
            post(approve_access_request),
        )
        .route(
            "/users/:owner_id/mobile/snapshot",
            post(upsert_mobile_snapshot),
        )
        .route("/users/:owner_id/mobile/sync", get(get_mobile_sync))
        .route(
            "/users/:owner_id/desktop/requests",
            get(pull_desktop_requests),
        )
        .route(
            "/users/:owner_id/desktop/responses",
            post(push_desktop_response),
        )
        .layer(discord_cors_layer())
        .layer(TraceLayer::new_for_http())
        .with_state(AppState {
            peers: Arc::new(RwLock::new(HashMap::new())),
            desktop_requests: Arc::new(RwLock::new(HashMap::new())),
            desktop_request_notifiers: Arc::new(RwLock::new(HashMap::new())),
            desktop_waiters: Arc::new(RwLock::new(HashMap::new())),
            next_desktop_request_id: Arc::new(AtomicU64::new(1)),
        });

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("relay server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

async fn register_peer(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    if !is_discord_id(&payload.owner_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    state.peers.write().await.insert(
        payload.owner_id,
        RegisteredPeer {
            shared_token: payload.shared_token,
        },
    );

    StatusCode::NO_CONTENT.into_response()
}

async fn list_users(State(state): State<AppState>) -> impl IntoResponse {
    let peers = state.peers.read().await;
    let mut users = peers.keys().cloned().collect::<Vec<_>>();
    users.sort();
    Json(UsersResponse {
        online_users: users,
    })
}

async fn get_canonical_profile_state(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Query(query): Query<ConfigReadQuery>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id) || !is_discord_id(&query.requester_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and requester_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }

    let config_response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::ReadConfig {
            requester_id: query.requester_id,
        },
    )
    .await;
    if !config_response.status.is_success() {
        return desktop_command_to_http_response(config_response);
    }

    let config = match config_response.body {
        Some(body) => body,
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: "target returned no config payload".to_string(),
                }),
            )
                .into_response();
        }
    };

    let mut allowed_editors = Vec::new();
    let allowed_response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::ReadAllowedEditors {
            requester_id: owner_id.clone(),
        },
    )
    .await;
    if allowed_response.status.is_success() {
        if let Some(body) = allowed_response.body {
            allowed_editors = body
                .get("allowed_editors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                .collect::<Vec<_>>();
            allowed_editors.sort();
        }
    }

    Json(CanonicalProfileStateResponse {
        owner_id: owner_id.clone(),
        revision: 0,
        last_writer_id: owner_id,
        config,
        allowed_editors,
        pending_requests: Vec::new(),
    })
    .into_response()
}

async fn get_remote_config(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Query(query): Query<ConfigReadQuery>,
) -> impl IntoResponse {
    let response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::ReadConfig {
            requester_id: query.requester_id,
        },
    )
    .await;
    desktop_command_to_http_response(response)
}

fn relay_passthrough_status(target_status: StatusCode) -> StatusCode {
    if target_status.is_client_error() {
        return target_status;
    }
    StatusCode::BAD_GATEWAY
}

async fn put_remote_config(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(payload): Json<RemoteUpdatePayload>,
) -> impl IntoResponse {
    if !is_discord_id(&payload.editor_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "editor_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    if let Err(err) = validate_config_shape(&payload.config) {
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: err })).into_response();
    }

    let response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::PutConfig {
            editor_id: payload.editor_id,
            config: payload.config,
            expected_revision: payload.expected_revision,
        },
    )
    .await;
    desktop_command_to_http_response(response)
}

async fn create_access_request(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(payload): Json<AccessRequestPayload>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id) || !is_discord_id(&payload.requester_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and requester_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }

    if !state.peers.read().await.contains_key(&owner_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "target user is offline or unknown".to_string(),
            }),
        )
            .into_response();
    }

    (
        StatusCode::ACCEPTED,
        Json(AccessRequestMutationResponse {
            request_id: 0,
            requester_id: payload.requester_id,
            state: AccessRequestStatus::RequestCreated,
            synced_to_desktop: false,
        }),
    )
        .into_response()
}

async fn list_access_requests(
    Path(owner_id): Path<String>,
    Query(query): Query<ConfigReadQuery>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id) || !is_discord_id(&query.requester_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and requester_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }

    if query.requester_id != owner_id {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "only owner can list access requests".to_string(),
            }),
        )
            .into_response();
    }

    Json(AccessRequestsResponse {
        requests: Vec::new(),
        details: Vec::new(),
    })
    .into_response()
}

async fn approve_access_request(
    State(state): State<AppState>,
    Path((owner_id, requester_id)): Path<(String, String)>,
    Json(payload): Json<AccessRequestApprovalPayload>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id)
        || !is_discord_id(&requester_id)
        || !is_discord_id(&payload.owner_id)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and requester_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }

    if payload.owner_id != owner_id {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "only owner can approve access requests".to_string(),
            }),
        )
            .into_response();
    }

    let response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::AddAllowedEditor {
            owner_id: owner_id.clone(),
            editor_id: requester_id.clone(),
        },
    )
    .await;
    if !response.status.is_success() {
        return desktop_command_to_http_response(response);
    }

    (
        StatusCode::OK,
        Json(AccessRequestMutationResponse {
            request_id: 0,
            requester_id,
            state: AccessRequestStatus::Approved,
            synced_to_desktop: true,
        }),
    )
        .into_response()
}

async fn deny_access_request(
    State(state): State<AppState>,
    Path((owner_id, requester_id)): Path<(String, String)>,
    Query(query): Query<ConfigReadQuery>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id)
        || !is_discord_id(&requester_id)
        || !is_discord_id(&query.requester_id)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and requester_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }

    if query.requester_id != owner_id {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "only owner can deny access requests".to_string(),
            }),
        )
            .into_response();
    }

    let response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::RemoveAllowedEditor {
            owner_id: owner_id.clone(),
            editor_id: requester_id.clone(),
        },
    )
    .await;
    if !response.status.is_success() && response.status != StatusCode::FORBIDDEN {
        return desktop_command_to_http_response(response);
    }

    (
        StatusCode::OK,
        Json(AccessRequestMutationResponse {
            request_id: 0,
            requester_id,
            state: AccessRequestStatus::Denied,
            synced_to_desktop: true,
        }),
    )
        .into_response()
}

async fn upsert_mobile_snapshot(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(payload): Json<MobileSnapshotPayload>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id)
        || !is_discord_id(&payload.owner_id)
        || payload
            .last_writer_id
            .as_deref()
            .is_some_and(|id| !is_discord_id(id))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and last_writer_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    if owner_id != payload.owner_id {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "owner_id path/body mismatch".to_string(),
            }),
        )
            .into_response();
    }
    if let Err(err) = validate_config_shape(&payload.config) {
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: err })).into_response();
    }
    if payload.allowed_editors.iter().any(|id| !is_discord_id(id)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "allowed_editors must be numeric Discord IDs".to_string(),
            }),
        )
            .into_response();
    }

    if !state.peers.read().await.contains_key(&owner_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "target user is offline or unknown".to_string(),
            }),
        )
            .into_response();
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn get_mobile_sync(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Query(query): Query<MobileSyncQuery>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id) || !is_discord_id(&query.requester_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id and requester_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    if owner_id != query.requester_id {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "only owner can sync mobile state".to_string(),
            }),
        )
            .into_response();
    }

    let _after_revision = query.after_revision.unwrap_or(0);

    let config_response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::ReadConfig {
            requester_id: owner_id.clone(),
        },
    )
    .await;
    if !config_response.status.is_success() {
        return desktop_command_to_http_response(config_response);
    }

    let config = match config_response.body {
        Some(body) => body,
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorResponse {
                    error: "target returned no config payload".to_string(),
                }),
            )
                .into_response();
        }
    };

    let mut allowed_editors = Vec::new();
    let allowed_response = dispatch_desktop_command(
        &state,
        &owner_id,
        DesktopCommand::ReadAllowedEditors {
            requester_id: owner_id.clone(),
        },
    )
    .await;
    if allowed_response.status.is_success() {
        if let Some(body) = allowed_response.body {
            allowed_editors = body
                .get("allowed_editors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                .collect::<Vec<_>>();
            allowed_editors.sort();
        }
    }

    Json(MobileSyncResponse {
        owner_id: owner_id.clone(),
        revision: 0,
        last_writer_id: owner_id,
        config,
        allowed_editors,
        operations: Vec::new(),
        pending_requests: Vec::new(),
    })
    .into_response()
}

async fn pull_desktop_requests(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Query(query): Query<DesktopRequestPullQuery>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    let Some(peer) = state.peers.read().await.get(&owner_id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "target user is offline or unknown".to_string(),
            }),
        )
            .into_response();
    };
    if !is_valid_loopback_token(&peer, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "invalid loopback token".to_string(),
            }),
        )
            .into_response();
    }
    let notifier = get_desktop_request_notifier(&state, &owner_id).await;
    let wait_seconds = query.wait_seconds.unwrap_or(0).min(25);
    let mut first_attempt = true;

    loop {
        let requests = state
            .desktop_requests
            .write()
            .await
            .remove(&owner_id)
            .unwrap_or_default();
        if !requests.is_empty() {
            return Json(DesktopRequestsResponse { requests }).into_response();
        }
        if !first_attempt || wait_seconds == 0 {
            return Json(DesktopRequestsResponse { requests }).into_response();
        }
        first_attempt = false;
        let _ = timeout(Duration::from_secs(wait_seconds), notifier.notified()).await;
    }
}

async fn push_desktop_response(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<DesktopCommandResponsePayload>,
) -> impl IntoResponse {
    if !is_discord_id(&owner_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    let Some(peer) = state.peers.read().await.get(&owner_id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "target user is offline or unknown".to_string(),
            }),
        )
            .into_response();
    };
    if !is_valid_loopback_token(&peer, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "invalid loopback token".to_string(),
            }),
        )
            .into_response();
    }
    let Ok(status) = StatusCode::from_u16(payload.status) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "status must be a valid HTTP status code".to_string(),
            }),
        )
            .into_response();
    };
    let sender = state
        .desktop_waiters
        .write()
        .await
        .remove(&payload.request_id);
    if let Some(sender) = sender {
        let _ = sender.send(DesktopCommandResponse {
            status,
            body: payload.body,
            error: payload.error,
        });
    }
    StatusCode::NO_CONTENT.into_response()
}

fn is_valid_loopback_token(peer: &RegisteredPeer, headers: &axum::http::HeaderMap) -> bool {
    let Some(expected) = peer.shared_token.as_deref() else {
        return true;
    };
    headers
        .get("x-loopback-token")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| value == expected)
}

async fn dispatch_desktop_command(
    state: &AppState,
    owner_id: &str,
    command: DesktopCommand,
) -> DesktopCommandResponse {
    if !state.peers.read().await.contains_key(owner_id) {
        return DesktopCommandResponse {
            status: StatusCode::NOT_FOUND,
            body: None,
            error: Some("target user is offline or unknown".to_string()),
        };
    }

    let request_id = state.next_desktop_request_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel::<DesktopCommandResponse>();
    state
        .desktop_waiters
        .write()
        .await
        .insert(request_id, sender);
    state
        .desktop_requests
        .write()
        .await
        .entry(owner_id.to_string())
        .or_default()
        .push(DesktopQueuedRequest {
            request_id,
            command,
        });
    get_desktop_request_notifier(state, owner_id)
        .await
        .notify_waiters();

    match timeout(Duration::from_secs(15), receiver).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => DesktopCommandResponse {
            status: StatusCode::BAD_GATEWAY,
            body: None,
            error: Some("desktop client disconnected before responding".to_string()),
        },
        Err(_) => {
            state.desktop_waiters.write().await.remove(&request_id);
            let mut requests = state.desktop_requests.write().await;
            if let Some(queue) = requests.get_mut(owner_id) {
                queue.retain(|entry| entry.request_id != request_id);
                if queue.is_empty() {
                    requests.remove(owner_id);
                }
            }
            DesktopCommandResponse {
                status: StatusCode::BAD_GATEWAY,
                body: None,
                error: Some("desktop client did not respond in time".to_string()),
            }
        }
    }
}

async fn get_desktop_request_notifier(state: &AppState, owner_id: &str) -> Arc<Notify> {
    let mut notifiers = state.desktop_request_notifiers.write().await;
    notifiers
        .entry(owner_id.to_string())
        .or_insert_with(|| Arc::new(Notify::new()))
        .clone()
}

fn desktop_command_to_http_response(response: DesktopCommandResponse) -> axum::response::Response {
    if response.status.is_success() {
        if let Some(body) = response.body {
            return Json(body).into_response();
        }
        return StatusCode::NO_CONTENT.into_response();
    }
    (
        relay_passthrough_status(response.status),
        Json(ErrorResponse {
            error: response
                .error
                .unwrap_or_else(|| format!("target returned status {}", response.status)),
        }),
    )
        .into_response()
}

fn is_discord_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
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
        .allow_headers(AllowHeaders::list([
            CONTENT_TYPE,
            HeaderName::from_static("x-loopback-token"),
            HeaderName::from_static("x-discord-user-id"),
            ORIGIN,
        ]))
}

fn has_exact_keys(map: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    if map.len() != expected.len() {
        return false;
    }
    expected.iter().all(|k| map.contains_key(*k))
}

fn validate_config_shape(value: &Value) -> Result<(), String> {
    let Some(root) = value.as_object() else {
        return Err("config must be an object".to_string());
    };

    let root_keys = [
        "config",
        "rules",
        "rules_groups",
        "whitelist",
        "blacklist",
        "filter_mode",
        "pet_words",
        "censored_words",
        "drone_config",
    ];
    if !has_exact_keys(root, &root_keys) {
        return Err("config has unexpected or missing top-level fields".to_string());
    }

    let Some(config) = root.get("config").and_then(Value::as_object) else {
        return Err("config.config must be an object".to_string());
    };
    let config_keys = [
        "rules_end",
        "gag_end",
        "pet_end",
        "pet_amount",
        "pet_type",
        "bimbo_end",
        "horny_end",
        "bimbo_word_length",
        "drone_end",
        "uwu_end",
        "censored_end",
        "censored_replacement",
        "debug",
        "blocked_by_dom",
    ];
    if !has_exact_keys(config, &config_keys) {
        return Err("config.config has unexpected or missing fields".to_string());
    }

    if !root.get("rules").is_some_and(Value::is_array)
        || !root.get("rules_groups").is_some_and(Value::is_array)
        || !root.get("whitelist").is_some_and(Value::is_array)
        || !root.get("blacklist").is_some_and(Value::is_array)
        || !root.get("pet_words").is_some_and(Value::is_array)
        || !root.get("censored_words").is_some_and(Value::is_array)
    {
        return Err("config array fields must be arrays".to_string());
    }

    if !matches!(
        root.get("filter_mode").and_then(Value::as_str),
        Some("whitelist" | "blacklist")
    ) {
        return Err("config.filter_mode must be whitelist or blacklist".to_string());
    }

    let Some(drone) = root.get("drone_config").and_then(Value::as_object) else {
        return Err("config.drone_config must be an object".to_string());
    };
    let drone_keys = [
        "drone_health",
        "speech_header",
        "speech_footer",
        "action_header",
        "action_footer",
        "whisper_header",
        "whisper_footer",
        "loud_header",
        "loud_footer",
        "drone_term",
    ];
    if !has_exact_keys(drone, &drone_keys) {
        return Err("config.drone_config has unexpected or missing fields".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;
    use serde_json::json;

    fn test_state() -> AppState {
        AppState {
            peers: Arc::new(RwLock::new(HashMap::new())),
            desktop_requests: Arc::new(RwLock::new(HashMap::new())),
            desktop_request_notifiers: Arc::new(RwLock::new(HashMap::new())),
            desktop_waiters: Arc::new(RwLock::new(HashMap::new())),
            next_desktop_request_id: Arc::new(AtomicU64::new(1)),
        }
    }

    fn sample_config() -> Value {
        json!({
            "config": {
                "rules_end": "9999-12-31T23:59:59.000Z",
                "gag_end": "1970-01-01T00:00:00.000Z",
                "pet_end": "1970-01-01T00:00:00.000Z",
                "pet_amount": 0.0,
                "pet_type": 0,
                "bimbo_end": "1970-01-01T00:00:00.000Z",
                "horny_end": "1970-01-01T00:00:00.000Z",
                "bimbo_word_length": 12,
                "drone_end": "1970-01-01T00:00:00.000Z",
                "uwu_end": "1970-01-01T00:00:00.000Z",
                "censored_end": "1970-01-01T00:00:00.000Z",
                "censored_replacement": "*",
                "debug": false,
                "blocked_by_dom": false
            },
            "rules": [],
            "rules_groups": [],
            "whitelist": [],
            "blacklist": [],
            "filter_mode": "whitelist",
            "pet_words": [],
            "censored_words": [],
            "drone_config": {
                "drone_health": 100,
                "speech_header": "Acknowledged",
                "speech_footer": "Compliance complete",
                "action_header": "ACTION",
                "action_footer": "ACTION COMPLETE",
                "whisper_header": "WHISPER",
                "whisper_footer": "WHISPER COMPLETE",
                "loud_header": "LOUD",
                "loud_footer": "LOUD COMPLETE",
                "drone_term": "Drone"
            }
        })
    }

    #[tokio::test]
    async fn register_peer_adds_user() {
        let state = test_state();
        let response = register_peer(
            State(state.clone()),
            Json(RegisterRequest {
                owner_id: "123".to_string(),
                base_url: "http://127.0.0.1:35491".to_string(),
                shared_token: None,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let users = state.peers.read().await;
        assert!(users.contains_key("123"));
    }

    #[tokio::test]
    async fn put_remote_config_returns_not_found_for_unknown_user() {
        let state = test_state();
        let response = put_remote_config(
            State(state),
            Path("missing".to_string()),
            Json(RemoteUpdatePayload {
                editor_id: "123".to_string(),
                config: sample_config(),
                expected_revision: None,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
