//! The body of a note saved from the editor of the open card
//! (SPEC_EDITING.md, Л2, Л3.3, Л3.4), the entry into editing (Л2.8) and the
//! body on disk an edit session compares with (Л4.1).
//!
//! The editor's document is the body: the end of the file after the front
//! matter, or the whole file when there is none or it does not parse. A save
//! writes the start of the file as it lies on disk at the moment of the
//! write, then the document, and nothing else: no line break is added or
//! taken away, no whitespace, Unicode form or line separator changes. The
//! properties never pass through the editor, so an action of Mine on them
//! during an edit session neither blocks nor is overwritten by the next save
//! (Л2.3). The checks, the read and the checked publication are the ones the
//! task checkbox uses (`storage::note_write`).

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::domain::block::{compute_body_hash, BlockType, ParsedMarkdownBlock};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::index::IndexedBlock;
use crate::storage::note_write::{self, NoteWriteRefusal, ReadNote};
use crate::storage::thumbnails::{self, ThumbSource};
use crate::storage::{cloud_files, index};

/// The index operation a save commits with.
const OPERATION: &str = "save_note_body";

/// What the editor sends to save the body of its note (Л3.3).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SaveNoteBodyParams {
    /// The note being edited.
    pub source_slug: String,
    /// `body_hash` of the body the unsaved edits started from: the base.
    pub base_body_hash: String,
    /// The new body, byte for byte: the document as `sliceDoc()` gives it,
    /// with the byte order mark back in front when the body had one (Л0.3,
    /// Л0.4).
    pub body: String,
}

/// A saved body (Л3.3).
#[derive(Debug, Serialize, specta::Type)]
pub struct SavedNoteBody {
    /// The card as the index holds it now: the new `body_hash` is the next
    /// base, `display_title` follows the first H1 (Л2.2).
    pub block: IndexedBlock,
    /// The written file divides into front matter and body differently from
    /// before (Л2.4): the editor takes `block.body` as its document.
    pub split_changed: bool,
    /// The file already held this body: nothing was written.
    pub unchanged: bool,
}

/// The body of a note as it is on disk (Л4.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct NoteBodyState {
    pub body_hash: String,
    pub body: String,
}

/// Why a body was not saved (Л3.3). Nothing was written in any case.
#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteSaveError {
    /// The tab shows no space.
    #[error("no space is open")]
    NoVault,
    /// The body on disk is not the base of the edits: the note changed
    /// outside this session (Л4.3). The body on disk and its hash come back.
    #[error("the body of '{source_slug}' on disk is not the one the edits started from; nothing was written")]
    StaleBody {
        source_slug: String,
        disk_body: String,
        disk_body_hash: String,
    },
    /// The note changed between Mine's read and the publication of the new
    /// version; the other version stays.
    #[error("'{source_slug}' changed outside Mine while it was saved; nothing was overwritten")]
    Changed { source_slug: String },
    /// The note's contents are in iCloud: Mine asked iCloud to download them
    /// and did not wait.
    #[error("the contents of “{file_name}” are in iCloud; Mine asked iCloud to download them")]
    InCloud { file_name: String },
    /// Mine may not write the note or its folder: no permission, a file
    /// locked in Finder, a read-only volume.
    #[error("Mine may not write “{file_name}” or its folder")]
    ReadOnly { file_name: String },
    /// The note is not on disk.
    #[error("'{source_slug}' is not on disk")]
    SourceNotFound { source_slug: String },
    /// The note is a collection page, or the new body would make it one
    /// (Л2.5).
    #[error("'{source_slug}' is a collection page, not a card")]
    NotACard { source_slug: String },
    #[error("{message}")]
    Internal { message: String },
}

impl NoteSaveError {
    /// Any other failure, with every cause down to the reason the system gave.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal {
            message: format!("{error:#}"),
        }
    }

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

    fn not_a_card(slug: &str) -> Self {
        Self::NotACard {
            source_slug: slug.to_string(),
        }
    }
}

/// Why editing does not begin, or the body on disk cannot be given (Л2.8,
/// Л4.1).
#[derive(Debug, Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteEditError {
    /// The tab shows no space.
    #[error("no space is open")]
    NoVault,
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
    /// The note is a collection page: the editor does not open it (Л2.5).
    #[error("'{source_slug}' is a collection page, not a card")]
    NotACard { source_slug: String },
    #[error("{message}")]
    Internal { message: String },
}

impl NoteEditError {
    /// Any other failure, with every cause down to the reason the system gave.
    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal {
            message: format!("{error:#}"),
        }
    }

    fn refused(refusal: NoteWriteRefusal, slug: &str) -> Self {
        match refusal {
            NoteWriteRefusal::SourceNotFound => Self::SourceNotFound {
                source_slug: slug.to_string(),
            },
            NoteWriteRefusal::InCloud { file_name } => Self::InCloud { file_name },
            NoteWriteRefusal::ReadOnly { file_name } => Self::ReadOnly { file_name },
            // A read publishes nothing, so nothing can change under it.
            NoteWriteRefusal::Changed => Self::internal(format!(
                "'{slug}' changed outside Mine while it was read"
            )),
            NoteWriteRefusal::Internal(message) => Self::Internal { message },
        }
    }

    fn not_a_card(slug: &str) -> Self {
        Self::NotACard {
            source_slug: slug.to_string(),
        }
    }
}

/// Save `params.body` as the body of its note in the space `vault` and index
/// the written note through `conn` (Л3.3).
///
/// The checks that read no contents come first (step 1); then the note is
/// read, a collection page is refused and the body on disk must be the base
/// (step 2). The new file is the start of the file as it is now and the new
/// body (step 3); a file that already holds it is not written (step 4). The
/// publication is refused when the file holds anything else by then
/// (step 6), and it is marked as Mine's own for the watcher (step 7). The
/// preview is not made here (step 8).
///
/// # Errors
///
/// [`NoteSaveError`] says which check refused; nothing was written then.
pub fn save_note_body(
    conn: &Connection,
    vault: &VaultLayout,
    params: &SaveNoteBodyParams,
) -> Result<SavedNoteBody, NoteSaveError> {
    let slug = params.source_slug.as_str();
    let refused = |refusal| NoteSaveError::refused(refusal, slug);
    let note = note_write::writable_note(vault, slug).map_err(refused)?;
    let read = note_write::read_note(vault, &note.path).map_err(refused)?;
    if is_collection_page(&read.parsed) {
        return Err(NoteSaveError::not_a_card(slug));
    }
    let disk_body = read.parsed.block.body.as_str();
    let disk_body_hash = compute_body_hash(disk_body);
    if disk_body_hash != params.base_body_hash.trim() {
        return Err(NoteSaveError::StaleBody {
            source_slug: slug.to_string(),
            disk_body: disk_body.to_string(),
            disk_body_hash,
        });
    }
    let body_start = read.body_start().map_err(refused)?;
    let written_text = new_file_text(&read.text, body_start, &params.body);
    if written_text == read.text {
        let block = current_row(conn, vault, &read).map_err(refused)?;
        return Ok(SavedNoteBody {
            block,
            split_changed: false,
            unchanged: true,
        });
    }
    let written = read.read_back(&written_text).map_err(refused)?;
    if is_collection_page(&written) {
        return Err(NoteSaveError::not_a_card(slug));
    }
    let split_changed = written.block.body != params.body;
    let published =
        note_write::publish_note(conn, vault, &note, read, written_text, &written, OPERATION)
            .map_err(refused)?;
    Ok(SavedNoteBody {
        block: published.indexed,
        split_changed,
        unchanged: false,
    })
}

/// The card `slug` for the editor to begin with (Л2.8): the checks the
/// task checkbox makes, without reading contents, then the note as it is on
/// disk. An index row behind the file catches up with it, so the card's
/// `body_hash` is the one a save compares with.
///
/// # Errors
///
/// [`NoteEditError`]: the note is gone, in iCloud, read-only or a collection
/// page, or cannot be read.
pub fn begin_note_edit(
    conn: &Connection,
    vault: &VaultLayout,
    slug: &str,
) -> Result<IndexedBlock, NoteEditError> {
    let refused = |refusal| NoteEditError::refused(refusal, slug);
    let note = note_write::writable_note(vault, slug).map_err(refused)?;
    let read = note_write::read_note(vault, &note.path).map_err(refused)?;
    if is_collection_page(&read.parsed) {
        return Err(NoteEditError::not_a_card(slug));
    }
    current_row(conn, vault, &read).map_err(refused)
}

/// The body of the note `slug` as it is on disk and its hash (Л4.1). A note
/// in iCloud is asked for and refused, not waited for.
///
/// # Errors
///
/// [`NoteEditError`] other than `ReadOnly`: the note is gone, in iCloud or a
/// collection page, or cannot be read.
pub fn note_body_state(vault: &VaultLayout, slug: &str) -> Result<NoteBodyState, NoteEditError> {
    let refused = |refusal| NoteEditError::refused(refusal, slug);
    let path = note_write::local_note(vault, slug).map_err(refused)?;
    let read = note_write::read_note(vault, &path).map_err(refused)?;
    if is_collection_page(&read.parsed) {
        return Err(NoteEditError::not_a_card(slug));
    }
    let body = read.parsed.block.body;
    Ok(NoteBodyState {
        body_hash: compute_body_hash(&body),
        body,
    })
}

/// The hash of the body of the note `slug` on disk, for `note-changed`
/// (Л4.1): `None` when the note is gone, its contents are in iCloud (they
/// are neither read nor asked for), it cannot be read or it is a collection
/// page.
pub fn current_body_hash(vault: &VaultLayout, slug: &str) -> Option<String> {
    validate_slug(slug).ok()?;
    let path = vault.block_path(slug);
    if !path.is_file() || cloud_files::is_content_offloaded(&path) {
        return None;
    }
    let read = note_write::read_note(vault, &path).ok()?;
    (!is_collection_page(&read.parsed)).then(|| compute_body_hash(&read.parsed.block.body))
}

/// Make the preview of the card `slug` from its index row (Л3.3 step 8):
/// the deferred task after the last save of an edit session. A preview that
/// is already fresh is kept. `None` when the card is no longer indexed.
///
/// # Errors
///
/// When the index cannot be read or holds a row that does not read back.
pub fn generate_note_preview(
    conn: &Connection,
    vault: &VaultLayout,
    slug: &str,
) -> anyhow::Result<Option<ThumbSource>> {
    let Some(row) = index::get_block(conn, slug)? else {
        return Ok(None);
    };
    let block = row.to_domain_block()?;
    let thumb_path = vault.thumb_path(slug);
    let thumb = if thumbnails::is_thumb_fresh(&thumb_path, &vault.block_path(slug), &block, vault) {
        ThumbSource::None
    } else {
        thumbnails::generate_for_block(&block, vault)
    };
    if let Err(error) = index::sync_thumb_metadata(conn, slug, &thumb_path, Some(vault.root())) {
        log::warn!("preview of '{slug}' made, not recorded: {error:#}");
    }
    Ok(Some(thumb))
}

/// The new file: the start of the file as it is now, then `body` (Л2.3,
/// Л3.3 step 3). A file that ends on its closing fence without a line break
/// takes one before a body that is not empty: without it the first line of
/// the body would join the fence, and the properties would become body.
fn new_file_text(read: &str, body_start: usize, body: &str) -> String {
    let start = &read[..body_start];
    let separator = fence_line_break(start, body);
    let mut text = String::with_capacity(start.len() + separator.len() + body.len());
    text.push_str(start);
    text.push_str(separator);
    text.push_str(body);
    text
}

/// The line break that ends the closing fence when `start`, the front matter,
/// ends on it without one and `body` is not empty: `\r\n` when the lines of
/// the properties end so, `\n` otherwise. Nothing in every other case: a
/// start that is empty (no front matter) or already ends a line.
fn fence_line_break(start: &str, body: &str) -> &'static str {
    if body.is_empty() || start.is_empty() || start.ends_with('\n') {
        return "";
    }
    if !start.ends_with('\r') && start.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// The index row of the note `read`, caught up with the file when it lags
/// behind it.
fn current_row(
    conn: &Connection,
    vault: &VaultLayout,
    read: &ReadNote,
) -> Result<IndexedBlock, NoteWriteRefusal> {
    let slug = read.parsed.block.slug.as_str();
    let disk_hash = compute_body_hash(&read.parsed.block.body);
    let row = index::get_block(conn, slug).map_err(NoteWriteRefusal::internal)?;
    match row {
        Some(row) if row.body_hash.as_deref() == Some(disk_hash.as_str()) => Ok(row),
        _ => note_write::index_read_note(conn, vault, read),
    }
}

/// Whether the parse is a collection page, which is no card (Л2.5).
fn is_collection_page(parsed: &ParsedMarkdownBlock) -> bool {
    parsed.block.frontmatter.block_type == BlockType::Channel
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{parse_markdown_document, DateTime};
    use crate::storage::db;
    use crate::storage::note_write::hooks;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    /// The fixture of the reading view (Л17): every construct the editor
    /// shows.
    const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/fixtures/reading-mode.md"));

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

    /// Write `content` as the note `slug` and index it as reconciliation
    /// does.
    fn note(space: &Space, slug: &str, content: &str) -> PathBuf {
        let path = space.vault.block_path(slug);
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::fs::write(&path, content).unwrap();
        let parsed = parse_markdown_document(
            slug,
            content,
            DateTime::new("2026-10-18T00:00:00Z").unwrap(),
        )
        .unwrap();
        if parsed.block.frontmatter.block_type != BlockType::Channel {
            index::upsert_block_with_diagnostics(
                &space.conn,
                &parsed.block,
                Some(space.vault.root()),
                Some(parsed.origin.as_str()),
                parsed.index_warning.as_deref(),
            )
            .unwrap();
        }
        path
    }

    /// The body reconciliation reads from `content`.
    fn body_of(content: &str) -> String {
        parse_markdown_document("x", content, DateTime::new("2026-10-18T00:00:00Z").unwrap())
            .unwrap()
            .block
            .body
    }

    fn save(space: &Space, slug: &str, base: &str, body: &str) -> Result<SavedNoteBody, NoteSaveError> {
        save_note_body(
            &space.conn,
            &space.vault,
            &SaveNoteBodyParams {
                source_slug: slug.to_string(),
                base_body_hash: compute_body_hash(base),
                body: body.to_string(),
            },
        )
    }

    fn kind(error: &impl Serialize) -> String {
        serde_json::to_value(error).unwrap()["kind"].as_str().unwrap().to_string()
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

    /// The range of bytes where `after` differs from `before`: the common
    /// start and end left out.
    fn changed_range(before: &[u8], after: &[u8]) -> (usize, usize, usize) {
        let prefix = before.iter().zip(after).take_while(|(a, b)| a == b).count();
        let suffix = before[prefix..]
            .iter()
            .rev()
            .zip(after[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        (prefix, before.len() - suffix, after.len() - suffix)
    }

    const FRONT: &str = "---\nsaved_at: 2026-10-18T00:00:00Z\nMine Collections:\n  - \"[[Reading]]\"\n---\n";

    /// Л2.3, Л3.4: the start of the file stays byte for byte, the new file is
    /// that start and the body, and the index holds the new body, its hash
    /// and the title of its first H1 (Л2.2).
    #[test]
    fn a_save_writes_only_the_body_and_the_index_follows() {
        for front in [
            FRONT.to_string(),
            FRONT.replace('\n', "\r\n"),
            "---\n---\n".to_string(),
        ] {
            let space = space();
            let body = "# Old\r\nline one\n\tтабуляция и пробелы  \n";
            let content = format!("{front}{body}");
            let path = note(&space, "Note", &content);
            let new_body = "# Новый заголовок\r\nline one\n\tтабуляция и пробелы  \nи\u{0306} ещё";

            let saved = save(&space, "Note", body, new_body).unwrap();

            let after = std::fs::read(&path).unwrap();
            assert_eq!(after, format!("{front}{new_body}").into_bytes(), "{front:?}");
            assert!(!saved.unchanged && !saved.split_changed);
            assert_eq!(saved.block.body, new_body);
            assert_eq!(saved.block.body_hash.as_deref(), Some(compute_body_hash(new_body).as_str()));
            assert_eq!(saved.block.display_title.as_deref(), Some("Новый заголовок"));
            assert_eq!(index::get_block(&space.conn, "Note").unwrap().unwrap().body, new_body);
            assert_eq!(folder_names(&path), ["Note.md"]);
        }
    }

    /// Л3.4: no line break is added at the end of the file or taken away,
    /// and a body without one stays without one.
    #[test]
    fn the_final_line_break_is_neither_added_nor_removed() {
        let space = space();
        let path = note(&space, "Note", &format!("{FRONT}text"));
        save(&space, "Note", "text", "text and more").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{FRONT}text and more"));
        save(&space, "Note", "text and more", "text and more\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{FRONT}text and more\n"));
        save(&space, "Note", "text and more\n", "").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), FRONT);
    }

    /// Л0.3, Л0.4, Л3.4: CRLF, mixed separators, a lone `\r` and a byte
    /// order mark in a file without front matter go back as they came.
    #[test]
    fn line_separators_and_the_byte_order_mark_stay() {
        let space = space();
        let body = "\u{feff}# Title\r\nmixed\nlone\rend\r\n";
        let path = note(&space, "Plain", body);
        let edited = "\u{feff}# Title\r\nmixed, edited\nlone\rend\r\n";
        save(&space, "Plain", body, edited).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), edited.as_bytes());
        save(&space, "Plain", edited, body).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), body.as_bytes());
    }

    /// Л3.3 step 4, Л3.4: the body the file already holds writes nothing:
    /// the file keeps its bytes and its modification time, and the answer
    /// is the card as it is.
    #[test]
    fn an_unchanged_body_writes_nothing() {
        let space = space();
        let body = "text\n";
        let path = note(&space, "Note", &format!("{FRONT}{body}"));
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let row_before = index::get_block(&space.conn, "Note").unwrap().unwrap();

        let saved = save(&space, "Note", body, body).unwrap();

        assert!(saved.unchanged && !saved.split_changed);
        assert_eq!(saved.block.body_hash, row_before.body_hash);
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{FRONT}{body}"));
    }

    /// Л3.3 step 4: an index behind the file catches up with the read note,
    /// so the answer carries the body hash on disk; the file is not written.
    #[test]
    fn an_unchanged_body_brings_a_lagging_index_up_to_the_file() {
        let space = space();
        let path = note(&space, "Note", &format!("{FRONT}old\n"));
        std::fs::write(&path, format!("{FRONT}new on disk\n")).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();

        let saved = save(&space, "Note", "new on disk\n", "new on disk\n").unwrap();

        assert!(saved.unchanged);
        assert_eq!(saved.block.body, "new on disk\n");
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified);
    }

    /// Л2.3: properties changed on disk after the editor read the body (a
    /// collection connected meanwhile) stay as they are now.
    #[test]
    fn properties_changed_during_the_session_stay_new() {
        let space = space();
        let body = "text\n";
        let path = note(&space, "Note", &format!("{FRONT}{body}"));
        let connected = FRONT.replace("  - \"[[Reading]]\"\n", "  - \"[[Reading]]\"\n  - \"[[Later]]\"\n");
        std::fs::write(&path, format!("{connected}{body}")).unwrap();

        save(&space, "Note", body, "text, edited\n").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{connected}text, edited\n"));
    }

    /// Л3.3 step 3: a file that ends on its closing fence takes the fence's
    /// line break before a body, so the properties stay properties.
    #[test]
    fn a_file_that_ends_on_its_fence_keeps_its_properties() {
        for (front, line_break) in [
            ("---\nsaved_at: 2026-10-18T00:00:00Z\n---", "\n"),
            ("---\r\nsaved_at: 2026-10-18T00:00:00Z\r\n---", "\r\n"),
        ] {
            let space = space();
            let path = note(&space, "Note", front);
            let saved = save(&space, "Note", "", "First line").unwrap();
            let after = std::fs::read_to_string(&path).unwrap();
            assert_eq!(after, format!("{front}{line_break}First line"));
            assert!(after.starts_with(front));
            assert!(!saved.split_changed);
            assert_eq!(saved.block.body, "First line", "the properties became body");
        }
    }

    /// Л2.4: a body whose save changes the division of the file is answered
    /// with `split_changed` and the body the file has now, both ways.
    #[test]
    fn a_save_that_changes_the_division_of_the_file_says_so() {
        let space = space();
        let broken = "---\nnot: [yaml\n---\nbody\n";
        let path = note(&space, "Broken", broken);
        let fixed = "---\nsaved_at: 2026-10-18T00:00:00Z\n---\nbody\n";
        let saved = save(&space, "Broken", broken, fixed).unwrap();
        assert!(saved.split_changed);
        assert_eq!(saved.block.body, "body\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), fixed);

        let plain = "text\n";
        let path = note(&space, "Plain", plain);
        let fenced = "---\ntags: x\n---\ntext\n";
        let saved = save(&space, "Plain", plain, fenced).unwrap();
        assert!(saved.split_changed);
        assert_eq!(saved.block.body, "text\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), fenced);
    }

    /// Л4.3: a body on disk other than the base refuses the save with that
    /// body and its hash; the file stays.
    #[test]
    fn a_stale_base_writes_nothing_and_gives_the_body_on_disk() {
        let space = space();
        let path = note(&space, "Note", &format!("{FRONT}from Obsidian\n"));
        let error = save(&space, "Note", "what the editor had\n", "edited\n").unwrap_err();
        let NoteSaveError::StaleBody {
            source_slug,
            disk_body,
            disk_body_hash,
        } = error
        else {
            panic!("{error}");
        };
        assert_eq!(source_slug, "Note");
        assert_eq!(disk_body, "from Obsidian\n");
        assert_eq!(disk_body_hash, compute_body_hash("from Obsidian\n"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{FRONT}from Obsidian\n"));
    }

    /// Л3.3 step 6, Л4.3: an edit that lands between Mine's read and the
    /// publication stays; nothing is overwritten and the index keeps the
    /// old body.
    #[test]
    fn an_edit_between_the_read_and_the_write_stays() {
        let space = space();
        let body = "text\n";
        let path = note(&space, "Note", &format!("{FRONT}{body}"));
        let outside = format!("{FRONT}text\nadded in Obsidian\n");
        let written = outside.clone();
        hooks::after_next_read(move |path| std::fs::write(path, written).unwrap());

        let error = save(&space, "Note", body, "text, edited\n").unwrap_err();

        assert!(matches!(error, NoteSaveError::Changed { ref source_slug } if source_slug == "Note"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), outside);
        assert_eq!(index::get_block(&space.conn, "Note").unwrap().unwrap().body, body);
        assert_eq!(folder_names(&path), ["Note.md"]);
    }

    /// Л3.3 step 1, Л4.6: a read-only file, a read-only folder and a file
    /// locked in Finder are refused before anything is staged.
    #[test]
    fn a_note_mine_may_not_write_is_refused_before_the_write() {
        let space = space();
        let body = "text\n";
        let path = note(&space, "Note", &format!("{FRONT}{body}"));
        let before = std::fs::read(&path).unwrap();
        let folder = path.parent().unwrap().to_path_buf();
        let set_mode = |at: &Path, mode: u32| {
            std::fs::set_permissions(at, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        let set_lock = |flag: &str| {
            let status = std::process::Command::new("chflags").arg(flag).arg(&path).status().unwrap();
            assert!(status.success());
        };
        let attempt = || save(&space, "Note", body, "edited\n");

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
            assert!(matches!(error, NoteSaveError::ReadOnly { ref file_name } if file_name == "Note.md"), "{error}");
        }
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(folder_names(&path), ["Note.md"]);
    }

    /// Л4.5: a note whose contents went to iCloud during the session is
    /// neither read nor waited for.
    #[test]
    fn a_note_in_icloud_is_refused_without_reading_it() {
        let space = space();
        let body = "text\n";
        let path = note(&space, "Заметка", &format!("{FRONT}{body}"));
        cloud_files::test_seam::mark_offloaded(&path);

        let saved = save(&space, "Заметка", body, "edited\n");
        let state = note_body_state(&space.vault, "Заметка");
        let begun = begin_note_edit(&space.conn, &space.vault, "Заметка");
        let hash = current_body_hash(&space.vault, "Заметка");

        let reads = cloud_files::test_seam::reads_of(&path);
        cloud_files::test_seam::mark_downloaded(&path);
        assert!(matches!(saved, Err(NoteSaveError::InCloud { ref file_name }) if file_name == "Заметка.md"));
        assert!(matches!(state, Err(NoteEditError::InCloud { ref file_name }) if file_name == "Заметка.md"));
        assert!(matches!(begun, Err(NoteEditError::InCloud { ref file_name }) if file_name == "Заметка.md"));
        assert_eq!(hash, None);
        assert_eq!(reads, 0, "the evicted note was read");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{FRONT}{body}"));
    }

    /// Л2.5, Л4.9: a collection page is no card, a body that would make the
    /// note one is refused, and a note gone during the session is reported
    /// as gone; nothing is written.
    #[test]
    fn a_missing_note_or_a_collection_page_writes_nothing() {
        let space = space();
        let error = save(&space, "Gone", "", "text").unwrap_err();
        assert!(matches!(error, NoteSaveError::SourceNotFound { ref source_slug } if source_slug == "Gone"));

        let page = "---\ntype: channel\nsaved_at: 2026-10-18T00:00:00Z\n---\nAbout\n";
        let path = note(&space, "Reading", page);
        assert_eq!(kind(&save(&space, "Reading", "About\n", "Edited\n").unwrap_err()), "not_a_card");
        assert_eq!(kind(&begin_note_edit(&space.conn, &space.vault, "Reading").unwrap_err()), "not_a_card");
        assert_eq!(kind(&note_body_state(&space.vault, "Reading").unwrap_err()), "not_a_card");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), page);

        let plain = "text\n";
        let path = note(&space, "Plain", plain);
        let made_page = "---\ntype: channel\nsaved_at: 2026-10-18T00:00:00Z\n---\ntext\n";
        assert_eq!(kind(&save(&space, "Plain", plain, made_page).unwrap_err()), "not_a_card");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), plain);

        let path = note(&space, "Deleted", plain);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(kind(&save(&space, "Deleted", plain, "edited\n").unwrap_err()), "source_not_found");
        assert!(!path.exists());
    }

    /// Л4.8: a note renamed during the session is gone under its old slug;
    /// under the new one the session saves.
    #[test]
    fn a_note_renamed_during_the_session_saves_under_its_new_slug() {
        let space = space();
        let body = "text\n";
        let path = note(&space, "Old", &format!("{FRONT}{body}"));
        let renamed = space.vault.block_path("New");
        std::fs::rename(&path, &renamed).unwrap();
        assert_eq!(kind(&save(&space, "Old", body, "edited\n").unwrap_err()), "source_not_found");
        save(&space, "New", body, "edited\n").unwrap();
        assert_eq!(std::fs::read_to_string(&renamed).unwrap(), format!("{FRONT}edited\n"));
    }

    /// Л3.3 step 8: a save makes no preview; the deferred task does.
    #[test]
    fn the_preview_is_made_by_the_deferred_task_not_by_the_save() {
        let space = space();
        let body = "# Title\n\nSome text for the preview.\n";
        note(&space, "Note", &format!("{FRONT}{body}"));
        let thumb = space.vault.thumb_path("Note");

        save(&space, "Note", body, "# Title\n\nOther text for the preview.\n").unwrap();
        assert!(!thumb.exists(), "the save made a preview");

        let made = generate_note_preview(&space.conn, &space.vault, "Note").unwrap();
        assert_eq!(made, Some(ThumbSource::Text));
        assert!(thumb.exists());
        assert_eq!(generate_note_preview(&space.conn, &space.vault, "Gone").unwrap(), None);
    }

    /// Л2.8: entering editing gives the card with the body on disk, catching
    /// a lagging index up; a note Mine may not write or that is gone is
    /// refused.
    #[test]
    fn beginning_an_edit_gives_the_card_as_it_is_on_disk() {
        let space = space();
        let path = note(&space, "Note", &format!("{FRONT}old\n"));
        let card = begin_note_edit(&space.conn, &space.vault, "Note").unwrap();
        assert_eq!(card.body, "old\n");

        std::fs::write(&path, format!("{FRONT}changed in Obsidian\n")).unwrap();
        let card = begin_note_edit(&space.conn, &space.vault, "Note").unwrap();
        assert_eq!(card.body, "changed in Obsidian\n");
        assert_eq!(card.body_hash.as_deref(), Some(compute_body_hash("changed in Obsidian\n").as_str()));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let read_only = begin_note_edit(&space.conn, &space.vault, "Note");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(kind(&read_only.unwrap_err()), "read_only");
        assert_eq!(kind(&begin_note_edit(&space.conn, &space.vault, "Gone").unwrap_err()), "source_not_found");
    }

    /// Л4.1: the body state is the body on disk and its hash, whatever the
    /// index holds; a file that is not UTF-8 is not read.
    #[test]
    fn the_body_state_is_the_body_on_disk() {
        let space = space();
        let path = note(&space, "Note", &format!("{FRONT}old\n"));
        std::fs::write(&path, format!("{FRONT}new\n")).unwrap();
        assert_eq!(
            note_body_state(&space.vault, "Note").unwrap(),
            NoteBodyState {
                body_hash: compute_body_hash("new\n"),
                body: "new\n".to_string(),
            }
        );
        assert_eq!(current_body_hash(&space.vault, "Note"), Some(compute_body_hash("new\n")));
        assert_eq!(kind(&note_body_state(&space.vault, "Gone").unwrap_err()), "source_not_found");

        std::fs::write(&path, b"\xff\xfe not UTF-8").unwrap();
        assert_eq!(kind(&note_body_state(&space.vault, "Note").unwrap_err()), "internal");
        assert_eq!(current_body_hash(&space.vault, "Note"), None);
    }

    /// The variants of the fixture Л17 names: line separators, a byte order
    /// mark, no final line break, tabs, properties with CRLF, broken
    /// properties.
    fn fixture_variants() -> Vec<(&'static str, String)> {
        let body = &FIXTURE[body_start_of(FIXTURE)..];
        let mixed: String = FIXTURE
            .split_inclusive('\n')
            .enumerate()
            .map(|(index, line)| if index % 2 == 0 { line.replace('\n', "\r\n") } else { line.to_string() })
            .collect();
        vec![
            ("as is", FIXTURE.to_string()),
            ("crlf", FIXTURE.replace('\n', "\r\n")),
            ("mixed", mixed),
            ("bom", format!("\u{feff}{FIXTURE}")),
            ("no final line break", FIXTURE.trim_end_matches('\n').to_string()),
            ("tabs", FIXTURE.replace("    ", "\t")),
            ("crlf properties", format!("{}{body}", FIXTURE[..body_start_of(FIXTURE)].replace('\n', "\r\n"))),
            ("broken properties", FIXTURE.replacen("saved_at:", "saved_at: [", 1)),
        ]
    }

    fn body_start_of(content: &str) -> usize {
        note_write::body_start(content, &body_of(content)).unwrap()
    }

    /// How many lines of the fixture's body each variant edits, spread over
    /// the whole body, the last line among them.
    const EDITED_LINES: usize = 30;

    /// Л3.4, Л17: on the fixture and each variant, a session without edits
    /// writes nothing; an edit at the end of a line, in lines spread over
    /// every block of the body, changes only its own bytes, and undoing it
    /// gives the file back byte for byte.
    #[test]
    fn the_fixture_and_its_variants_round_trip_byte_for_byte() {
        for (name, content) in fixture_variants() {
            let space = space();
            let path = note(&space, "Fixture", &content);
            let original = std::fs::read(&path).unwrap();
            let card = begin_note_edit(&space.conn, &space.vault, "Fixture").unwrap();
            let body = card.body.clone();
            let start = content.len() - body.len();
            assert_eq!(&content[start..], body, "{name}");

            let saved = save(&space, "Fixture", &body, &body).unwrap();
            assert!(saved.unchanged, "{name}: opening without edits wrote");

            let mut line_ends = Vec::new();
            let mut offset = 0;
            for line in body.split_inclusive('\n') {
                line_ends.push(offset + line.find(['\r', '\n']).unwrap_or(line.len()));
                offset += line.len();
            }
            let stride = line_ends.len().div_ceil(EDITED_LINES).max(1);
            let mut picked: Vec<usize> = line_ends.iter().copied().step_by(stride).collect();
            picked.extend(line_ends.last().copied());
            let mut lines_edited = 0;
            for at in picked {
                let edited = format!("{}✎{}", &body[..at], &body[at..]);
                let saved = save(&space, "Fixture", &body, &edited).unwrap();
                assert!(!saved.unchanged, "{name}");
                let after = std::fs::read(&path).unwrap();
                let (from, old_end, new_end) = changed_range(&original, &after);
                assert_eq!(from, start + at, "{name}: an edit at {at} changed other bytes");
                assert_eq!((old_end, new_end), (start + at, start + at + "✎".len()), "{name}");

                let undone = save(&space, "Fixture", &edited, &body).unwrap();
                assert!(!undone.unchanged, "{name}");
                assert_eq!(std::fs::read(&path).unwrap(), original, "{name}: undo did not give the file back");
                lines_edited += 1;
            }
            assert!(lines_edited > 0, "{name}");
        }
    }
}
