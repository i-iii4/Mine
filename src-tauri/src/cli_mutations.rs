//! The `mine` CLI mutation layer — SPEC_AI_ACCESS.
//!
//! One principle: the CLI never edits a file as text. A mutation is a surgical
//! patch of one named part — a single front-matter field, the collections
//! block, or the body — with everything else byte-identical. Every write goes
//! through the same guards:
//!
//! 1. the patched content must parse back (round-trip), else refusal;
//! 2. front matter cannot disappear and `saved_at` cannot change;
//! 3. the previous version is copied into the derived store first, and
//!    `mine restore` brings it back;
//! 4. the write is atomic (`write_atomically`).
//!
//! The index is never touched: files are the source of truth, the running
//! app's watcher catches up, a closed app catches up on launch.

use std::path::PathBuf;

use crate::domain::block::{
    body_without_media_embeds, iter_inline_media_sources, parse_markdown_document, DateTime,
};
use crate::domain::collection::{normalize_collection_ref, patch_collections_frontmatter};
use crate::domain::vault::VaultLayout;
use crate::storage::files::write_atomically;

/// Front-matter fields the CLI may set. Everything else is either managed
/// (`Mine Collections`, `file`, `saved_at`) or unknown — both are refused.
pub const SETTABLE_FIELDS: &[&str] = &["title", "description", "url", "author", "source"];

pub struct MutationOutcome {
    /// What changed, для отчёта и dry-run.
    pub summary: String,
    /// True when nothing was written (dry-run or no-op).
    pub dry_run: bool,
}

pub enum MutationError {
    Usage(String),
    NotFound(String),
    Refused(String),
    Internal(String),
}

impl MutationError {
    pub fn message(&self) -> &str {
        match self {
            Self::Usage(m) | Self::NotFound(m) | Self::Refused(m) | Self::Internal(m) => m,
        }
    }
}

fn read_card(vault: &VaultLayout, slug: &str) -> Result<(PathBuf, String), MutationError> {
    let path = vault.block_path(slug);
    let content = std::fs::read_to_string(&path)
        .map_err(|_| MutationError::NotFound(format!("no card {slug}")))?;
    Ok((path, content))
}

/// The byte range of the front-matter block, excluding both fences.
fn frontmatter_span(content: &str) -> Option<(usize, usize)> {
    let after_open = content.strip_prefix("---\n")?;
    let close = after_open.find("\n---")?;
    Some((4, 4 + close))
}

fn saved_at_of(content: &str) -> Option<String> {
    let (start, end) = frontmatter_span(content)?;
    content[start..end]
        .lines()
        .find_map(|line| line.strip_prefix("saved_at:").map(|v| v.trim().to_string()))
}

/// Every guard a patched card must clear before it may touch the disk.
fn verify_patched(
    slug: &str,
    old_content: &str,
    new_content: &str,
) -> Result<(), MutationError> {
    // Front matter cannot disappear.
    if frontmatter_span(old_content).is_some() && frontmatter_span(new_content).is_none() {
        return Err(MutationError::Refused(
            "the patch would drop the front matter — refused".into(),
        ));
    }
    // saved_at cannot change.
    if saved_at_of(old_content) != saved_at_of(new_content) {
        return Err(MutationError::Refused(
            "the patch would change saved_at — refused".into(),
        ));
    }
    // The result must still parse.
    parse_markdown_document(slug, new_content, DateTime::new("2000-01-01").unwrap())
        .map_err(|e| MutationError::Refused(format!("the patched card no longer parses: {e}")))?;
    Ok(())
}

fn backup_path(vault: &VaultLayout, slug: &str) -> PathBuf {
    vault
        .derived_root()
        .join("cli-backups")
        .join(format!("{slug}.md"))
}

/// Write with the full guard chain: verify, back up, atomic replace.
fn guarded_write(
    vault: &VaultLayout,
    slug: &str,
    path: &std::path::Path,
    old_content: &str,
    new_content: &str,
    summary: String,
    dry_run: bool,
) -> Result<MutationOutcome, MutationError> {
    if old_content == new_content {
        return Ok(MutationOutcome { summary: "no change".into(), dry_run: true });
    }
    verify_patched(slug, old_content, new_content)?;
    if dry_run {
        return Ok(MutationOutcome { summary: format!("would apply: {summary}"), dry_run: true });
    }
    let backup = backup_path(vault, slug);
    if let Some(parent) = backup.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| MutationError::Internal(format!("backup dir: {e}")))?;
    }
    std::fs::write(&backup, old_content)
        .map_err(|e| MutationError::Internal(format!("backup write: {e}")))?;
    write_atomically(path, new_content.as_bytes())
        .map_err(|e| MutationError::Internal(format!("write: {e:#}")))?;
    Ok(MutationOutcome { summary, dry_run: false })
}

/// yaml_quote lives in domain::block privately; the CLI reuses the same rules
/// through serialization of a single field line.
fn yaml_field_line(field: &str, value: &str) -> String {
    format!("{field}: {}", crate::domain::block::yaml_quote_public(value))
}

/// Set or replace one known front-matter field, byte-surgically.
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
    let Some((start, end)) = frontmatter_span(&content) else {
        return Err(MutationError::Refused(
            "this note has no front matter; the CLI does not invent one".into(),
        ));
    };
    let fm = &content[start..end];
    let prefix = format!("{field}:");
    let mut lines: Vec<&str> = fm.lines().collect();
    let existing = lines.iter().position(|line| line.starts_with(&prefix));
    let new_line;
    let summary;
    match (existing, value) {
        (Some(i), Some(v)) => {
            new_line = yaml_field_line(field, v);
            summary = format!("{field}: {:?} -> {v:?}", lines[i].trim_start_matches(&prefix).trim());
            lines[i] = &new_line;
        }
        (None, Some(v)) => {
            new_line = yaml_field_line(field, v);
            summary = format!("{field}: (absent) -> {v:?}");
            lines.push(&new_line);
        }
        (Some(i), None) => {
            summary = format!("{field}: {:?} -> (absent)", lines[i].trim_start_matches(&prefix).trim());
            lines.remove(i);
        }
        (None, None) => {
            return Ok(MutationOutcome { summary: format!("{field} already absent"), dry_run: true });
        }
    }
    let new_fm = lines.join("\n");
    let new_content = format!("{}{}{}", &content[..start], new_fm, &content[end..]);
    guarded_write(vault, slug, &path, &content, &new_content, summary, dry_run)
}

/// Replace the body wholesale, keeping the front matter byte-identical.
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
    let (old_body_start, old_body) = match frontmatter_span(&content) {
        Some((_, end)) => {
            // Past the closing fence line.
            let after = content[end..].find('\n').map(|i| end + i + 1).unwrap_or(content.len());
            let after = content[after..]
                .find('\n')
                .map(|i| after + i + 1)
                .unwrap_or(content.len());
            (after, &content[after..])
        }
        None => (0, content.as_str()),
    };

    let old_embeds: Vec<String> = iter_inline_media_sources(old_body);
    let new_embeds: Vec<String> = iter_inline_media_sources(new_body);
    if !allow_media_changes {
        let mut lost: Vec<&String> =
            old_embeds.iter().filter(|e| !new_embeds.contains(e)).collect();
        lost.dedup();
        if !lost.is_empty() {
            return Err(MutationError::Refused(format!(
                "the new body loses media embeds: {}; pass --allow-media-changes to do this deliberately",
                lost.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            )));
        }
    }

    let mut new_content = content[..old_body_start].to_string();
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
    guarded_write(vault, slug, &path, &content, &new_content, summary, dry_run)
}

/// Connect or disconnect a card and a collection — the only door to
/// `Mine Collections`.
pub fn set_collection_membership(
    vault: &VaultLayout,
    slug: &str,
    collection: &str,
    connected: bool,
    dry_run: bool,
) -> Result<MutationOutcome, MutationError> {
    let (path, content) = read_card(vault, slug)?;
    let collection_ref = normalize_collection_ref(collection);
    if collection_ref.is_empty() {
        return Err(MutationError::Usage("empty collection name".into()));
    }
    let parsed = parse_markdown_document(slug, &content, DateTime::new("2000-01-01").unwrap())
        .map_err(|e| MutationError::Refused(format!("card does not parse: {e}")))?;
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
    let new_content = patch_collections_frontmatter(&content, &tags)
        .map_err(MutationError::Internal)?;
    let verb = if connected { "connect" } else { "disconnect" };
    guarded_write(
        vault,
        slug,
        &path,
        &content,
        &new_content,
        format!("{verb} {collection_ref}"),
        dry_run,
    )
}

/// Bring back the version saved before the last CLI mutation of this card.
pub fn restore(vault: &VaultLayout, slug: &str) -> Result<MutationOutcome, MutationError> {
    let backup = backup_path(vault, slug);
    let previous = std::fs::read_to_string(&backup)
        .map_err(|_| MutationError::NotFound(format!("no CLI backup for {slug}")))?;
    let path = vault.block_path(slug);
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    // The swap keeps one level of undo in both directions.
    std::fs::write(&backup, &current)
        .map_err(|e| MutationError::Internal(format!("backup swap: {e}")))?;
    write_atomically(&path, previous.as_bytes())
        .map_err(|e| MutationError::Internal(format!("restore write: {e:#}")))?;
    Ok(MutationOutcome { summary: format!("restored {slug} from the CLI backup"), dry_run: false })
}
