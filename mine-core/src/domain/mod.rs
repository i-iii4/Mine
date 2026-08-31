//! Portable content rules shared by native clients and browser WebAssembly.
//!
//! Filesystem observations, clocks, networking and persistence belong to the
//! executors; these modules only interpret supplied content and facts.

pub mod article_audio;
pub mod block;
pub mod channel;
pub mod collection;
pub mod markdown;
pub mod search;
pub mod tag;
pub mod vault;
