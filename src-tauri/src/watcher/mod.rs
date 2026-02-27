/// File system watcher: detects changes in vault and triggers re-indexing.
/// Depends on domain/ and storage/.
pub mod events;
pub mod handler;
