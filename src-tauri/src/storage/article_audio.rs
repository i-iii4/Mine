// Article audio derived artifacts: local ready/absent state, sidecar JSON,
// playback position persistence, and stale-artifact invalidation.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::domain::article_audio::{prepare_article_speech, PreparedArticleSpeech};
use crate::domain::block::{parse_markdown_document, Block, BlockType, DateTime};
use crate::domain::vault::VaultLayout;
use crate::storage::files;

const ARTICLE_AUDIO_FILE_EXTENSIONS: &[&str] = &["aiff", "caf", "m4a", "wav"];
const ARTICLE_AUDIO_FORMAT_VERSION: u8 = 2;
const DESKTOP_ARTICLE_AUDIO_BACKEND: &str = "apple_avspeech_v2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArticleAudioStatus {
    Absent,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArticleAudioState {
    pub status: ArticleAudioStatus,
    pub audio_path: Option<String>,
    pub duration_ms: Option<u64>,
    pub last_position_ms: u64,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoredArticleAudioState {
    format_version: u8,
    text_hash: String,
    #[serde(default)]
    generation_backend: Option<String>,
    #[serde(default)]
    voice_id: Option<String>,
    #[serde(default)]
    voice_name: Option<String>,
    audio_file_name: String,
    duration_ms: Option<u64>,
    last_position_ms: u64,
    completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArticleAudioPersistMetadata {
    pub generation_backend: String,
    pub voice_id: String,
    pub voice_name: String,
}

pub fn absent_state() -> ArticleAudioState {
    ArticleAudioState {
        status: ArticleAudioStatus::Absent,
        audio_path: None,
        duration_ms: None,
        last_position_ms: 0,
        completed_at: None,
    }
}

pub fn ensure_audio_dir(vault: &VaultLayout) -> Result<()> {
    std::fs::create_dir_all(vault.audio_dir()).with_context(|| {
        format!(
            "failed to create article audio dir: {}",
            vault.audio_dir().display()
        )
    })
}

pub fn load_block_for_audio(vault: &VaultLayout, slug: &str) -> Result<Block> {
    let block_path = vault.block_path(slug);
    let (read_slug, content) = files::read_block_file(vault, &block_path).with_context(|| {
        format!(
            "failed to read article source file: {}",
            block_path.display()
        )
    })?;
    let parsed = parse_markdown_document(&read_slug, &content, file_saved_at(&block_path))
        .with_context(|| {
            format!(
                "failed to parse article source file: {}",
                block_path.display()
            )
        })?;
    Ok(parsed.block)
}

pub fn resolve_state_for_block(vault: &VaultLayout, block: &Block) -> Result<ArticleAudioState> {
    let prepared = match prepare_article_speech(block) {
        Ok(prepared) => prepared,
        Err(_) => return Ok(absent_state()),
    };
    resolve_state_for_prepared(vault, &block.slug, &prepared)
}

pub fn resolve_state_for_prepared(
    vault: &VaultLayout,
    slug: &str,
    prepared: &PreparedArticleSpeech,
) -> Result<ArticleAudioState> {
    ensure_audio_dir(vault)?;
    let Some(stored) = read_stored_state(vault, slug)? else {
        return Ok(absent_state());
    };
    if stored.format_version < ARTICLE_AUDIO_FORMAT_VERSION {
        delete_all_artifacts(vault, slug)?;
        return Ok(absent_state());
    }
    if stored.generation_backend.as_deref() != Some(DESKTOP_ARTICLE_AUDIO_BACKEND)
        || stored.voice_id.as_deref().is_none()
        || stored.voice_name.as_deref().is_none()
    {
        delete_all_artifacts(vault, slug)?;
        return Ok(absent_state());
    }
    if stored.text_hash != prepared.text_hash {
        delete_all_artifacts(vault, slug)?;
        return Ok(absent_state());
    }

    let audio_path = vault.audio_dir().join(&stored.audio_file_name);
    if !audio_path.exists() {
        delete_all_artifacts(vault, slug)?;
        return Ok(absent_state());
    }

    Ok(ArticleAudioState {
        status: ArticleAudioStatus::Ready,
        audio_path: Some(audio_path.to_string_lossy().into_owned()),
        duration_ms: stored.duration_ms,
        last_position_ms: stored.last_position_ms,
        completed_at: stored.completed_at,
    })
}

pub fn invalidate_for_block(vault: &VaultLayout, block: &Block) -> Result<bool> {
    if block.frontmatter.block_type != BlockType::Article {
        return delete_all_artifacts(vault, &block.slug);
    }

    let prepared = match prepare_article_speech(block) {
        Ok(prepared) => prepared,
        Err(_) => return delete_all_artifacts(vault, &block.slug),
    };

    let Some(stored) = read_stored_state(vault, &block.slug)? else {
        return Ok(false);
    };

    if stored.text_hash == prepared.text_hash {
        return Ok(false);
    }

    delete_all_artifacts(vault, &block.slug)
}

pub fn persist_ready_state(
    vault: &VaultLayout,
    slug: &str,
    prepared: &PreparedArticleSpeech,
    audio_file_name: String,
    duration_ms: Option<u64>,
    metadata: Option<ArticleAudioPersistMetadata>,
) -> Result<ArticleAudioState> {
    ensure_audio_dir(vault)?;
    let metadata = metadata.context("missing article audio metadata for v2 ready state")?;
    let stored = StoredArticleAudioState {
        format_version: ARTICLE_AUDIO_FORMAT_VERSION,
        text_hash: prepared.text_hash.clone(),
        generation_backend: Some(metadata.generation_backend),
        voice_id: Some(metadata.voice_id),
        voice_name: Some(metadata.voice_name),
        audio_file_name: audio_file_name.clone(),
        duration_ms,
        last_position_ms: 0,
        completed_at: None,
    };
    write_stored_state(vault, slug, &stored)?;
    Ok(ArticleAudioState {
        status: ArticleAudioStatus::Ready,
        audio_path: Some(
            vault
                .audio_dir()
                .join(audio_file_name)
                .to_string_lossy()
                .into_owned(),
        ),
        duration_ms,
        last_position_ms: 0,
        completed_at: None,
    })
}

pub fn update_playback_position(
    vault: &VaultLayout,
    slug: &str,
    position_ms: u64,
    duration_ms: Option<u64>,
    completed: bool,
    completed_at: Option<String>,
) -> Result<ArticleAudioState> {
    let Some(mut stored) = read_stored_state(vault, slug)? else {
        return Ok(absent_state());
    };

    if completed {
        stored.last_position_ms = 0;
        stored.completed_at = completed_at;
    } else {
        stored.last_position_ms = position_ms;
        stored.completed_at = None;
    }

    if duration_ms.is_some() {
        stored.duration_ms = duration_ms;
    }

    let audio_path = vault.audio_dir().join(&stored.audio_file_name);
    if !audio_path.exists() {
        delete_all_artifacts(vault, slug)?;
        return Ok(absent_state());
    }

    write_stored_state(vault, slug, &stored)?;
    Ok(ArticleAudioState {
        status: ArticleAudioStatus::Ready,
        audio_path: Some(audio_path.to_string_lossy().into_owned()),
        duration_ms: stored.duration_ms,
        last_position_ms: stored.last_position_ms,
        completed_at: stored.completed_at,
    })
}

pub fn delete_all_artifacts(vault: &VaultLayout, slug: &str) -> Result<bool> {
    let mut removed = false;
    let state_path = vault.article_audio_state_path(slug);
    if state_path.exists() {
        std::fs::remove_file(&state_path).with_context(|| {
            format!(
                "failed to remove article audio state: {}",
                state_path.display()
            )
        })?;
        removed = true;
    }

    if vault.audio_dir().exists() {
        for ext in ARTICLE_AUDIO_FILE_EXTENSIONS {
            let audio_path = vault.article_audio_asset_path(slug, ext);
            if audio_path.exists() {
                std::fs::remove_file(&audio_path).with_context(|| {
                    format!(
                        "failed to remove article audio asset: {}",
                        audio_path.display()
                    )
                })?;
                removed = true;
            }
        }
    }

    Ok(removed)
}

pub fn rename_all_artifacts(vault: &VaultLayout, old_slug: &str, new_slug: &str) -> Result<bool> {
    if old_slug == new_slug {
        return Ok(false);
    }

    ensure_audio_dir(vault)?;
    let mut renamed = false;

    if let Some(mut stored) = read_stored_state(vault, old_slug)? {
        let current_ext = std::path::Path::new(&stored.audio_file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("wav");
        stored.audio_file_name = audio_file_name_for_ext(new_slug, current_ext);
        write_stored_state(vault, new_slug, &stored)?;

        let old_state_path = vault.article_audio_state_path(old_slug);
        if old_state_path.exists() {
            std::fs::remove_file(&old_state_path).with_context(|| {
                format!(
                    "failed to remove old article audio state: {}",
                    old_state_path.display()
                )
            })?;
        }
        renamed = true;
    }

    for ext in ARTICLE_AUDIO_FILE_EXTENSIONS {
        let old_path = vault.article_audio_asset_path(old_slug, ext);
        if !old_path.exists() {
            continue;
        }
        let new_path = vault.article_audio_asset_path(new_slug, ext);
        anyhow::ensure!(
            !new_path.exists(),
            "target article audio asset already exists: {}",
            new_path.display()
        );
        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory: {}", parent.display()))?;
        }
        std::fs::rename(&old_path, &new_path).with_context(|| {
            format!(
                "failed to rename article audio asset {} -> {}",
                old_path.display(),
                new_path.display()
            )
        })?;
        renamed = true;
    }

    Ok(renamed)
}

pub fn audio_file_name_for_ext(slug: &str, ext: &str) -> String {
    format!("{}.{}", slug, ext.strip_prefix('.').unwrap_or(ext))
}

pub fn article_audio_extensions() -> &'static [&'static str] {
    ARTICLE_AUDIO_FILE_EXTENSIONS
}

fn file_saved_at(path: &std::path::Path) -> DateTime {
    let time = std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().ok().or_else(|| metadata.modified().ok()))
        .unwrap_or_else(std::time::SystemTime::now);
    DateTime::new(&crate::util::system_time_to_iso8601(time))
        .unwrap_or_else(|_| DateTime::new("1970-01-01T00:00:00Z").unwrap())
}

fn read_stored_state(vault: &VaultLayout, slug: &str) -> Result<Option<StoredArticleAudioState>> {
    let path = vault.article_audio_state_path(slug);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("failed to read article audio state: {}", path.display()))?;
    let stored: StoredArticleAudioState = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse article audio state: {}", path.display()))?;
    Ok(Some(stored))
}

fn write_stored_state(
    vault: &VaultLayout,
    slug: &str,
    state: &StoredArticleAudioState,
) -> Result<()> {
    let path = vault.article_audio_state_path(slug);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create directory: {}", parent.display()))?;
    }
    let bytes =
        serde_json::to_vec_pretty(state).context("failed to serialize article audio state")?;
    std::fs::write(&path, bytes)
        .with_context(|| format!("failed to write article audio state: {}", path.display()))
}

#[cfg(test)]
pub(crate) fn write_test_state_file(
    vault: &VaultLayout,
    slug: &str,
    text_hash: &str,
    audio_file_name: &str,
    duration_ms: Option<u64>,
    last_position_ms: u64,
    completed_at: Option<&str>,
) -> Result<()> {
    ensure_audio_dir(vault)?;
    write_stored_state(
        vault,
        slug,
        &StoredArticleAudioState {
            format_version: ARTICLE_AUDIO_FORMAT_VERSION,
            text_hash: text_hash.to_string(),
            generation_backend: Some(DESKTOP_ARTICLE_AUDIO_BACKEND.to_string()),
            voice_id: Some("voice-id".to_string()),
            voice_name: Some("Voice".to_string()),
            audio_file_name: audio_file_name.to_string(),
            duration_ms,
            last_position_ms,
            completed_at: completed_at.map(str::to_string),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::Frontmatter;

    fn vault() -> VaultLayout {
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        VaultLayout::with_derived_root(root.keep(), derived.keep())
    }

    fn article(body: &str) -> Block {
        Block {
            slug: "essay".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some("Audio Essay".to_string()),
                description: None,
                url: Some("https://example.com/article".to_string()),
                file: None,
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-04-19T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: Some("Jane".to_string()),
                position: None,
                color: None,
                icon: None,
            },
            body: body.to_string(),
        }
    }

    #[test]
    fn load_block_for_audio_accepts_foreign_markdown_without_frontmatter() {
        let vault = vault();
        std::fs::write(vault.block_path("foreign"), "Plain article body").unwrap();

        let block = load_block_for_audio(&vault, "foreign").unwrap();

        assert_eq!(block.frontmatter.block_type, BlockType::Article);
        assert_eq!(block.frontmatter.title.as_deref(), Some("foreign"));
        assert_eq!(block.body, "Plain article body");
    }

    #[test]
    fn resolves_absent_when_no_state_file_exists() {
        let vault = vault();
        let state = resolve_state_for_block(&vault, &article("Hello")).unwrap();
        assert_eq!(state, absent_state());
    }

    #[test]
    fn resolves_ready_when_hash_and_asset_match() {
        let vault = vault();
        let block = article("Hello");
        let prepared = prepare_article_speech(&block).unwrap();
        ensure_audio_dir(&vault).unwrap();
        let audio_name = audio_file_name_for_ext("essay", "wav");
        std::fs::write(vault.audio_dir().join(&audio_name), b"audio").unwrap();
        write_test_state_file(
            &vault,
            "essay",
            &prepared.text_hash,
            &audio_name,
            Some(1200),
            500,
            None,
        )
        .unwrap();

        let state = resolve_state_for_block(&vault, &block).unwrap();
        assert_eq!(state.status, ArticleAudioStatus::Ready);
        assert_eq!(state.duration_ms, Some(1200));
        assert_eq!(state.last_position_ms, 500);
    }

    #[test]
    fn stale_hash_deletes_audio_and_returns_absent() {
        let vault = vault();
        let block = article("Hello");
        let prepared = prepare_article_speech(&block).unwrap();
        ensure_audio_dir(&vault).unwrap();
        let audio_name = audio_file_name_for_ext("essay", "wav");
        let audio_path = vault.audio_dir().join(&audio_name);
        std::fs::write(&audio_path, b"audio").unwrap();
        write_test_state_file(&vault, "essay", "stale", &audio_name, None, 0, None).unwrap();

        let state = resolve_state_for_prepared(&vault, "essay", &prepared).unwrap();
        assert_eq!(state, absent_state());
        assert!(!audio_path.exists());
        assert!(!vault.article_audio_state_path("essay").exists());
    }

    #[test]
    fn missing_audio_file_self_heals_to_absent() {
        let vault = vault();
        let block = article("Hello");
        let prepared = prepare_article_speech(&block).unwrap();
        let audio_name = audio_file_name_for_ext("essay", "wav");
        write_test_state_file(
            &vault,
            "essay",
            &prepared.text_hash,
            &audio_name,
            None,
            0,
            None,
        )
        .unwrap();

        let state = resolve_state_for_block(&vault, &block).unwrap();
        assert_eq!(state, absent_state());
        assert!(!vault.article_audio_state_path("essay").exists());
    }

    #[test]
    fn update_playback_position_persists_progress_and_completion() {
        let vault = vault();
        let block = article("Hello");
        let prepared = prepare_article_speech(&block).unwrap();
        ensure_audio_dir(&vault).unwrap();
        let audio_name = audio_file_name_for_ext("essay", "wav");
        std::fs::write(vault.audio_dir().join(&audio_name), b"audio").unwrap();
        persist_ready_state(
            &vault,
            "essay",
            &prepared,
            audio_name,
            Some(2000),
            Some(ArticleAudioPersistMetadata {
                generation_backend: DESKTOP_ARTICLE_AUDIO_BACKEND.to_string(),
                voice_id: "voice-id".to_string(),
                voice_name: "Voice".to_string(),
            }),
        )
        .unwrap();

        let paused =
            update_playback_position(&vault, "essay", 900, Some(2000), false, None).unwrap();
        assert_eq!(paused.last_position_ms, 900);
        assert_eq!(paused.completed_at, None);

        let completed = update_playback_position(
            &vault,
            "essay",
            2000,
            Some(2000),
            true,
            Some("2026-04-19T10:00:00Z".to_string()),
        )
        .unwrap();
        assert_eq!(completed.last_position_ms, 0);
        assert_eq!(
            completed.completed_at.as_deref(),
            Some("2026-04-19T10:00:00Z")
        );
    }

    #[test]
    fn invalidate_for_block_removes_stale_ready_audio() {
        let vault = vault();
        let block = article("Hello");
        let prepared = prepare_article_speech(&block).unwrap();
        ensure_audio_dir(&vault).unwrap();
        let audio_name = audio_file_name_for_ext("essay", "wav");
        let audio_path = vault.audio_dir().join(&audio_name);
        std::fs::write(&audio_path, b"audio").unwrap();
        write_test_state_file(
            &vault,
            "essay",
            &prepared.text_hash,
            &audio_name,
            None,
            0,
            None,
        )
        .unwrap();

        let mut changed_block = block.clone();
        changed_block.body = "Different body".to_string();
        assert!(invalidate_for_block(&vault, &changed_block).unwrap());
        assert!(!audio_path.exists());
    }

    #[test]
    fn legacy_v1_state_is_invalidated_on_read() {
        let vault = vault();
        let block = article("Hello");
        let prepared = prepare_article_speech(&block).unwrap();
        ensure_audio_dir(&vault).unwrap();
        let audio_name = audio_file_name_for_ext("essay", "m4a");
        let audio_path = vault.audio_dir().join(&audio_name);
        std::fs::write(&audio_path, b"audio").unwrap();
        let legacy_state = serde_json::json!({
            "format_version": 1,
            "text_hash": prepared.text_hash,
            "audio_file_name": audio_name,
            "duration_ms": 1200,
            "last_position_ms": 0,
            "completed_at": null
        });
        std::fs::write(
            vault.article_audio_state_path("essay"),
            serde_json::to_vec_pretty(&legacy_state).unwrap(),
        )
        .unwrap();

        let state = resolve_state_for_block(&vault, &block).unwrap();
        assert_eq!(state, absent_state());
        assert!(!audio_path.exists());
        assert!(!vault.article_audio_state_path("essay").exists());
    }

    #[test]
    fn delete_all_artifacts_removes_legacy_and_wav_outputs() {
        let vault = vault();
        ensure_audio_dir(&vault).unwrap();
        let wav_path = vault.article_audio_asset_path("essay", "wav");
        let m4a_path = vault.article_audio_asset_path("essay", "m4a");
        std::fs::write(&wav_path, b"wav").unwrap();
        std::fs::write(&m4a_path, b"m4a").unwrap();
        std::fs::write(vault.article_audio_state_path("essay"), b"{}").unwrap();

        assert!(delete_all_artifacts(&vault, "essay").unwrap());
        assert!(!wav_path.exists());
        assert!(!m4a_path.exists());
        assert!(!vault.article_audio_state_path("essay").exists());
    }

    #[test]
    fn rename_all_artifacts_updates_sidecar_and_audio_file_name() {
        let vault = vault();
        ensure_audio_dir(&vault).unwrap();
        let wav_path = vault.article_audio_asset_path("essay", "wav");
        std::fs::write(&wav_path, b"wav").unwrap();
        write_test_state_file(&vault, "essay", "hash", "essay.wav", Some(42), 7, None).unwrap();

        assert!(rename_all_artifacts(&vault, "essay", "Renamed Essay").unwrap());
        assert!(!vault.article_audio_state_path("essay").exists());
        assert!(!wav_path.exists());
        assert!(vault
            .article_audio_asset_path("Renamed Essay", "wav")
            .exists());

        let prepared = PreparedArticleSpeech {
            speakable_text: "body".to_string(),
            text_hash: "hash".to_string(),
            language_tag: None,
        };
        let state = resolve_state_for_prepared(&vault, "Renamed Essay", &prepared).unwrap();
        assert_eq!(state.status, ArticleAudioStatus::Ready);
        assert_eq!(state.last_position_ms, 7);
        assert_eq!(
            state.audio_path.as_deref(),
            Some(
                vault
                    .article_audio_asset_path("Renamed Essay", "wav")
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }
}
