//! The one owner of the app's `config.json` (SPEC_VAULT_LIFECYCLE.md, П28).
//!
//! The desktop app, its settings window, the clipper's native helper and the
//! CLI all keep settings in one file. Each used to read it, rebuild it and
//! write it whole; one of them deleted it outright. A single "Forget this
//! space" took the list of every other space, the shortcuts and the voices
//! with it. Every change now goes through [`AppConfig::update`]:
//!
//! - under an exclusive file lock shared by every process, so two writers
//!   never lose each other's change;
//! - reading the current file and changing only the fields asked for, so keys
//!   another writer owns survive untouched;
//! - refusing to write over a file it cannot read: a damaged file is moved
//!   aside next to it, never replaced by an empty one;
//! - bumping [`GENERATION_KEY`] on every real change, so the clipper can tell
//!   its copy of the settings is stale (SPEC_CLIPPER.md, К5).
//!
//! No caller may delete the file.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde_json::{Map, Value};

/// File name inside the app data directory.
pub const CONFIG_FILE: &str = "config.json";

/// Monotonic counter of changes, read by the clipper (К5).
pub const GENERATION_KEY: &str = "config_generation";

/// App data directory name under `~/Library/Application Support`.
pub const APP_DATA_DIR_NAME: &str = "com.mine.app";

#[derive(Debug, thiserror::Error)]
pub enum AppConfigError {
    #[error("cannot read app settings {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("app settings {path} could not be understood; the file was kept as {kept} and nothing was written")]
    Damaged { path: PathBuf, kept: PathBuf },
    #[error("app settings {path} could not be understood")]
    Unreadable { path: PathBuf },
    #[error("cannot lock app settings {path}: {source}")]
    Lock {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot write app settings {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: anyhow::Error,
    },
}

/// The settings file of one app data directory.
#[derive(Debug, Clone)]
pub struct AppConfig {
    path: PathBuf,
}

impl AppConfig {
    /// The settings in `app_data_dir`.
    pub fn in_dir(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join(CONFIG_FILE),
        }
    }

    /// The current user's settings, for processes the app does not start:
    /// the native helper and the CLI.
    pub fn for_current_user() -> Option<Self> {
        let home = std::env::var_os("HOME")?;
        Some(Self::in_dir(
            &PathBuf::from(home)
                .join("Library/Application Support")
                .join(APP_DATA_DIR_NAME),
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The app data directory holding the file.
    pub fn app_data_dir(&self) -> &Path {
        self.path.parent().unwrap_or_else(|| Path::new("."))
    }

    /// The settings as they are on disk. A missing file is empty settings;
    /// an unreadable or damaged one is an error, never an empty object that a
    /// careless caller could write back.
    pub fn read(&self) -> Result<Map<String, Value>, AppConfigError> {
        match parse(&self.path)? {
            Parsed::Object(map) => Ok(map),
            Parsed::Missing => Ok(Map::new()),
            Parsed::Damaged => Err(AppConfigError::Unreadable {
                path: self.path.clone(),
            }),
        }
    }

    /// Change the settings: lock, read, apply `change` to the current object,
    /// write atomically if anything changed. Returns what `change` returned.
    pub fn update<T>(
        &self,
        change: impl FnOnce(&mut Map<String, Value>) -> T,
    ) -> Result<T, AppConfigError> {
        let dir = self.app_data_dir().to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|source| AppConfigError::Lock {
            path: self.path.clone(),
            source,
        })?;
        let lock_path = self.path.with_file_name(format!("{CONFIG_FILE}.lock"));
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|source| AppConfigError::Lock {
                path: lock_path.clone(),
                source,
            })?;
        lock.lock_exclusive().map_err(|source| AppConfigError::Lock {
            path: lock_path.clone(),
            source,
        })?;

        let mut current = match parse(&self.path)? {
            Parsed::Object(map) => map,
            Parsed::Missing => Map::new(),
            Parsed::Damaged => {
                let kept = self.keep_aside()?;
                return Err(AppConfigError::Damaged {
                    path: self.path.clone(),
                    kept,
                });
            }
        };
        let before = current.clone();
        let result = change(&mut current);
        let mut unchanged_before = before;
        unchanged_before.remove(GENERATION_KEY);
        let mut unchanged_after = current.clone();
        unchanged_after.remove(GENERATION_KEY);
        if unchanged_before != unchanged_after {
            let generation = current
                .get(GENERATION_KEY)
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            current.insert(GENERATION_KEY.to_string(), Value::from(generation));
            let bytes = serde_json::to_vec_pretty(&Value::Object(current))
                .map_err(|error| AppConfigError::Write {
                    path: self.path.clone(),
                    source: error.into(),
                })?;
            crate::storage::files::write_atomically(&self.path, &bytes).map_err(|source| {
                AppConfigError::Write {
                    path: self.path.clone(),
                    source,
                }
            })?;
        }
        drop(lock);
        Ok(result)
    }

    /// Move a damaged file aside so its content survives and the next change
    /// starts from clean settings (П28). The space list is then rebuilt from
    /// the spaces' own derived stores (П27).
    fn keep_aside(&self) -> Result<PathBuf, AppConfigError> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or_default();
        let kept = self
            .path
            .with_file_name(format!("{CONFIG_FILE}.damaged-{stamp}"));
        std::fs::rename(&self.path, &kept).map_err(|source| AppConfigError::Read {
            path: self.path.clone(),
            source,
        })?;
        Ok(kept)
    }
}

enum Parsed {
    Object(Map<String, Value>),
    Missing,
    Damaged,
}

fn parse(path: &Path) -> Result<Parsed, AppConfigError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Parsed::Missing),
        Err(source) => {
            return Err(AppConfigError::Read {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(Parsed::Object(map)),
        _ => Ok(Parsed::Damaged),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> (tempfile::TempDir, AppConfig) {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig::in_dir(dir.path());
        (dir, config)
    }

    #[test]
    fn a_change_keeps_every_key_it_did_not_touch() {
        let (_dir, config) = config();
        std::fs::write(
            config.path(),
            json!({"shortcut_overrides": {"a": "b"}, "known_vaults": ["/x"]}).to_string(),
        )
        .unwrap();
        config
            .update(|cfg| {
                cfg.insert("vault_path".into(), json!("/x"));
            })
            .unwrap();
        let saved = config.read().unwrap();
        assert_eq!(saved["shortcut_overrides"], json!({"a": "b"}));
        assert_eq!(saved["known_vaults"], json!(["/x"]));
        assert_eq!(saved["vault_path"], json!("/x"));
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_never_overwritten() {
        let (dir, config) = config();
        std::fs::write(config.path(), b"{ not json").unwrap();
        assert!(matches!(config.read(), Err(AppConfigError::Unreadable { .. })));
        let error = config
            .update(|cfg| {
                cfg.insert("vault_path".into(), json!("/x"));
            })
            .unwrap_err();
        let AppConfigError::Damaged { kept, .. } = error else {
            panic!("expected Damaged, got {error:?}");
        };
        assert_eq!(std::fs::read(&kept).unwrap(), b"{ not json");
        assert!(!config.path().exists());
        assert!(kept.starts_with(dir.path()));
        // The next change starts from clean settings.
        config
            .update(|cfg| {
                cfg.insert("vault_path".into(), json!("/x"));
            })
            .unwrap();
        assert_eq!(config.read().unwrap()["vault_path"], json!("/x"));
    }

    #[test]
    fn every_real_change_bumps_the_generation_and_a_no_op_does_not() {
        let (_dir, config) = config();
        config.update(|cfg| cfg.insert("a".into(), json!(1))).unwrap();
        assert_eq!(config.read().unwrap()[GENERATION_KEY], json!(1));
        config.update(|cfg| cfg.insert("a".into(), json!(1))).unwrap();
        assert_eq!(config.read().unwrap()[GENERATION_KEY], json!(1));
        config.update(|cfg| cfg.insert("a".into(), json!(2))).unwrap();
        assert_eq!(config.read().unwrap()[GENERATION_KEY], json!(2));
    }

    #[test]
    fn concurrent_writers_never_lose_each_others_changes() {
        let (_dir, config) = config();
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let config = config.clone();
                std::thread::spawn(move || {
                    for step in 0..25 {
                        config
                            .update(|cfg| {
                                cfg.insert(format!("writer-{index}-{step}"), json!(true));
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let saved = config.read().unwrap();
        assert_eq!(saved.len(), 8 * 25 + 1);
        assert_eq!(saved[GENERATION_KEY], json!(8 * 25));
    }

    #[test]
    fn a_missing_file_reads_as_empty_settings() {
        let (_dir, config) = config();
        assert!(config.read().unwrap().is_empty());
    }
}
