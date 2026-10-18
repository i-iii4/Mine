//! Commands of the editor of the open card (SPEC_EDITING.md, Л2.8, Л3.3,
//! Л4.1). Thin: the steps are in `storage::note_edit`. Also the deferred
//! preview of edited notes (Л3.3 step 8).

use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State, Webview};

use super::edit_sessions;
use super::state::AppState;
use crate::domain::vault::VaultLayout;
use crate::storage::index::IndexedBlock;
use crate::storage::note_edit::{
    self, NoteBodyState, NoteEditError, NoteSaveError, SaveNoteBodyParams, SavedNoteBody,
};
use crate::storage::thumbnails::ThumbSource;
use crate::storage::db;

/// How long after the last save of a note its preview waits (Л3.3 step 8):
/// typing writes several times a second, the preview is made once it rests.
pub const EDIT_PREVIEW_IDLE_MS: u64 = 3000;

/// The layout of the calling tab's space and the space's id.
fn tab_vault(state: &AppState, webview: &Webview) -> Option<(String, VaultLayout)> {
    let space = state.space_for(webview.label())?;
    let layout = space.layout().ok()?;
    Some((space.vault_id().to_string(), layout))
}

/// Check that the calling tab may edit the note `slug` and give its card
/// (Л2.8); a success opens the tab's edit session of the note (Л3.9).
#[tauri::command(rename_all = "snake_case")]
pub async fn begin_note_edit(
    webview: Webview,
    state: State<'_, AppState>,
    slug: String,
) -> Result<IndexedBlock, NoteEditError> {
    let (vault_id, vault) = tab_vault(&state, &webview).ok_or(NoteEditError::NoVault)?;
    let note = slug.clone();
    let card = tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_or_create(&vault.index_db_path()).map_err(NoteEditError::internal)?;
        note_edit::begin_note_edit(&conn, &vault, &note)
    })
    .await
    .map_err(|error| NoteEditError::internal(format!("the edit check failed: {error}")))??;
    state.edit_sessions.begin(webview.label(), &vault_id, &slug);
    Ok(card)
}

/// The body of the note `slug` on disk and its hash (Л4.1).
#[tauri::command(rename_all = "snake_case")]
pub async fn note_body_state(
    webview: Webview,
    state: State<'_, AppState>,
    slug: String,
) -> Result<NoteBodyState, NoteEditError> {
    let (_, vault) = tab_vault(&state, &webview).ok_or(NoteEditError::NoVault)?;
    tauri::async_runtime::spawn_blocking(move || note_edit::note_body_state(&vault, &slug))
        .await
        .map_err(|error| NoteEditError::internal(format!("reading the note failed: {error}")))?
}

async fn save_note_body_unannounced(
    webview: &Webview,
    app: &AppHandle,
    state: &AppState,
    params: SaveNoteBodyParams,
) -> Result<SavedNoteBody, NoteSaveError> {
    let (vault_id, vault) = tab_vault(state, webview).ok_or(NoteSaveError::NoVault)?;
    let preview_vault = vault.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_or_create(&vault.index_db_path()).map_err(NoteSaveError::internal)?;
        note_edit::save_note_body(&conn, &vault, &params)
    })
    .await
    .map_err(|error| NoteSaveError::internal(format!("the save failed: {error}")))??;
    if !saved.unchanged {
        let slug = saved.block.slug.as_str();
        if let Some(body_hash) = saved.block.body_hash.as_deref() {
            edit_sessions::announce_note(app, &vault_id, slug, body_hash, webview.label());
        }
        schedule_preview(app, &vault_id, preview_vault, slug);
    }
    Ok(saved)
}

/// Save the body of a note from the editor (Л3.3):
/// [`save_note_body_unannounced`], then the other tabs of the space hear of
/// the change (SPEC_TABS.md, В15) unless nothing was written.
#[tauri::command(rename_all = "snake_case")]
pub async fn save_note_body(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    params: SaveNoteBodyParams,
) -> Result<SavedNoteBody, NoteSaveError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = save_note_body_unannounced(&webview, &app, &state, params).await;
    if outcome.as_ref().is_ok_and(|saved| !saved.unchanged) {
        announcing.send(Vec::new());
    }
    outcome
}

/// A preview waiting for its note to rest.
#[derive(Debug, Clone)]
struct PendingPreview {
    vault: VaultLayout,
    due: Instant,
}

/// The previews waiting, by space id and note slug, and whether a worker
/// makes them.
#[derive(Debug, Default)]
struct PreviewQueue {
    pending: BTreeMap<(String, String), PendingPreview>,
    worker: bool,
}

impl PreviewQueue {
    /// The note `slug` of `vault_id` was saved at `now`: its preview is due
    /// [`EDIT_PREVIEW_IDLE_MS`] after the last save.
    fn schedule(&mut self, vault_id: &str, vault: VaultLayout, slug: &str, now: Instant) {
        self.pending.insert(
            (vault_id.to_string(), slug.to_string()),
            PendingPreview {
                vault,
                due: now + Duration::from_millis(EDIT_PREVIEW_IDLE_MS),
            },
        );
    }

    /// The session of the note ended: its preview is due now, if it waits.
    fn make_due(&mut self, vault_id: &str, slug: &str, now: Instant) {
        if let Some(pending) = self.pending.get_mut(&(vault_id.to_string(), slug.to_string())) {
            pending.due = pending.due.min(now);
        }
    }

    /// Take the previews due by `now`.
    fn take_due(&mut self, now: Instant) -> Vec<(VaultLayout, String)> {
        let due: Vec<(String, String)> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.due <= now)
            .map(|(key, _)| key.clone())
            .collect();
        due.into_iter()
            .filter_map(|key| self.pending.remove(&key).map(|pending| (pending.vault, key.1)))
            .collect()
    }

    /// When the next preview is due.
    fn next_due(&self) -> Option<Instant> {
        self.pending.values().map(|pending| pending.due).min()
    }
}

/// The deferred previews of edited notes (Л3.3 step 8).
#[derive(Debug, Default)]
pub struct EditPreviews {
    queue: Mutex<PreviewQueue>,
    /// Signalled when a preview is scheduled or made due.
    changed: Condvar,
}

impl EditPreviews {
    fn queue(&self) -> MutexGuard<'_, PreviewQueue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Put off the preview of the note `slug` until it rests (Л3.3 step 8).
fn schedule_preview(app: &AppHandle, vault_id: &str, vault: VaultLayout, slug: &str) {
    let previews = &app.state::<AppState>().edit_previews;
    let start_worker = {
        let mut queue = previews.queue();
        queue.schedule(vault_id, vault, slug, Instant::now());
        !std::mem::replace(&mut queue.worker, true)
    };
    previews.changed.notify_all();
    if !start_worker {
        return;
    }
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("edit-previews".into())
        .spawn(move || preview_worker(&handle));
    if let Err(error) = spawned {
        log::warn!("cannot start the preview worker of edited notes: {error}");
        previews.queue().worker = false;
    }
}

/// The edit session of the note `slug` ended: its preview is made now.
pub fn make_preview_due(app: &AppHandle, vault_id: &str, slug: &str) {
    let previews = &app.state::<AppState>().edit_previews;
    previews.queue().make_due(vault_id, slug, Instant::now());
    previews.changed.notify_all();
}

/// Mine is quitting: make every waiting preview now, after the flush of the
/// edit sessions (Л3.9).
pub fn make_waiting_previews(app: &AppHandle) {
    let state = app.state::<AppState>();
    let waiting = {
        let mut queue = state.edit_previews.queue();
        let all: Vec<(String, String)> = queue.pending.keys().cloned().collect();
        for (vault_id, slug) in &all {
            queue.make_due(vault_id, slug, Instant::now());
        }
        queue.take_due(Instant::now())
    };
    for (vault, slug) in waiting {
        make_preview(app, &vault, &slug);
    }
}

/// Make the previews as they fall due, until none waits.
fn preview_worker(app: &AppHandle) {
    let previews = &app.state::<AppState>().edit_previews;
    loop {
        let due = {
            let mut queue = previews.queue();
            loop {
                let now = Instant::now();
                let Some(next) = queue.next_due() else {
                    queue.worker = false;
                    return;
                };
                if next <= now {
                    break queue.take_due(now);
                }
                queue = previews
                    .changed
                    .wait_timeout(queue, next - now)
                    .map_or_else(|poisoned| poisoned.into_inner().0, |(queue, _)| queue);
            }
        };
        for (vault, slug) in due {
            make_preview(app, &vault, &slug);
        }
    }
}

/// Make the preview of the note `slug` and tell the space's tabs.
fn make_preview(app: &AppHandle, vault: &VaultLayout, slug: &str) {
    if !app.state::<AppState>().is_open_root(vault.root()) {
        return;
    }
    let made = db::open_or_create(&vault.index_db_path())
        .and_then(|conn| note_edit::generate_note_preview(&conn, vault, slug));
    match made {
        Ok(Some(thumb)) if thumb != ThumbSource::None => {
            super::space_events::announce_to_vault(
                app,
                vault,
                "thumb:updated",
                super::blocks::ThumbUpdatedPayload {
                    slug: slug.to_string(),
                    is_text: thumb == ThumbSource::Text,
                },
            );
        }
        Ok(_) => {}
        Err(error) => log::warn!("the preview of edited '{slug}' was not made: {error:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> VaultLayout {
        VaultLayout::new(std::path::PathBuf::from("/spaces/A"))
    }

    /// Л3.3 step 8: each save puts the preview off by the idle time, the end
    /// of the session makes it due at once, and a preview is taken once.
    #[test]
    fn a_preview_waits_for_the_note_to_rest() {
        let mut queue = PreviewQueue::default();
        let start = Instant::now();
        let idle = Duration::from_millis(EDIT_PREVIEW_IDLE_MS);
        queue.schedule("space-x", layout(), "Note", start);
        queue.schedule("space-x", layout(), "Note", start + Duration::from_millis(1000));
        assert_eq!(queue.next_due(), Some(start + Duration::from_millis(1000) + idle));
        assert!(queue.take_due(start + idle).is_empty(), "a save did not put the preview off");
        let due = queue.take_due(start + Duration::from_millis(1000) + idle);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1, "Note");
        assert!(queue.take_due(start + idle * 10).is_empty(), "the preview was made twice");

        queue.schedule("space-x", layout(), "Other", start);
        queue.make_due("space-x", "Other", start);
        queue.make_due("space-x", "Unknown", start);
        assert_eq!(queue.take_due(start).len(), 1);
        assert_eq!(queue.next_due(), None);
    }

    /// The previews of two spaces with the same slug are apart.
    #[test]
    fn previews_are_kept_per_space() {
        let mut queue = PreviewQueue::default();
        let start = Instant::now();
        queue.schedule("space-x", layout(), "Note", start);
        queue.schedule("space-y", layout(), "Note", start);
        queue.make_due("space-x", "Note", start);
        assert_eq!(queue.take_due(start).len(), 1);
        assert_eq!(queue.pending.len(), 1);
    }
}
