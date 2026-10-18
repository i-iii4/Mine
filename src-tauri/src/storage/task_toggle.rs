//! A task checkbox of a note toggled from the reading view
//! (SPEC_READING_MODE.md, Ч12.3).
//!
//! The note's file changes by one byte, the state character of one GFM task
//! (`domain::markdown::toggle_task_marker`); every other byte of the file
//! stays. The checks, the read and the checked publication are the steps
//! every write of a note's body shares (`storage::note_write`,
//! SPEC_EDITING.md, Л3.3): a file that holds anything else by the time the
//! new version would become visible is not overwritten, and the index takes
//! the written note in the same step.
//!
//! Nothing is read or written that would wait: a note whose contents are in
//! iCloud is asked for and refused at once, and a note Mine may not write is
//! refused before anything is staged.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::domain::block::{compute_body_hash, BlockType, ParsedMarkdownBlock};
use crate::domain::markdown::toggle_task_marker;
use crate::domain::vault::VaultLayout;
use crate::storage::index::IndexedBlock;
use crate::storage::note_write::{self, NoteWriteRefusal, ReadNote, WritableNote};
use crate::storage::thumbnails::ThumbSource;
use crate::storage::{index, thumbnails};

// What the tests below name from this module's scope.
#[cfg(test)]
use crate::domain::block::parse_markdown_document;
#[cfg(test)]
use crate::storage::note_write::hooks;
#[cfg(test)]
use crate::storage::source_mutation::SourceMutationError;
#[cfg(test)]
use crate::storage::cloud_files;
#[cfg(test)]
use std::io;
#[cfg(test)]
use std::path::{Path, PathBuf};

/// The index operation the write commits with.
const OPERATION: &str = "toggle_task_item";

/// What the reading view sends to toggle one task (Ч12.3).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ToggleTaskItemParams {
    /// The open card.
    pub source_slug: String,
    /// `body_hash` of the body the reader saw.
    pub source_body_hash: String,
    /// The byte offset in that body where the task's list item starts: its
    /// list marker, after `> ` in a quote or a callout.
    pub item_start: usize,
    /// The state the reader saw: `true` for a done task.
    pub checked: bool,
}

/// Why a task was not toggled (Ч12.3). Nothing was written in any case.
#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskToggleError {
    /// The tab shows no space.
    #[error("no space is open")]
    NoVault,
    /// The body is not the one the reader saw: the note changed after it
    /// was read.
    #[error("the body of '{source_slug}' changed after it was read; nothing was written")]
    StaleBody { source_slug: String },
    /// The note changed between Mine's read and the publication of the new
    /// version; the other version stays.
    #[error(
        "'{source_slug}' changed outside Mine while the task was written; nothing was overwritten"
    )]
    Changed { source_slug: String },
    /// No task in the state the reader saw starts at `item_start`.
    #[error("the task at offset {item_start} of '{source_slug}' changed: {reason}")]
    StateChanged {
        source_slug: String,
        item_start: usize,
        reason: String,
    },
    /// The note's contents are in iCloud: Mine asked iCloud to download them
    /// and did not wait.
    #[error("the contents of “{file_name}” are in iCloud; Mine asked iCloud to download them")]
    InCloud { file_name: String },
    /// Mine may not write the note or its folder.
    #[error("Mine may not write “{file_name}” or its folder")]
    ReadOnly { file_name: String },
    /// The note is not on disk.
    #[error("'{source_slug}' is not on disk")]
    SourceNotFound { source_slug: String },
    #[error("{message}")]
    Internal { message: String },
}

impl TaskToggleError {
    /// Any other failure, with every cause down to the reason the system gave.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal {
            message: format!("{error:#}"),
        }
    }

    /// What a refusal of the shared write steps tells the reader of `slug`.
    fn refused(refusal: NoteWriteRefusal, slug: &str) -> Self {
        match refusal {
            NoteWriteRefusal::SourceNotFound => Self::SourceNotFound {
                source_slug: slug.to_string(),
            },
            NoteWriteRefusal::InCloud { file_name } => Self::InCloud { file_name },
            NoteWriteRefusal::ReadOnly { file_name } => Self::ReadOnly { file_name },
            NoteWriteRefusal::Changed => Self::Changed {
                source_slug: slug.to_string(),
            },
            NoteWriteRefusal::Internal(message) => Self::Internal { message },
        }
    }
}

/// A toggled task: the card as the index holds it now, and which preview
/// the write baked.
#[derive(Debug)]
pub struct ToggledTask {
    pub block: IndexedBlock,
    pub thumb: ThumbSource,
}

/// Toggle the task `params` names in the note of the space `vault` and
/// index the written note through `conn` (Ч12.3).
///
/// The checks go from the cheapest, which read no contents: the note is on
/// disk, its contents are on this Mac, Mine may write it and its folder. Then
/// the note is read, its body must be the one the reader saw, and a task in
/// the state the reader saw must start at `item_start`. The publication is
/// refused when the file holds anything else by then.
///
/// # Errors
///
/// [`TaskToggleError`] says which check refused; nothing was written then.
pub fn toggle_task_item(
    conn: &Connection,
    vault: &VaultLayout,
    params: &ToggleTaskItemParams,
) -> Result<ToggledTask, TaskToggleError> {
    let slug = params.source_slug.as_str();
    let refused = |refusal| TaskToggleError::refused(refusal, slug);
    let note = note_write::writable_note(vault, slug).map_err(refused)?;
    let toggled = toggled_note(vault, &note, params)?;
    let published = note_write::publish_note(
        conn,
        vault,
        &note,
        toggled.read,
        toggled.toggled,
        &toggled.written,
        OPERATION,
    )
    .map_err(refused)?;
    let block = published.block;

    let thumb = thumbnails::generate_for_block(&block, vault);
    if let Err(error) = index::sync_thumb_metadata(
        conn,
        &block.slug,
        &vault.thumb_path(&block.slug),
        Some(vault.root()),
    ) {
        log::warn!(
            "task of '{}' written, its preview not recorded: {error:#}",
            block.slug
        );
    }
    Ok(ToggledTask {
        block: published.indexed,
        thumb,
    })
}

/// A note as read and with its task toggled.
struct ToggledNote {
    /// The note as read from the file: the write is refused unless the file
    /// still holds it.
    read: ReadNote,
    /// The same text with the one state byte changed.
    toggled: String,
    /// `toggled` read the way reconciliation reads the file.
    written: ParsedMarkdownBlock,
}

/// Read `note` and toggle the task `params` names in its body, when the body
/// is the one the reader saw.
fn toggled_note(
    vault: &VaultLayout,
    note: &WritableNote,
    params: &ToggleTaskItemParams,
) -> Result<ToggledNote, TaskToggleError> {
    let slug = params.source_slug.as_str();
    let read = note_write::read_note(vault, &note.path)
        .map_err(|refusal| TaskToggleError::refused(refusal, slug))?;
    if read.parsed.block.frontmatter.block_type == BlockType::Channel {
        // A collection page is no card: its row is a collection's, and the
        // reading view never shows it.
        return Err(TaskToggleError::internal(format!(
            "'{slug}' is a collection page, not a card"
        )));
    }
    let body = read.parsed.block.body.as_str();
    if compute_body_hash(body) != params.source_body_hash.trim() {
        return Err(TaskToggleError::StaleBody {
            source_slug: slug.to_string(),
        });
    }
    let toggled_body =
        toggle_task_marker(body, params.item_start, params.checked).map_err(|error| {
            TaskToggleError::StateChanged {
                source_slug: slug.to_string(),
                item_start: params.item_start,
                reason: error.to_string(),
            }
        })?;
    let body_start = read
        .body_start()
        .map_err(|refusal| TaskToggleError::refused(refusal, slug))?;
    let toggled = format!("{}{toggled_body}", &read.text[..body_start]);
    let written = read
        .read_back(&toggled)
        .map_err(|refusal| TaskToggleError::refused(refusal, slug))?;
    Ok(ToggledNote {
        read,
        toggled,
        written,
    })
}

/// What a refused source mutation tells the reader.
#[cfg(test)]
fn refusal(
    error: SourceMutationError,
    slug: &str,
    path: &Path,
    file_name: &str,
) -> TaskToggleError {
    TaskToggleError::refused(note_write::mutation_refusal(&error, path, file_name), slug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::DateTime;
    use crate::storage::db;
    use std::os::unix::fs::PermissionsExt;

    struct Space {
        _root: tempfile::TempDir,
        _derived: tempfile::TempDir,
        vault: VaultLayout,
        conn: Connection,
    }

    fn space() -> Space {
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(root.path().to_path_buf(), derived.path().to_path_buf());
        let conn = db::open_or_create(&vault.index_db_path()).unwrap();
        Space {
            _root: root,
            _derived: derived,
            vault,
            conn,
        }
    }

    /// Write `content` as the note `slug` and index it as reconciliation does.
    fn note(space: &Space, slug: &str, content: &str) -> PathBuf {
        let path = space.vault.block_path(slug);
        std::fs::write(&path, content).unwrap();
        let parsed = parse_markdown_document(
            slug,
            content,
            DateTime::new("2026-10-18T00:00:00Z").unwrap(),
        )
        .unwrap();
        index::upsert_block_with_diagnostics(
            &space.conn,
            &parsed.block,
            Some(space.vault.root()),
            Some(parsed.origin.as_str()),
            parsed.index_warning.as_deref(),
        )
        .unwrap();
        path
    }

    /// The body the index holds for `slug`.
    fn indexed_body(space: &Space, slug: &str) -> String {
        index::get_block(&space.conn, slug).unwrap().unwrap().body
    }

    fn params(slug: &str, body: &str, item_start: usize, checked: bool) -> ToggleTaskItemParams {
        ToggleTaskItemParams {
            source_slug: slug.to_string(),
            source_body_hash: compute_body_hash(body),
            item_start,
            checked,
        }
    }

    /// The offsets at which `after` differs from `before`.
    fn changed_bytes(before: &[u8], after: &[u8]) -> Vec<usize> {
        assert_eq!(before.len(), after.len());
        (0..before.len())
            .filter(|&i| before[i] != after[i])
            .collect()
    }

    /// The names in the folder of `path`.
    fn folder_names(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    const FRONTMATTER: &str = "---\ntype: article\nsaved_at: 2026-10-18T00:00:00Z\nMine Collections:\n  - \"[[Reading]]\"\n---\n";

    /// Ч12.2, Ч12.3: the file changes by exactly the state byte, CRLF and
    /// decomposed letters included; the index holds the new body and hash,
    /// and toggling back restores the file byte for byte.
    #[test]
    fn a_toggle_changes_one_byte_of_the_file_and_the_index_follows() {
        let space = space();
        let body = "Список и\u{0306}:\r\n- [ ] parent\r\n  - [x] child\r\n> - [ ] quoted\r\n";
        let content = format!("{FRONTMATTER}{body}");
        let path = note(&space, "Tasks", &content);
        let before = std::fs::read(&path).unwrap();
        let child = body.find("- [x]").unwrap();

        let toggled = toggle_task_item(
            &space.conn,
            &space.vault,
            &params("Tasks", body, child, true),
        )
        .unwrap();

        let after = std::fs::read(&path).unwrap();
        let state = FRONTMATTER.len() + child + 3;
        assert_eq!(changed_bytes(&before, &after), [state]);
        assert_eq!(after[state], b' ');
        let new_body = body.replacen("- [x] child", "- [ ] child", 1);
        assert_eq!(toggled.block.body, new_body);
        assert_eq!(
            toggled.block.body_hash.as_deref(),
            Some(compute_body_hash(&new_body).as_str())
        );
        assert_eq!(indexed_body(&space, "Tasks"), new_body);
        assert_eq!(toggled.thumb, ThumbSource::Text);
        assert_eq!(folder_names(&path), ["Tasks.md"]);

        toggle_task_item(
            &space.conn,
            &space.vault,
            &params("Tasks", &new_body, child, false),
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(indexed_body(&space, "Tasks"), body);
    }

    /// A plain Obsidian note, and one whose front matter does not parse, are
    /// read whole as the body: the offset counts from the start of the file.
    #[test]
    fn a_note_without_readable_front_matter_counts_from_the_start_of_the_file() {
        let space = space();
        for (slug, content) in [
            ("Plain", "# Plan\n\n1) [ ] first\n"),
            ("Malformed", "---\nnot: [yaml\n---\n1. [ ] first\n"),
        ] {
            let path = note(&space, slug, content);
            let item_start = content.rfind('1').unwrap();
            toggle_task_item(
                &space.conn,
                &space.vault,
                &params(slug, content, item_start, false),
            )
            .unwrap();
            let after = std::fs::read(&path).unwrap();
            assert_eq!(
                changed_bytes(content.as_bytes(), &after),
                [item_start + 4],
                "{slug}"
            );
            assert_eq!(after[item_start + 4], b'x', "{slug}");
        }
    }

    /// Ч12.3: a body other than the one the reader saw, a task in the other
    /// state and an offset that names no task change nothing.
    #[test]
    fn a_stale_body_or_task_writes_nothing() {
        let space = space();
        let body = "- [ ] open\n- [x] done\n";
        let path = note(&space, "Tasks", &format!("{FRONTMATTER}{body}"));
        let before = std::fs::read(&path).unwrap();
        let done = body.find("- [x]").unwrap();

        let mut stale = params("Tasks", body, 0, false);
        stale.source_body_hash = compute_body_hash("- [ ] open\n");
        let refusals = [
            (stale, "stale_body"),
            (params("Tasks", body, done, false), "state_changed"),
            (params("Tasks", body, 2, false), "state_changed"),
            (params("Tasks", body, body.len(), false), "state_changed"),
        ];
        for (request, kind) in refusals {
            let error = toggle_task_item(&space.conn, &space.vault, &request).unwrap_err();
            assert_eq!(
                serde_json::to_value(&error).unwrap()["kind"],
                kind,
                "{error}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(indexed_body(&space, "Tasks"), body);
        }
        let error = toggle_task_item(
            &space.conn,
            &space.vault,
            &params("Tasks", body, done, false),
        )
        .unwrap_err();
        let TaskToggleError::StateChanged {
            item_start, reason, ..
        } = error
        else {
            panic!("{error}");
        };
        assert_eq!(item_start, done);
        assert!(reason.contains("already done"), "{reason}");
    }

    /// Ч12.3: an edit that lands between Mine's read and the publication
    /// stays; nothing is overwritten and the index keeps the old body.
    #[test]
    fn an_edit_between_the_read_and_the_write_stays() {
        let space = space();
        let body = "- [ ] open\n";
        let path = note(&space, "Tasks", &format!("{FRONTMATTER}{body}"));
        let edited = format!("{FRONTMATTER}- [ ] open\n- [ ] added in Obsidian\n");
        let outside = edited.clone();
        hooks::after_next_read(move |path| std::fs::write(path, outside).unwrap());

        let error = toggle_task_item(&space.conn, &space.vault, &params("Tasks", body, 0, false))
            .unwrap_err();

        assert!(
            matches!(error, TaskToggleError::Changed { ref source_slug } if source_slug == "Tasks"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
        assert_eq!(indexed_body(&space, "Tasks"), body);
        assert_eq!(folder_names(&path), ["Tasks.md"]);
    }

    /// Ч12.3: a read-only file, a read-only folder and a file locked in
    /// Finder are refused before anything is staged; the file stays as it
    /// was and no temp file is left beside it.
    #[test]
    fn a_note_mine_may_not_write_is_refused_before_the_write() {
        let space = space();
        let body = "- [ ] open\n";
        let path = note(&space, "Tasks", &format!("{FRONTMATTER}{body}"));
        let before = std::fs::read(&path).unwrap();
        let folder = path.parent().unwrap().to_path_buf();
        let set_mode = |at: &Path, mode: u32| {
            std::fs::set_permissions(at, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        let set_lock = |flag: &str| {
            let status = std::process::Command::new("chflags")
                .arg(flag)
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success());
        };
        let attempt =
            || toggle_task_item(&space.conn, &space.vault, &params("Tasks", body, 0, false));

        set_mode(&path, 0o444);
        let read_only_file = attempt();
        set_mode(&path, 0o644);
        set_mode(&folder, 0o555);
        let read_only_folder = attempt();
        set_mode(&folder, 0o755);
        set_lock("uchg");
        let locked = attempt();
        set_lock("nouchg");

        for outcome in [read_only_file, read_only_folder, locked] {
            let error = outcome.unwrap_err();
            assert!(
                matches!(error, TaskToggleError::ReadOnly { ref file_name } if file_name == "Tasks.md"),
                "{error}"
            );
        }
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(folder_names(&path), ["Tasks.md"]);
        assert_eq!(indexed_body(&space, "Tasks"), body);
    }

    /// Ч12.3: a note whose contents are in iCloud is neither read nor
    /// waited for: Mine refuses at once with the file's name.
    #[test]
    fn a_note_in_icloud_is_refused_without_reading_it() {
        let space = space();
        let body = "- [ ] open\n";
        let path = note(&space, "Заметка", &format!("{FRONTMATTER}{body}"));
        let before = std::fs::read(&path).unwrap();
        cloud_files::test_seam::mark_offloaded(&path);

        let outcome = toggle_task_item(
            &space.conn,
            &space.vault,
            &params("Заметка", body, 0, false),
        );

        let reads = cloud_files::test_seam::reads_of(&path);
        cloud_files::test_seam::mark_downloaded(&path);
        let error = outcome.unwrap_err();
        assert!(
            matches!(error, TaskToggleError::InCloud { ref file_name } if file_name == "Заметка.md"),
            "{error}"
        );
        assert_eq!(reads, 0, "the evicted note was read");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    /// Ч12.3: a note that is gone is reported as gone, and a collection page
    /// is no card to toggle.
    #[test]
    fn a_missing_note_or_a_collection_page_writes_nothing() {
        let space = space();
        let error = toggle_task_item(
            &space.conn,
            &space.vault,
            &params("Gone", "- [ ] a\n", 0, false),
        )
        .unwrap_err();
        assert!(
            matches!(error, TaskToggleError::SourceNotFound { ref source_slug } if source_slug == "Gone"),
            "{error}"
        );

        let page = "---\ntype: channel\n---\n- [ ] a\n";
        let path = space.vault.block_path("Reading");
        std::fs::write(&path, page).unwrap();
        let error = toggle_task_item(
            &space.conn,
            &space.vault,
            &params("Reading", "- [ ] a\n", 0, false),
        )
        .unwrap_err();
        assert!(matches!(error, TaskToggleError::Internal { .. }), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), page);
    }

    /// Ч12.3: a refusal of the right to write met while staging or
    /// publishing, after the check before it passed, is `ReadOnly`; an
    /// outside edit is `Changed`; anything else stays `Internal`.
    #[test]
    fn a_refused_mutation_names_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Tasks.md");
        std::fs::write(&path, "- [ ] a\n").unwrap();
        let denied = || anyhow::Error::new(io::Error::from(io::ErrorKind::PermissionDenied));
        let kind = |error: SourceMutationError| {
            serde_json::to_value(refusal(error, "Tasks", &path, "Tasks.md")).unwrap()["kind"]
                .clone()
        };

        assert_eq!(
            kind(SourceMutationError::Stage {
                path: path.clone(),
                source: denied().context("create temp")
            }),
            "read_only"
        );
        assert_eq!(
            kind(SourceMutationError::CommitFile {
                path: path.clone(),
                source: anyhow::Error::new(io::Error::from(io::ErrorKind::ReadOnlyFilesystem)),
            }),
            "read_only"
        );
        assert_eq!(
            kind(SourceMutationError::Changed {
                path: path.clone(),
                preserved: None
            }),
            "changed"
        );
        assert_eq!(
            kind(SourceMutationError::Stage {
                path: path.clone(),
                source: anyhow::Error::new(io::Error::from(io::ErrorKind::StorageFull)),
            }),
            "internal"
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            kind(SourceMutationError::Stage {
                path: path.clone(),
                source: denied()
            }),
            "source_not_found"
        );
    }
}
