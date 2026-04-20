// Article audio commands: query local derived audio state, generate a local
// audio rendition, remove it, and persist playback progress.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::article_audio_desktop::{
    ensure_desktop_article_audio_config, generate_desktop_article_audio,
    resolve_article_audio_helper_path,
};
use crate::commands::state::{current_vault_layout, now_iso8601, AppState, CommandError};
use crate::domain::vault::validate_slug;
use crate::storage::article_audio::{self, ArticleAudioState};

const ARTICLE_AUDIO_UPDATED_EVENT: &str = "article-audio-updated";

#[derive(Debug, Clone, Serialize)]
struct ArticleAudioUpdatedPayload {
    slug: String,
}

#[tauri::command]
pub fn get_article_audio_state(
    state: State<'_, AppState>,
    slug: String,
) -> Result<ArticleAudioState, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = current_vault_layout(&state)?;
    let block = article_audio::load_block_for_audio(&vault, &slug)?;
    Ok(article_audio::resolve_state_for_block(&vault, &block)?)
}

#[tauri::command]
pub async fn generate_article_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
) -> Result<ArticleAudioState, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = current_vault_layout(&state)?;
    let helper_path = resolve_article_audio_helper_path(&app)?;
    let desktop_config = ensure_desktop_article_audio_config(&app)?;
    let task_slug = slug.clone();
    let ready = tauri::async_runtime::spawn_blocking(move || {
        generate_desktop_article_audio(&vault, &task_slug, &desktop_config, &helper_path)
    })
    .await
    .map_err(|e| {
        CommandError::Internal(format!("generate_article_audio task join failed: {e}"))
    })??;
    emit_audio_updated(&app, &slug);
    Ok(ready)
}

#[tauri::command]
pub fn delete_article_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
) -> Result<(), CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = current_vault_layout(&state)?;
    let removed = article_audio::delete_all_artifacts(&vault, &slug)?;
    if removed {
        emit_audio_updated(&app, &slug);
    }
    Ok(())
}

#[tauri::command]
pub fn set_article_audio_position(
    state: State<'_, AppState>,
    slug: String,
    position_ms: u64,
    duration_ms: Option<u64>,
    completed: bool,
) -> Result<(), CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = current_vault_layout(&state)?;
    let completed_at = completed.then(now_iso8601);
    let next_state = article_audio::update_playback_position(
        &vault,
        &slug,
        position_ms,
        duration_ms,
        completed,
        completed_at,
    )?;
    let _ = next_state;
    Ok(())
}

fn emit_audio_updated(app: &AppHandle, slug: &str) {
    let _ = app.emit(
        ARTICLE_AUDIO_UPDATED_EVENT,
        ArticleAudioUpdatedPayload {
            slug: slug.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use crate::storage::article_audio::article_audio_extensions;

    #[test]
    fn article_audio_extensions_keep_desktop_output_supported() {
        assert!(article_audio_extensions().contains(&"wav"));
    }
}
