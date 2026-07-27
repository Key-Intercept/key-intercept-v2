use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::sync::RwLock;
use tracing::info;

#[derive(Clone)]
struct AppState {
    peers: Arc<RwLock<HashMap<String, RegisteredPeer>>>,
    client: reqwest::Client,
}

#[derive(Clone, Deserialize, Serialize)]
struct RegisterRequest {
    owner_id: String,
    base_url: String,
    shared_token: Option<String>,
}

#[derive(Clone)]
struct RegisteredPeer {
    base_url: String,
    shared_token: Option<String>,
}

#[derive(Deserialize)]
struct RemoteUpdatePayload {
    editor_id: String,
    config: Value,
}

#[derive(Serialize)]
struct UsersResponse {
    online_users: Vec<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
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
        .unwrap_or(45491);

    let app = Router::new()
        .route("/health", get(health))
        .route("/register", post(register_peer))
        .route("/users", get(list_users))
        .route(
            "/users/:owner_id/config",
            get(get_remote_config).put(put_remote_config),
        )
        .with_state(AppState {
            peers: Arc::new(RwLock::new(HashMap::new())),
            client: reqwest::Client::new(),
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
    state.peers.write().await.insert(
        payload.owner_id,
        RegisteredPeer {
            base_url: payload.base_url,
            shared_token: payload.shared_token,
        },
    );

    StatusCode::NO_CONTENT
}

async fn list_users(State(state): State<AppState>) -> impl IntoResponse {
    let mut users = state.peers.read().await.keys().cloned().collect::<Vec<_>>();
    users.sort();
    Json(UsersResponse {
        online_users: users,
    })
}

async fn get_remote_config(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
) -> impl IntoResponse {
    let Some(peer) = state.peers.read().await.get(&owner_id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "target user is offline or unknown".to_string(),
            }),
        )
            .into_response();
    };

    let mut req = state
        .client
        .get(format!("{}/config", peer.base_url.trim_end_matches('/')));

    if let Some(token) = peer.shared_token {
        req = req.header("x-loopback-token", token);
    }

    match req.send().await {
        Ok(response) if response.status().is_success() => {
            let Ok(body) = response.json::<Value>().await else {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorResponse {
                        error: "target returned invalid JSON".to_string(),
                    }),
                )
                    .into_response();
            };
            Json(body).into_response()
        }
        Ok(response) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: format!("target returned status {}", response.status()),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: format!("target is unreachable: {err}"),
            }),
        )
            .into_response(),
    }
}

async fn put_remote_config(
    State(state): State<AppState>,
    Path(owner_id): Path<String>,
    Json(payload): Json<RemoteUpdatePayload>,
) -> impl IntoResponse {
    let Some(peer) = state.peers.read().await.get(&owner_id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "target user is offline or unknown".to_string(),
            }),
        )
            .into_response();
    };

    let mut req = state
        .client
        .put(format!("{}/config", peer.base_url.trim_end_matches('/')))
        .header("x-discord-user-id", payload.editor_id)
        .json(&serde_json::json!({ "config": payload.config }));

    if let Some(token) = peer.shared_token {
        req = req.header("x-loopback-token", token);
    }

    match req.send().await {
        Ok(response) if response.status().is_success() => StatusCode::NO_CONTENT.into_response(),
        Ok(response) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: format!("target rejected update with status {}", response.status()),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorResponse {
                error: format!("target is unreachable: {err}"),
            }),
        )
            .into_response(),
    }
}
