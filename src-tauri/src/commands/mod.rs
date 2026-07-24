/// Tauri commands: thin IPC layer between frontend and backend.
/// Contains no business logic. Delegates to domain/ and storage/.
pub mod article_audio;
mod article_audio_desktop;
pub mod blocks;
pub mod channels;
pub mod clipper_recovery;
pub mod conflicts;
mod freshness;
pub mod graph;
pub mod import;
pub mod native_shell_smoke;
mod preview_reconcile;
pub mod search;
pub mod settings;
pub mod state;
pub mod tags;
mod thumbnail_sweeps;
pub mod thumbnails;
pub mod vault;
pub mod vault_stats;
