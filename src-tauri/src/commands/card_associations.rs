//! The open card's associations (SPEC_CARD_ASSOCIATIONS.md): a thin read of
//! `storage::card_associations` on the tab's space.

use tauri::{AppHandle, State};

use crate::commands::state::{ensure_vault_fresh, read_owned_projection, tab_layout, AppState, CommandError};
use crate::domain::vault::validate_slug;
use crate::storage::card_associations::{self, CardAssociationKind, CardAssociations};

/// The cards related to the card `slug` by author, site and address.
/// `exclude_slugs` are the card's Related notes, which it already shows;
/// `expanded` are the groups to read past their first rows.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_card_associations(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    exclude_slugs: Vec<String>,
    expanded: Vec<CardAssociationKind>,
) -> Result<CardAssociations, CommandError> {
    validate_slug(&slug).map_err(|e| CommandError::Internal(e.to_string()))?;
    let vault = tab_layout(&state, &webview)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || -> Result<CardAssociations, CommandError> {
        read_owned_projection(&app, &vault, |conn| {
            card_associations::read_card_associations(conn, &slug, &exclude_slugs, &expanded)
        })
    })
    .await
    .map_err(|error| {
        CommandError::Internal(format!("list_card_associations task join failed: {error}"))
    })?
}
