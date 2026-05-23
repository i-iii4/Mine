/// Tauri commands: thin IPC layer between frontend and backend.
/// Contains no business logic. Delegates to domain/ and storage/.
pub mod article_audio;
mod article_audio_desktop;
pub mod blocks;
pub mod channels;
pub mod clipper_recovery;
pub mod conflicts;
pub mod import;
pub mod search;
pub mod state;
pub mod tags;
pub mod thumbnails;
pub mod vault;
pub mod vault_stats;
