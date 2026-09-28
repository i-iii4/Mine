//! Address of the local page that hosts a card's YouTube player.
use super::state::CommandError;
use crate::youtube_embed::YoutubeEmbedServer;

#[tauri::command]
pub fn youtube_player_url(
    source_url: String,
    server: tauri::State<'_, YoutubeEmbedServer>,
) -> Result<String, CommandError> {
    server
        .player_url(&source_url)
        .map_err(|error| CommandError::Internal(error.to_string()))
}
