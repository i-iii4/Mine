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
/// next write does not destroy it (В32); a file that cannot be read at all is
/// unusable too (Е2.11): until 13.10.2026 a read error started from scratch
/// and the next write replaced the file.
///
/// # Errors
/// The file cannot be used and cannot be moved aside either: the caller must
/// not write over it ([`WindowStore::hold`]).
pub fn load(dir: &Path) -> Result<Loaded, SavedWindowsError> {
    let path = dir.join(WINDOWS_FILE);
    let issue = match std::fs::read_to_string(&path) {
        Ok(text) => match parse(&text) {
            Ok(windows) => return Ok(Loaded::Windows(windows)),
            Err(issue) => issue,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(error) => {
            log::warn!("saved windows cannot be read, setting them aside: {error}");
            ReadIssue::Corrupt
        }
    };
    let aside = match &issue {
        ReadIssue::Corrupt => dir.join(WINDOWS_CORRUPT_FILE),
        ReadIssue::Newer { found } => dir.join(format!("windows.v{found}.json")),
    };
    std::fs::rename(&path, &aside).map_err(|source| SavedWindowsError::Write { source })?;
    Ok(Loaded::SetAside(issue))
}

/// Write `windows` to `dir` atomically and durably: a temporary file of its
/// own, flushed to disk, renamed over the file, and the folder flushed.
///
/// # Errors
/// The folder or file cannot be written.
pub fn save(dir: &Path, windows: &SavedWindows) -> Result<(), SavedWindowsError> {
    use std::io::Write;
    let bytes =
        serde_json::to_vec_pretty(windows).map_err(|source| SavedWindowsError::Encode { source })?;
    std::fs::create_dir_all(dir).map_err(|source| SavedWindowsError::Write { source })?;
    let write = |source| SavedWindowsError::Write { source };
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(".{WINDOWS_FILE}."))
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(write)?;
    temporary.write_all(&bytes).map_err(write)?;
    temporary.as_file().sync_all().map_err(write)?;
    temporary
        .persist(dir.join(WINDOWS_FILE))
        .map_err(|error| SavedWindowsError::Write { source: error.error })?;
    std::fs::File::open(dir).and_then(|folder| folder.sync_all()).map_err(write)
}

#[derive(Default)]
struct Pending {
    latest: Option<SavedWindows>,
    quitting: bool,
    stopped: bool,
    /// The file could be neither read nor set aside: nothing is written over
    /// it in this run (Е2.11).
    held: bool,
}

struct StoreShared {
    dir: Option<PathBuf>,
    pending: Mutex<Pending>,
    changed: Condvar,
    /// The one writer of the file (Е2.11): the delayed writer and the exit
    /// write take turns, and the delayed writer, once it has the turn, looks
    /// again whether the exit wrote, so it never writes an older value after
    /// it. Until 13.10.2026 both wrote through one temporary file at once.
    writer: Mutex<()>,
}

/// The writer of `windows.json` for the running app.
pub struct WindowStore {
    shared: Arc<StoreShared>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
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
            writer: Mutex::new(()),
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

    /// The saved windows could not be read nor set aside: write nothing over
    /// them in this run.
    pub fn hold(&self) {
        lock(&self.shared.pending).held = true;
    }

    /// Remember `windows` to be written after the debounce (В31).
    pub fn schedule(&self, windows: SavedWindows) {
        let mut pending = lock(&self.shared.pending);
        if pending.quitting || pending.held {
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
        let held = pending.held;
        drop(pending);
        self.shared.changed.notify_all();
        if held {
            return;
        }
        if let Some(dir) = &self.shared.dir {
            let _turn = lock(&self.shared.writer);
            if let Err(error) = save(dir, windows) {
                log::warn!("{error}");
            }
        }
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
            let _turn = lock(&self.writer);
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
        // Written once the writer thread gets to it: a deadline only ends a
        // test that would hang, it does not guess the thread's pace.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while load(dir.path()).unwrap() == Loaded::Missing {
            assert!(std::time::Instant::now() < deadline, "the burst was never written");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
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

    /// Е2.11: two writes at once (the delayed writer and the exit write) each
    /// go through a temporary file of its own and leave a whole file.
    #[test]
    fn two_writes_at_once_both_land_whole() {
        const ROUNDS: usize = 200;
        let dir = tempfile::tempdir().unwrap();
        for round in 0..ROUNDS {
            let start = std::sync::Barrier::new(2);
            let results: Vec<_> = std::thread::scope(|scope| {
                let writers: Vec<_> = ["a", "b"]
                    .into_iter()
                    .map(|tab| {
                        let (dir, start) = (dir.path(), &start);
                        scope.spawn(move || {
                            start.wait();
                            save(dir, &sample(tab))
                        })
                    })
                    .collect();
                writers.into_iter().map(|writer| writer.join().unwrap()).collect()
            });
            for result in results {
                assert!(result.is_ok(), "round {round}: {result:?}");
            }
            assert!(matches!(load(dir.path()).unwrap(), Loaded::Windows(_)), "round {round}");
        }
    }

    /// Е2.11: a file that cannot be read is set aside as unreadable (В32),
    /// not taken for a missing one and written over.
    #[test]
    fn a_file_that_cannot_be_read_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        // A folder in the file's place reads as an error, not as text.
        std::fs::create_dir(dir.path().join(WINDOWS_FILE)).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Loaded::SetAside(ReadIssue::Corrupt));
        assert!(dir.path().join(WINDOWS_CORRUPT_FILE).is_dir());
        assert_eq!(load(dir.path()).unwrap(), Loaded::Missing);
    }

    /// Е2.11: saved windows that could be neither read nor set aside are not
    /// written over in this run.
    #[test]
    fn a_held_store_writes_nothing_over_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(WINDOWS_FILE), "kept as it is").unwrap();
        let store = WindowStore::new(Some(dir.path().to_path_buf()));
        store.hold();
        store.schedule(sample("t1"));
        std::thread::sleep(SAVE_WINDOWS_DEBOUNCE * 3);
        store.flush_for_exit(&sample("t2"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(WINDOWS_FILE)).unwrap(),
            "kept as it is"
        );
    }

    #[test]
    fn a_store_without_a_folder_writes_nothing() {
        let store = WindowStore::new(None);
        store.schedule(sample("t1"));
        store.flush_for_exit(&sample("t1"));
        assert!(store.quitting());
    }
}
