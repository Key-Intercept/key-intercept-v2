use crate::schema::LocalConfig;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::{
    fs,
    sync::{Notify, RwLock},
    time::{Duration, Instant},
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
    file_modified_at: Arc<RwLock<Option<SystemTime>>>,
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

        let file_modified_at = fs::metadata(&path)
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok());

        Ok(Self {
            path,
            state: Arc::new(RwLock::new(state)),
            file_modified_at: Arc::new(RwLock::new(file_modified_at)),
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
        let deadline = Instant::now() + wait_for;

        loop {
            if let Err(err) = self.refresh_from_disk_if_changed().await {
                warn!(
                    "failed to refresh config store from disk {}: {}",
                    self.path.display(),
                    err
                );
            }

            let current = self.get().await;
            if current.revision != after_revision {
                return Some(current);
            }

            let now = Instant::now();
            if now >= deadline {
                return None;
            }

            let remaining = deadline.saturating_duration_since(now);
            let wait_step = std::cmp::min(remaining, Duration::from_secs(1));

            tokio::select! {
                _ = self.changed_notify.notified() => {}
                _ = tokio::time::sleep(wait_step) => {}
            }
        }
    }

    async fn persist(&self, state: &PersistedState) -> Result<()> {
        fs::write(&self.path, serde_json::to_vec_pretty(state)?)
            .await
            .with_context(|| format!("failed to write {}", self.path.display()))?;
        let modified = fs::metadata(&self.path)
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        *self.file_modified_at.write().await = modified;
        Ok(())
    }

    pub async fn refresh_from_disk_if_changed(&self) -> Result<bool> {
        let current_modified = fs::metadata(&self.path)
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok());

        if current_modified.is_none() {
            return Ok(false);
        }

        {
            let known_modified = self.file_modified_at.read().await;
            if *known_modified == current_modified {
                return Ok(false);
            }
        }

        let raw = fs::read_to_string(&self.path)
            .await
            .with_context(|| format!("failed to read {}", self.path.display()))?;
        let mut state = self.state.write().await;
        let reloaded = match serde_json::from_str::<PersistedState>(&raw) {
            Ok(mut parsed) => {
                if parsed.owner_discord_id.trim().is_empty() {
                    parsed.owner_discord_id = state.owner_discord_id.clone();
                }
                parsed.revision = state.revision.saturating_add(1);
                parsed
            }
            Err(_) => match serde_json::from_str::<LocalConfig>(&raw) {
                Ok(parsed_config) => PersistedState {
                    owner_discord_id: state.owner_discord_id.clone(),
                    revision: state.revision.saturating_add(1),
                    config: parsed_config,
                    allowed_editors: state.allowed_editors.clone(),
                },
                Err(err) => {
                    bail!("failed parsing config file after disk change: {err}");
                }
            },
        };
        *state = reloaded;
        drop(state);

        *self.file_modified_at.write().await = current_modified;
        self.changed_notify.notify_waiters();
        Ok(true)
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
    use tokio::time::sleep;

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

    #[tokio::test]
    async fn refresh_from_disk_applies_manual_local_config_edits() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();

        let initial = store.get().await;
        sleep(Duration::from_millis(20)).await;

        let mut edited = LocalConfig::default();
        edited.config.censored_replacement = "#".to_string();
        fs::write(&path, serde_json::to_vec_pretty(&edited).unwrap())
            .await
            .unwrap();

        let changed = store.refresh_from_disk_if_changed().await.unwrap();
        let refreshed = store.get().await;

        assert!(changed);
        assert_eq!(refreshed.config.config.censored_replacement, "#");
        assert_eq!(refreshed.owner_discord_id, initial.owner_discord_id);
        assert_eq!(refreshed.allowed_editors, initial.allowed_editors);
        assert!(refreshed.revision > initial.revision);
    }

    #[tokio::test]
    async fn wait_for_config_change_detects_manual_disk_edit() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::load_or_create(&path, "owner".to_string())
            .await
            .unwrap();
        let after_revision = store.get().await.revision;

        let path_for_write = path.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(100)).await;
            let mut edited = LocalConfig::default();
            edited.config.censored_replacement = "!".to_string();
            fs::write(&path_for_write, serde_json::to_vec_pretty(&edited).unwrap())
                .await
                .unwrap();
        });

        let updated = store
            .wait_for_config_change(after_revision, Duration::from_secs(2))
            .await
            .expect("manual edit should trigger config update");

        assert_eq!(updated.config.config.censored_replacement, "!");
        assert!(updated.revision > after_revision);
    }
}
