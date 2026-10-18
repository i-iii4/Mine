//! The edit sessions of the tab pages (SPEC_EDITING.md, Л3.9, Л4.1, Л4.7,
//! Л4.8): which page edits which note, whether it holds edits not yet in the
//! file, and the flush that asks pages to write them before a page closes,
//! before Mine quits and before a command of Mine writes a note being edited.
//!
//! A page opens its session with `begin_note_edit` (`commands::note_edit`),
//! reports its flag with [`report_note_edits`] and ends it with
//! [`end_note_edit`]. A flush sends `flush-edits` to the pages with unsaved
//! edits and waits up to [`EDIT_FLUSH_DEADLINE_MS`] for each to answer with
//! [`report_edits_flushed`]. The waits never run on the main thread: the
//! answers arrive through it.
//!
//! `note-changed` tells the sessions of a note its body hash on disk after a
//! change they did not make themselves (Л4.1): an outside write the watcher
//! saw, a save of another tab, a command of Mine.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Webview};

use super::space_events;
use super::state::{AppState, OpenSpace};
use crate::domain::vault::VaultLayout;
use crate::storage::note_edit;

/// Longest wait for the pages to write their unsaved edits (Л3.9).
pub const EDIT_FLUSH_DEADLINE_MS: u64 = 3000;

/// The event that asks a page to write its unsaved edits now.
pub const FLUSH_EDITS_EVENT: &str = "flush-edits";

/// The event that tells a page the body hash on disk of a note it edits.
pub const NOTE_CHANGED_EVENT: &str = "note-changed";

/// `note-changed`: the body of the note `slug` on disk hashes to
/// `body_hash` now (Л4.1). A session whose base is that hash does nothing;
/// any other takes the body from `note_body_state` or enters a conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct NoteChangedPayload {
    pub slug: String,
    pub body_hash: String,
}

/// `flush-edits`: write every unsaved edit now and answer
/// `report_edits_flushed(request_id)` (Л3.9).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct FlushEditsPayload {
    pub request_id: u32,
}

/// One note in the editor of one page.
#[derive(Debug, Clone)]
struct Session {
    /// The space the page showed when the session began.
    vault_id: String,
    /// The page holds edits not yet in the file.
    unsaved: bool,
}

/// The sessions, by page label and note slug, and the flushes waiting for
/// answers.
#[derive(Debug, Default)]
struct Registry {
    sessions: BTreeMap<(String, String), Session>,
    next_request: u32,
    /// The pages each flush still waits for, by request.
    requests: HashMap<u32, BTreeSet<String>>,
}

impl Registry {
    /// Pages that no longer have any session have nothing left to flush:
    /// they no longer hold up a request.
    fn settle_requests(&mut self) {
        let live: BTreeSet<&str> = self.sessions.keys().map(|(label, _)| label.as_str()).collect();
        for waiting in self.requests.values_mut() {
            waiting.retain(|label| live.contains(label.as_str()));
        }
    }
}

/// Which sessions a flush asks for (Л3.9, Л4.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlushScope {
    /// Every session: Mine is quitting.
    All,
    /// The sessions of these pages: they close or unload.
    Pages(Vec<String>),
    /// The sessions of these notes of the space `vault_id`: a command of
    /// Mine writes them.
    Notes { vault_id: String, slugs: Vec<String> },
    /// Every session of the space `vault_id`: a command of Mine writes notes
    /// it finds while it runs.
    Space(String),
}

impl FlushScope {
    fn covers(&self, label: &str, slug: &str, session: &Session) -> bool {
        match self {
            Self::All => true,
            Self::Pages(labels) => labels.iter().any(|candidate| candidate == label),
            Self::Notes { vault_id, slugs } => {
                session.vault_id == *vault_id && slugs.iter().any(|candidate| candidate == slug)
            }
            Self::Space(vault_id) => session.vault_id == *vault_id,
        }
    }
}

/// A flush sent and waiting for its answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushRequest {
    pub id: u32,
    /// The pages asked, each with at least one session with unsaved edits.
    pub labels: Vec<String>,
}

/// The edit sessions of every page of the app (Л3.9).
#[derive(Debug, Default)]
pub struct EditSessions {
    registry: Mutex<Registry>,
    /// Signalled whenever a page answers a flush or ends its sessions.
    answered: Condvar,
}

impl EditSessions {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The page `label`, showing the space `vault_id`, begins editing `slug`
    /// with no unsaved edits.
    pub fn begin(&self, label: &str, vault_id: &str, slug: &str) {
        self.registry().sessions.insert(
            (label.to_string(), slug.to_string()),
            Session {
                vault_id: vault_id.to_string(),
                unsaved: false,
            },
        );
    }

    /// The page `label` holds unsaved edits of `slug`, or no longer does. A
    /// report for a session not yet open opens it: a page's reports keep
    /// their order, its `begin_note_edit` may answer after them.
    pub fn report(&self, label: &str, vault_id: &str, slug: &str, unsaved: bool) {
        let mut registry = self.registry();
        let session = registry
            .sessions
            .entry((label.to_string(), slug.to_string()))
            .or_insert_with(|| Session {
                vault_id: vault_id.to_string(),
                unsaved,
            });
        session.unsaved = unsaved;
    }

    /// The page `label` stopped editing `slug`.
    pub fn end(&self, label: &str, slug: &str) {
        let mut registry = self.registry();
        registry.sessions.remove(&(label.to_string(), slug.to_string()));
        registry.settle_requests();
        drop(registry);
        self.answered.notify_all();
    }

    /// The page `label` closed or started again: its sessions end.
    pub fn end_page(&self, label: &str) {
        let mut registry = self.registry();
        registry.sessions.retain(|(page, _), _| page != label);
        registry.settle_requests();
        drop(registry);
        self.answered.notify_all();
    }

    /// The note `from` of the space `vault_id` is now `to` (Л4.8): its
    /// sessions follow it.
    pub fn rename(&self, vault_id: &str, from: &str, to: &str) {
        let mut registry = self.registry();
        let moved: Vec<(String, Session)> = registry
            .sessions
            .iter()
            .filter(|((_, slug), session)| slug == from && session.vault_id == vault_id)
            .map(|((label, _), session)| (label.clone(), session.clone()))
            .collect();
        for (label, session) in moved {
            registry.sessions.remove(&(label.clone(), from.to_string()));
            registry.sessions.insert((label, to.to_string()), session);
        }
    }

    /// Which of `labels` have a session with unsaved edits.
    pub fn unsaved_pages(&self, labels: &[String]) -> Vec<String> {
        let registry = self.registry();
        labels
            .iter()
            .filter(|label| {
                registry
                    .sessions
                    .iter()
                    .any(|((page, _), session)| page == *label && session.unsaved)
            })
            .cloned()
            .collect()
    }

    /// The pages with a session of the note `slug` of the space `vault_id`.
    pub fn pages_of(&self, vault_id: &str, slug: &str) -> Vec<String> {
        self.registry()
            .sessions
            .iter()
            .filter(|((_, session_slug), session)| session_slug == slug && session.vault_id == vault_id)
            .map(|((label, _), _)| label.clone())
            .collect()
    }

    /// The notes of the space `vault_id` some page edits.
    pub fn notes_of_space(&self, vault_id: &str) -> BTreeSet<String> {
        self.registry()
            .sessions
            .iter()
            .filter(|(_, session)| session.vault_id == vault_id)
            .map(|((_, slug), _)| slug.clone())
            .collect()
    }

    /// Start a flush of the sessions `scope` names that hold unsaved edits:
    /// `None` when there are none, and nothing waits.
    pub fn start_flush(&self, scope: &FlushScope) -> Option<FlushRequest> {
        let mut registry = self.registry();
        let labels: BTreeSet<String> = registry
            .sessions
            .iter()
            .filter(|((label, slug), session)| session.unsaved && scope.covers(label, slug, session))
            .map(|((label, _), _)| label.clone())
            .collect();
        if labels.is_empty() {
            return None;
        }
        registry.next_request = registry.next_request.wrapping_add(1);
        let id = registry.next_request;
        registry.requests.insert(id, labels.clone());
        Some(FlushRequest {
            id,
            labels: labels.into_iter().collect(),
        })
    }

    /// The page `label` wrote what it had for the flush `id`.
    pub fn answer(&self, id: u32, label: &str) {
        if let Some(waiting) = self.registry().requests.get_mut(&id) {
            waiting.remove(label);
        }
        self.answered.notify_all();
    }

    /// Wait up to `deadline` for every page of the flush `id` to answer and
    /// forget the flush. Returns the pages that did not answer in time.
    pub fn wait(&self, id: u32, deadline: Duration) -> Vec<String> {
        let started = Instant::now();
        let mut registry = self.registry();
        loop {
            let waiting = registry.requests.get(&id).map_or(0, BTreeSet::len);
            if waiting == 0 {
                break;
            }
            let Some(left) = deadline.checked_sub(started.elapsed()) else {
                break;
            };
            registry = self
                .answered
                .wait_timeout(registry, left)
                .map_or_else(|poisoned| poisoned.into_inner().0, |(registry, _)| registry);
        }
        registry
            .requests
            .remove(&id)
            .map(|waiting| waiting.into_iter().collect())
            .unwrap_or_default()
    }
}

/// Ask the pages with unsaved edits among the sessions `scope` names to
/// write them, and wait for their answers up to [`EDIT_FLUSH_DEADLINE_MS`]
/// (Л3.9). Blocks: never call it on the main thread, which carries the
/// answers.
pub fn flush(app: &AppHandle, scope: &FlushScope) {
    let sessions = &app.state::<AppState>().edit_sessions;
    let Some(request) = sessions.start_flush(scope) else {
        return;
    };
    space_events::emit_to_labels(
        app,
        request.labels.clone(),
        FLUSH_EDITS_EVENT,
        FlushEditsPayload {
            request_id: request.id,
        },
    );
    let unanswered = sessions.wait(request.id, Duration::from_millis(EDIT_FLUSH_DEADLINE_MS));
    if !unanswered.is_empty() {
        log::warn!(
            "{} page(s) did not write their edits within {EDIT_FLUSH_DEADLINE_MS} ms: {}",
            unanswered.len(),
            unanswered.join(", ")
        );
    }
}

/// [`flush`] from an `async` command: the wait runs on a blocking thread.
pub async fn flush_async(app: &AppHandle, scope: FlushScope) {
    let app = app.clone();
    if let Err(error) = tauri::async_runtime::spawn_blocking(move || flush(&app, &scope)).await {
        log::warn!("the flush of edit sessions failed: {error}");
    }
}

/// Run `then` once the pages `labels` wrote their unsaved edits (Л3.9): at
/// once when none of them has any, otherwise on the main thread after their
/// answers or the deadline. Returns whether `then` was put off. Called on
/// the main thread, which the wait must not hold.
pub fn after_flushing_pages(
    app: &AppHandle,
    labels: Vec<String>,
    then: impl FnOnce(&AppHandle) + Send + 'static,
) -> bool {
    let unsaved = app.state::<AppState>().edit_sessions.unsaved_pages(&labels);
    if unsaved.is_empty() {
        then(app);
        return false;
    }
    let handle = app.clone();
    let then = Arc::new(Mutex::new(Some(then)));
    let later = Arc::clone(&then);
    let waiting = std::thread::Builder::new()
        .name("flush-edits".into())
        .spawn(move || {
            flush(&handle, &FlushScope::Pages(unsaved));
            let main = handle.clone();
            let scheduled = handle.run_on_main_thread(move || {
                if let Some(then) = take(&later) {
                    then(&main);
                }
            });
            if let Err(error) = scheduled {
                log::warn!("cannot finish closing after the flush: {error}");
            }
        });
    if let Err(error) = waiting {
        log::warn!("cannot wait for the pages to write their edits: {error}");
        if let Some(then) = take(&then) {
            then(app);
        }
        return false;
    }
    true
}

fn take<T>(slot: &Mutex<Option<T>>) -> Option<T> {
    slot.lock().unwrap_or_else(PoisonError::into_inner).take()
}

/// The flush a command of Mine makes before it writes notes being edited,
/// and the news its sessions get after it (Л4.7). Noted for the space the
/// calling tab shows when the command begins, as `ChangeNews` is.
pub struct SessionFlush {
    app: AppHandle,
    space: Option<Arc<OpenSpace>>,
}

impl SessionFlush {
    fn noted(webview: &Webview) -> Self {
        let app = webview.app_handle().clone();
        let space = app.state::<AppState>().space_for(webview.label());
        Self { app, space }
    }

    fn vault_id(&self) -> Option<String> {
        self.space.as_ref().map(|space| space.vault_id().to_string())
    }

    /// Flush the sessions of the notes `slugs` of the calling tab's space
    /// before a command writes them. Blocks: for a command that runs on the
    /// thread pool.
    pub fn notes(webview: &Webview, slugs: Vec<String>) -> Self {
        let noted = Self::noted(webview);
        if let Some(vault_id) = noted.vault_id() {
            flush(&noted.app, &FlushScope::Notes { vault_id, slugs });
        }
        noted
    }

    /// [`Self::notes`] for an `async` command.
    pub async fn notes_async(webview: &Webview, slugs: Vec<String>) -> Self {
        let noted = Self::noted(webview);
        if let Some(vault_id) = noted.vault_id() {
            flush_async(&noted.app, FlushScope::Notes { vault_id, slugs }).await;
        }
        noted
    }

    /// Flush every session of the calling tab's space before a command that
    /// finds the notes it writes while it runs. Blocks.
    pub fn space(webview: &Webview) -> Self {
        let noted = Self::noted(webview);
        if let Some(vault_id) = noted.vault_id() {
            flush(&noted.app, &FlushScope::Space(vault_id));
        }
        noted
    }

    /// The command succeeded: every session of the space hears the body
    /// hash of its note on disk now, the calling tab's too.
    pub fn announce(&self) {
        if let Some(space) = &self.space {
            announce_space_notes(&self.app, space);
        }
    }
}

/// Tell every session of `space` the body hash of its note on disk now.
pub fn announce_space_notes(app: &AppHandle, space: &OpenSpace) {
    let Ok(layout) = space.layout() else {
        return;
    };
    let sessions = &app.state::<AppState>().edit_sessions;
    let slugs = sessions.notes_of_space(space.vault_id());
    for (labels, payload) in note_changes(sessions, space.vault_id(), &layout, slugs, None) {
        space_events::emit_to_labels(app, labels, NOTE_CHANGED_EVENT, payload);
    }
}

/// Tell the sessions of the note `slug` of the space `vault_id`, but the
/// page `except`, that its body hashes to `body_hash` now.
pub fn announce_note(app: &AppHandle, vault_id: &str, slug: &str, body_hash: &str, except: &str) {
    let labels: Vec<String> = app
        .state::<AppState>()
        .edit_sessions
        .pages_of(vault_id, slug)
        .into_iter()
        .filter(|label| label != except)
        .collect();
    space_events::emit_to_labels(
        app,
        labels,
        NOTE_CHANGED_EVENT,
        NoteChangedPayload {
            slug: slug.to_string(),
            body_hash: body_hash.to_string(),
        },
    );
}

/// The `note-changed` news for the notes `slugs` of the space `vault_id`
/// laid out as `vault`, with the pages that edit each: one per note in an
/// edit session whose body on disk can be read now (Л4.1). The pages of
/// `except` are left out.
pub fn note_changes(
    sessions: &EditSessions,
    vault_id: &str,
    vault: &VaultLayout,
    slugs: impl IntoIterator<Item = String>,
    except: Option<&str>,
) -> Vec<(Vec<String>, NoteChangedPayload)> {
    let mut news = Vec::new();
    for slug in slugs.into_iter().collect::<BTreeSet<_>>() {
        let labels: Vec<String> = sessions
            .pages_of(vault_id, &slug)
            .into_iter()
            .filter(|label| Some(label.as_str()) != except)
            .collect();
        if labels.is_empty() {
            continue;
        }
        if let Some(body_hash) = note_edit::current_body_hash(vault, &slug) {
            news.push((labels, NoteChangedPayload { slug, body_hash }));
        }
    }
    news
}

/// The watcher saw the notes at `paths` of `vault` change, none of them by a
/// write of Mine (Л3.6): tell their sessions at once, outside the window of
/// `vault-changed`, so the last change of a burst is never lost (Л4.1).
pub fn announce_outside_changes<'a>(
    app: &AppHandle,
    vault: &VaultLayout,
    paths: impl IntoIterator<Item = &'a std::path::Path>,
) {
    let state = app.state::<AppState>();
    let Some(space) = state.spaces.by_root(vault.root()) else {
        return;
    };
    let slugs: Vec<String> = paths
        .into_iter()
        .filter_map(|path| vault.slug_for_path(path).ok())
        .collect();
    for (labels, payload) in note_changes(&state.edit_sessions, space.vault_id(), vault, slugs, None) {
        space_events::emit_to_labels(app, labels, NOTE_CHANGED_EVENT, payload);
    }
}

/// The calling page holds unsaved edits of `slug`, or no longer does
/// (Л3.9). On the main thread, so the reports of a page keep their order.
#[tauri::command(rename_all = "snake_case")]
pub fn report_note_edits(webview: Webview, state: State<'_, AppState>, slug: String, unsaved: bool) {
    if let Some(space) = state.space_for(webview.label()) {
        state
            .edit_sessions
            .report(webview.label(), space.vault_id(), &slug, unsaved);
    }
}

/// The calling page stopped editing `slug` (Л3.9): its session ends, and
/// the deferred preview of the note is made now (Л3.3 step 8).
#[tauri::command(rename_all = "snake_case")]
pub fn end_note_edit(app: AppHandle, webview: Webview, state: State<'_, AppState>, slug: String) {
    state.edit_sessions.end(webview.label(), &slug);
    if let Some(space) = state.space_for(webview.label()) {
        super::note_edit::make_preview_due(&app, space.vault_id(), &slug);
    }
}

/// The calling page wrote its unsaved edits for the flush `request_id`: the
/// answer `edits-flushed` (Л3.9).
#[tauri::command(rename_all = "snake_case")]
pub fn report_edits_flushed(webview: Webview, state: State<'_, AppState>, request_id: u32) {
    state.edit_sessions.answer(request_id, webview.label());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;
    use std::path::Path;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    /// Л3.9: a flush asks only the pages with unsaved edits among the
    /// sessions it names; without any, nothing waits.
    #[test]
    fn a_flush_asks_only_the_pages_with_unsaved_edits() {
        let sessions = EditSessions::default();
        sessions.begin("tab-a", "space-x", "Note");
        sessions.begin("tab-b", "space-x", "Note");
        sessions.begin("tab-c", "space-y", "Other");
        assert_eq!(sessions.start_flush(&FlushScope::All), None);

        sessions.report("tab-a", "space-x", "Note", true);
        sessions.report("tab-c", "space-y", "Other", true);
        let request = sessions.start_flush(&FlushScope::All).unwrap();
        assert_eq!(request.labels, labels(&["tab-a", "tab-c"]));
        assert_eq!(sessions.wait(request.id, Duration::ZERO), labels(&["tab-a", "tab-c"]));

        let notes = FlushScope::Notes {
            vault_id: "space-x".into(),
            slugs: labels(&["Note"]),
        };
        assert_eq!(sessions.start_flush(&notes).unwrap().labels, labels(&["tab-a"]));
        let elsewhere = FlushScope::Notes {
            vault_id: "space-y".into(),
            slugs: labels(&["Note"]),
        };
        assert_eq!(sessions.start_flush(&elsewhere), None);
        assert_eq!(
            sessions.start_flush(&FlushScope::Space("space-y".into())).unwrap().labels,
            labels(&["tab-c"])
        );
        assert_eq!(
            sessions.start_flush(&FlushScope::Pages(labels(&["tab-b", "tab-c"]))).unwrap().labels,
            labels(&["tab-c"])
        );
        assert_eq!(sessions.unsaved_pages(&labels(&["tab-a", "tab-b"])), labels(&["tab-a"]));
    }

    /// Л4.7: a command waits for a session that answers late, and goes on
    /// at once when every page has answered.
    #[test]
    fn a_flush_waits_for_a_late_answer() {
        let sessions = Arc::new(EditSessions::default());
        sessions.begin("tab-a", "space-x", "Note");
        sessions.report("tab-a", "space-x", "Note", true);
        let request = sessions.start_flush(&FlushScope::Space("space-x".into())).unwrap();
        let page = Arc::clone(&sessions);
        let answering = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            page.report("tab-a", "space-x", "Note", false);
            page.answer(request.id, "tab-a");
        });
        let started = Instant::now();
        let unanswered = sessions.wait(request.id, Duration::from_millis(EDIT_FLUSH_DEADLINE_MS));
        let waited = started.elapsed();
        answering.join().unwrap();
        assert!(unanswered.is_empty());
        assert!(waited >= Duration::from_millis(200), "the command did not wait: {waited:?}");
        assert!(waited < Duration::from_millis(EDIT_FLUSH_DEADLINE_MS), "{waited:?}");
    }

    /// Л3.9: a page that does not answer holds the flush only up to the
    /// deadline, and is named; a page that closes meanwhile releases it.
    #[test]
    fn a_silent_page_holds_the_flush_until_the_deadline() {
        let sessions = Arc::new(EditSessions::default());
        sessions.report("tab-a", "space-x", "Note", true);
        let request = sessions.start_flush(&FlushScope::All).unwrap();
        let started = Instant::now();
        assert_eq!(sessions.wait(request.id, Duration::from_millis(150)), labels(&["tab-a"]));
        assert!(started.elapsed() >= Duration::from_millis(150));

        let request = sessions.start_flush(&FlushScope::All).unwrap();
        let page = Arc::clone(&sessions);
        let closing = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            page.end_page("tab-a");
        });
        let started = Instant::now();
        assert!(sessions.wait(request.id, Duration::from_millis(EDIT_FLUSH_DEADLINE_MS)).is_empty());
        assert!(started.elapsed() < Duration::from_millis(EDIT_FLUSH_DEADLINE_MS));
        closing.join().unwrap();
    }

    /// Л3.9: a page's report opens its session when `begin_note_edit`
    /// answers later; ending a session or the page forgets it.
    #[test]
    fn sessions_open_with_a_report_and_end_with_their_page() {
        let sessions = EditSessions::default();
        sessions.report("tab-a", "space-x", "Note", true);
        assert_eq!(sessions.pages_of("space-x", "Note"), labels(&["tab-a"]));
        sessions.begin("tab-a", "space-x", "Other");
        sessions.end("tab-a", "Note");
        assert!(sessions.pages_of("space-x", "Note").is_empty());
        assert_eq!(sessions.notes_of_space("space-x"), BTreeSet::from(["Other".to_string()]));
        sessions.end_page("tab-a");
        assert!(sessions.notes_of_space("space-x").is_empty());
    }

    /// Л4.8: a renamed note keeps its sessions under the new slug, in its
    /// own space only.
    #[test]
    fn sessions_follow_a_renamed_note() {
        let sessions = EditSessions::default();
        sessions.report("tab-a", "space-x", "Old", true);
        sessions.begin("tab-b", "space-y", "Old");
        sessions.rename("space-x", "Old", "New");
        assert_eq!(sessions.pages_of("space-x", "New"), labels(&["tab-a"]));
        assert!(sessions.pages_of("space-x", "Old").is_empty());
        assert_eq!(sessions.pages_of("space-y", "Old"), labels(&["tab-b"]));
        assert_eq!(sessions.unsaved_pages(&labels(&["tab-a"])), labels(&["tab-a"]));
    }

    struct Space {
        _root: tempfile::TempDir,
        _derived: tempfile::TempDir,
        vault: VaultLayout,
    }

    fn space() -> Space {
        let root = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        let vault =
            VaultLayout::with_derived_root(root.path().to_path_buf(), derived.path().to_path_buf());
        Space {
            _root: root,
            _derived: derived,
            vault,
        }
    }

    /// Л4.1: the news of a change goes to every page that edits the note,
    /// with the body hash on disk; a note nobody edits gets none, and the
    /// writing page is left out of the news of its own save.
    #[test]
    fn note_changes_go_to_the_pages_that_edit_the_note() {
        let space = space();
        std::fs::write(space.vault.block_path("Note"), "---\nsaved_at: 2026-10-18T00:00:00Z\n---\nnew\n").unwrap();
        std::fs::write(space.vault.block_path("Idle"), "text\n").unwrap();
        let sessions = EditSessions::default();
        sessions.begin("tab-a", "space-x", "Note");
        sessions.begin("tab-b", "space-x", "Note");
        sessions.begin("tab-c", "space-y", "Note");

        let news = note_changes(&sessions, "space-x", &space.vault, labels(&["Note", "Idle", "Gone"]), None);
        assert_eq!(
            news,
            vec![(
                labels(&["tab-a", "tab-b"]),
                NoteChangedPayload {
                    slug: "Note".into(),
                    body_hash: crate::domain::block::compute_body_hash("new\n"),
                }
            )]
        );
        let others = note_changes(&sessions, "space-x", &space.vault, labels(&["Note"]), Some("tab-a"));
        assert_eq!(others[0].0, labels(&["tab-b"]));
    }

    /// Л3.6, Л4.1: a write of another tab or of Obsidian reaches the
    /// session; Mine's own write does not, for the watcher drops it.
    #[test]
    fn the_watcher_tells_sessions_of_outside_writes_but_not_of_its_own() {
        let space = space();
        let conn = db::open_or_create(&space.vault.index_db_path()).unwrap();
        let path = space.vault.block_path("Note");
        std::fs::write(&path, "before\n").unwrap();
        let note = crate::storage::note_write::writable_note(&space.vault, "Note").unwrap();
        let read = crate::storage::note_write::read_note(&space.vault, &note.path).unwrap();
        let written = read.read_back("mine\n").unwrap();
        crate::storage::note_write::publish_note(&conn, &space.vault, &note, read, "mine\n".into(), &written, "test")
            .unwrap();
        assert!(crate::storage::note_write::is_own_write(&space.vault, &path));

        std::fs::write(&path, "from Obsidian\n").unwrap();
        assert!(!crate::storage::note_write::is_own_write(&space.vault, &path));
        let sessions = EditSessions::default();
        sessions.begin("tab-a", "space-x", "Note");
        let news = note_changes(&sessions, "space-x", &space.vault, labels(&["Note"]), None);
        assert_eq!(news[0].1.body_hash, crate::domain::block::compute_body_hash("from Obsidian\n"));
    }

    /// Л4.1: two outside writes in quick succession each give news, the
    /// last one with the final body: nothing is held back for a window.
    #[test]
    fn the_last_change_of_a_burst_is_told() {
        let space = space();
        let path = space.vault.block_path("Note");
        let sessions = EditSessions::default();
        sessions.begin("tab-a", "space-x", "Note");
        let mut told = Vec::new();
        for text in ["first\n", "second\n"] {
            std::fs::write(&path, text).unwrap();
            for (_, payload) in note_changes(&sessions, "space-x", &space.vault, labels(&["Note"]), None) {
                told.push(payload.body_hash);
            }
        }
        assert_eq!(
            told,
            vec![
                crate::domain::block::compute_body_hash("first\n"),
                crate::domain::block::compute_body_hash("second\n"),
            ]
        );
    }

    /// Л4.7: every command of the list flushes the sessions before it
    /// writes and tells them after it succeeded.
    #[test]
    fn every_command_that_writes_notes_being_edited_flushes_first() {
        let blocks = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/blocks.rs")).unwrap();
        for name in [
            "extract_text_selection",
            "delete_text_selection",
            "toggle_task_item",
            "remove_media_asset_from_card",
            "delete_block",
            "delete_blocks",
            "rename_block_file",
            "merge_blocks",
            "rename_media_asset",
            "delete_media_asset",
        ] {
            let start = blocks
                .find(&format!("pub fn {name}("))
                .or_else(|| blocks.find(&format!("pub async fn {name}(")))
                .unwrap_or_else(|| panic!("{name} not found"));
            let end = blocks[start..].find("\n}\n").map_or(blocks.len(), |end| start + end);
            let body = &blocks[start..end];
            let flush = body.find("SessionFlush::").unwrap_or_else(|| panic!("{name} does not flush the sessions"));
            let runs = body.find("_unannounced(").unwrap_or_else(|| panic!("{name}: no command body"));
            assert!(flush < runs, "{name} flushes after it writes");
            assert!(body.contains(".announce()"), "{name} does not tell the sessions");
        }
    }
}
