// Importer: converts Are.na blocks into local vault blocks.
//
// For each Are.na block: creates a .md file with frontmatter,
// downloads media/thumbnail if available, generates local thumbnail.
// Reports progress via callback for each imported block.

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;

use crate::domain::block::{suggest_slug, Block, BlockType, DateTime, Frontmatter};
use crate::domain::vault::VaultLayout;
use crate::import::arena_api::{self, ArenaBlock};
use crate::storage::{files, index, thumbnails};

// ─── Types ───────────────────────────────────────────────────────────────────

/// Result of importing a single channel.
#[derive(Debug, Clone, Serialize)]
pub struct ImportChannelResult {
    pub channel_slug: String,
    pub channel_title: String,
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// Progress update for a single block import.
#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub channel_slug: String,
    pub current: usize,
    pub total: usize,
    pub block_title: Option<String>,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Import all blocks from an Are.na channel into the vault.
///
/// - `channel_slug`: Are.na channel slug (from URL)
/// - `tag`: local tag to assign to all imported blocks
/// - `on_progress`: called for each block with progress info
pub fn import_channel<F>(
    conn: &Connection,
    vault: &VaultLayout,
    channel_slug: &str,
    tag: &str,
    on_progress: F,
) -> Result<ImportChannelResult>
where
    F: Fn(ImportProgress),
{
    let arena_blocks = arena_api::fetch_channel_blocks(channel_slug)
        .with_context(|| format!("failed to fetch channel {}", channel_slug))?;

    let total = arena_blocks.len();
    let mut imported = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();

    // Track slugs created during this import session to avoid conflicts
    let mut session_slugs: HashSet<String> = HashSet::new();

    for (i, arena_block) in arena_blocks.iter().enumerate() {
        let block_title = arena_block.title.clone();

        on_progress(ImportProgress {
            channel_slug: channel_slug.to_string(),
            current: i + 1,
            total,
            block_title: block_title.clone(),
        });

        match import_single_block(conn, vault, arena_block, tag, &mut session_slugs) {
            Ok(_) => imported += 1,
            Err(e) => {
                let msg = format!(
                    "block {} ({}): {:#}",
                    arena_block.id,
                    block_title.as_deref().unwrap_or("untitled"),
                    e
                );
                log::warn!("import error: {}", msg);
                errors.push(msg);
                skipped += 1;
            }
        }
    }

    Ok(ImportChannelResult {
        channel_slug: channel_slug.to_string(),
        channel_title: tag.to_string(),
        imported,
        skipped,
        errors,
    })
}

// ─── Private ─────────────────────────────────────────────────────────────────

fn import_single_block(
    conn: &Connection,
    vault: &VaultLayout,
    arena_block: &ArenaBlock,
    tag: &str,
    session_slugs: &mut HashSet<String>,
) -> Result<()> {
    let block_type = map_block_type(&arena_block.class);
    let title = arena_block.title.clone();
    let url = arena_block.source.as_ref().and_then(|s| s.url.clone());

    // Generate unique slug (check DB + session-local set)
    let raw_slug = suggest_slug(title.as_deref(), url.as_deref());
    let slug = {
        if !session_slugs.contains(&raw_slug) && !index::slug_exists(conn, &raw_slug)? {
            raw_slug
        } else {
            let mut found = None;
            for n in 2..=1000u32 {
                let candidate = format!("{}-{}", raw_slug, n);
                if !session_slugs.contains(&candidate) && !index::slug_exists(conn, &candidate)? {
                    found = Some(candidate);
                    break;
                }
            }
            found.ok_or_else(|| {
                anyhow::anyhow!(
                    "could not resolve slug conflict for '{}' after 1000 attempts",
                    raw_slug
                )
            })?
        }
    };
    session_slugs.insert(slug.clone());

    // Download media file if applicable
    let (media_file, media_ext) = download_media(vault, &slug, arena_block)?;

    // Download thumbnail for links
    let thumbnail = if block_type == BlockType::Link {
        download_thumbnail(vault, &slug, arena_block)?
    } else {
        None
    };

    // Generate local thumbnail for images
    if block_type == BlockType::Image {
        if let Some(ref ext) = media_ext {
            let media_path = vault.media_path(&slug, ext);
            if media_path.exists() {
                let thumb_path = vault.thumb_path(&slug);
                let _ = thumbnails::generate_thumbnail(
                    &media_path,
                    &thumb_path,
                    thumbnails::DEFAULT_MAX_SIZE,
                );
            }
        }
    }

    // Parse saved_at
    let saved_at_str = normalize_datetime(&arena_block.created_at);
    let saved_at = DateTime::new(&saved_at_str)
        .unwrap_or_else(|_| DateTime::new("2026-01-01T00:00:00Z").unwrap());

    // Build block
    let block = Block {
        slug: slug.clone(),
        frontmatter: Frontmatter {
            block_type,
            title,
            description: arena_block.description.clone(),
            url,
            file: media_file,
            thumbnail,
            tags: vec![tag.to_string()],
            related_notes: Vec::new(),
            source_media: None,
            saved_at,
            source: Some("arena-import".to_string()),
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        },
        body: extract_body(arena_block),
    };

    // Write .md file
    files::write_block_file(vault, &block)?;

    // Index
    index::upsert_block(conn, &block, Some(vault.root()))?;

    Ok(())
}

/// Map Are.na block class to local BlockType.
fn map_block_type(arena_class: &str) -> BlockType {
    match arena_class {
        "Image" => BlockType::Image,
        "Text" => BlockType::Article,
        "Link" => BlockType::Link,
        "Media" => BlockType::Video,
        "Attachment" => BlockType::File,
        _ => BlockType::Link,
    }
}

/// Download the main media file (image or attachment).
/// Returns (file_name, extension) if successful.
fn download_media(
    vault: &VaultLayout,
    slug: &str,
    arena_block: &ArenaBlock,
) -> Result<(Option<String>, Option<String>)> {
    let (url, fallback_ext) = match arena_block.class.as_str() {
        "Image" => {
            let img_url = arena_block
                .image
                .as_ref()
                .and_then(|i| i.original.as_ref())
                .map(|v| v.url.as_str());
            match img_url {
                Some(u) => (u.to_string(), arena_api::ext_from_url(u)),
                None => return Ok((None, None)),
            }
        }
        "Attachment" => {
            let att_url = arena_block.attachment.as_ref().map(|a| a.url.as_str());
            match att_url {
                Some(u) => (u.to_string(), arena_api::ext_from_url(u)),
                None => return Ok((None, None)),
            }
        }
        _ => return Ok((None, None)),
    };

    let bytes = arena_api::download_file(&url)?;
    let ext = &fallback_ext;
    let dest = vault.media_path(slug, ext);
    std::fs::write(&dest, &bytes)
        .with_context(|| format!("failed to write media file: {}", dest.display()))?;

    let file_name = format!("{}.{}", slug, ext);
    Ok((Some(file_name), Some(ext.clone())))
}

/// Download thumbnail for link blocks from Are.na's thumb image.
fn download_thumbnail(
    vault: &VaultLayout,
    slug: &str,
    arena_block: &ArenaBlock,
) -> Result<Option<String>> {
    let thumb_url = arena_block
        .image
        .as_ref()
        .and_then(|i| i.thumb.as_ref())
        .map(|v| v.url.as_str());

    let url = match thumb_url {
        Some(u) => u,
        None => return Ok(None),
    };

    match arena_api::download_file(url) {
        Ok(bytes) => {
            let ext = arena_api::ext_from_url(url);
            let thumb_name = format!("{}-thumb.{}", slug, ext);
            let dest = vault.root().join(&thumb_name);
            std::fs::write(&dest, &bytes)
                .with_context(|| format!("failed to write thumbnail: {}", dest.display()))?;
            Ok(Some(thumb_name))
        }
        Err(e) => {
            log::warn!("failed to download thumbnail for {}: {:#}", slug, e);
            Ok(None)
        }
    }
}

/// Extract body text from an Are.na block (for text/article blocks).
fn extract_body(arena_block: &ArenaBlock) -> String {
    if arena_block.class == "Text" {
        arena_block.content.clone().unwrap_or_default()
    } else {
        String::new()
    }
}

/// Normalize an ISO 8601 datetime string.
/// Removes milliseconds and ensures Z suffix.
fn normalize_datetime(dt: &str) -> String {
    // Are.na returns "2024-03-15T10:30:00.000Z" or similar
    // Our DateTime expects "2024-03-15T10:30:00Z" or "2024-03-15T10:30:00+03:00"
    if let Some(dot_pos) = dt.find('.') {
        // Remove fractional seconds
        let before = &dt[..dot_pos];
        // Find the timezone part after the fractional seconds
        let after = &dt[dot_pos..];
        let tz = if after.contains('Z') {
            "Z"
        } else if let Some(plus_pos) = after.rfind('+') {
            &after[plus_pos..]
        } else if let Some(minus_pos) = after.rfind('-') {
            &after[minus_pos..]
        } else {
            "Z"
        };
        format!("{}{}", before, tz)
    } else {
        dt.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_datetime_with_millis() {
        assert_eq!(
            normalize_datetime("2024-03-15T10:30:00.000Z"),
            "2024-03-15T10:30:00Z"
        );
    }

    #[test]
    fn normalize_datetime_without_millis() {
        assert_eq!(
            normalize_datetime("2024-03-15T10:30:00Z"),
            "2024-03-15T10:30:00Z"
        );
    }

    #[test]
    fn normalize_datetime_with_offset() {
        assert_eq!(
            normalize_datetime("2024-03-15T10:30:00.123+03:00"),
            "2024-03-15T10:30:00+03:00"
        );
    }

    #[test]
    fn map_arena_types() {
        assert_eq!(map_block_type("Image"), BlockType::Image);
        assert_eq!(map_block_type("Text"), BlockType::Article);
        assert_eq!(map_block_type("Link"), BlockType::Link);
        assert_eq!(map_block_type("Media"), BlockType::Video);
        assert_eq!(map_block_type("Attachment"), BlockType::File);
        assert_eq!(map_block_type("Unknown"), BlockType::Link);
    }
}
