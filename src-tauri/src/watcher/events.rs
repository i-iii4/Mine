// Events: vault file system event classification.
//
// Converts raw notify events into typed VaultEvents.
// Filters out .arena/ directory and non-file events.
//
// Contract: SPEC_INTEGRATION.md#watcher/events

use crate::domain::vault::VaultLayout;
use crate::storage::files;
use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::EventKind;
use std::path::{Path, PathBuf};

// ─── Types ──────────────────────────────────────────────────────────────────

/// A classified file system event within the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultEvent {
    /// A .md block file was created or modified.
    BlockChanged(PathBuf),
    /// A .md block file was deleted.
    BlockDeleted(PathBuf),
    /// A media file was created or modified.
    MediaChanged(PathBuf),
    /// A media file was deleted.
    MediaDeleted(PathBuf),
}

impl VaultEvent {
    pub fn path(&self) -> &Path {
        match self {
            Self::BlockChanged(path)
            | Self::BlockDeleted(path)
            | Self::MediaChanged(path)
            | Self::MediaDeleted(path) => path.as_path(),
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Classify a raw notify event into zero or more VaultEvents.
///
/// - Ignores paths inside hidden/service directories
/// - Ignores directories
/// - `.md` files produce Block events
/// - Other files produce Media events
/// - Create/Modify → Changed, Remove → Deleted
pub fn classify_notify_event(event: &notify::Event, vault: &VaultLayout) -> Vec<VaultEvent> {
    let mut result = Vec::new();

    let is_change = matches!(
        event.kind,
        EventKind::Create(CreateKind::File)
            | EventKind::Create(CreateKind::Any)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Any)
    );
    let is_delete = matches!(
        event.kind,
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Any)
    );

    if !is_change && !is_delete {
        return result;
    }

    for path in &event.paths {
        if !is_in_vault(path, vault.root()) {
            continue;
        }

        let is_md = path.extension().and_then(|e| e.to_str()) == Some("md");

        let event = if is_md {
            if is_change {
                VaultEvent::BlockChanged(path.clone())
            } else {
                VaultEvent::BlockDeleted(path.clone())
            }
        } else if is_change {
            VaultEvent::MediaChanged(path.clone())
        } else {
            VaultEvent::MediaDeleted(path.clone())
        };

        result.push(event);
    }

    result
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Check that a path is inside the vault and outside ignored service dirs.
fn is_in_vault(path: &Path, root: &Path) -> bool {
    if !path.starts_with(root) {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    for ancestor in relative.ancestors().skip(1) {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        if files::is_ignored_vault_dir(ancestor) {
            return false;
        }
    }
    relative
        .parent()
        .map(|parent| {
            parent.components().all(|component| match component {
                std::path::Component::Normal(part) => !part.to_str().is_some_and(|name| {
                    name.starts_with('.')
                        || matches!(name, "node_modules" | "target" | "__pycache__")
                }),
                _ => true,
            })
        })
        .unwrap_or(true)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};

    fn vault() -> VaultLayout {
        VaultLayout::new(PathBuf::from("/vault"))
    }

    fn make_event(kind: EventKind, paths: Vec<PathBuf>) -> notify::Event {
        notify::Event {
            kind,
            paths,
            attrs: Default::default(),
        }
    }

    // ── BlockChanged ─────────────────────────────────────────────────────

    #[test]
    fn md_create_produces_block_changed() {
        let event = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/vault/note.md")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(
            result,
            vec![VaultEvent::BlockChanged(PathBuf::from("/vault/note.md"))]
        );
    }

    #[test]
    fn md_modify_produces_block_changed() {
        let event = make_event(
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            vec![PathBuf::from("/vault/note.md")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(
            result,
            vec![VaultEvent::BlockChanged(PathBuf::from("/vault/note.md"))]
        );
    }

    // ── BlockDeleted ─────────────────────────────────────────────────────

    #[test]
    fn md_remove_produces_block_deleted() {
        let event = make_event(
            EventKind::Remove(RemoveKind::File),
            vec![PathBuf::from("/vault/note.md")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(
            result,
            vec![VaultEvent::BlockDeleted(PathBuf::from("/vault/note.md"))]
        );
    }

    // ── MediaChanged / MediaDeleted ──────────────────────────────────────

    #[test]
    fn image_create_produces_media_changed() {
        let event = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/vault/photo.jpg")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(
            result,
            vec![VaultEvent::MediaChanged(PathBuf::from("/vault/photo.jpg"))]
        );
    }

    #[test]
    fn image_remove_produces_media_deleted() {
        let event = make_event(
            EventKind::Remove(RemoveKind::File),
            vec![PathBuf::from("/vault/photo.jpg")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(
            result,
            vec![VaultEvent::MediaDeleted(PathBuf::from("/vault/photo.jpg"))]
        );
    }

    // ── Filtering ────────────────────────────────────────────────────────

    #[test]
    fn arena_dir_ignored() {
        let event = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/vault/.arena/index.db")],
        );
        let result = classify_notify_event(&event, &vault());
        assert!(result.is_empty());
    }

    #[test]
    fn subdirectory_markdown_is_indexed() {
        let event = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/vault/subdir/note.md")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(
            result,
            vec![VaultEvent::BlockChanged(PathBuf::from(
                "/vault/subdir/note.md"
            ))]
        );
    }

    #[test]
    fn unrelated_event_kinds_ignored() {
        let event = make_event(
            EventKind::Access(notify::event::AccessKind::Read),
            vec![PathBuf::from("/vault/note.md")],
        );
        let result = classify_notify_event(&event, &vault());
        assert!(result.is_empty());
    }

    #[test]
    fn multiple_paths_in_one_event() {
        let event = make_event(
            EventKind::Create(CreateKind::File),
            vec![PathBuf::from("/vault/a.md"), PathBuf::from("/vault/b.jpg")],
        );
        let result = classify_notify_event(&event, &vault());
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0],
            VaultEvent::BlockChanged(PathBuf::from("/vault/a.md"))
        );
        assert_eq!(
            result[1],
            VaultEvent::MediaChanged(PathBuf::from("/vault/b.jpg"))
        );
    }
}
