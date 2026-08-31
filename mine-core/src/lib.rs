//! Platform-independent document rules and save decisions shared by Mine clients.
//!
//! This library performs no filesystem, network, database or clock operations.
pub mod domain;
pub mod save;

#[cfg(target_arch = "wasm32")]
mod wasm;
