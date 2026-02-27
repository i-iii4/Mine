/// Tauri commands: thin IPC layer between frontend and backend.
/// Contains no business logic. Delegates to domain/ and storage/.
pub mod blocks;
pub mod channels;
pub mod search;
pub mod state;
pub mod tags;
pub mod vault;
