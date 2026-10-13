//! The `mine` CLI mutation layer — SPEC_AI_ACCESS.
//!
//! One principle: the CLI never edits a file as text. A mutation is a surgical
//! patch of one named part — a single front-matter field, the collections
//! block, or the body — with everything else byte-identical. The front matter
//! is found by the app's own boundary (`frontmatter_bounds`), a field is
//! written by the app's own source-preserving writer (`apply_block_changes`),
//! and every write goes through the same guards (SPEC_DEEP_AUDIT.md, Н1):
//!
//! 1. the patched content is read back the way the app reads notes: the
//!    front matter cannot disappear or stop parsing, every property the
//!    mutation does not own (`saved_at` among them) reads as before, and the
//!    body is the one intended;
//! 2. the previous version is copied into the derived store first, with a
//!    fingerprint of what the CLI leaves in its place, and `mine restore`
//!    brings it back only while the file still holds that;
//! 3. the write is published only while the file still holds the bytes it
//!    was built from (`write_atomically_if_unchanged`, SPEC_AUDIT_FIXES.md,
//!    Ф2).

use std::path::{Path, PathBuf};

use crate::domain::block::{
    body_without_media_embeds, iter_inline_media_sources, parse_markdown_document, DateTime,
    Frontmatter, ParsedMarkdownBlock,
};
use crate::domain::collection::{
    normalize_collection_ref, patch_collections_frontmatter, MINE_COLLECTIONS_FIELD,
};
use crate::domain::source_patch::{
    apply_block_changes, body_of, frontmatter_bounds, verify_other_properties, FrontmatterBounds,
};
use crate::domain::vault::{validate_slug, VaultLayout};
use crate::storage::files::{
    conflict_dir_for, source_changed, write_atomically, write_atomically_if_unchanged,
    write_new_atomically,
};

/// Front-matter fields the CLI may set. Everything else is either managed
/// (`Mine Collections`, `file`, `saved_at`) or unknown — both are refused.
pub const SETTABLE_FIELDS: &[&str] = &["title", "description", "url", "author", "source"];

/// `saved_at` a note without one is read back under; never written.
const READ_BACK_SAVED_AT: &str = "1970-01-01T00:00:00Z";

/// The parse origin of fences around text that is not YAML properties.
const MALFORMED_ORIGIN: &str = "malformed_frontmatter";

pub struct MutationOutcome {
    /// What changed, для отчёта и dry-run.
    pub summary: String,
    /// True when nothing was written (dry-run or no-op).
    pub dry_run: bool,
}

pub enum MutationError {
    Usage(String),
    NotFound(String),
    /// A card was to be connected to `collection`, which has no page
    /// (`type: channel`): a collection exists only as its page, and nothing
    /// was written (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7).
    CollectionNotFound { collection: String },
    Refused(String),
    Internal(String),
}

impl MutationError {
    pub fn message(&self) -> String {
        match self {
            Self::Usage(m) | Self::NotFound(m) | Self::Refused(m) | Self::Internal(m) => m.clone(),
            Self::CollectionNotFound { collection } => collection_not_found_message(collection),
        }
    }
}

/// What the CLI and MCP say when a collection has no page: the name, that
/// its page does not exist, and the command that makes one.
pub fn collection_not_found_message(collection: &str) -> String {
    format!(
        "no collection \"{collection}\": its page does not exist; create it with mine collection create"
    )
}

/// The page check every CLI path that writes a new link into
/// `Mine Collections` runs before it writes: the one the app runs
/// ([`crate::commands::channels::require_collection_page`]), found the way
/// `mine collection rename` and `delete` find a page. No page is
/// [`MutationError::CollectionNotFound`]; anything else (an ambiguous bare
/// name, an unreadable page) is internal, as it is for those commands.
#[cfg(feature = "desktop")]
pub fn require_collection_page(
    conn: &rusqlite::Connection,
    vault: &VaultLayout,
    collection: &str,
) -> Result<(), MutationError> {
    let collection_ref = normalize_collection_ref(collection);
    if collection_ref.is_empty() {
        return Err(MutationError::Usage("empty collection name".into()));
    }
    crate::domain::collection::validate_collection_ref(&collection_ref)
        .map_err(MutationError::Usage)?;
    match crate::commands::channels::require_collection_page(conn, vault, &collection_ref) {
        Ok(()) => Ok(()),
        Err(crate::commands::state::CommandError::CollectionNotFound { collection }) => {
            Err(MutationError::CollectionNotFound { collection })
        }
        Err(error) => Err(MutationError::Internal(error.to_string())),
    }
}

/// A slug the CLI may turn into a path: inside the space, no traversal.
pub fn checked_slug(slug: &str) -> Result<(), MutationError> {
    validate_slug(slug).map_err(|error| MutationError::Usage(format!("{slug}: {error}")))
}

fn read_card(vault: &VaultLayout, slug: &str) -> Result<(PathBuf, String), MutationError> {
    checked_slug(slug)?;
    let path = vault.block_path(slug);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(MutationError::NotFound(format!("no card {slug}")));
        }
        Err(error) => {
            return Err(MutationError::Internal(format!(
                "read {}: {error}",
                path.display()
            )));
        }
    };
    let content = String::from_utf8(bytes).map_err(|_| {
        MutationError::Refused(format!("{slug} is not UTF-8 text; nothing was written"))
    })?;
    Ok((path, content))
}

/// The note as the app reads it.
fn read_as_app(slug: &str, content: &str) -> Result<ParsedMarkdownBlock, MutationError> {
    let fallback = DateTime::new(READ_BACK_SAVED_AT)
        .map_err(|error| MutationError::Internal(error.to_string()))?;
    parse_markdown_document(slug, content, fallback)
        .map_err(|error| MutationError::Refused(format!("{slug} does not parse: {error}")))
}

/// What a patch may change: the properties it owns, and the body.
struct PatchScope<'a> {
    /// Properties the mutation writes. Every other one must read back as it
    /// was; with none, the front matter must stay byte for byte.
    own_keys: &'a [&'a str],
    /// The body the mutation writes, or `None` when the body must stay.
    body: Option<&'a str>,
}

/// Every guard a patched card must clear before it may touch the disk: it is
/// read back the way the app reads notes (SPEC_DEEP_AUDIT.md, Н1).
fn verify_patched(
    slug: &str,
    old_content: &str,
    new_content: &str,
    scope: &PatchScope<'_>,
) -> Result<(), MutationError> {
    // Front matter cannot disappear; a body or membership patch leaves the
    // rest of it byte for byte.
    if let FrontmatterBounds::Valid {
        body_start: old_start,
        ..
    } = frontmatter_bounds(old_content)
    {
        let FrontmatterBounds::Valid {
            body_start: new_start,
            ..
        } = frontmatter_bounds(new_content)
        else {
            return Err(MutationError::Refused(
                "the patch would drop the front matter — refused".into(),
            ));
        };
        let old_fences = &old_content[..old_start];
        let new_fences = &new_content[..new_start];
        // A file that ended on its closing fence gains the line break the
        // body starts after; nothing else of the fences may change.
        let same_fences = new_fences == old_fences
            || (!old_fences.ends_with('\n')
                && new_fences
                    .strip_prefix(old_fences)
                    .is_some_and(|rest| rest == "\n" || rest == "\r\n"));
        if scope.own_keys.is_empty() && !same_fences {
            return Err(MutationError::Refused(
                "the patch would change the front matter — refused".into(),
            ));
        }
    }
    // Properties that read as properties keep doing so.
    let old_read = read_as_app(slug, old_content)?;
    let new_read = read_as_app(slug, new_content)?;
    if old_read.origin != MALFORMED_ORIGIN && new_read.origin == MALFORMED_ORIGIN {
        return Err(MutationError::Refused(
            "the patched card's front matter no longer parses — refused".into(),
        ));
    }
    // Every property the mutation does not own reads as before; `saved_at`
    // is never owned.
    verify_other_properties(old_content, new_content, scope.own_keys).map_err(|error| {
        MutationError::Refused(format!(
            "the patch would change other properties ({error}) — refused"
        ))
    })?;
    let intended_body = scope.body.unwrap_or_else(|| body_of(old_content));
    if body_of(new_content) != intended_body {
        return Err(MutationError::Refused(
            "the patched card would not read back with the intended body — refused".into(),
        ));
    }
    Ok(())
}

/// Write with the full guard chain: verify, back up, publish only over the
/// bytes that were read.
#[allow(clippy::too_many_arguments)]
fn guarded_write(
    vault: &VaultLayout,
    slug: &str,
    path: &Path,
    old_content: &str,
    new_content: &str,
    scope: &PatchScope<'_>,
    summary: String,
    dry_run: bool,
) -> Result<MutationOutcome, MutationError> {
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| MutationError::Internal(error.to_string()))?;
    if old_content == new_content {
        return Ok(MutationOutcome {
            summary: "no change".into(),
            dry_run: true,
        });
    }
    verify_patched(slug, old_content, new_content, scope)?;
    if dry_run {
        return Ok(MutationOutcome {
            summary: format!("would apply: {summary}"),
            dry_run: true,
        });
    }
    let backup = CliBackup::record(
        vault,
        slug,
        old_content,
        &Left::Bytes(new_content.as_bytes()),
    )?;
    publish_over(slug, path, old_content.as_bytes(), new_content.as_bytes())?;
    backup.keep();
    Ok(MutationOutcome {
        summary,
        dry_run: false,
    })
}

/// Replace `path` with `replacement` only while it holds `expected`
/// (SPEC_AUDIT_FIXES.md, Ф2). An outside edit wins and is reported.
fn publish_over(
    slug: &str,
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
) -> Result<(), MutationError> {
    write_atomically_if_unchanged(path, expected, replacement, &conflict_dir_for(path)).map_err(
        |error| {
            if source_changed(&error).is_some() {
                MutationError::Refused(format!(
                    "{slug} changed outside Mine after it was read; nothing was written"
                ))
            } else {
                MutationError::Internal(format!("write: {error:#}"))
            }
        },
    )
}

// ─── Backups ────────────────────────────────────────────────────────────────

/// What a CLI mutation left at the card's path: these bytes, or no file.
pub enum Left<'a> {
    Bytes(&'a [u8]),
    Absent,
}

impl Left<'_> {
    fn marker(&self) -> String {
        match self {
            Self::Bytes(bytes) => {
                use sha2::{Digest, Sha256};
                format!("sha256:{:x}\n", Sha256::digest(bytes))
            }
            Self::Absent => "absent\n".to_string(),
        }
    }
}

/// A backup file's bytes before a mutation replaced them, if it was there.
type EarlierBackup = (Option<Vec<u8>>, Option<Vec<u8>>);

/// The one level of undo of a card: its text before the last CLI mutation
/// (`cli-backups/<slug>.md`) and a fingerprint of what that mutation left at
/// the card's path (`<slug>.md.left`). `mine restore` puts the text back only
/// while the path still holds what the mutation left, so it never writes over
/// an edit made since, nor over another note that took the name
/// (SPEC_DEEP_AUDIT.md, Е1.9).
pub struct CliBackup {
    text: PathBuf,
    left: PathBuf,
    /// The backup this one replaced, put back unless the mutation went
    /// through (`keep`).
    earlier: Option<EarlierBackup>,
}

impl CliBackup {
    fn paths(vault: &VaultLayout, slug: &str) -> (PathBuf, PathBuf) {
        let text = vault
            .derived_root()
            .join("cli-backups")
            .join(format!("{slug}.md"));
        let mut left = text.clone().into_os_string();
        left.push(".left");
        (text, PathBuf::from(left))
    }

    /// Back up `previous` as the text before a mutation that leaves `left`.
    /// The backup it replaces comes back if the mutation does not go through.
    pub fn record(
        vault: &VaultLayout,
        slug: &str,
        previous: &str,
        left: &Left<'_>,
    ) -> Result<Self, MutationError> {
        checked_slug(slug)?;
        let (text, left_path) = Self::paths(vault, slug);
        let earlier = (read_optional(&text)?, read_optional(&left_path)?);
        if let Some(parent) = text.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| MutationError::Internal(format!("backup dir: {e}")))?;
        }
        let backup = Self {
            text,
            left: left_path,
            earlier: Some(earlier),
        };
        backup.write(previous.as_bytes(), left)?;
        Ok(backup)
    }

    fn write(&self, previous: &[u8], left: &Left<'_>) -> Result<(), MutationError> {
        write_atomically(&self.text, previous)
            .map_err(|e| MutationError::Internal(format!("backup write: {e:#}")))?;
        write_atomically(&self.left, left.marker().as_bytes())
            .map_err(|e| MutationError::Internal(format!("backup write: {e:#}")))
    }

    /// The mutation went through: this backup stays.
    pub fn keep(mut self) {
        self.earlier = None;
    }

    fn put_back(&self, earlier: &EarlierBackup) -> std::io::Result<()> {
        for (path, bytes) in [(&self.text, &earlier.0), (&self.left, &earlier.1)] {
            match bytes {
                Some(bytes) => std::fs::write(path, bytes)?,
                None => match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                },
            }
        }
        Ok(())
    }
}

impl Drop for CliBackup {
    fn drop(&mut self) {
        if let Some(earlier) = self.earlier.take() {
            if let Err(error) = self.put_back(&earlier) {
                // The failed mutation's own error is the answer; this line
                // says why undo now holds the refused version instead.
                eprintln!(
                    "mine: the CLI backup {} could not be put back as it was: {error}",
                    self.text.display()
                );
            }
        }
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, MutationError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(MutationError::Internal(format!(
            "read {}: {error}",
            path.display()
        ))),
    }
}

// ─── Fields and body ────────────────────────────────────────────────────────

/// The field `name` of the model, for a known settable field.
fn settable_field<'f>(frontmatter: &'f mut Frontmatter, name: &str) -> Option<&'f mut Option<String>> {
    match name {
        "title" => Some(&mut frontmatter.title),
        "description" => Some(&mut frontmatter.description),
        "url" => Some(&mut frontmatter.url),
        "author" => Some(&mut frontmatter.author),
        "source" => Some(&mut frontmatter.source),
        _ => None,
    }
}

/// Set or remove one known front-matter field: its key is replaced whole,
/// continuation lines included, by the app's source-preserving writer, and
/// the value reads back as given, line breaks included (SPEC_DEEP_AUDIT.md,
/// Н1, Е1.2).
pub fn set_field(
    vault: &VaultLayout,
    slug: &str,
    field: &str,
    value: Option<&str>,
    dry_run: bool,
) -> Result<MutationOutcome, MutationError> {
    if !SETTABLE_FIELDS.contains(&field) {
        return Err(MutationError::Usage(format!(
            "field {field} is not settable; settable: {}",
            SETTABLE_FIELDS.join(", ")
        )));
    }
    let (path, content) = read_card(vault, slug)?;
    if !matches!(frontmatter_bounds(&content), FrontmatterBounds::Valid { .. }) {
        return Err(MutationError::Refused(
            "this note has no front matter; the CLI does not invent one".into(),
        ));
    }
    let read = read_as_app(slug, &content)?;
    if read.origin == MALFORMED_ORIGIN {
        return Err(MutationError::Refused(format!(
            "the front matter of {slug} is not valid YAML properties; nothing was written"
        )));
    }
    let before = read.block;
    let mut after = before.clone();
    let Some(slot) = settable_field(&mut after.frontmatter, field) else {
        return Err(MutationError::Usage(format!("field {field} is not settable")));
    };
    let previous = slot.clone();
    match (&previous, value) {
        (None, None) => {
            return Ok(MutationOutcome {
                summary: format!("{field} already absent"),
                dry_run: true,
            })
        }
        (Some(old), Some(new)) if old == new => {
            return Ok(MutationOutcome {
                summary: "no change".into(),
                dry_run: true,
            })
        }
        _ => {}
    }
    *slot = value.map(str::to_string);
    let summary = format!(
        "{field}: {} -> {}",
        previous
            .as_deref()
            .map_or_else(|| "(absent)".to_string(), |old| format!("{old:?}")),
        value.map_or_else(|| "(absent)".to_string(), |new| format!("{new:?}")),
    );
    let new_content = apply_block_changes(&content, &before, &after).map_err(|error| {
        MutationError::Refused(format!("{slug}: {error}; nothing was written"))
    })?;
    guarded_write(
        vault,
        slug,
        &path,
        &content,
        &new_content,
        &PatchScope {
            own_keys: &[field],
            body: None,
        },
        summary,
        dry_run,
    )
}

/// Replace the body wholesale, keeping the front matter byte-identical.
///
/// The body starts after the closing fence the app finds
/// (`frontmatter_bounds`): CRLF, a closing line of exactly `---`, a file
/// that ends on that line, an empty front matter (SPEC_DEEP_AUDIT.md, Н1).
///
/// The media embeds are the content itself; losing one to a careless rewrite
/// (a translation that drops the pictures) is the classic failure, so by
/// default the embed set before must equal the embed set after.
pub fn set_body(
    vault: &VaultLayout,
    slug: &str,
    new_body: &str,
    allow_media_changes: bool,
    dry_run: bool,
) -> Result<MutationOutcome, MutationError> {
    let (path, content) = read_card(vault, slug)?;
    let (prefix, old_body) = match frontmatter_bounds(&content) {
        FrontmatterBounds::Valid { body_start, .. } => {
            let mut prefix = content[..body_start].to_string();
            if !prefix.ends_with('\n') {
                // The file ends on its closing fence: the body starts on a
                // line of its own, in the line breaks the fences use.
                prefix.push_str(if prefix.contains("\r\n") { "\r\n" } else { "\n" });
            }
            (prefix, &content[body_start..])
        }
        FrontmatterBounds::None => (String::new(), content.as_str()),
    };

    let old_embeds: Vec<String> = iter_inline_media_sources(old_body);
    let new_embeds: Vec<String> = iter_inline_media_sources(new_body);
    if !allow_media_changes {
        let mut lost: Vec<&String> = old_embeds
            .iter()
            .filter(|e| !new_embeds.contains(e))
            .collect();
        lost.dedup();
        if !lost.is_empty() {
            return Err(MutationError::Refused(format!(
                "the new body loses media embeds: {}; pass --allow-media-changes to do this deliberately",
                lost.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            )));
        }
    }

    let mut new_content = prefix.clone();
    new_content.push_str(new_body);
    if !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    let summary = format!(
        "body: {} chars -> {} chars (own text {} -> {})",
        old_body.len(),
        new_body.len(),
        body_without_media_embeds(old_body).trim().len(),
        body_without_media_embeds(new_body).trim().len(),
    );
    let written_body = new_content[prefix.len()..].to_string();
    guarded_write(
        vault,
        slug,
        &path,
        &content,
        &new_content,
        &PatchScope {
            own_keys: &[],
            body: Some(&written_body),
        },
        summary,
        dry_run,
    )
}

/// The text `mine card body` prints: what follows the closing fence the app
/// finds, or the whole note without front matter. `card set-body` writes
/// exactly this part.
pub fn card_body(vault: &VaultLayout, slug: &str) -> Result<String, MutationError> {
    let (_, content) = read_card(vault, slug)?;
    Ok(body_of(&content).to_string())
}

/// Connect or disconnect a card and a collection — the only door to
/// `Mine Collections`.
///
/// Connecting needs the collection's page: `collection_page` answers whether
/// the normalized name has one ([`require_collection_page`] in the CLI), and
/// a refusal stops the connect before anything is written, even when the
/// card already names it. Disconnecting takes the link off whether the page
/// exists or not (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7 and К8). The new
/// list is built from the card's text, so links to names without a page
/// stay where they are (К2).
pub fn set_collection_membership(
    vault: &VaultLayout,
    slug: &str,
    collection: &str,
    connected: bool,
    dry_run: bool,
    collection_page: impl FnOnce(&str) -> Result<(), MutationError>,
) -> Result<MutationOutcome, MutationError> {
    let (path, content) = read_card(vault, slug)?;
    let collection_ref = normalize_collection_ref(collection);
    if collection_ref.is_empty() {
        return Err(MutationError::Usage("empty collection name".into()));
    }
    if connected {
        collection_page(&collection_ref)?;
    }
    let parsed = read_as_app(slug, &content)?;
    let mut tags = parsed.block.frontmatter.tags.clone();
    let had = tags.contains(&collection_ref);
    match (had, connected) {
        (true, true) => {
            return Ok(MutationOutcome {
                summary: format!("already connected to {collection_ref}"),
                dry_run: true,
            })
        }
        (false, false) => {
            return Ok(MutationOutcome {
                summary: format!("not connected to {collection_ref}"),
                dry_run: true,
            })
        }
        (false, true) => tags.push(collection_ref.clone()),
        (true, false) => tags.retain(|t| t != &collection_ref),
    }
    // The writer reads its result back and refuses properties it would break
    // or rewrite in another layout (SPEC_AUDIT_FIXES.md, Ф1, Г1.5).
    let new_content = patch_collections_frontmatter(&content, &tags).map_err(|error| {
        MutationError::Refused(format!("{slug}: {error}; nothing was written"))
    })?;
    let verb = if connected { "connect" } else { "disconnect" };
    guarded_write(
        vault,
        slug,
        &path,
        &content,
        &new_content,
        &PatchScope {
            own_keys: &[MINE_COLLECTIONS_FIELD],
            body: None,
        },
        format!("{verb} {collection_ref}"),
        dry_run,
    )
}

/// Bring back the version saved before the last CLI mutation of this card,
/// only while the card's path holds what that mutation left there: an edit
/// made since, or another note that took the name, stays and the restore
/// refuses (SPEC_DEEP_AUDIT.md, Е1.9; SPEC_AUDIT_FIXES.md, Ф2).
pub fn restore(vault: &VaultLayout, slug: &str) -> Result<MutationOutcome, MutationError> {
    checked_slug(slug)?;
    let _write = crate::storage::source_mutation::begin_write()
        .map_err(|error| MutationError::Internal(error.to_string()))?;
    let (text_path, left_path) = CliBackup::paths(vault, slug);
    let Some(previous) = read_optional(&text_path)? else {
        return Err(MutationError::NotFound(format!("no CLI backup for {slug}")));
    };
    let Some(left) = read_optional(&left_path)? else {
        return Err(MutationError::Refused(format!(
            "the CLI backup of {slug} was made before restore could check the card; nothing was restored; the earlier text is at {}",
            text_path.display()
        )));
    };
    let path = vault.block_path(slug);
    let current = read_optional(&path)?;
    let still_left = match &current {
        Some(bytes) => Left::Bytes(bytes).marker(),
        None => Left::Absent.marker(),
    };
    if left != still_left.as_bytes() {
        return Err(MutationError::Refused(format!(
            "{slug} changed since the last CLI mutation, or another note took its name; nothing was restored; the earlier text is at {}",
            text_path.display()
        )));
    }
    match &current {
        Some(bytes) => publish_over(slug, &path, bytes, &previous)?,
        None => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| MutationError::Internal(format!("restore dir: {e}")))?;
            }
            write_new_atomically(&path, &previous).map_err(|e| {
                MutationError::Refused(format!(
                    "{slug} could not be brought back ({e:#}); nothing was restored"
                ))
            })?;
        }
    }
    // The swap keeps one level of undo in both directions; a restored
    // deletion has nothing to go back to.
    let swap = match current {
        Some(bytes) => {
            let swapped = CliBackup {
                text: text_path,
                left: left_path,
                earlier: None,
            };
            swapped.write(&bytes, &Left::Bytes(&previous)).err()
        }
        None => [&text_path, &left_path]
            .into_iter()
            .find_map(|path| std::fs::remove_file(path).err())
            .map(|error| MutationError::Internal(error.to_string())),
    };
    let summary = match swap {
        None => format!("restored {slug} from the CLI backup"),
        Some(error) => format!(
            "restored {slug} from the CLI backup; the backup could not be swapped ({}), so mine restore cannot undo this",
            error.message()
        ),
    };
    Ok(MutationOutcome {
        summary,
        dry_run: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space_with_card(source: &str) -> (tempfile::TempDir, VaultLayout) {
        let dir = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(dir.path().join("space"), dir.path().join("derived"));
        std::fs::create_dir_all(vault.root()).unwrap();
        std::fs::write(vault.block_path("Note"), source).unwrap();
        (dir, vault)
    }

    /// The page check of a space where every collection has a page.
    fn page_exists(_collection: &str) -> Result<(), MutationError> {
        Ok(())
    }

    /// The page check of a space where no collection has a page.
    fn no_page(collection: &str) -> Result<(), MutationError> {
        Err(MutationError::CollectionNotFound {
            collection: collection.to_string(),
        })
    }

    /// К7 (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md): a connect the page check
    /// refuses writes nothing, even when the card already names it; К8: a
    /// disconnect never asks for the page.
    #[test]
    fn connect_needs_the_page_and_disconnect_does_not() {
        let source = "---\nsaved_at: 2026-07-10\nMine Collections:\n  - \"[[Pageless]]\"\n---\nBody\n";
        let (_dir, vault) = space_with_card(source);

        for name in ["Design", "Pageless"] {
            let refused = set_collection_membership(&vault, "Note", name, true, false, no_page);
            assert!(
                matches!(&refused, Err(MutationError::CollectionNotFound { collection }) if collection == name),
                "connect to {name} was not refused"
            );
            assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), source);
        }

        let removed = set_collection_membership(&vault, "Note", "Pageless", false, false, |_: &str| {
            panic!("disconnect asked for the page")
        });
        assert!(removed.is_ok());
        let written = std::fs::read_to_string(vault.block_path("Note")).unwrap();
        assert!(!written.contains("Pageless"), "{written}");
    }

    /// Г1.5: `mine connect` on a card whose properties are a flow mapping
    /// writes the membership inside the braces; the file stays valid YAML.
    #[test]
    fn connect_keeps_flow_mapping_properties_valid() {
        let (_dir, vault) =
            space_with_card("---\n{aliases: [A], saved_at: 2026-07-10}\n---\nBody\n");

        assert!(set_collection_membership(&vault, "Note", "Design", true, false, page_exists).is_ok());

        let written = std::fs::read_to_string(vault.block_path("Note")).unwrap();
        assert_eq!(
            written,
            "---\n{aliases: [A], saved_at: 2026-07-10, Mine Collections: [\"[[Design]]\"]}\n---\nBody\n"
        );
        let read =
            parse_markdown_document("Note", &written, DateTime::new("2000-01-01").unwrap())
                .unwrap();
        assert_eq!(read.origin, "partial_frontmatter");
        assert_eq!(read.block.frontmatter.tags, vec!["Design"]);
    }

    /// Г1.5: properties the writer would break are refused; the card stays
    /// byte for byte.
    #[test]
    fn connect_refuses_properties_it_would_break() {
        let source = "---\n  aliases: [A]\n  saved_at: 2026-07-10\n---\nBody\n";
        let (_dir, vault) = space_with_card(source);

        let refused = set_collection_membership(&vault, "Note", "Design", true, false, page_exists);

        assert!(matches!(refused, Err(MutationError::Refused(_))));
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), source);
    }

    /// SPEC_DEEP_AUDIT.md, Е1.9 (Ф2): a write whose file changed after it
    /// was read refuses, and the other version stays as it is.
    #[test]
    fn a_write_refuses_a_file_changed_after_it_was_read() {
        let source = "---\nsaved_at: 2026-07-10\n---\nBody\n";
        let (_dir, vault) = space_with_card(source);
        let edited = "---\nsaved_at: 2026-07-10\n---\nEdited elsewhere\n";
        std::fs::write(vault.block_path("Note"), edited).unwrap();

        let outcome = guarded_write(
            &vault,
            "Note",
            &vault.block_path("Note"),
            source,
            "---\nsaved_at: 2026-07-10\nauthor: Ann\n---\nBody\n",
            &PatchScope {
                own_keys: &["author"],
                body: None,
            },
            "author".into(),
            false,
        );

        assert!(matches!(outcome, Err(MutationError::Refused(_))));
        assert_eq!(std::fs::read_to_string(vault.block_path("Note")).unwrap(), edited);
        // The refused write left no backup to restore over the edit.
        assert!(matches!(restore(&vault, "Note"), Err(MutationError::NotFound(_))));
    }

    /// Н1: a patch that would read back with another `saved_at`, another
    /// property or another body is refused before it reaches the disk.
    #[test]
    fn a_patch_that_reads_back_differently_is_refused() {
        let source = "---\nsaved_at: 2026-07-10\nrating: 5\n---\nBody\n";
        let scope = PatchScope {
            own_keys: &["author"],
            body: None,
        };
        for patched in [
            "---\nsaved_at: 2026-07-11\nrating: 5\nauthor: Ann\n---\nBody\n",
            "---\nsaved_at: 2026-07-10\nrating: 4\nauthor: Ann\n---\nBody\n",
            "---\nsaved_at: 2026-07-10\nrating: 5\nauthor: Ann\n---\nOther\n",
            "---\nsaved_at: 2026-07-10\nrating: [5\n---\nBody\n",
        ] {
            assert!(
                matches!(verify_patched("Note", source, patched, &scope), Err(MutationError::Refused(_))),
                "{patched:?}"
            );
        }
    }
}
