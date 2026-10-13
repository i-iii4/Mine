// iCloud sync conflicts of a space (SPEC_ICLOUD_CONFLICTS.md): the check
// passes in the background (ВК4) and the commands of the notice and the
// window (ВК7, ВК8, ВК10). What a pass, the list and a resolution do is in
// `storage::icloud_conflicts`; this layer finds the space, the helper and the
// tabs to tell.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::state::{tab_layout, AppState, CommandError};
use crate::domain::vault::VaultLayout;
use crate::storage::icloud_conflicts::{
    self, CheckOutcome, CheckScope, ConflictChoice, ConflictsHelper, ResolveRequest, VaultConflict,
    VaultConflictError,
};
use crate::storage::{db, vault_conflicts};

const CONFLICT_MUTATION_WATCHER_SUPPRESSION_MS: u64 = 1500;
/// A pass waits this long before it starts, so the paths of one batch of
/// watcher events go to one helper run: the window of the watcher's own
/// delay (`watcher/watch.rs`).
const CHECK_BATCH_WINDOW: Duration = Duration::from_millis(300);
/// The set of conflict paths of a space changed (ВК6).
pub const VAULT_CONFLICTS_CHANGED_EVENT: &str = "vault-conflicts-changed";

/// `vault-conflicts-changed`: how many notes of the space are in conflict now.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct VaultConflictsChanged {
    pub count: u32,
}

/// One check of a space at a time; a request during it leaves exactly one
/// repeat after it, covering everything asked meanwhile (ВК4).
#[derive(Default)]
pub struct ConflictChecks {
    state: Mutex<HashMap<PathBuf, CheckEntry>>,
}

#[derive(Default)]
struct CheckEntry {
    running: bool,
    pending: Option<CheckScope>,
}

impl ConflictChecks {
    /// Ask for a pass of `scope` over the space at `root`. Returns whether
    /// the caller starts the worker; otherwise the running one takes it.
    fn request(&self, root: &Path, scope: CheckScope) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = state.entry(root.to_path_buf()).or_default();
        entry.pending = Some(match entry.pending.take() {
            Some(pending) => pending.merge(scope),
            None => scope,
        });
        if entry.running {
            return false;
        }
        entry.running = true;
        true
    }

    /// The next pass of the worker of `root`, or none: the worker ends.
    fn next(&self, root: &Path) -> Option<CheckScope> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let pending = state.get_mut(root)?.pending.take();
        if pending.is_none() {
            state.remove(root);
        }
        pending
    }

    /// The worker of `root` could not start: forget it, so the next request
    /// starts one.
    fn abandon(&self, root: &Path) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(root);
    }
}

/// Check the notes of `scope` for iCloud conflicts, in the background and
/// after the batch window (ВК4). A space outside iCloud is never checked
/// (ВК3).
pub fn schedule_conflict_check(app: &AppHandle, vault: &VaultLayout, scope: CheckScope) {
    let root = vault.root().to_path_buf();
    if !icloud_conflicts::is_icloud_space(&root) {
        return;
    }
    let checks = &app.state::<AppState>().conflict_checks;
    if !checks.request(&root, scope) {
        return;
    }
    let worker_app = app.clone();
    let worker_root = root.clone();
    let spawned = std::thread::Builder::new()
        .name("icloud-conflicts".to_string())
        .spawn(move || run_checks(&worker_app, &worker_root));
    if let Err(error) = spawned {
        log::warn!("failed to start the iCloud conflict check of {}: {error}", root.display());
        checks.abandon(&root);
    }
}

/// The watcher saw these files change: check the notes among them.
pub fn schedule_paths_check<'a>(
    app: &AppHandle,
    vault: &VaultLayout,
    paths: impl IntoIterator<Item = &'a Path>,
) {
    let notes: BTreeSet<PathBuf> = paths
        .into_iter()
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("md"))
        .map(Path::to_path_buf)
        .collect();
    if !notes.is_empty() {
        schedule_conflict_check(app, vault, CheckScope::Paths(notes));
    }
}

fn run_checks(app: &AppHandle, root: &Path) {
    std::thread::sleep(CHECK_BATCH_WINDOW);
    let state = app.state::<AppState>();
    while let Some(scope) = state.conflict_checks.next(root) {
        // The space closed meanwhile: nothing to check, nobody to tell.
        let Some(vault) = state.spaces.by_root(root).and_then(|space| space.layout().ok()) else {
            continue;
        };
        match check_once(app, &vault, &scope) {
            Ok(outcome) if outcome.changed => announce_count(app, vault.root(), outcome.count),
            Ok(_) => {}
            Err(error) => {
                log::warn!("iCloud conflict check of {} failed: {error:#}", root.display());
            }
        }
    }
}

fn check_once(app: &AppHandle, vault: &VaultLayout, scope: &CheckScope) -> anyhow::Result<CheckOutcome> {
    let helper = conflicts_helper(app)?;
    let conn = db::open_or_create(&vault.index_db_path())?;
    icloud_conflicts::run_check(&conn, vault, &helper, scope, &crate::util::now_iso8601())
}

fn conflicts_helper(app: &AppHandle) -> Result<ConflictsHelper, CommandError> {
    super::icloud_progress::bundled_helper(app, icloud_conflicts::HELPER_NAME).map(ConflictsHelper::new)
}

/// Tell the tabs of the space at `root` how many notes are in conflict now.
fn announce_count(app: &AppHandle, root: &Path, count: usize) {
    crate::commands::space_events::emit_to_space_root(
        app,
        root,
        VAULT_CONFLICTS_CHANGED_EVENT,
        VaultConflictsChanged {
            count: u32::try_from(count).unwrap_or(u32::MAX),
        },
    );
}

fn conflict_error(error: CommandError) -> VaultConflictError {
    match error {
        CommandError::NoVault => VaultConflictError::NoVault,
        CommandError::SourceChanged { path } => VaultConflictError::SourceChanged { path },
        error => VaultConflictError::Internal {
            message: error.to_string(),
        },
    }
}

/// The conflict paths of the calling tab's space, newest first, from the
/// table alone: what the notice counts (ВК7, ВК10). The helper does not run.
#[tauri::command(async)]
pub fn list_vault_conflict_paths(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let vault = tab_layout(&state, &webview)?;
    crate::commands::state::read_owned_projection(&app, &vault, vault_conflicts::list_conflict_paths)
}

/// The calling tab's conflicts with their versions, read again by one helper
/// run (ВК7). A conflict resolved on another device leaves the table, and
/// the tabs hear the new count.
#[tauri::command(async)]
pub fn list_vault_conflicts(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<VaultConflict>, VaultConflictError> {
    let vault = tab_layout(&state, &webview).map_err(conflict_error)?;
    let helper = conflicts_helper(&app).map_err(conflict_error)?;
    let conn = db::open_or_create(&vault.index_db_path())?;
    let list = icloud_conflicts::list_conflicts(&conn, &vault, &helper)?;
    if !list.removed.is_empty() {
        let count = vault_conflicts::list_conflict_paths(&conn)?.len();
        announce_count(&app, vault.root(), count);
    }
    Ok(list.conflicts)
}

fn resolve_vault_conflict_unannounced(
    webview: &tauri::Webview,
    app: &AppHandle,
    state: &AppState,
    path: &str,
    choice: &ConflictChoice,
    expected_tokens: &[String],
) -> Result<(), VaultConflictError> {
    let space = state.space_for(webview.label()).ok_or(VaultConflictError::NoVault)?;
    let helper = conflicts_helper(app).map_err(conflict_error)?;
    let vault_state = space.vault_state.lock().map_err(|_| VaultConflictError::Internal {
        message: "vault state mutex poisoned".into(),
    })?;
    let session = vault_state.as_ref().ok_or(VaultConflictError::NoVault)?;
    let suppress = |paths: &[PathBuf]| {
        if let Err(error) = state.suppress_paths(
            paths.iter().cloned(),
            Duration::from_millis(CONFLICT_MUTATION_WATCHER_SUPPRESSION_MS),
        ) {
            log::warn!("conflict resolution could not quiet the watcher: {error}");
        }
    };
    let outcome = icloud_conflicts::resolve_conflict(
        &session.conn,
        &session.vault,
        &helper,
        ResolveRequest {
            path,
            choice,
            expected_tokens,
        },
        &suppress,
    );
    let count = vault_conflicts::list_conflict_paths(&session.conn)
        .map(|paths| paths.len())
        .map_err(VaultConflictError::from);
    let vault = session.vault.clone();
    drop(vault_state);

    if let Ok(count) = &count {
        announce_count(app, vault.root(), *count);
    }
    // A background pass that read the versions before the settle could
    // record the conflict again; the next pass runs after it and corrects
    // that (ВК4: one pass at a time).
    if let Ok(resolution) = &outcome {
        schedule_conflict_check(
            app,
            &vault,
            CheckScope::Paths(BTreeSet::from([vault.root().join(&resolution.path)])),
        );
    }
    let resolution = outcome?;
    count?;
    let trash_refused = matches!(choice, ConflictChoice::KeepVersion { .. })
        && !resolution.kept_separately.is_empty();
    if trash_refused {
        return Err(VaultConflictError::TrashFailed {
            paths: resolution.kept_separately,
        });
    }
    Ok(())
}

/// Resolve the conflict of the note at `path` (ВК8): keep one version, or
/// keep all. `expected_tokens` are the versions the window showed. The other
/// tabs of the space hear of the change (SPEC_TABS.md, В15), whatever the
/// outcome: a resolution that failed after writing may have changed files.
#[tauri::command(async, rename_all = "snake_case")]
pub fn resolve_vault_conflict(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    choice: ConflictChoice,
    expected_tokens: Vec<String>,
) -> Result<(), VaultConflictError> {
    let announcing = super::effects::ChangeNews::before(&webview);
    let outcome = resolve_vault_conflict_unannounced(
        &webview,
        &app,
        &state,
        &path,
        &choice,
        &expected_tokens,
    );
    if !matches!(outcome, Err(VaultConflictError::NoVault)) {
        announcing.send(Vec::new());
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(names: &[&str]) -> CheckScope {
        CheckScope::Paths(names.iter().map(PathBuf::from).collect())
    }

    /// ВК4: one pass per space; requests while it runs become exactly one
    /// repeat covering all of them; the worker ends when nothing is left.
    #[test]
    fn one_check_per_space_and_one_repeat_after_it() {
        let checks = ConflictChecks::default();
        let space = Path::new("/spaces/A");

        assert!(checks.request(space, paths(&["/spaces/A/One.md"])));
        assert!(!checks.request(space, paths(&["/spaces/A/Two.md"])));
        assert_eq!(checks.next(space), Some(paths(&["/spaces/A/One.md", "/spaces/A/Two.md"])));

        // While that pass runs, two more requests: one repeat after it.
        assert!(!checks.request(space, paths(&["/spaces/A/Three.md"])));
        assert!(!checks.request(space, CheckScope::Full));
        assert_eq!(checks.next(space), Some(CheckScope::Full));
        assert_eq!(checks.next(space), None);

        // The worker ended: the next request starts a new one.
        assert!(checks.request(space, CheckScope::Full));
    }

    #[test]
    fn spaces_are_checked_independently() {
        let checks = ConflictChecks::default();
        assert!(checks.request(Path::new("/spaces/A"), CheckScope::Full));
        assert!(checks.request(Path::new("/spaces/B"), CheckScope::Full));
        checks.abandon(Path::new("/spaces/A"));
        assert!(checks.request(Path::new("/spaces/A"), CheckScope::Full));
    }
}
