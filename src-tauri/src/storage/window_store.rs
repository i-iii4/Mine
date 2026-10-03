//! `windows.json`: the tab windows restored at launch (SPEC_TABS.md, В27,
//! В31 по В34).
//!
//! The file lives in the app's data folder, not in `config.json`: it changes
//! with every tab switch, and every change of the config wakes the clipper.
//! Writes are atomic (temporary file, then rename) and gathered: a burst of
//! changes is written once after `SAVE_WINDOWS_DEBOUNCE`. Quitting writes at
//! once and stops further writes, so windows closing on the way out do not
//! change what is restored.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use crate::domain::windows::{parse, ReadIssue, SavedWindows};

/// The file name inside the app's data folder.
pub const WINDOWS_FILE: &str = "windows.json";
/// Where an unreadable file is kept aside.
pub const WINDOWS_CORRUPT_FILE: &str = "windows.corrupt.json";
/// How long changes gather before they are written (В31).
pub const SAVE_WINDOWS_DEBOUNCE: Duration = Duration::from_millis(500);

/// Failures of reading and writing `windows.json`.
#[derive(Debug, thiserror::Error)]
pub enum SavedWindowsError {
    #[error("failed to read the saved windows: {source}")]
    Read { source: std::io::Error },
    #[error("failed to write the saved windows: {source}")]
    Write { source: std::io::Error },
    #[error("failed to encode the saved windows: {source}")]
    Encode { source: serde_json::Error },
}

/// What reading the file found.
#[derive(Debug, PartialEq)]
pub enum Loaded {
    /// Windows to restore.
    Windows(SavedWindows),
    /// No file: a first launch, or the first with tabs.
    Missing,
    /// The file could not be used and was kept aside.
    SetAside(ReadIssue),
}

/// Read the saved windows from `dir`. An unusable file is moved aside, so the
/// next write does not destroy it (В32).
///
/// # Errors
/// The file exists and cannot be read.
pub fn load(dir: &Path) -> Result<Loaded, SavedWindowsError> {
    let path = dir.join(WINDOWS_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => String::new(),
        Err(source) => return Err(SavedWindowsError::Read { source }),
    };
    match parse(&text) {
        Ok(windows) => Ok(Loaded::Windows(windows)),
        Err(issue) => {
            let aside = match &issue {
                ReadIssue::Corrupt => dir.join(WINDOWS_CORRUPT_FILE),
                ReadIssue::Newer { found } => dir.join(format!("windows.v{found}.json")),
            };
            std::fs::rename(&path, &aside).map_err(|source| SavedWindowsError::Write { source })?;
            Ok(Loaded::SetAside(issue))
        }
    }
}

/// Write `windows` to `dir` atomically.
///
/// # Errors
/// The folder or file cannot be written.
pub fn save(dir: &Path, windows: &SavedWindows) -> Result<(), SavedWindowsError> {
    let bytes =
        serde_json::to_vec_pretty(windows).map_err(|source| SavedWindowsError::Encode { source })?;
    std::fs::create_dir_all(dir).map_err(|source| SavedWindowsError::Write { source })?;
    let temporary = dir.join(format!(".{WINDOWS_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, bytes).map_err(|source| SavedWindowsError::Write { source })?;
    std::fs::rename(&temporary, dir.join(WINDOWS_FILE)).map_err(|source| {
        let _ = std::fs::remove_file(&temporary);
        SavedWindowsError::Write { source }
    })
}

#[derive(Default)]
struct Pending {
    latest: Option<SavedWindows>,
    quitting: bool,
    stopped: bool,
}

struct StoreShared {
    dir: Option<PathBuf>,
    pending: Mutex<Pending>,
    changed: Condvar,
}

/// The writer of `windows.json` for the running app.
pub struct WindowStore {
    shared: Arc<StoreShared>,
}

fn lock(mutex: &Mutex<Pending>) -> MutexGuard<'_, Pending> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl WindowStore {
    /// A store writing into `dir`; `None` writes nothing (the native shell
    /// check runs beside the person's Mine and must not touch its file, В34).
    pub fn new(dir: Option<PathBuf>) -> Self {
        let shared = Arc::new(StoreShared {
            dir,
            pending: Mutex::new(Pending::default()),
            changed: Condvar::new(),
        });
        if shared.dir.is_some() {
            let worker = Arc::clone(&shared);
            let spawned = std::thread::Builder::new()
                .name("windows-store".into())
                .spawn(move || worker.run());
            if let Err(error) = spawned {
                log::warn!("cannot start the saved windows writer: {error}");
            }
        }
        Self { shared }
    }

    /// Remember `windows` to be written after the debounce (В31).
    pub fn schedule(&self, windows: SavedWindows) {
        let mut pending = lock(&self.shared.pending);
        if pending.quitting {
            return;
        }
        pending.latest = Some(windows);
        self.shared.changed.notify_all();
    }

    /// The app is quitting: write `windows` now and nothing after (В33).
    pub fn flush_for_exit(&self, windows: &SavedWindows) {
        let mut pending = lock(&self.shared.pending);
        if pending.quitting {
            return;
        }
        pending.quitting = true;
        pending.latest = None;
        drop(pending);
        if let Some(dir) = &self.shared.dir {
            if let Err(error) = save(dir, windows) {
                log::warn!("{error}");
            }
        }
        self.shared.changed.notify_all();
    }

    /// Whether the app is quitting: closing windows no longer changes what is
    /// restored.
    pub fn quitting(&self) -> bool {
        lock(&self.shared.pending).quitting
    }
}

impl Drop for WindowStore {
    fn drop(&mut self) {
        lock(&self.shared.pending).stopped = true;
        self.shared.changed.notify_all();
    }
}

impl StoreShared {
    fn run(&self) {
        let Some(dir) = self.dir.clone() else {
            return;
        };
        loop {
            let mut pending = lock(&self.pending);
            while pending.latest.is_none() && !pending.stopped && !pending.quitting {
                pending = self
                    .changed
                    .wait(pending)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            if pending.stopped || pending.quitting {
                return;
            }
            // Gather the burst: later changes replace the value to write.
            drop(pending);
            std::thread::sleep(SAVE_WINDOWS_DEBOUNCE);
            let latest = {
                let mut pending = lock(&self.pending);
                if pending.quitting {
                    return;
                }
                pending.latest.take()
            };
            if let Some(windows) = latest {
                if let Err(error) = save(&dir, &windows) {
                    // The next change writes again; the interface goes on.
                    log::warn!("{error}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::windows::{ScreenArea, TabId, TabSpace, WindowId};

    fn sample(tab: &str) -> SavedWindows {
        SavedWindows::fresh(
            TabSpace::Picker,
            WindowId("w".into()),
            TabId(tab.into()),
            &[ScreenArea { x: 0.0, y: 0.0, width: 1440.0, height: 900.0, main: true }],
        )
    }

    #[test]
    fn a_saved_value_loads_back() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample("t1")).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Loaded::Windows(sample("t1")));
        assert_eq!(load(&dir.path().join("none")).unwrap(), Loaded::Missing);
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_a_newer_one_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(WINDOWS_FILE), "not json").unwrap();
        assert_eq!(load(dir.path()).unwrap(), Loaded::SetAside(ReadIssue::Corrupt));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(WINDOWS_CORRUPT_FILE)).unwrap(),
            "not json"
        );

        std::fs::write(dir.path().join(WINDOWS_FILE), "{\"version\":4,\"windows\":[]}").unwrap();
        assert_eq!(
            load(dir.path()).unwrap(),
            Loaded::SetAside(ReadIssue::Newer { found: 4 })
        );
        assert!(dir.path().join("windows.v4.json").is_file());
        save(dir.path(), &sample("t1")).unwrap();
        assert!(dir.path().join("windows.v4.json").is_file());
    }

    #[test]
    fn a_burst_of_changes_is_written_once_with_the_last_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = WindowStore::new(Some(dir.path().to_path_buf()));
        store.schedule(sample("t1"));
        store.schedule(sample("t2"));
        assert_eq!(load(dir.path()).unwrap(), Loaded::Missing, "written before the debounce");
        std::thread::sleep(SAVE_WINDOWS_DEBOUNCE * 3);
        assert_eq!(load(dir.path()).unwrap(), Loaded::Windows(sample("t2")));
    }

    #[test]
    fn quitting_writes_at_once_and_ignores_later_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = WindowStore::new(Some(dir.path().to_path_buf()));
        store.schedule(sample("t1"));
        store.flush_for_exit(&sample("t2"));
        assert_eq!(load(dir.path()).unwrap(), Loaded::Windows(sample("t2")));
        store.schedule(sample("t3"));
        std::thread::sleep(SAVE_WINDOWS_DEBOUNCE * 3);
        assert_eq!(load(dir.path()).unwrap(), Loaded::Windows(sample("t2")));
        assert!(store.quitting());
    }

    #[test]
    fn a_store_without_a_folder_writes_nothing() {
        let store = WindowStore::new(None);
        store.schedule(sample("t1"));
        store.flush_for_exit(&sample("t1"));
        assert!(store.quitting());
    }
}
