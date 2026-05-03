// Vault conflict resolution commands (Phase 18.G.4).
//
// Expose the `vault_conflicts` table built up by the watcher during
// iCloud sync-conflict detection (Phase 18.G.3) as IPC endpoints the
// frontend can list and resolve.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

use crate::commands::state::{AppState, CommandError};
use crate::domain::vault::validate_slug;
use crate::storage::index;
use crate::watcher::handler;

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
    /// `.arena/conflicts-archive/` and rename the conflict file onto
    /// the base slug.
    KeepConflict,
    /// Dismiss the conflict without touching files. The user is
    /// expected to merge manually in Obsidian.
    DismissForManualMerge,
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_vault_conflicts(
    state: State<'_, AppState>,
) -> Result<Vec<VaultConflictItem>, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;

    let rows = index::list_vault_conflicts(&vs.conn)
        .map_err(|e| CommandError::Internal(format!("list_vault_conflicts failed: {e:#}")))?;
    Ok(rows.into_iter().map(VaultConflictItem::from).collect())
}

#[tauri::command(rename_all = "snake_case")]
pub fn resolve_vault_conflict(
    app: AppHandle,
    state: State<'_, AppState>,
    base_slug: String,
    conflict_slug: String,
    action: ResolveAction,
) -> Result<(), CommandError> {
    validate_slug(&base_slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    validate_slug(&conflict_slug).map_err(|e| CommandError::Internal(e.to_string()))?;

    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    let vault_root = vs.vault.root().to_path_buf();
    let derived_arena = vs.vault.derived_root().to_path_buf();

    let conflict_exists = index::vault_conflict_exists(&vs.conn, &base_slug, &conflict_slug)
        .map_err(|e| CommandError::Internal(format!("vault_conflict_exists failed: {e:#}")))?;
    if !conflict_exists {
        return Err(CommandError::Internal(format!(
            "vault conflict is no longer pending: {base_slug} / {conflict_slug}"
        )));
    }

    let base_path: PathBuf = vault_root.join(format!("{base_slug}.md"));
    let conflict_path: PathBuf = vault_root.join(format!("{conflict_slug}.md"));

    match action {
        ResolveAction::KeepOriginal => {
            if conflict_path.exists() {
                std::fs::remove_file(&conflict_path).map_err(|e| {
                    CommandError::Internal(format!(
                        "failed to delete conflict file {}: {e}",
                        conflict_path.display()
                    ))
                })?;
            }
        }
        ResolveAction::KeepConflict => {
            if !conflict_path.exists() {
                return Err(CommandError::Internal(format!(
                    "conflict file no longer exists: {}",
                    conflict_path.display()
                )));
            }

            if base_path.exists() {
                let archive_dir = derived_arena.join("conflicts-archive");
                std::fs::create_dir_all(&archive_dir).map_err(|e| {
                    CommandError::Internal(format!(
                        "failed to create archive dir {}: {e}",
                        archive_dir.display()
                    ))
                })?;
                let archive_name = archive_filename(&base_slug);
                let archive_path = archive_dir.join(archive_name);
                std::fs::rename(&base_path, &archive_path).map_err(|e| {
                    CommandError::Internal(format!(
                        "failed to archive original {}: {e}",
                        base_path.display()
                    ))
                })?;
            }

            std::fs::rename(&conflict_path, &base_path).map_err(|e| {
                CommandError::Internal(format!(
                    "failed to promote conflict file to {}: {e}",
                    base_path.display()
                ))
            })?;

            // Re-index the promoted file so the block picks up the new
            // body without waiting for the watcher.
            let _ = handler::index_md_file(&vs.conn, &vs.vault, &base_path, Some(&app));
        }
        ResolveAction::DismissForManualMerge => {
            // User will reconcile in Obsidian. We only clear the DB
            // surface so Mine stops showing the banner; files on disk
            // remain in place.
        }
    }

    index::clear_vault_conflict(&vs.conn, &base_slug, &conflict_slug)
        .map_err(|e| CommandError::Internal(format!("clear_vault_conflict failed: {e:#}")))?;

    // Notify listeners so any open sidebar banner / dialog refreshes.
    let _ = app.emit(
        "vault-conflict-resolved",
        VaultConflictItem {
            base_slug: base_slug.clone(),
            conflict_slug: conflict_slug.clone(),
            detected_at: String::new(),
        },
    );

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

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
