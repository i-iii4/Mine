/// Persistence layer: SQLite index, file operations, thumbnails.
/// Depends on domain/ for types. Does not depend on commands/ or watcher/.
pub mod article_audio;
pub mod clipper_uploads;
pub mod db;
pub mod derived_preview;
pub mod files;
pub mod graph;
pub mod index;
pub mod media_dimensions;
pub mod media_refs;
pub mod preview_plan;
pub mod reconcile;
pub mod search_engine;
pub mod source_mutation;
pub mod thumbnails;
pub mod vault_stats;
