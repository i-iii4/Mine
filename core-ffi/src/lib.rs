// UniFFI bindings for Local Arena core.
//
// Exposes domain and storage functionality to Swift/iOS via FFI.
// Types are mapped to UniFFI-compatible wrappers (Record, Object, Error).

uniffi::setup_scaffolding!();

use mine_lib::domain::block::parse_block;
use mine_lib::storage::{db, index};
use std::path::PathBuf;
use std::sync::Mutex;

// ─── Types ──────────────────────────────────────────────────────────────────

/// Lightweight block for grid/list views (mirrors LightBlock from index.rs).
#[derive(uniffi::Record)]
pub struct FfiLightBlock {
    pub id: i64,
    pub slug: String,
    pub block_type: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub media_file: Option<String>,
    pub thumbnail: Option<String>,
    pub author: Option<String>,
    pub body: String,
    pub saved_at: String,
    pub first_image: Option<String>,
    pub media_urls: Option<String>,
    pub tags: Vec<String>,
}

/// Error type exposed to Swift.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum ArenaError {
    #[error("Database error: {msg}")]
    Database { msg: String },
    #[error("Parse error: {msg}")]
    Parse { msg: String },
    #[error("IO error: {msg}")]
    Io { msg: String },
}

// ─── Vault handle ───────────────────────────────────────────────────────────

/// Main entry point for iOS app. Wraps a SQLite connection to the vault index.
/// UniFFI Object = passed by reference (Arc), safe across threads via Mutex.
#[derive(uniffi::Object)]
pub struct ArenaVault {
    conn: Mutex<rusqlite::Connection>,
    vault_path: String,
}

#[uniffi::export]
impl ArenaVault {
    /// Open (or create) a vault at the given path.
    #[uniffi::constructor]
    fn open(vault_path: String) -> Result<Self, ArenaError> {
        let db_path = PathBuf::from(&vault_path).join(".arena").join("index.db");
        let conn = db::open_or_create(&db_path)
            .map_err(|e| ArenaError::Database { msg: e.to_string() })?;
        Ok(Self {
            conn: Mutex::new(conn),
            vault_path,
        })
    }

    /// List all blocks (lightweight, for grid views).
    fn list_blocks(&self) -> Result<Vec<FfiLightBlock>, ArenaError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| ArenaError::Database { msg: e.to_string() })?;
        let blocks = index::list_blocks_light(&conn)
            .map_err(|e| ArenaError::Database { msg: e.to_string() })?;
        Ok(blocks.into_iter().map(light_block_to_ffi).collect())
    }

    /// Scan all .md files in vault and index them in SQLite.
    /// Must be called after open() to populate the database.
    fn scan_vault(&self) -> Result<u32, ArenaError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| ArenaError::Database { msg: e.to_string() })?;

        let vault_dir = PathBuf::from(&self.vault_path);
        let entries =
            std::fs::read_dir(&vault_dir).map_err(|e| ArenaError::Io { msg: e.to_string() })?;

        let mut count = 0u32;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Ok((slug, content)) = mine_lib::storage::files::read_block_file(&path) {
                match mine_lib::domain::block::parse_block(&slug, &content) {
                    Ok(block) => {
                        if block.frontmatter.block_type
                            == mine_lib::domain::block::BlockType::Channel
                        {
                            let _ = index::upsert_channel_from_block(&conn, &block);
                        } else {
                            let _ = index::upsert_block(&conn, &block);
                        }
                        count += 1;
                    }
                    Err(_) => continue,
                }
            }
        }
        Ok(count)
    }

    /// Get the vault path.
    fn vault_path(&self) -> String {
        self.vault_path.clone()
    }
}

// ─── Standalone functions ───────────────────────────────────────────────────

/// Parse a .md file content into a block. Useful for testing and direct file reads.
#[uniffi::export]
fn parse_block_file(slug: String, content: String) -> Result<FfiLightBlock, ArenaError> {
    let block =
        parse_block(&slug, &content).map_err(|e| ArenaError::Parse { msg: e.to_string() })?;
    Ok(FfiLightBlock {
        id: 0,
        slug: block.slug,
        block_type: block.frontmatter.block_type.as_str().to_string(),
        title: block.frontmatter.title,
        url: block.frontmatter.url,
        media_file: block.frontmatter.file,
        thumbnail: block.frontmatter.thumbnail,
        author: block.frontmatter.author,
        body: block.body,
        saved_at: block.frontmatter.saved_at.as_str().to_string(),
        first_image: None,
        media_urls: None,
        tags: block.frontmatter.tags,
    })
}

// ─── Internal helpers ───────────────────────────────────────────────────────

fn light_block_to_ffi(b: index::LightBlock) -> FfiLightBlock {
    FfiLightBlock {
        id: b.id,
        slug: b.slug,
        block_type: b.block_type.as_str().to_string(),
        title: b.title,
        url: b.url,
        media_file: b.media_file,
        thumbnail: b.thumbnail,
        author: b.author,
        body: b.body,
        saved_at: b.saved_at,
        first_image: b.first_image,
        media_urls: b.media_urls,
        tags: b.tags,
    }
}
