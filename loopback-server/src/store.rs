use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{fs, sync::RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedState {
    pub owner_discord_id: String,
    pub config: Value,
    pub allowed_editors: HashSet<String>,
}

impl PersistedState {
    pub fn new(owner_discord_id: String) -> Self {
        Self {
            owner_discord_id,
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
            allowed_editors: HashSet::new(),
        }
    }
}

#[derive(Clone)]
pub struct ConfigStore {
    path: PathBuf,
    state: Arc<RwLock<PersistedState>>,
}

impl ConfigStore {
    pub async fn load_or_create(path: impl AsRef<Path>, owner_discord_id: String) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let state = if path.exists() {
            let existing = fs::read_to_string(&path)
                .await
                .with_context(|| format!("failed to read {}", path.display()))?;
            serde_json::from_str::<PersistedState>(&existing)
                .with_context(|| format!("failed to parse {}", path.display()))?
        } else {
            let fresh = PersistedState::new(owner_discord_id);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .await
                    .with_context(|| format!("failed to create directory {}", parent.display()))?;
            }
            fs::write(&path, serde_json::to_vec_pretty(&fresh)?)
                .await
                .with_context(|| format!("failed to create {}", path.display()))?;
            fresh
        };

        Ok(Self {
            path,
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub async fn get(&self) -> PersistedState {
        self.state.read().await.clone()
    }

    pub async fn update_config(&self, editor_id: &str, config: Value) -> Result<()> {
        let mut state = self.state.write().await;
        if !can_edit(&state, editor_id) {
            bail!("editor is not allowed to update config");
        }

        state.config = config;
        self.persist(&state).await
    }

    pub async fn add_editor(&self, requester_id: &str, editor_id: String) -> Result<()> {
        let mut state = self.state.write().await;
        ensure_owner(&state, requester_id)?;
        state.allowed_editors.insert(editor_id);
        self.persist(&state).await
    }

    pub async fn remove_editor(&self, requester_id: &str, editor_id: &str) -> Result<()> {
        let mut state = self.state.write().await;
        ensure_owner(&state, requester_id)?;
        state.allowed_editors.remove(editor_id);
        self.persist(&state).await
    }

    async fn persist(&self, state: &PersistedState) -> Result<()> {
        fs::write(&self.path, serde_json::to_vec_pretty(state)?)
            .await
            .with_context(|| format!("failed to write {}", self.path.display()))
    }
}

fn can_edit(state: &PersistedState, editor_id: &str) -> bool {
    state.owner_discord_id == editor_id || state.allowed_editors.contains(editor_id)
}

fn ensure_owner(state: &PersistedState, requester_id: &str) -> Result<()> {
    if state.owner_discord_id != requester_id {
        bail!("only owner can modify allowed editors");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[tokio::test]
    async fn owner_can_update_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        store
            .update_config("owner", json!({ "replacement": "a" }))
            .await
            .unwrap();

        assert_eq!(store.get().await.config, json!({ "replacement": "a" }));
    }

    #[tokio::test]
    async fn non_whitelisted_editor_is_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        let err = store
            .update_config("editor", json!({ "replacement": "x" }))
            .await
            .unwrap_err();

        assert!(err.to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn whitelisted_editor_can_update() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        store
            .add_editor("owner", "editor".to_string())
            .await
            .unwrap();
        store
            .update_config("editor", json!({ "replacement": "ok" }))
            .await
            .unwrap();

        assert_eq!(store.get().await.config, json!({ "replacement": "ok" }));
    }
}
