// Vault conflict resolution commands (Phase 18.G.4).
//
// Expose the `vault_conflicts` table built up by the watcher during
// iCloud sync-conflict detection (Phase 18.G.3) as IPC endpoints the
// frontend can list and resolve.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::commands::state::{tab_layout, read_owned_projection, AppState, CommandError};
use crate::domain::block::{parse_markdown_document, ParsedMarkdownBlock};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::source_mutation::{SourceFileWrite, StagedSourceMutation};
use crate::storage::{files, index};

const CONFLICT_MUTATION_WATCHER_SUPPRESSION_MS: u64 = 1500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConflictItem {
    pub base_slug: String,
    pub conflict_slug: String,
    pub detected_at: String,
}

impl From<index::VaultConflict> for VaultConflictItem {
    fn from(value: index::VaultConflict) -> Self {
        Self {
            base_slug: value.base_slug,
            conflict_slug: value.conflict_slug,
            detected_at: value.detected_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum ResolveAction {
    /// Keep the original `base_slug`. Delete the conflict file from
    /// disk; the DB row is cleared when the watcher observes the
    /// deletion plus when the command returns.
    KeepOriginal,
    /// Keep the conflict version. Archive the original base file into
    /// the local derived `conflicts-archive/` and rename the conflict
    /// file onto the base slug.
    KeepConflict,
    /// Dismiss the conflict without touching files. The user is
    /// expected to merge manually in Obsidian.
    DismissForManualMerge,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_vault_conflicts(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<VaultConflictItem>, CommandError> {
    let vault = tab_layout(&state, &webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let rows = read_owned_projection(&app, &vault, index::list_vault_conflicts)?;
        Ok(rows.into_iter().map(VaultConflictItem::from).collect())
    })
    .await
    .map_err(|error| CommandError::Internal(format!("conflict list task failed: {error}")))?
}

fn resolve_vault_conflict_unannounced(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    base_slug: String,
    conflict_slug: String,
    action: ResolveAction,
) -> Result<(), CommandError> {
    validate_slug(&base_slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    validate_slug(&conflict_slug).map_err(|e| CommandError::Internal(e.to_string()))?;

    let space = state.space_for(webview.label()).ok_or(CommandError::NoVault)?;
    let vault_state = space
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let resolution =
        ConflictResolution::plan(&vs.conn, &vs.vault, &base_slug, &conflict_slug, action)?;
    state.suppress_paths(
        [resolution.base_path.clone(), resolution.conflict_path.clone()],
        Duration::from_millis(CONFLICT_MUTATION_WATCHER_SUPPRESSION_MS),
    )?;
    resolution.apply(&vs.conn, &vs.vault)?;

    // Notify listeners so any open sidebar banner / dialog refreshes.
    let _ = crate::commands::space_events::emit_to_vault(&app, &vs.vault, 
        "vault-conflict-resolved",
        VaultConflictItem {
            base_slug: base_slug.clone(),
            conflict_slug: conflict_slug.clone(),
            detected_at: String::new(),
        },
    );

    Ok(())
}

/// [`resolve_vault_conflict_unannounced`], then the other tabs of the space hear of the
/// change (SPEC_TABS.md, В15).
#[tauri::command(rename_all = "snake_case")]
pub fn resolve_vault_conflict(webview: tauri::Webview, app: AppHandle, state: State<'_, AppState>, base_slug: String, conflict_slug: String, action: ResolveAction) -> Result<(), CommandError> {
    let announcing = webview.clone();
    let outcome = resolve_vault_conflict_unannounced(webview, app, state, base_slug, conflict_slug, action);
    if outcome.is_ok() {
        super::effects::space_changed_by_tab(&announcing, Vec::new());
    }
    outcome
}

/// The source writes and index changes of one chosen conflict version,
/// built from the files as they were read.
struct ConflictResolution {
    base_slug: String,
    conflict_slug: String,
    base_path: PathBuf,
    conflict_path: PathBuf,
    action: ResolveAction,
    writes: Vec<SourceFileWrite>,
    /// The conflict copy as the base note it becomes, for `KeepConflict`.
    promoted: Option<ParsedMarkdownBlock>,
}

impl ConflictResolution {
    /// Read the files the chosen version touches and plan the writes.
    fn plan(
        conn: &Connection,
        vault: &VaultLayout,
        base_slug: &str,
        conflict_slug: &str,
        action: ResolveAction,
    ) -> Result<Self, CommandError> {
        let conflict_exists = index::vault_conflict_exists(conn, base_slug, conflict_slug)
            .map_err(|e| CommandError::Internal(format!("vault_conflict_exists failed: {e:#}")))?;
        if !conflict_exists {
            return Err(CommandError::Internal(format!(
                "vault conflict is no longer pending: {base_slug} / {conflict_slug}"
            )));
        }

        let base_path: PathBuf = vault.root().join(format!("{base_slug}.md"));
        let conflict_path: PathBuf = vault.root().join(format!("{conflict_slug}.md"));

        let mut writes = Vec::new();
        let mut promoted = None;
        // The conflict copy goes to the Trash only as it was read here: a
        // version iCloud or an editor writes meanwhile stays, and the
        // resolution refuses (`SPEC_AUDIT_FIXES.md`, Ф2, Г1.8).
        match &action {
            ResolveAction::KeepOriginal => match std::fs::read(&conflict_path) {
                Ok(read) => writes.push(SourceFileWrite::delete_if_unchanged(
                    conflict_path.clone(),
                    read,
                )),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(CommandError::Internal(format!(
                        "failed to read conflict copy {}: {error}",
                        conflict_path.display()
                    )))
                }
            },
            ResolveAction::KeepConflict => {
                if !conflict_path.exists() {
                    return Err(CommandError::Internal(format!(
                        "conflict file no longer exists: {}",
                        conflict_path.display()
                    )));
                }

                let (_, conflict_content) = files::read_block_file(vault, &conflict_path)?;
                promoted = Some(
                    parse_markdown_document(
                        base_slug,
                        &conflict_content,
                        file_saved_at(&conflict_path),
                    )
                    .map_err(|error| CommandError::Internal(error.to_string()))?,
                );
                if base_path.exists() {
                    let archive_path = vault
                        .derived_root()
                        .join("conflicts-archive")
                        .join(archive_filename(base_slug));
                    let base_content = std::fs::read(&base_path).map_err(|error| {
                        CommandError::Internal(format!(
                            "failed to read conflict base {}: {error}",
                            base_path.display()
                        ))
                    })?;
                    let conflict_bytes = conflict_content.into_bytes();
                    writes.push(SourceFileWrite::create(archive_path, base_content.clone()));
                    writes.push(SourceFileWrite::replace(
                        base_path.clone(),
                        base_content,
                        conflict_bytes.clone(),
                    ));
                    writes.push(SourceFileWrite::delete_if_unchanged(
                        conflict_path.clone(),
                        conflict_bytes,
                    ));
                } else {
                    // The conflict copy becomes the note as it is.
                    writes.push(SourceFileWrite::rename(
                        conflict_path.clone(),
                        base_path.clone(),
                    ));
                }
            }
            ResolveAction::DismissForManualMerge => {
                // User will reconcile in Obsidian. We only clear the DB
                // surface so Mine stops showing the banner; files on disk
                // remain in place.
            }
        }
        Ok(Self {
            base_slug: base_slug.to_string(),
            conflict_slug: conflict_slug.to_string(),
            base_path,
            conflict_path,
            action,
            writes,
            promoted,
        })
    }

    /// Publish the writes and the index changes as one operation.
    fn apply(self, conn: &Connection, vault: &VaultLayout) -> Result<(), CommandError> {
        let Self {
            base_slug,
            conflict_slug,
            action,
            writes,
            promoted,
            ..
        } = self;
        StagedSourceMutation::stage(writes)?.commit_with_index(
            conn,
            "resolve_vault_conflict",
            |index_conn| {
                match action {
                    ResolveAction::KeepOriginal => {
                        index::remove_block(index_conn, &conflict_slug)?;
                    }
                    ResolveAction::KeepConflict => {
                        let promoted = promoted.as_ref().ok_or_else(|| {
                            anyhow::anyhow!("promoted conflict projection missing")
                        })?;
                        index::upsert_block_with_diagnostics(
                            index_conn,
                            &promoted.block,
                            Some(vault.root()),
                            Some(promoted.origin.as_str()),
                            promoted.index_warning.as_deref(),
                        )?;
                        index::remove_block(index_conn, &conflict_slug)?;
                    }
                    ResolveAction::DismissForManualMerge => {}
                }
                index::clear_vault_conflict(index_conn, &base_slug, &conflict_slug)?;
                Ok(())
            },
        )?;
        Ok(())
    }
}

/// Build an archive filename for a retired base block. Appends an
/// ISO-8601 timestamp suffix so multiple resolutions don't collide.
fn archive_filename(base_slug: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{base_slug} (archived {ts}).md")
}

fn file_saved_at(path: &std::path::Path) -> crate::domain::block::DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    crate::domain::block::DateTime::new(&crate::util::system_time_to_iso8601(time))
        .unwrap_or_else(|_| crate::domain::block::DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;

    const BASE: &str = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nThe original";
    const CONFLICT: &str = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nThe conflict copy";
    const EDITED: &str = "---\nsaved_at: 2026-07-10T00:00:00Z\n---\nThe conflict copy, edited meanwhile";

    /// A space with a base note and its iCloud conflict copy, both indexed
    /// and the conflict pending.
    fn space_with_conflict() -> (tempfile::TempDir, VaultLayout, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        for (slug, source) in [("Note", BASE), ("Note 2", CONFLICT)] {
            let path = vault.block_path(slug);
            std::fs::write(&path, source).unwrap();
            let parsed = parse_markdown_document(slug, source, file_saved_at(&path)).unwrap();
            index::upsert_block(&conn, &parsed.block, Some(vault.root())).unwrap();
        }
        index::record_vault_conflict(&conn, "Note", "Note 2").unwrap();
        (dir, vault, conn)
    }

    /// Г1.8: the conflict copy is edited after the resolution read it. The
    /// edit is not deleted: the resolution refuses and both files stay.
    #[test]
    fn keeping_the_conflict_refuses_when_the_copy_changed_after_it_was_read() {
        let (_dir, vault, conn) = space_with_conflict();
        let resolution =
            ConflictResolution::plan(&conn, &vault, "Note", "Note 2", ResolveAction::KeepConflict)
                .unwrap();
        std::fs::write(vault.block_path("Note 2"), EDITED).unwrap();

        let refused = resolution.apply(&conn, &vault);

        assert!(matches!(refused, Err(CommandError::SourceChanged { .. })), "{refused:?}");
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), BASE);
        assert_eq!(std::fs::read_to_string(vault.block_path("Note 2")).unwrap(), EDITED);
        assert_eq!(space_entries(&vault), vec!["Note 2.md", "Note.md"]);
        let archive = vault.derived_root().join("conflicts-archive");
        assert!(!archive.exists() || std::fs::read_dir(archive).unwrap().next().is_none());
        assert!(index::vault_conflict_exists(&conn, "Note", "Note 2").unwrap());
    }

    /// Г1.8: keeping the original deletes the copy only as it was read.
    #[test]
    fn keeping_the_original_refuses_when_the_copy_changed_after_it_was_read() {
        let (_dir, vault, conn) = space_with_conflict();
        let resolution =
            ConflictResolution::plan(&conn, &vault, "Note", "Note 2", ResolveAction::KeepOriginal)
                .unwrap();
        std::fs::write(vault.block_path("Note 2"), EDITED).unwrap();

        let refused = resolution.apply(&conn, &vault);

        assert!(matches!(refused, Err(CommandError::SourceChanged { .. })), "{refused:?}");
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), BASE);
        assert_eq!(std::fs::read_to_string(vault.block_path("Note 2")).unwrap(), EDITED);
        assert_eq!(space_entries(&vault), vec!["Note 2.md", "Note.md"]);
        assert!(index::vault_conflict_exists(&conn, "Note", "Note 2").unwrap());
    }

    /// Every entry of the space folder, hidden ones included, sorted.
    fn space_entries(vault: &VaultLayout) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(vault.root())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn keeping_the_conflict_promotes_the_copy_it_read() {
        let (_dir, vault, conn) = space_with_conflict();

        ConflictResolution::plan(&conn, &vault, "Note", "Note 2", ResolveAction::KeepConflict)
            .unwrap()
            .apply(&conn, &vault)
            .unwrap();

        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), CONFLICT);
        assert!(!vault.block_path("Note 2").exists());
        assert!(!index::vault_conflict_exists(&conn, "Note", "Note 2").unwrap());
        assert!(index::get_block(&conn, "Note 2").unwrap().is_none());
    }

    #[test]
    fn archive_filename_is_unique_per_second() {
        let a = archive_filename("Note");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b = archive_filename("Note");
        assert_ne!(a, b);
        assert!(a.starts_with("Note (archived "));
        assert!(a.ends_with(").md"));
    }
}
