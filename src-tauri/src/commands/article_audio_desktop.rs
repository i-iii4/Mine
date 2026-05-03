use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use crate::commands::state::CommandError;
use crate::commands::vault::{load_config, write_config};
use crate::domain::article_audio::prepare_article_speech;
use crate::domain::vault::VaultLayout;
use crate::storage::article_audio::{
    self, audio_file_name_for_ext, ArticleAudioPersistMetadata, ArticleAudioState,
};

pub(crate) const DESKTOP_ARTICLE_AUDIO_BACKEND: &str = "apple_avspeech_v2";
pub(crate) const DESKTOP_ARTICLE_AUDIO_EXT: &str = "wav";

const ARTICLE_AUDIO_CONFIG_KEY: &str = "article_audio";
const APPLE_VOICE_OVERRIDES_KEY: &str = "apple_voice_overrides";

const EN_US_SAMANTHA_VOICE_ID: &str = "com.apple.voice.compact.en-US.Samantha";
const EN_GB_DANIEL_VOICE_ID: &str = "com.apple.voice.super-compact.en-GB.Daniel";
const RU_RU_MILENA_VOICE_ID: &str = "com.apple.voice.compact.ru-RU.Milena";
const ARTICLE_AUDIO_HELPER_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopArticleAudioConfig {
    pub apple_voice_overrides: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct DesktopArticleAudioHelperRequest {
    pub text: String,
    pub language_tag: Option<String>,
    pub preferred_voice_id: Option<String>,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct DesktopArticleAudioHelperResponse {
    pub duration_ms: u64,
    pub resolved_voice_id: String,
    pub resolved_voice_name: String,
}

pub(crate) fn ensure_desktop_article_audio_config(
    app: &AppHandle,
) -> Result<DesktopArticleAudioConfig, CommandError> {
    let mut config = load_config(app);
    let before = config.clone();
    let article_audio_config = merge_article_audio_defaults(&mut config)?;
    if config != before {
        write_config(app, &config);
    }
    Ok(article_audio_config)
}

pub(crate) fn generate_desktop_article_audio(
    vault: &VaultLayout,
    slug: &str,
    config: &DesktopArticleAudioConfig,
    helper_path: &Path,
) -> Result<ArticleAudioState, CommandError> {
    let block = article_audio::load_block_for_audio(vault, slug)?;
    let prepared = prepare_article_speech(&block)
        .map_err(|error| CommandError::Internal(error.to_string()))?;

    article_audio::delete_all_artifacts(vault, slug)?;
    article_audio::ensure_audio_dir(vault)?;

    let audio_file_name = audio_file_name_for_ext(slug, DESKTOP_ARTICLE_AUDIO_EXT);
    let audio_path = vault.audio_dir().join(&audio_file_name);
    if let Some(parent) = audio_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Internal(format!("create audio dir: {e}")))?;
    }
    let helper_request = DesktopArticleAudioHelperRequest {
        text: prepared.speakable_text.clone(),
        language_tag: prepared.language_tag.clone(),
        preferred_voice_id: preferred_voice_id_for(
            prepared.language_tag.as_deref(),
            &config.apple_voice_overrides,
        ),
        output_path: audio_path.to_string_lossy().into_owned(),
    };
    let helper_response = run_article_audio_helper(helper_path, &helper_request)?;
    let metadata = ArticleAudioPersistMetadata {
        generation_backend: DESKTOP_ARTICLE_AUDIO_BACKEND.to_string(),
        voice_id: helper_response.resolved_voice_id,
        voice_name: helper_response.resolved_voice_name,
    };

    article_audio::persist_ready_state(
        vault,
        slug,
        &prepared,
        audio_file_name,
        Some(helper_response.duration_ms),
        Some(metadata),
    )
    .map_err(Into::into)
}

pub(crate) fn resolve_article_audio_helper_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    for candidate in article_audio_helper_path_candidates(app) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(CommandError::Internal(format!(
        "article-audio helper binary '{}' not found in expected runtime locations",
        env!("ARTICLE_AUDIO_HELPER_BINARY_NAME")
    )))
}

fn article_audio_helper_path_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let helper_name = env!("ARTICLE_AUDIO_HELPER_BINARY_NAME");
    let mut candidates = Vec::new();

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(helper_name));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(helper_name));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(helper_name),
    );
    candidates
}

fn preferred_voice_id_for(
    language_tag: Option<&str>,
    overrides: &BTreeMap<String, String>,
) -> Option<String> {
    let language_tag = language_tag?;
    if let Some(override_id) = overrides.get(language_tag) {
        return Some(override_id.clone());
    }

    curated_voice_id_for(language_tag).map(str::to_string)
}

fn curated_voice_id_for(language_tag: &str) -> Option<&'static str> {
    match language_tag {
        "en-US" => Some(EN_US_SAMANTHA_VOICE_ID),
        "en-GB" => Some(EN_GB_DANIEL_VOICE_ID),
        "ru-RU" => Some(RU_RU_MILENA_VOICE_ID),
        _ => None,
    }
}

fn merge_article_audio_defaults(
    config: &mut serde_json::Value,
) -> Result<DesktopArticleAudioConfig, CommandError> {
    if !config.is_object() {
        *config = json!({});
    }

    let root = config
        .as_object_mut()
        .ok_or_else(|| CommandError::Internal("application config root is not an object".into()))?;

    let article_audio_entry = root
        .entry(ARTICLE_AUDIO_CONFIG_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !article_audio_entry.is_object() {
        *article_audio_entry = json!({});
    }
    let article_audio_object = article_audio_entry.as_object_mut().ok_or_else(|| {
        CommandError::Internal("article_audio config section is not an object".into())
    })?;

    let overrides_entry = article_audio_object
        .entry(APPLE_VOICE_OVERRIDES_KEY.to_string())
        .or_insert_with(|| json!({}));
    if !overrides_entry.is_object() {
        *overrides_entry = json!({});
    }
    let overrides_object = overrides_entry.as_object_mut().ok_or_else(|| {
        CommandError::Internal("apple_voice_overrides config section is not an object".into())
    })?;

    for (language_tag, voice_id) in [
        ("en-US", EN_US_SAMANTHA_VOICE_ID),
        ("en-GB", EN_GB_DANIEL_VOICE_ID),
        ("ru-RU", RU_RU_MILENA_VOICE_ID),
    ] {
        overrides_object
            .entry(language_tag.to_string())
            .or_insert_with(|| json!(voice_id));
    }

    let overrides = overrides_object
        .iter()
        .filter_map(|(language_tag, value)| {
            value
                .as_str()
                .map(|voice_id| (language_tag.clone(), voice_id.to_string()))
        })
        .collect();

    Ok(DesktopArticleAudioConfig {
        apple_voice_overrides: overrides,
    })
}

fn run_article_audio_helper(
    helper_path: &Path,
    request: &DesktopArticleAudioHelperRequest,
) -> Result<DesktopArticleAudioHelperResponse, CommandError> {
    let request_bytes = serde_json::to_vec(request).map_err(|error| {
        CommandError::Internal(format!(
            "failed to serialize article-audio helper request: {error}"
        ))
    })?;

    let mut child = Command::new(helper_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CommandError::Internal(format!(
                "failed to launch article-audio helper {}: {error}",
                helper_path.display()
            ))
        })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        CommandError::Internal(format!(
            "failed to open stdin for article-audio helper {}",
            helper_path.display()
        ))
    })?;
    stdin.write_all(&request_bytes).map_err(|error| {
        CommandError::Internal(format!(
            "failed to write article-audio helper request to {}: {error}",
            helper_path.display()
        ))
    })?;
    drop(stdin);

    let started_at = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            CommandError::Internal(format!(
                "failed while waiting for article-audio helper {}: {error}",
                helper_path.display()
            ))
        })? {
            break status;
        }

        if started_at.elapsed() >= ARTICLE_AUDIO_HELPER_TIMEOUT {
            child.kill().map_err(|error| {
                CommandError::Internal(format!(
                    "failed to terminate timed-out article-audio helper {}: {error}",
                    helper_path.display()
                ))
            })?;
            let _ = child.wait();
            return Err(CommandError::Internal(format!(
                "article-audio helper timed out after {} seconds",
                ARTICLE_AUDIO_HELPER_TIMEOUT.as_secs()
            )));
        }

        sleep(Duration::from_millis(50));
    };

    let mut stdout = Vec::new();
    if let Some(mut stdout_handle) = child.stdout.take() {
        stdout_handle.read_to_end(&mut stdout).map_err(|error| {
            CommandError::Internal(format!(
                "failed to read stdout from article-audio helper {}: {error}",
                helper_path.display()
            ))
        })?;
    }

    let mut stderr = Vec::new();
    if let Some(mut stderr_handle) = child.stderr.take() {
        stderr_handle.read_to_end(&mut stderr).map_err(|error| {
            CommandError::Internal(format!(
                "failed to read stderr from article-audio helper {}: {error}",
                helper_path.display()
            ))
        })?;
    }

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        return Err(CommandError::Internal(format!(
            "article-audio helper failed: {}",
            stderr.trim()
        )));
    }

    serde_json::from_slice(&stdout).map_err(|error| {
        CommandError::Internal(format!(
            "failed to parse article-audio helper response from {}: {error}",
            helper_path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(target_os = "macos")]
    fn native_speech_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn merge_article_audio_defaults_bootstraps_missing_voice_overrides() {
        let mut config = json!({});
        let article_audio_config = merge_article_audio_defaults(&mut config).unwrap();
        assert_eq!(
            article_audio_config
                .apple_voice_overrides
                .get("en-US")
                .map(String::as_str),
            Some(EN_US_SAMANTHA_VOICE_ID)
        );
        assert_eq!(
            article_audio_config
                .apple_voice_overrides
                .get("ru-RU")
                .map(String::as_str),
            Some(RU_RU_MILENA_VOICE_ID)
        );
    }

    #[test]
    fn preferred_voice_id_uses_exact_override_before_curated_default() {
        let overrides =
            BTreeMap::from([("en-US".to_string(), "com.example.custom-voice".to_string())]);
        assert_eq!(
            preferred_voice_id_for(Some("en-US"), &overrides).as_deref(),
            Some("com.example.custom-voice")
        );
    }

    #[test]
    fn preferred_voice_id_falls_back_to_curated_default_when_override_missing() {
        assert_eq!(
            preferred_voice_id_for(Some("en-GB"), &BTreeMap::new()).as_deref(),
            Some(EN_GB_DANIEL_VOICE_ID)
        );
        assert_eq!(
            preferred_voice_id_for(Some("es-ES"), &BTreeMap::new()),
            None
        );
    }

    #[cfg(target_os = "macos")]
    fn helper_path() -> PathBuf {
        let helper_name = env!("ARTICLE_AUDIO_HELPER_BINARY_NAME");
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(helper_name)
    }

    #[cfg(target_os = "macos")]
    fn assert_valid_wav(path: &Path) {
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.len() > 44, "generated wav must contain audio data");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a live macOS AVSpeechSynthesizer runtime"]
    fn helper_generates_valid_wav_for_short_text() {
        let _lock = native_speech_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempdir().unwrap();
        let output = dir.path().join("short.wav");
        let response = run_article_audio_helper(
            &helper_path(),
            &DesktopArticleAudioHelperRequest {
                text: "Welcome to LessWrong.".to_string(),
                language_tag: Some("en-US".to_string()),
                preferred_voice_id: Some(EN_US_SAMANTHA_VOICE_ID.to_string()),
                output_path: output.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert!(response.duration_ms > 0);
        assert_valid_wav(&output);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a live macOS AVSpeechSynthesizer runtime"]
    fn helper_generates_valid_wav_for_long_text() {
        let _lock = native_speech_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempdir().unwrap();
        let output = dir.path().join("long.wav");
        let response = run_article_audio_helper(
            &helper_path(),
            &DesktopArticleAudioHelperRequest {
                text: "LessWrong is an online forum and community dedicated to improving human reasoning and decision-making. We seek to hold true beliefs and to be effective at accomplishing our goals. Each day, we aim to be less wrong about the world than the day before.".to_string(),
                language_tag: Some("en-US".to_string()),
                preferred_voice_id: Some(EN_US_SAMANTHA_VOICE_ID.to_string()),
                output_path: output.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert!(response.duration_ms > 0);
        assert_valid_wav(&output);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a live macOS AVSpeechSynthesizer runtime"]
    fn helper_uses_samantha_when_installed() {
        let _lock = native_speech_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempdir().unwrap();
        let output = dir.path().join("samantha.wav");
        let response = run_article_audio_helper(
            &helper_path(),
            &DesktopArticleAudioHelperRequest {
                text: "Hello from Mine.".to_string(),
                language_tag: Some("en-US".to_string()),
                preferred_voice_id: Some(EN_US_SAMANTHA_VOICE_ID.to_string()),
                output_path: output.to_string_lossy().into_owned(),
            },
        )
        .unwrap();

        if response.resolved_voice_id == EN_US_SAMANTHA_VOICE_ID {
            assert_eq!(response.resolved_voice_name, "Samantha");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a live macOS AVSpeechSynthesizer runtime"]
    fn helper_uses_milena_when_installed() {
        let _lock = native_speech_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempdir().unwrap();
        let output = dir.path().join("milena.wav");
        let response = run_article_audio_helper(
            &helper_path(),
            &DesktopArticleAudioHelperRequest {
                text: "Привет от Mine.".to_string(),
                language_tag: Some("ru-RU".to_string()),
                preferred_voice_id: Some(RU_RU_MILENA_VOICE_ID.to_string()),
                output_path: output.to_string_lossy().into_owned(),
            },
        )
        .unwrap();

        if response.resolved_voice_id == RU_RU_MILENA_VOICE_ID {
            assert_eq!(response.resolved_voice_name, "Milena");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a live macOS AVSpeechSynthesizer runtime"]
    fn helper_falls_back_to_system_voice_when_no_curated_voice_matches() {
        let _lock = native_speech_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempdir().unwrap();
        let output = dir.path().join("fallback.wav");
        let response = run_article_audio_helper(
            &helper_path(),
            &DesktopArticleAudioHelperRequest {
                text: "Fallback voice check.".to_string(),
                language_tag: Some("zz-ZZ".to_string()),
                preferred_voice_id: None,
                output_path: output.to_string_lossy().into_owned(),
            },
        )
        .unwrap();

        assert!(!response.resolved_voice_id.is_empty());
        assert!(!response.resolved_voice_name.is_empty());
        assert_valid_wav(&output);
    }
}
