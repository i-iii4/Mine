/// Tauri commands: thin IPC layer between frontend and backend.
/// Contains no business logic. Delegates to domain/ and storage/.
/// Article audio is behind the `article-audio` feature and off by default. The
/// modules stay in the tree; see SPEC_ARTICLE_AUDIO.md.
#[cfg(feature = "article-audio")]
pub mod article_audio;
#[cfg(feature = "article-audio")]
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
pub mod window_chrome;
