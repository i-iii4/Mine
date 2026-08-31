//! Shared capture construction and publication/recovery decisions.
//!
//! Executors supply prepared media, observed files, time and operation identity.
//! No operation here reads a filesystem, clock, database or network.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::block::{
    derive_block_type, ensure_body_starts_with_h1, parse_block, serialize_block, suggest_slug,
    Block, BlockType, DateTime, Frontmatter,
};
use crate::domain::collection::{normalize_collection_ref, validate_collection_ref};
use crate::domain::vault::{resolve_card_name_conflict, validate_slug, VaultWriteLayout};
pub use crate::domain::vault::VaultWriteLayout as CoreLayout;

/// A prepared capture. Resource acquisition belongs to the executor.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct CaptureRequest {
    #[serde(default)]
    pub slug: String,
    pub block_type: String,
    #[serde(default)]
    pub intent: CaptureIntent,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub body: String,
    pub file: Option<String>,
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub saved_at: String,
    pub source: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub author: Option<String>,
}

/// The existing client intent, separate from the derived document type.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CaptureIntent {
    /// Browser extraction keeps its missing-content and required-media checks.
    #[default]
    WebClip,
    /// A local paste/import preserves its body; the title is a filename seed.
    Desktop,
    /// An explicit CLI title is content for a text note, not generated metadata.
    Manual,
}

/// Transport outcomes do not confuse an unobserved result with a rejected save.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SaveOutcome { Committed, NotCommitted, Unknown }

/// A started operation cannot move between these executors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SaveExecutor { Native, Browser }

/// A machine-readable core failure, safe to expose across the native/WASM bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, thiserror::Error)]
#[error("{code}: {message}")]
pub struct SaveError {
    pub code: SaveErrorCode,
    pub message: String,
}

/// Stable failure categories; clients never infer state from error text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SaveErrorCode {
    InvalidRequest,
    InvalidPath,
    InvalidCollection,
    MissingContent,
    MissingMedia,
    NameConflict,
    UnknownOutcome,
}

impl std::fmt::Display for SaveErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

fn failure(code: SaveErrorCode, message: impl ToString) -> SaveError {
    SaveError { code, message: message.to_string() }
}

/// Normalize and validate collection references while preserving their order.
pub fn normalize_collections(values: &[String]) -> Result<Vec<String>, SaveError> {
    let mut collections = Vec::new();
    for value in values {
        let normalized = normalize_collection_ref(value);
        if normalized.is_empty() { continue; }
        let checked = validate_collection_ref(&normalized)
            .map_err(|error| failure(SaveErrorCode::InvalidCollection, error))?;
        if !collections.contains(&checked) { collections.push(checked); }
    }
    Ok(collections)
}

/// Whether the page represents a social post rather than a headed article.
pub fn is_social_status_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false; };
    let host = url.host_str().unwrap_or_default().trim_start_matches("www.");
    let path = url.path();
    ((host == "twitter.com" || host == "x.com" || host == "mobile.twitter.com")
        && path.contains("/status/"))
        || (host == "instagram.com"
            && ["/p/", "/reel/", "/stories/"].iter().any(|prefix| path.starts_with(prefix)))
}

/// Shared heading policy for every capture entry point.
pub fn should_write_body_h1(kind: BlockType, url: Option<&str>) -> bool {
    let social = url.is_some_and(is_social_status_url);
    match kind {
        BlockType::Link => true,
        BlockType::Article => !social,
        BlockType::Video => url.is_some() && !social,
        BlockType::Image | BlockType::File | BlockType::Channel => false,
    }
}

/// Validate extraction semantics before an executor acquires resources. The
/// same check runs again on prepared content before source construction.
pub fn validate_capture_input(intent: CaptureIntent, kind: &str, body: &str, has_media: bool) -> Result<(), SaveError> {
    if intent == CaptureIntent::WebClip {
        let kind = BlockType::from_str(kind)
            .map_err(|error| failure(SaveErrorCode::InvalidRequest, error))?;
        if kind == BlockType::Channel {
            return Err(failure(SaveErrorCode::InvalidRequest, "use collection creation for channels"));
        }
        if kind == BlockType::Article && body.trim().is_empty() {
        return Err(failure(SaveErrorCode::MissingContent, "article block requires non-empty extracted content"));
        }
        if kind == BlockType::Image && !has_media {
        return Err(failure(SaveErrorCode::MissingMedia, "image block requires a media file or thumbnail"));
        }
    }
    Ok(())
}

/// Build the canonical document from content prepared by any executor.
pub fn build_capture(request: &CaptureRequest) -> Result<Block, SaveError> {
    validate_slug(&request.slug).map_err(|error| failure(SaveErrorCode::InvalidPath, error))?;
    validate_capture_input(request.intent, &request.block_type, &request.body, request.file.is_some() || request.thumbnail.is_some())?;
    let kind = if request.intent == CaptureIntent::WebClip {
        BlockType::from_str(&request.block_type).map_err(|error| failure(SaveErrorCode::InvalidRequest, error))?
    } else { BlockType::Article };
    for reference in [&request.file, &request.thumbnail].into_iter().flatten() {
        validate_slug(reference).map_err(|error| failure(SaveErrorCode::InvalidPath, error))?;
    }
    let write_heading = match request.intent {
        CaptureIntent::WebClip => !request.body.trim().is_empty()
            && should_write_body_h1(kind, request.url.as_deref()),
        CaptureIntent::Desktop => false,
        CaptureIntent::Manual => request.file.is_none() || !request.body.trim().is_empty(),
    };
    let body = if write_heading {
        ensure_body_starts_with_h1(&request.body, request.title.as_deref().unwrap_or_default())
    } else { request.body.clone() };
    let mut block = Block {
        slug: request.slug.clone(),
        frontmatter: Frontmatter {
            block_type: kind,
            title: None,
            description: request.description.clone(),
            url: request.url.clone(),
            file: request.file.clone(),
            thumbnail: request.thumbnail.clone(),
            tags: normalize_collections(&request.tags)?,
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new(&request.saved_at)
                .map_err(|error| failure(SaveErrorCode::InvalidRequest, error))?,
            source: request.source.clone(),
            width: request.width,
            height: request.height,
            author: request.author.clone(),
            position: None, color: None, icon: None,
        },
        body,
    };
    block.frontmatter.block_type = derive_block_type(&block.frontmatter, &block.body);
    Ok(block)
}

/// Select a filename using the same namespace in native and browser clients.
pub fn select_name(layout: &VaultWriteLayout, title: Option<&str>, url: Option<&str>, existing: &[String]) -> Result<String, SaveError> {
    let layout = layout.validate().map_err(|error| failure(SaveErrorCode::InvalidPath, error))?;
    let existing: HashSet<String> = existing.iter().cloned().collect();
    resolve_card_name_conflict(&layout, &suggest_slug(title, url), &existing)
        .map_err(|error| failure(SaveErrorCode::NameConflict, error))
}

/// Durable phases. Publishing intent is recorded before a filesystem side effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SavePhase { Prepared, MediaPublishing, MediaPublished, MarkdownPublishing, SourceCommitted, Committed }

/// What the executor can actually establish about the expected Markdown file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PublicationEvidence { NotRequired, Missing, Matches, Conflict, Unreadable }

/// Filesystem observations, never optimistic predictions.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SaveEvidence { pub markdown: PublicationEvidence, pub media: PublicationEvidence }

/// The next domain decision; platform code performs only its concrete effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SaveAction { PublishMedia, PublishMarkdown, PersistReceipt, ReturnCommitted, UnknownOutcome, NameConflict }

/// Decide save/recovery without treating a lost acknowledgement as a failed write.
pub fn next_save_action(phase: SavePhase, evidence: &SaveEvidence) -> SaveAction {
    use PublicationEvidence::{Matches, Missing, NotRequired};
    use SaveAction::*;
    // A durable receipt records the completed operation, not ownership of the
    // document forever. Later user edits/deletion must not turn replay into a write.
    if phase == SavePhase::Committed { return ReturnCommitted; }
    let media_ready = matches!(evidence.media, Matches | NotRequired);
    if matches!(phase, SavePhase::MediaPublishing | SavePhase::MediaPublished) && !media_ready { return UnknownOutcome; }
    if matches!(phase, SavePhase::MarkdownPublishing | SavePhase::SourceCommitted) {
        if evidence.markdown != Matches || !media_ready { return UnknownOutcome; }
        return PersistReceipt;
    }
    if evidence.markdown != Missing {
        return if evidence.markdown == PublicationEvidence::Unreadable { UnknownOutcome } else { NameConflict };
    }
    if evidence.media == PublicationEvidence::Unreadable { return UnknownOutcome; }
    if phase == SavePhase::Prepared && matches!(evidence.media, Matches | PublicationEvidence::Conflict) { return NameConflict; }
    if media_ready { PublishMarkdown } else { PublishMedia }
}

/// A stable fingerprint of the semantic request, independent of map-key ordering.
pub fn request_fingerprint(value: &serde_json::Value) -> String {
    // serde_json's default Map is a BTreeMap; canonicalize recursively even if
    // a downstream package enables preserve_order through feature unification.
    fn canonical(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::Object(map) => {
                let mut entries: Vec<_> = map.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                format!("{{{}}}", entries.into_iter().map(|(key, value)|
                    format!("{}:{}", serde_json::Value::String(key.clone()), canonical(value))
                ).collect::<Vec<_>>().join(","))
            }
            serde_json::Value::Array(values) => format!("[{}]", values.iter().map(canonical).collect::<Vec<_>>().join(",")),
            other => other.to_string(),
        }
    }
    format!("{:x}", Sha256::digest(canonical(value).as_bytes()))
}

/// Hash prepared source bytes for recovery verification.
pub fn content_hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

/// Commands supported by the JSON/WASM bridge, generated into TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CoreCommand {
    Capture { request: CaptureRequest },
    Name { title: Option<String>, url: Option<String>, layout: CoreLayout, existing: Vec<String> },
    Layout { layout: CoreLayout },
    DetectLayout { stored: Option<CoreLayout>, empty: bool, cards: bool, media: bool, collections: bool },
    Collection { slug: String, saved_at: String },
    Inspect { slug: String, markdown: String },
    Advance { phase: SavePhase, evidence: SaveEvidence },
    Fingerprint { value: String },
}

/// Execute a pure bridge command. Native fixtures and WASM use this same entry point.
pub fn execute(command: CoreCommand) -> Result<serde_json::Value, SaveError> {
    use serde_json::json;
    match command {
        CoreCommand::Capture { request } => {
            let block = build_capture(&request)?;
            let markdown = serialize_block(&block);
            Ok(json!({ "slug": block.slug, "markdown": markdown, "hash": content_hash(markdown.as_bytes()) }))
        }
        CoreCommand::Name { title, url, layout, existing } => {
            let layout = layout.validate().map_err(|e| failure(SaveErrorCode::InvalidPath, e))?;
            let name = select_name(&layout, title.as_deref(), url.as_deref(), &existing)?;
            Ok(json!({ "name": name, "slug": layout.new_card_slug(&name) }))
        }
        CoreCommand::Layout { layout } => {
            let layout = layout.validate().map_err(|e| failure(SaveErrorCode::InvalidPath, e))?;
            Ok(json!({ "cards": layout.cards, "media": layout.media, "collections": layout.collections }))
        }
        CoreCommand::DetectLayout { stored, empty, cards, media, collections } => {
            let layout = stored.unwrap_or_else(|| if empty {
                CoreLayout::standard()
            } else {
                CoreLayout::detect(crate::domain::vault::VaultLayoutFacts {
                    cards_dir: cards, media_dir: media, collections_dir: collections,
                })
            }).validate().map_err(|e| failure(SaveErrorCode::InvalidPath, e))?;
            Ok(json!(layout))
        }
        CoreCommand::Collection { slug, saved_at } => {
            validate_slug(&slug).map_err(|e| failure(SaveErrorCode::InvalidPath, e))?;
            let mut block = build_capture(&CaptureRequest { slug, block_type: "link".into(), saved_at, ..Default::default() })?;
            block.frontmatter.block_type = BlockType::Channel;
            Ok(json!({ "markdown": serialize_block(&block) }))
        }
        CoreCommand::Inspect { slug, markdown } => {
            let block = parse_block(&slug, &markdown).map_err(|e| failure(SaveErrorCode::InvalidRequest, e))?;
            Ok(json!({ "collection": block.frontmatter.block_type == BlockType::Channel }))
        }
        CoreCommand::Advance { phase, evidence } => Ok(json!(next_save_action(phase, &evidence))),
        CoreCommand::Fingerprint { value } => {
            let value = serde_json::from_str(&value).map_err(|e| failure(SaveErrorCode::InvalidRequest, e))?;
            Ok(json!(request_fingerprint(&value)))
        }
    }
}

/// JSON envelope, shared by the actual native and WebAssembly fixture runners.
pub fn execute_json(input: &str) -> String {
    let result = serde_json::from_str(input)
        .map_err(|error| failure(SaveErrorCode::InvalidRequest, error))
        .and_then(execute);
    match result {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }).to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> CaptureRequest {
        CaptureRequest { slug: "Cards/Example".into(), block_type: "article".into(),
            title: Some("Example".into()), body: "Text".into(),
            saved_at: "2026-08-31T12:00:00Z".into(), source: Some("web-clipper".into()), ..Default::default() }
    }
    #[test]
    fn desktop_capture_preserves_body_and_ignores_the_obsolete_declared_type() {
        let mut input = request();
        input.intent = CaptureIntent::Desktop;
        input.block_type = "unknown legacy value".into();
        input.body = "A pasted quote".into();
        let block = build_capture(&input).expect("local content is authoritative");
        assert_eq!(block.body, "A pasted quote");
        assert_eq!(block.frontmatter.title, None);
        input.body.clear();
        input.url = Some("https://example.com".into());
        assert!(build_capture(&input).expect("URL-only local capture remains valid").body.is_empty());
        input.url = None;
        assert!(build_capture(&input).is_ok(), "existing empty local create remains valid");
    }
    #[test]
    fn manual_title_only_becomes_body_content_without_legacy_title() {
        let mut input = request();
        input.intent = CaptureIntent::Manual;
        input.body.clear();
        let block = build_capture(&input).expect("title-only CLI creation remains valid");
        assert_eq!(block.body, "# Example");
        assert_eq!(block.frontmatter.title, None);
        input.body = "# Example\n\nText".into();
        assert_eq!(build_capture(&input).expect("existing H1 is retained").body, input.body);
    }
    #[test]
    fn manual_media_import_does_not_turn_its_filename_seed_into_a_heading() {
        let mut input = request();
        input.intent = CaptureIntent::Manual;
        input.file = Some("Example.jpg".into());
        input.body.clear();
        let block = build_capture(&input).expect("media-only CLI capture remains valid");
        assert!(block.body.is_empty());
        assert_eq!(block.frontmatter.title, None);
    }
    #[test]
    fn web_clip_still_rejects_missing_extracted_content() {
        let mut input = request();
        input.body.clear();
        assert_eq!(build_capture(&input).expect_err("missing article body").code, SaveErrorCode::MissingContent);
        input.block_type = "image".into();
        assert_eq!(build_capture(&input).expect_err("missing image").code, SaveErrorCode::MissingMedia);
    }
    #[test]
    fn capture_uses_body_heading_and_no_card_type_or_title_frontmatter() {
        let markdown = serialize_block(&build_capture(&request()).expect("valid fixture"));
        assert!(markdown.contains("# Example\n\nText"));
        assert!(!markdown.contains("type:")); assert!(!markdown.contains("title:"));
    }
    #[test]
    fn missing_article_or_image_material_is_rejected() {
        let mut input = request(); input.body.clear();
        assert_eq!(build_capture(&input).expect_err("empty article").code, SaveErrorCode::MissingContent);
        input.block_type = "image".into();
        assert_eq!(build_capture(&input).expect_err("missing image").code, SaveErrorCode::MissingMedia);
    }
    #[test]
    fn invalid_paths_and_collections_are_rejected_before_io() {
        let mut input = request(); input.slug = "../outside".into();
        assert_eq!(build_capture(&input).expect_err("outside").code, SaveErrorCode::InvalidPath);
        input.slug = "Safe".into(); input.tags = vec!["../outside".into()];
        assert!(build_capture(&input).is_err());
    }
    #[test]
    fn interrupted_publication_never_blindly_retries() {
        let missing = SaveEvidence { markdown: PublicationEvidence::Missing, media: PublicationEvidence::NotRequired };
        assert_eq!(next_save_action(SavePhase::Prepared, &missing), SaveAction::PublishMarkdown);
        assert_eq!(next_save_action(SavePhase::MarkdownPublishing, &missing), SaveAction::UnknownOutcome);
        let present = SaveEvidence { markdown: PublicationEvidence::Matches, media: PublicationEvidence::NotRequired };
        assert_eq!(next_save_action(SavePhase::MarkdownPublishing, &present), SaveAction::PersistReceipt);
        assert_eq!(next_save_action(SavePhase::Committed, &present), SaveAction::ReturnCommitted);
    }
    #[test]
    fn fingerprint_is_independent_of_object_key_order() {
        assert_eq!(request_fingerprint(&serde_json::json!({"a":1,"b":2})), request_fingerprint(&serde_json::json!({"b":2,"a":1})));
    }
}
