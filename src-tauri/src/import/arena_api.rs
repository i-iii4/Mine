// Are.na API client: fetches channels and blocks.
//
// Uses ureq for synchronous HTTP. All endpoints are public
// (no authentication required for public channels).
// Rate-limited: 200ms between requests.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::thread;
use std::time::Duration;

const API_BASE: &str = "https://api.are.na/v2";
const PER_PAGE: usize = 50;
const RATE_LIMIT_MS: u64 = 300;

// ─── API response types ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ArenaChannel {
    pub id: i64,
    pub title: String,
    pub slug: String,
    pub length: i64,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ArenaBlock {
    pub id: i64,
    pub title: Option<String>,
    pub description: Option<String>,
    pub content: Option<String>,
    pub source: Option<ArenaSource>,
    pub image: Option<ArenaImage>,
    pub attachment: Option<ArenaAttachment>,
    pub class: String,
    pub base_class: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ArenaSource {
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ArenaImage {
    pub original: Option<ArenaImageVariant>,
    pub thumb: Option<ArenaImageVariant>,
}

#[derive(Debug, Deserialize)]
pub struct ArenaImageVariant {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ArenaAttachment {
    pub url: String,
    pub file_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChannelsResponse {
    channels: Vec<ArenaChannel>,
    #[allow(dead_code)]
    length: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ContentsResponse {
    contents: Vec<serde_json::Value>,
    #[allow(dead_code)]
    length: Option<i64>,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Fetch all public channels for a user.
pub fn fetch_user_channels(username: &str) -> Result<Vec<ArenaChannel>> {
    let mut all_channels = Vec::new();
    let mut page = 1;

    loop {
        let url = format!(
            "{}/users/{}/channels?page={}&per={}",
            API_BASE, username, page, PER_PAGE
        );

        log::info!("fetching arena channels: {}", url);

        let response: ChannelsResponse = ureq::get(&url)
            .call()
            .with_context(|| format!("failed to fetch Are.na channels for {}", username))?
            .into_json()
            .context("failed to parse Are.na channels response")?;

        let count = response.channels.len();
        all_channels.extend(response.channels);

        if count < PER_PAGE {
            break;
        }

        page += 1;
        thread::sleep(Duration::from_millis(RATE_LIMIT_MS));
    }

    Ok(all_channels)
}

/// Fetch all blocks from a channel, paginating automatically.
/// Skips connected channels (base_class == "Channel").
pub fn fetch_channel_blocks(channel_slug: &str) -> Result<Vec<ArenaBlock>> {
    let mut all_blocks = Vec::new();
    let mut page = 1;

    loop {
        let url = format!(
            "{}/channels/{}/contents?page={}&per={}",
            API_BASE, channel_slug, page, PER_PAGE
        );

        log::info!("fetching arena blocks: {} page {}", channel_slug, page);

        let response: ContentsResponse = ureq::get(&url)
            .call()
            .with_context(|| format!("failed to fetch blocks for channel {}", channel_slug))?
            .into_json()
            .context("failed to parse channel contents")?;

        let count = response.contents.len();

        for value in response.contents {
            // Skip connected channels
            let base_class = value.get("base_class").and_then(|v| v.as_str());
            let class = value.get("class").and_then(|v| v.as_str());
            if base_class == Some("Channel") || class == Some("Channel") {
                continue;
            }

            match serde_json::from_value::<ArenaBlock>(value) {
                Ok(block) => all_blocks.push(block),
                Err(e) => log::warn!("skipping unparseable block: {e}"),
            }
        }

        if count < PER_PAGE {
            break;
        }

        page += 1;
        thread::sleep(Duration::from_millis(RATE_LIMIT_MS));
    }

    Ok(all_blocks)
}

/// Download a file from a URL and return the raw bytes.
pub fn download_file(url: &str) -> Result<Vec<u8>> {
    log::info!("downloading: {}", url);

    let response = ureq::get(url)
        .call()
        .with_context(|| format!("failed to download {}", url))?;

    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read response body from {}", url))?;

    Ok(bytes)
}

/// Extract file extension from a URL path.
/// Falls back to "jpg" if extraction fails.
pub fn ext_from_url(url: &str) -> String {
    // Strip query string and fragment
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);

    path.rsplit('.')
        .next()
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "jpg".to_string())
}
