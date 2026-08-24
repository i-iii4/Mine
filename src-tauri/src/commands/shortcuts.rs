//! Keyboard shortcut overrides.
//!
//! Rebindings live in the app config rather than in web storage for two
//! reasons: the native menu has to read them to rebuild its accelerators, and
//! clearing site data must not silently return every shortcut to default.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::state::CommandError;
use super::vault::{load_config, write_config};

const CONFIG_KEY: &str = "shortcut_overrides";

/// One rebound command: which key, which modifiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ShortcutBinding {
    pub key: String,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
}

impl ShortcutBinding {
    /// The Tauri accelerator form, for commands that also live in the native
    /// menu. `CmdOrCtrl` is deliberately not used: bindings are recorded from
    /// real key presses on this machine, so the modifier is literal.
    pub fn accelerator(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if self.ctrl {
            parts.push("Ctrl");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.shift {
            parts.push("Shift");
        }
        if self.meta {
            parts.push("Cmd");
        }
        let key = match self.key.as_str() {
            "," => "Comma".to_string(),
            "/" => "Slash".to_string(),
            "[" => "BracketLeft".to_string(),
            "]" => "BracketRight".to_string(),
            other => other.to_uppercase(),
        };
        let mut accelerator = parts.join("+");
        if accelerator.is_empty() {
            key
        } else {
            accelerator.push('+');
            accelerator.push_str(&key);
            accelerator
        }
    }
}

pub type ShortcutOverrides = std::collections::BTreeMap<String, ShortcutBinding>;

pub fn load_overrides(app: &AppHandle) -> ShortcutOverrides {
    let cfg = load_config(app);
    cfg.get(CONFIG_KEY)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_shortcut_overrides(app: AppHandle) -> Result<ShortcutOverrides, CommandError> {
    Ok(load_overrides(&app))
}

/// Replace the whole override set. The caller owns validation — conflicts and
/// reserved combos are decided against the command registry, which lives in
/// the frontend.
#[tauri::command(rename_all = "snake_case")]
pub fn save_shortcut_overrides(
    app: AppHandle,
    overrides: ShortcutOverrides,
) -> Result<(), CommandError> {
    let mut cfg = load_config(&app);
    cfg[CONFIG_KEY] = serde_json::to_value(&overrides)
        .map_err(|e| CommandError::Internal(format!("failed to serialize overrides: {e}")))?;
    write_config(&app, &cfg);

    // The menu accelerator consumes the key before the webview sees it, so a
    // stale menu would keep firing the old command.
    crate::refresh_app_menu(&app);

    // Both windows read shortcuts.
    app.emit("shortcuts-changed", &overrides)
        .map_err(|e| CommandError::Internal(format!("failed to emit shortcuts-changed: {e}")))?;
    Ok(())
}
