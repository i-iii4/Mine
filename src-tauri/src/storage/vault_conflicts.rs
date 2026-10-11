//! The notes of a space that iCloud holds conflict versions of
//! (SPEC_ICLOUD_CONFLICTS.md, ВК6).
//!
//! The table is derived data: the helper's scan is its source, and the table
//! remembers only what the last check found and since when. A path is the
//! note's path from the space root with its folders, NFC, `Cards/Note.md`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

/// The folder of the derived store where the former resolution kept the
/// notes it replaced, out of the person's sight (SPEC_ICLOUD_CONFLICTS.md,
/// «Что было», 3). Nothing writes it any more.
pub const RETIRED_ARCHIVE_DIR: &str = "conflicts-archive";

/// One note with conflict versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictRow {
    pub path: String,
    /// When a check first found the conflict, ISO 8601.
    pub detected_at: String,
}

/// Every row, newest first.
pub fn list_conflict_rows(conn: &Connection) -> Result<Vec<ConflictRow>> {
    let mut stmt = conn.prepare(
        "SELECT path, detected_at FROM vault_conflicts ORDER BY detected_at DESC, path",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConflictRow {
            path: row.get(0)?,
            detected_at: row.get(1)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to list vault conflicts")
}

/// Every conflict path, newest first.
pub fn list_conflict_paths(conn: &Connection) -> Result<Vec<String>> {
    Ok(list_conflict_rows(conn)?
        .into_iter()
        .map(|row| row.path)
        .collect())
}

/// Since when the note at `path` has a recorded conflict, or none.
pub fn conflict_detected_at(conn: &Connection, path: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT detected_at FROM vault_conflicts WHERE path = ?1",
        [path],
        |row| row.get(0),
    )
    .optional()
    .context("failed to read a vault conflict")
}

/// Forget the conflicts of `paths`. Returns how many rows went.
pub fn remove_conflicts(conn: &Connection, paths: &[String]) -> Result<usize> {
    let mut removed = 0;
    for path in paths {
        removed += conn
            .execute("DELETE FROM vault_conflicts WHERE path = ?1", [path])
            .context("failed to remove a vault conflict")?;
    }
    Ok(removed)
}

/// What one check pass learned.
#[derive(Debug, Clone, Copy)]
pub struct CheckResult<'a> {
    /// The paths the helper answered for.
    pub checked: &'a BTreeSet<String>,
    /// Of those, the ones with conflict versions.
    pub found: &'a BTreeSet<String>,
    /// For a full pass, every note path of the space: a row of any other
    /// path goes, its note is gone.
    pub inventory: Option<&'a BTreeSet<String>>,
}

/// Apply one pass in one transaction (ВК6): a new conflict path is inserted
/// with `now`, a checked path without conflict goes, a path still in conflict
/// keeps its `detected_at`, and a full pass drops paths no longer in the
/// space. A path the helper did not answer for keeps its row. Returns whether
/// the set of conflict paths changed.
pub fn apply_check(conn: &Connection, result: CheckResult<'_>, now: &str) -> Result<bool> {
    let tx = conn
        .unchecked_transaction()
        .context("failed to begin a conflict check transaction")?;
    let before: BTreeSet<String> = list_conflict_paths(&tx)?.into_iter().collect();
    for path in result.checked {
        if result.found.contains(path) {
            tx.execute(
                "INSERT OR IGNORE INTO vault_conflicts (path, detected_at) VALUES (?1, ?2)",
                params![path, now],
            )
            .context("failed to record a vault conflict")?;
        } else {
            tx.execute("DELETE FROM vault_conflicts WHERE path = ?1", [path])
                .context("failed to clear a vault conflict")?;
        }
    }
    if let Some(inventory) = result.inventory {
        for path in before.iter().filter(|path| !inventory.contains(*path)) {
            tx.execute("DELETE FROM vault_conflicts WHERE path = ?1", [path])
                .context("failed to clear a vault conflict of a gone note")?;
        }
    }
    let after: BTreeSet<String> = list_conflict_paths(&tx)?.into_iter().collect();
    tx.commit()
        .context("failed to commit a conflict check transaction")?;
    Ok(before != after)
}

/// Retire the archive folder of the former resolution: its files go to the
/// Trash, where the person can see and restore them, and the folder goes
/// (ВК8). Returns how many entries went to the Trash. Nothing to do when the
/// folder is not there.
pub fn retire_conflicts_archive(derived_root: &Path) -> Result<usize> {
    let archive = derived_root.join(RETIRED_ARCHIVE_DIR);
    if !archive.is_dir() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(&archive)
        .with_context(|| format!("failed to read {}", archive.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<PathBuf>>>()
        .with_context(|| format!("failed to read {}", archive.display()))?;
    crate::storage::files::delete_user_files(&entries)
        .with_context(|| format!("failed to move {} to the Trash", archive.display()))?;
    std::fs::remove_dir(&archive)
        .with_context(|| format!("failed to remove {}", archive.display()))?;
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;

    fn set(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|path| (*path).to_string()).collect()
    }

    fn rows(conn: &Connection) -> Vec<(String, String)> {
        list_conflict_rows(conn)
            .unwrap()
            .into_iter()
            .map(|row| (row.path, row.detected_at))
            .collect()
    }

    /// ВК6: insert new, delete resolved, keep `detected_at` of a lasting one,
    /// keep a path the helper gave no answer for.
    #[test]
    fn a_pass_inserts_deletes_and_keeps_detected_at() {
        let conn = db::open_memory().unwrap();
        let first = apply_check(
            &conn,
            CheckResult {
                checked: &set(&["Cards/A.md", "Cards/B.md", "C.md"]),
                found: &set(&["Cards/A.md", "Cards/B.md"]),
                inventory: None,
            },
            "2026-10-11T09:00:00Z",
        )
        .unwrap();
        assert!(first);

        let second = apply_check(
            &conn,
            CheckResult {
                checked: &set(&["Cards/A.md", "Cards/B.md", "D.md"]),
                found: &set(&["Cards/A.md", "D.md"]),
                inventory: None,
            },
            "2026-10-11T10:00:00Z",
        )
        .unwrap();
        assert!(second);
        assert_eq!(
            rows(&conn),
            vec![
                ("D.md".to_string(), "2026-10-11T10:00:00Z".to_string()),
                ("Cards/A.md".to_string(), "2026-10-11T09:00:00Z".to_string()),
            ]
        );

        // The same answer again changes nothing; an unanswered path stays.
        let third = apply_check(
            &conn,
            CheckResult {
                checked: &set(&["Cards/A.md"]),
                found: &set(&["Cards/A.md"]),
                inventory: None,
            },
            "2026-10-11T11:00:00Z",
        )
        .unwrap();
        assert!(!third);
        assert_eq!(list_conflict_paths(&conn).unwrap(), vec!["D.md", "Cards/A.md"]);
    }

    /// ВК6: a full pass drops the rows of notes that are gone, but keeps a
    /// note of the space the helper did not answer for.
    #[test]
    fn a_full_pass_drops_paths_that_left_the_space() {
        let conn = db::open_memory().unwrap();
        apply_check(
            &conn,
            CheckResult {
                checked: &set(&["Gone.md", "Kept.md", "Unanswered.md"]),
                found: &set(&["Gone.md", "Kept.md", "Unanswered.md"]),
                inventory: None,
            },
            "2026-10-11T09:00:00Z",
        )
        .unwrap();

        let changed = apply_check(
            &conn,
            CheckResult {
                checked: &set(&["Kept.md"]),
                found: &set(&["Kept.md"]),
                inventory: Some(&set(&["Kept.md", "Unanswered.md"])),
            },
            "2026-10-11T10:00:00Z",
        )
        .unwrap();

        assert!(changed);
        assert_eq!(
            list_conflict_paths(&conn).unwrap(),
            vec!["Kept.md", "Unanswered.md"]
        );
        assert_eq!(
            conflict_detected_at(&conn, "Kept.md").unwrap().as_deref(),
            Some("2026-10-11T09:00:00Z")
        );
    }

    /// ВК8, ВК13: the archive of the former resolution goes to the Trash and
    /// the folder goes; a store without one is left alone.
    #[test]
    fn the_former_archive_goes_to_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join(RETIRED_ARCHIVE_DIR);
        std::fs::create_dir_all(&archive).unwrap();
        std::fs::write(archive.join("Note (archived 1).md"), "old").unwrap();
        std::fs::write(archive.join("Other (archived 2).md"), "older").unwrap();

        assert_eq!(retire_conflicts_archive(dir.path()).unwrap(), 2);
        assert!(!archive.exists());
        assert_eq!(retire_conflicts_archive(dir.path()).unwrap(), 0);
    }
}
