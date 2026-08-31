//! WebAssembly transport only; all behavior lives in the shared save module.
use wasm_bindgen::prelude::*;

/// Execute a typed JSON command without platform-specific save rules.
#[wasm_bindgen]
pub fn execute_json(input: &str) -> String { crate::save::execute_json(input) }
