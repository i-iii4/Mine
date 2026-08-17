//! The Keep Downloaded recommendation: when to show it, how it is dismissed.
//!
//! The decision data lives with the space (`storage::cloud_waits`); the one
//! thing that is global is the "don't show again" checkbox — a person who
//! refused the advice refused the advice, not the space (Х19). That flag
//! lives in the app config beside the vault list.
//! See SPEC_CLOUD_STORAGE.md Х16–Х19, Х21–Х22.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::state::{AppState, CommandError};
use crate::commands::vault::{load_config, write_config};
use crate::storage::cloud_waits;

const NEVER_SHOW_KEY: &str = "cloud_recommendation_never";

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CloudRecommendationState {
    /// Show the card now: waits repeated across sessions, nobody dismissed it
    /// here, and the global checkbox was never ticked.
    pub due: bool,
}

fn never_show(app: &AppHandle) -> bool {
    load_config(app)
        .get(NEVER_SHOW_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn derived_root(state: &State<'_, AppState>) -> Result<std::path::PathBuf, CommandError> {
    let vault_state = state
        .vault_state
        .lock()
        .map_err(|_| CommandError::Internal("vault state mutex poisoned".into()))?;
    let vs = vault_state.as_ref().ok_or(CommandError::NoVault)?;
    Ok(vs.vault.derived_root().to_path_buf())
}

#[tauri::command]
pub fn cloud_recommendation_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CloudRecommendationState, CommandError> {
    if never_show(&app) {
        return Ok(CloudRecommendationState { due: false });
    }
    let root = derived_root(&state)?;
    let log = cloud_waits::load(&root);
    Ok(CloudRecommendationState {
        due: cloud_waits::recommendation_due(&log),
    })
}

/// Close the card. Without the checkbox the dismissal binds to this space;
/// with it, the advice never comes back anywhere (Х19).
#[tauri::command]
pub fn dismiss_cloud_recommendation(
    app: AppHandle,
    state: State<'_, AppState>,
    never_show_again: bool,
) -> Result<(), CommandError> {
    let root = derived_root(&state)?;
    cloud_waits::dismiss(&root)
        .map_err(|error| CommandError::Internal(format!("failed to dismiss: {error:#}")))?;
    if never_show_again {
        let mut cfg = load_config(&app);
        cfg[NEVER_SHOW_KEY] = serde_json::json!(true);
        write_config(&app, &cfg);
    }
    Ok(())
}
