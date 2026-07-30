use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
struct RemoteUpdatePayload {
    editor_id: String,
    config: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigReadQuery {
    requester_id: String,
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
    if !is_discord_id(&payload.owner_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "owner_id must be numeric".to_string(),
            }),
        )
            .into_response();
    }
    if !is_valid_base_url(&payload.base_url) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "base_url must be a valid http(s) URL".to_string(),
            }),
        )
            .into_response();
    }

    state.peers.write().await.insert(
        payload.owner_id,
        RegisteredPeer {
            base_url: payload.base_url,
            shared_token: payload.shared_token,
        },
    );

    StatusCode::NO_CONTENT.into_response()
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
    Query(query): Query<ConfigReadQuery>,
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
        .get(format!("{}/config", peer.base_url.trim_end_matches('/')))
        .query(&[("requester_id", &query.requester_id)]);

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
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse { error: err }),
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

fn is_discord_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

fn is_valid_base_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    (url.scheme() == "http" || url.scheme() == "https") && url.host_str().is_some()
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
    ];
    if !has_exact_keys(config, &config_keys) {
        return Err("config.config has unexpected or missing fields".to_string());
    }

    if !root.get("rules").is_some_and(Value::is_array)
        || !root.get("rules_groups").is_some_and(Value::is_array)
        || !root.get("whitelist").is_some_and(Value::is_array)
        || !root.get("pet_words").is_some_and(Value::is_array)
        || !root.get("censored_words").is_some_and(Value::is_array)
    {
        return Err("config array fields must be arrays".to_string());
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
            client: reqwest::Client::new(),
        }
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
    async fn get_remote_config_returns_not_found_for_unknown_user() {
        let state = test_state();
        let response = get_remote_config(
            State(state),
            Path("missing".to_string()),
            Query(ConfigReadQuery {
                requester_id: "123".to_string(),
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn put_remote_config_returns_not_found_for_unknown_user() {
        let state = test_state();
        let response = put_remote_config(
            State(state),
            Path("missing".to_string()),
            Json(RemoteUpdatePayload {
                editor_id: "123".to_string(),
                config: json!({
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
                        "debug": false
                    },
                    "rules": [],
                    "rules_groups": [],
                    "whitelist": [],
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
                }),
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn validate_config_shape_rejects_unexpected_fields() {
        let value = json!({
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
                "debug": false
            },
            "rules": [],
            "rules_groups": [],
            "whitelist": [],
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
            },
            "extra": true
        });

        assert!(validate_config_shape(&value).is_err());
    }
}
