/// Persistence layer: SQLite index, file operations, thumbnails.
/// Depends on domain/ for types. Does not depend on commands/ or watcher/.
pub mod article_audio;
pub mod clipper_uploads;
pub mod db;
pub mod files;
pub mod index;
pub mod media_dimensions;
pub mod media_refs;
pub mod thumbnails;
