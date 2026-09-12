use crate::schema::LocalConfig;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    fs,
    sync::{Notify, RwLock},
    time::{Duration, timeout},
};
use tracing::warn;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedState {
    pub owner_discord_id: String,
    #[serde(default)]
    pub revision: u64,
    pub config: LocalConfig,
    #[serde(default)]
    pub allowed_editors: HashSet<String>,
}

impl PersistedState {
    pub fn new(owner_discord_id: String) -> Self {
        Self {
            owner_discord_id,
            revision: 0,
            config: LocalConfig::default(),
            allowed_editors: HashSet::new(),
        }
    }
}

#[derive(Clone)]
pub struct ConfigStore {
    path: PathBuf,
    state: Arc<RwLock<PersistedState>>,
    changed_notify: Arc<Notify>,
}

impl ConfigStore {
    pub async fn load_or_create(path: impl AsRef<Path>, owner_discord_id: String) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let state = if path.exists() {
            let existing = fs::read_to_string(&path)
                .await
                .with_context(|| format!("failed to read {}", path.display()))?;
            match serde_json::from_str::<PersistedState>(&existing) {
                Ok(state) => state,
                Err(err) => match serde_json::from_str::<LocalConfig>(&existing) {
                    Ok(config) => {
                        let migrated = PersistedState {
                            owner_discord_id: owner_discord_id.clone(),
                            revision: 0,
                            config,
                            allowed_editors: HashSet::new(),
                        };
                        fs::write(&path, serde_json::to_vec_pretty(&migrated)?)
                            .await
                            .with_context(|| format!("failed to migrate {}", path.display()))?;
                        migrated
                    }
                    Err(_) => {
                        let backup_path = path.with_extension("corrupt.json");
                        warn!(
                            "failed to parse {}; backing up to {} and recreating default config: {}",
                            path.display(),
                            backup_path.display(),
                            err
                        );
                        fs::write(&backup_path, existing.as_bytes()).await.with_context(|| {
                            format!("failed to write backup {}", backup_path.display())
                        })?;
                        let fresh = PersistedState::new(owner_discord_id.clone());
                        fs::write(&path, serde_json::to_vec_pretty(&fresh)?)
                            .await
                            .with_context(|| format!("failed to recreate {}", path.display()))?;
                        fresh
                    }
                },
            }
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
            changed_notify: Arc::new(Notify::new()),
        })
    }

    pub async fn get(&self) -> PersistedState {
        self.state.read().await.clone()
    }

    pub async fn update_config(&self, editor_id: &str, config: LocalConfig) -> Result<()> {
        let mut state = self.state.write().await;
        if !can_edit(&state, editor_id) {
            bail!("editor is not allowed to update config");
        }

        state.config = config;
        state.revision = state.revision.saturating_add(1);
        self.persist(&state).await?;
        self.changed_notify.notify_waiters();
        Ok(())
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

    pub async fn wait_for_config_change(
        &self,
        after_revision: u64,
        wait_for: Duration,
    ) -> Option<PersistedState> {
        let current = self.get().await;
        if current.revision != after_revision {
            return Some(current);
        }
        if timeout(wait_for, self.changed_notify.notified()).await.is_err() {
            return None;
        }
        let updated = self.get().await;
        if updated.revision != after_revision {
            Some(updated)
        } else {
            None
        }
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
    use tempfile::tempdir;

    #[tokio::test]
    async fn owner_can_update_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        store
            .update_config("owner", LocalConfig::default())
            .await
            .unwrap();

        assert_eq!(
            store.get().await.config.config.censored_replacement,
            "*".to_string()
        );
    }

    #[tokio::test]
    async fn non_whitelisted_editor_is_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        let err = store
            .update_config("editor", LocalConfig::default())
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
            .update_config("editor", LocalConfig::default())
            .await
            .unwrap();

        assert_eq!(
            store.get().await.config.config.censored_replacement,
            "*".to_string()
        );
    }

    #[tokio::test]
    async fn updates_persist_to_disk_for_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        let mut updated = LocalConfig::default();
        updated.config.censored_replacement = "#".to_string();

        store.update_config("owner", updated.clone()).await.unwrap();

        let reloaded = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        assert_eq!(
            reloaded.get().await.config.config.censored_replacement,
            updated.config.censored_replacement
        );
    }

    #[tokio::test]
    async fn load_or_create_migrates_legacy_local_config_format() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, serde_json::to_vec_pretty(&LocalConfig::default()).unwrap())
            .await
            .unwrap();

        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();
        let state = store.get().await;

        assert_eq!(state.owner_discord_id, "owner");
        assert_eq!(state.revision, 0);
        assert!(state.allowed_editors.is_empty());
        assert_eq!(state.config.config.censored_replacement, "*");
    }

    #[tokio::test]
    async fn load_or_create_recovers_from_corrupt_config_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"{invalid json")
            .await
            .unwrap();

        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();
        let state = store.get().await;

        assert_eq!(state.owner_discord_id, "owner");
        assert!(state.allowed_editors.is_empty());
        assert_eq!(state.config.config.censored_replacement, "*");

        let backup_path = path.with_extension("corrupt.json");
        assert!(backup_path.exists());
    }
}
