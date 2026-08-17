/// Persistence layer: SQLite index, file operations, thumbnails.
/// Depends on domain/ for types. Does not depend on commands/ or watcher/.
pub mod article_audio;
pub mod block_queries;
pub mod channel_index;
pub mod clipper_uploads;
pub mod cloud_waits;
pub mod cold_space_audit;
pub mod db;
pub mod derived_preview;
pub mod files;
pub mod graph;
pub mod index;
pub mod media_dimensions;
pub mod media_refs;
pub(crate) mod migrations;
pub mod preview_plan;
pub mod projection;
pub mod reconcile;
pub mod search_engine;
pub mod search_projection;
pub mod source_mutation;
pub mod thumbnails;
pub mod vault_conflicts;
pub mod vault_stats;
