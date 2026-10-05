// Open spaces and the tabs bound to them (SPEC_TABS.md, В7 по В14).
//
// One process may hold several spaces open at once. Each open space has one
// owner object, `OpenSpace`, shared by every tab that shows it: one index
// connection, one watcher, one place where its session is replaced. Tabs
// hold leases on the spaces they show; a space nobody leases closes after a
// grace period, so switching back and forth does not reopen it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use super::state::{CommandError, VaultState};
use crate::domain::vault::VaultLayout;
use crate::watcher::watch::VaultWatcher;

/// How long a space nobody leases stays open (SPEC_TABS.md, В8).
pub const SPACE_RELEASE_GRACE: Duration = Duration::from_millis(30_000);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The one owner of an open space in this process.
pub struct OpenSpace {
    vault_id: String,
    /// The session: the index connection and the layout it serves. Replaced
    /// in place when the index slot is recovered or the folder moves (П30).
    pub vault_state: Mutex<Option<VaultState>>,
    /// The folder the session serves, kept beside it under a lock of its own
    /// that is never held while another is taken. Finding a space by its
    /// folder (`SpaceHost::by_root`, which every event to a space's tabs goes
    /// through) reads this, never the session: a command that holds its
    /// session while it tells the tabs would otherwise wait on itself, as a
    /// card rename did on 05.10.2026.
    served_root: Mutex<Option<PathBuf>>,
    /// The file watcher of the session's layout.
    pub watcher: Mutex<Option<VaultWatcher>>,
    /// Held while the session and watcher are swapped together, so nothing
    /// reads one from the old session and the other from the new.
    pub(crate) publication: Mutex<()>,
    /// Serializes opening this space: two tabs choosing it at once open it
    /// once.
    pub(crate) opening: Mutex<()>,
    /// The watch of the folder itself runs once per open space.
    root_watch_started: AtomicBool,
    /// The startup sync of this opening finished: a later tab of the space
    /// does not run it again, the watcher already follows changes
    /// (SPEC_TABS.md, В7).
    synced: AtomicBool,
    closed: AtomicBool,
    /// Space notices closed during this opening (SPEC_TABS.md, В20).
    dismissed_notices: Mutex<BTreeSet<String>>,
}

impl OpenSpace {
    fn new(vault_id: &str) -> Self {
        Self {
            vault_id: vault_id.to_string(),
            vault_state: Mutex::new(None),
            served_root: Mutex::new(None),
            watcher: Mutex::new(None),
            publication: Mutex::new(()),
            opening: Mutex::new(()),
            root_watch_started: AtomicBool::new(false),
            synced: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            dismissed_notices: Mutex::new(BTreeSet::new()),
        }
    }

    /// The space's identity, from `.mine/vault-id`.
    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    /// The layout the session serves now.
    pub fn layout(&self) -> Result<VaultLayout, CommandError> {
        lock(&self.vault_state)
            .as_ref()
            .map(|session| session.vault.clone())
            .ok_or(CommandError::NoVault)
    }

    /// The folder the session serves now, if it has opened. Never waits on
    /// the session itself (`served_root`).
    pub fn root(&self) -> Option<PathBuf> {
        lock(&self.served_root).clone()
    }

    /// The session now serves `root`. Called by whoever replaces the session,
    /// while it still holds the session.
    pub(crate) fn serve_root(&self, root: &Path) {
        *lock(&self.served_root) = Some(root.to_path_buf());
    }

    /// The space closed: nobody leased it through the grace period. Work
    /// bound to it stops.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Record a space notice closed in this opening (В20): the next lead tab
    /// does not show it again.
    pub fn dismiss_notice(&self, notice: &str) {
        lock(&self.dismissed_notices).insert(notice.to_string());
    }

    /// Whether a space notice was closed in this opening.
    pub fn notice_dismissed(&self, notice: &str) -> bool {
        lock(&self.dismissed_notices).contains(notice)
    }

    /// Claim the folder watch for this opening; `true` once.
    pub(crate) fn claim_root_watch(&self) -> bool {
        !self.root_watch_started.swap(true, Ordering::SeqCst)
    }

    /// The folder watch ended (the space is unavailable or closed): the next
    /// opening claims it again.
    pub(crate) fn release_root_watch(&self) {
        self.root_watch_started.store(false, Ordering::SeqCst);
    }

    /// Whether the startup sync of this opening finished.
    pub(crate) fn opening_synced(&self) -> bool {
        self.synced.load(Ordering::SeqCst)
    }

    /// The startup sync of this opening finished; a failed one is not marked,
    /// so the next tab runs it again.
    pub(crate) fn mark_opening_synced(&self) {
        self.synced.store(true, Ordering::SeqCst);
    }

    /// Publish a session, replacing the previous one and its watcher. The
    /// old session and watcher are dropped after the locks are released.
    pub(crate) fn publish(&self, session: VaultState, watcher: Option<VaultWatcher>) {
        let publication = lock(&self.publication);
        let root = session.vault.root().to_path_buf();
        let (old_session, old_watcher) = {
            let mut active = lock(&self.vault_state);
            let mut slot = lock(&self.watcher);
            self.serve_root(&root);
            (
                active.replace(session),
                std::mem::replace(&mut *slot, watcher),
            )
        };
        drop(publication);
        drop(old_watcher);
        drop(old_session);
    }

    fn close(&self) -> (Option<VaultState>, Option<VaultWatcher>) {
        self.closed.store(true, Ordering::SeqCst);
        let publication = lock(&self.publication);
        let mut active = lock(&self.vault_state);
        *lock(&self.served_root) = None;
        let taken = (active.take(), lock(&self.watcher).take());
        drop(active);
        drop(publication);
        taken
    }
}

struct HostedSpace {
    space: Arc<OpenSpace>,
    leases: usize,
    /// Bumped on every release, so a grace timer only closes the space it
    /// was started for.
    release_generation: u64,
}

#[derive(Default)]
struct HostInner {
    spaces: BTreeMap<String, HostedSpace>,
}

struct HostShared {
    inner: Mutex<HostInner>,
    grace: Duration,
}

/// Every open space in the process, by `vault_id` (SPEC_TABS.md, В7).
pub struct SpaceHost {
    shared: Arc<HostShared>,
}

impl Default for SpaceHost {
    fn default() -> Self {
        Self::with_grace(SPACE_RELEASE_GRACE)
    }
}

impl SpaceHost {
    /// A host whose released spaces close after `grace`.
    pub fn with_grace(grace: Duration) -> Self {
        Self {
            shared: Arc::new(HostShared {
                inner: Mutex::new(HostInner::default()),
                grace,
            }),
        }
    }

    /// The open space `vault_id`, if open.
    pub fn get(&self, vault_id: &str) -> Option<Arc<OpenSpace>> {
        lock(&self.shared.inner)
            .spaces
            .get(vault_id)
            .map(|hosted| Arc::clone(&hosted.space))
    }

    /// The open space whose session serves `root`.
    pub fn by_root(&self, root: &Path) -> Option<Arc<OpenSpace>> {
        self.all()
            .into_iter()
            .find(|space| space.root().as_deref() == Some(root))
    }

    /// Whether any open space serves `root`. Background work for a folder
    /// no open space serves any more stops.
    pub fn is_open_root(&self, root: &Path) -> bool {
        self.by_root(root).is_some()
    }

    /// Every open space.
    pub fn all(&self) -> Vec<Arc<OpenSpace>> {
        lock(&self.shared.inner)
            .spaces
            .values()
            .map(|hosted| Arc::clone(&hosted.space))
            .collect()
    }

    /// The roots every open space serves.
    pub fn open_roots(&self) -> Vec<PathBuf> {
        self.all().iter().filter_map(|space| space.root()).collect()
    }

    /// Lease the space `vault_id`, creating its owner when it is not open
    /// yet. The new owner has no session until it is published.
    pub fn lease(&self, vault_id: &str) -> SpaceLease {
        let space = {
            let mut inner = lock(&self.shared.inner);
            let hosted = inner
                .spaces
                .entry(vault_id.to_string())
                .or_insert_with(|| HostedSpace {
                    space: Arc::new(OpenSpace::new(vault_id)),
                    leases: 0,
                    release_generation: 0,
                });
            hosted.leases += 1;
            Arc::clone(&hosted.space)
        };
        SpaceLease {
            shared: Arc::clone(&self.shared),
            space,
        }
    }

    #[cfg(test)]
    pub(crate) fn leases_of(&self, vault_id: &str) -> usize {
        lock(&self.shared.inner)
            .spaces
            .get(vault_id)
            .map_or(0, |hosted| hosted.leases)
    }
}

impl HostShared {
    fn release(self: &Arc<Self>, vault_id: &str) {
        let generation = {
            let mut inner = lock(&self.inner);
            let Some(hosted) = inner.spaces.get_mut(vault_id) else {
                return;
            };
            hosted.leases = hosted.leases.saturating_sub(1);
            if hosted.leases > 0 {
                return;
            }
            hosted.release_generation += 1;
            hosted.release_generation
        };
        let shared = Arc::clone(self);
        let vault_id = vault_id.to_string();
        let grace = self.grace;
        let spawned = std::thread::Builder::new()
            .name("space-release".into())
            .spawn(move || {
                std::thread::sleep(grace);
                shared.close_if_unleased(&vault_id, generation);
            });
        if let Err(error) = spawned {
            // Without a timer the space stays open until the process ends:
            // a leak of one index connection, never a lost write.
            log::warn!("cannot schedule closing a released space: {error}");
        }
    }

    fn close_if_unleased(&self, vault_id: &str, generation: u64) {
        let closing = {
            let mut inner = lock(&self.inner);
            let unleased = inner.spaces.get(vault_id).is_some_and(|hosted| {
                hosted.leases == 0 && hosted.release_generation == generation
            });
            if !unleased {
                return;
            }
            inner.spaces.remove(vault_id)
        };
        if let Some(hosted) = closing {
            log::info!("open space closed after its grace period");
            drop(hosted.space.close());
        }
    }
}

/// A claim on an open space. While any lease lives the space stays open;
/// dropping the last one starts the grace period.
pub struct SpaceLease {
    shared: Arc<HostShared>,
    space: Arc<OpenSpace>,
}

impl SpaceLease {
    /// The leased space.
    pub fn space(&self) -> &Arc<OpenSpace> {
        &self.space
    }
}

impl Drop for SpaceLease {
    fn drop(&mut self) {
        self.shared.release(self.space.vault_id());
    }
}

/// The place of a space selection in its tab's order (SPEC_TABS.md, В10):
/// the generation of the page that made it, then the page's own count. The
/// page stamps a choice when it makes it, because the commands that carry
/// two choices may start in either order. A page load takes a newer
/// generation (`page_generation`), so a late request of the page it
/// replaced loses to it. Ordered by generation, then by count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize, specta::Type)]
pub struct SelectionStamp {
    pub generation: u64,
    pub sequence: u64,
}

/// One tab's slot: the space it shows and whether its page is shown in its
/// window.
struct TabSlot {
    lease: Option<SpaceLease>,
    visible: bool,
}

#[derive(Default)]
struct TabsInner {
    tabs: BTreeMap<String, TabSlot>,
    /// Each tab's newest selection. Kept when the slot goes, so a request
    /// still on its way after that stays ordered against the next ones.
    selections: BTreeMap<String, SelectionStamp>,
    /// The last page generation handed out, for any tab.
    generation: u64,
    /// Tab labels, the most recently active first.
    recent: Vec<String>,
}

/// Which space each tab shows (SPEC_TABS.md, В10, В11). Tabs are known by
/// the label of their page.
#[derive(Default)]
pub struct TabRegistry {
    inner: Mutex<TabsInner>,
}

/// The choice was superseded by a newer one in the same tab.
#[derive(Debug, PartialEq, Eq)]
pub struct Superseded;

impl TabRegistry {
    /// A generation for a page that just loaded: newer than any handed out
    /// before, in any tab.
    pub fn page_generation(&self) -> u64 {
        let mut inner = lock(&self.inner);
        inner.generation += 1;
        inner.generation
    }

    /// Start the selection `stamp` in the tab `label`. A selection the page
    /// stamped later supersedes it, whichever starts first; one stamped
    /// earlier than the tab's newest is superseded already. Other tabs are
    /// not affected (В10).
    pub fn begin_selection(&self, label: &str, stamp: SelectionStamp) -> Result<SelectionStamp, Superseded> {
        let mut inner = lock(&self.inner);
        if inner.selections.get(label).is_some_and(|newest| *newest >= stamp) {
            return Err(Superseded);
        }
        inner.selections.insert(label.to_string(), stamp);
        inner.tabs.entry(label.to_string()).or_insert(TabSlot {
            lease: None,
            visible: true,
        });
        Ok(stamp)
    }

    /// Whether `stamp` is still the newest selection of the tab.
    pub fn is_latest(&self, label: &str, stamp: SelectionStamp) -> bool {
        lock(&self.inner).selections.get(label) == Some(&stamp)
    }

    /// Bind the tab to the leased space when `stamp` is still its newest
    /// selection. The previous lease is released after the lock.
    pub fn bind(&self, label: &str, stamp: SelectionStamp, lease: SpaceLease) -> Result<(), Superseded> {
        let previous = {
            let mut inner = lock(&self.inner);
            if inner.selections.get(label) != Some(&stamp) {
                return Err(Superseded);
            }
            let Some(slot) = inner.tabs.get_mut(label) else {
                return Err(Superseded);
            };
            let previous = slot.lease.replace(lease);
            inner.recent.retain(|recent| recent != label);
            inner.recent.insert(0, label.to_string());
            previous
        };
        drop(previous);
        Ok(())
    }

    /// The tab is gone: its lease is released.
    pub fn remove(&self, label: &str) {
        let removed = {
            let mut inner = lock(&self.inner);
            inner.recent.retain(|recent| recent != label);
            inner.tabs.remove(label)
        };
        drop(removed);
    }

    /// The space the tab shows.
    pub fn space_of(&self, label: &str) -> Option<Arc<OpenSpace>> {
        lock(&self.inner)
            .tabs
            .get(label)
            .and_then(|slot| slot.lease.as_ref())
            .map(|lease| Arc::clone(lease.space()))
    }

    /// The labels of every tab showing `vault_id`.
    pub fn labels_of(&self, vault_id: &str) -> Vec<String> {
        lock(&self.inner)
            .tabs
            .iter()
            .filter(|(_, slot)| {
                slot.lease
                    .as_ref()
                    .is_some_and(|lease| lease.space().vault_id() == vault_id)
            })
            .map(|(label, _)| label.clone())
            .collect()
    }

    /// The tab was used: it moves to the front of the recency order.
    pub fn touch(&self, label: &str) {
        let mut inner = lock(&self.inner);
        if inner.tabs.contains_key(label) {
            inner.recent.retain(|recent| recent != label);
            inner.recent.insert(0, label.to_string());
        }
    }

    /// The space of the most recently used tab that shows one.
    pub fn last_active_space(&self) -> Option<Arc<OpenSpace>> {
        let inner = lock(&self.inner);
        inner
            .recent
            .iter()
            .filter_map(|label| inner.tabs.get(label))
            .find_map(|slot| slot.lease.as_ref().map(|lease| Arc::clone(lease.space())))
    }

    /// Record whether the tab's page is shown in its window (SPEC_TABS.md,
    /// В4). A hidden tab never leads its space. The slot is made when the
    /// page has not chosen a space yet.
    pub fn set_visible(&self, label: &str, visible: bool) {
        let mut inner = lock(&self.inner);
        let slot = inner.tabs.entry(label.to_string()).or_insert(TabSlot {
            lease: None,
            visible,
        });
        slot.visible = visible;
    }

    /// The lead tab of `vault_id`: its visible tab used last (В19).
    pub fn lead(&self, vault_id: &str) -> Option<String> {
        let visible: BTreeSet<String> = lock(&self.inner)
            .tabs
            .iter()
            .filter(|(_, slot)| slot.visible)
            .map(|(label, _)| label.clone())
            .collect();
        self.lead_of(vault_id, &|label| visible.contains(label))
    }

    /// The most recently used tab showing `vault_id`, among `visible` tabs.
    pub fn lead_of(&self, vault_id: &str, visible: &dyn Fn(&str) -> bool) -> Option<String> {
        let inner = lock(&self.inner);
        inner
            .recent
            .iter()
            .filter(|label| visible(label))
            .find(|label| {
                inner.tabs.get(label.as_str()).is_some_and(|slot| {
                    slot.lease
                        .as_ref()
                        .is_some_and(|lease| lease.space().vault_id() == vault_id)
                })
            })
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;

    fn session(dir: &Path) -> VaultState {
        let vault = VaultLayout::with_derived_root(dir.to_path_buf(), dir.join("derived"));
        VaultState {
            conn: db::open_memory().unwrap(),
            vault,
        }
    }

    /// The `sequence`th choice of the page of generation 1.
    fn stamp(sequence: u64) -> SelectionStamp {
        SelectionStamp { generation: 1, sequence }
    }

    #[test]
    fn a_choice_stamped_earlier_loses_whichever_starts_first() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        // The page chose x, then y; the command carrying y started first.
        let y = tabs.begin_selection("tab-a", stamp(2)).unwrap();
        assert_eq!(tabs.begin_selection("tab-a", stamp(1)), Err(Superseded));
        tabs.bind("tab-a", y, host.lease("space-y")).unwrap();
        assert_eq!(tabs.space_of("tab-a").unwrap().vault_id(), "space-y");
    }

    #[test]
    fn a_reloaded_page_beats_the_late_request_of_the_page_before() {
        let tabs = TabRegistry::default();
        let before = tabs.page_generation();
        let after = tabs.page_generation();
        assert!(after > before);
        let reloaded = SelectionStamp { generation: after, sequence: 1 };
        tabs.begin_selection("tab-a", reloaded).unwrap();
        let late = SelectionStamp { generation: before, sequence: 9 };
        assert_eq!(tabs.begin_selection("tab-a", late), Err(Superseded));
        assert!(tabs.is_latest("tab-a", reloaded));
    }

    #[test]
    fn the_newest_choice_outlives_the_tab_slot() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        let newer = tabs.begin_selection("tab-a", stamp(2)).unwrap();
        tabs.bind("tab-a", newer, host.lease("space-x")).unwrap();
        // The space was forgotten: the tab's slot went, its page stayed.
        tabs.remove("tab-a");
        assert_eq!(tabs.begin_selection("tab-a", stamp(1)), Err(Superseded));
        assert!(tabs.begin_selection("tab-a", stamp(3)).is_ok());
    }

    #[test]
    fn two_tabs_of_one_space_share_its_owner() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        let a = tabs.begin_selection("tab-a", stamp(1)).unwrap();
        let b = tabs.begin_selection("tab-b", stamp(1)).unwrap();
        tabs.bind("tab-a", a, host.lease("space-x")).unwrap();
        tabs.bind("tab-b", b, host.lease("space-x")).unwrap();

        let from_a = tabs.space_of("tab-a").unwrap();
        let from_b = tabs.space_of("tab-b").unwrap();
        assert!(Arc::ptr_eq(&from_a, &from_b));
        assert_eq!(host.leases_of("space-x"), 2);
        assert_eq!(tabs.labels_of("space-x"), vec!["tab-a", "tab-b"]);
    }

    #[test]
    fn the_last_release_closes_the_space_after_the_grace_period() {
        let dir = tempfile::tempdir().unwrap();
        let host = SpaceHost::with_grace(Duration::from_millis(30));
        let lease = host.lease("space-x");
        lease.space().publish(session(dir.path()), None);
        let space = Arc::clone(lease.space());
        drop(lease);

        assert!(host.get("space-x").is_some(), "closed before the grace period");
        std::thread::sleep(Duration::from_millis(120));
        assert!(host.get("space-x").is_none());
        assert!(space.is_closed());
        assert!(space.root().is_none(), "the session outlived the space");
    }

    #[test]
    fn finding_a_space_by_its_folder_does_not_wait_on_its_session() {
        // A command holding its session while it tells the space's tabs
        // (emit_to_vault finds the space by its folder) froze the app on a
        // card rename (05.10.2026).
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(SpaceHost::with_grace(Duration::from_millis(20)));
        let lease = host.lease("space-x");
        lease.space().publish(session(dir.path()), None);
        let space = Arc::clone(lease.space());
        let root = dir.path().to_path_buf();
        let (found, answer) = std::sync::mpsc::channel();
        let searching = Arc::clone(&host);
        std::thread::spawn(move || {
            let _held = lock(&space.vault_state);
            let _ = found.send(searching.by_root(&root).is_some());
        });
        assert_eq!(answer.recv_timeout(Duration::from_secs(5)), Ok(true));
    }

    #[test]
    fn a_lease_within_the_grace_period_keeps_the_same_owner() {
        let dir = tempfile::tempdir().unwrap();
        let host = SpaceHost::with_grace(Duration::from_millis(40));
        let first = host.lease("space-x");
        first.space().publish(session(dir.path()), None);
        let owner = Arc::clone(first.space());
        drop(first);

        let again = host.lease("space-x");
        std::thread::sleep(Duration::from_millis(120));
        assert!(Arc::ptr_eq(again.space(), &owner));
        assert!(!owner.is_closed());
        assert_eq!(owner.root().as_deref(), Some(dir.path()));
    }

    #[test]
    fn the_startup_sync_runs_once_per_opening_of_a_space() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let first = host.lease("space-x");
        assert!(!first.space().opening_synced());
        first.space().mark_opening_synced();

        // A second tab of the same opening finds it synced.
        let second = host.lease("space-x");
        assert!(second.space().opening_synced());

        // Closed after its grace period and opened again: a new opening syncs.
        drop(first);
        drop(second);
        std::thread::sleep(Duration::from_millis(100));
        assert!(host.get("space-x").is_none());
        assert!(!host.lease("space-x").space().opening_synced());
    }

    #[test]
    fn running_work_keeps_the_space_after_its_tabs_close() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        let request = tabs.begin_selection("tab-a", stamp(1)).unwrap();
        tabs.bind("tab-a", request, host.lease("space-x")).unwrap();
        let job = host.lease("space-x");

        tabs.remove("tab-a");
        std::thread::sleep(Duration::from_millis(80));
        assert!(host.get("space-x").is_some());
        drop(job);
        std::thread::sleep(Duration::from_millis(80));
        assert!(host.get("space-x").is_none());
    }

    #[test]
    fn a_choice_in_one_tab_never_supersedes_another_tab() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        let a = tabs.begin_selection("tab-a", stamp(1)).unwrap();
        let b = tabs.begin_selection("tab-b", stamp(1)).unwrap();
        assert!(tabs.is_latest("tab-a", a));
        tabs.bind("tab-b", b, host.lease("space-y")).unwrap();
        tabs.bind("tab-a", a, host.lease("space-x")).unwrap();

        let newer = tabs.begin_selection("tab-a", stamp(2)).unwrap();
        assert!(!tabs.is_latest("tab-a", a));
        assert_eq!(tabs.bind("tab-a", a, host.lease("space-z")), Err(Superseded));
        assert!(tabs.is_latest("tab-b", b));
        assert_eq!(tabs.space_of("tab-a").unwrap().vault_id(), "space-x");
        assert!(tabs.is_latest("tab-a", newer));
    }

    #[test]
    fn rebinding_a_tab_releases_its_previous_space() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        let first = tabs.begin_selection("tab-a", stamp(1)).unwrap();
        tabs.bind("tab-a", first, host.lease("space-x")).unwrap();
        let second = tabs.begin_selection("tab-a", stamp(2)).unwrap();
        tabs.bind("tab-a", second, host.lease("space-y")).unwrap();

        assert_eq!(host.leases_of("space-x"), 0);
        assert_eq!(host.leases_of("space-y"), 1);
        std::thread::sleep(Duration::from_millis(80));
        assert!(host.get("space-x").is_none());
    }

    #[test]
    fn the_lead_is_the_most_recent_visible_tab_of_the_space() {
        let host = SpaceHost::with_grace(Duration::from_millis(20));
        let tabs = TabRegistry::default();
        for label in ["tab-a", "tab-b", "tab-c"] {
            let request = tabs.begin_selection(label, stamp(1)).unwrap();
            let space = if label == "tab-c" { "space-y" } else { "space-x" };
            tabs.bind(label, request, host.lease(space)).unwrap();
        }
        tabs.touch("tab-a");

        assert_eq!(tabs.lead_of("space-x", &|_| true).as_deref(), Some("tab-a"));
        assert_eq!(
            tabs.lead_of("space-x", &|label| label != "tab-a").as_deref(),
            Some("tab-b")
        );
        assert_eq!(tabs.lead_of("space-x", &|_| false), None);
        assert_eq!(tabs.last_active_space().unwrap().vault_id(), "space-x");

        tabs.set_visible("tab-a", false);
        assert_eq!(tabs.lead("space-x").as_deref(), Some("tab-b"));
        tabs.set_visible("tab-b", false);
        assert_eq!(tabs.lead("space-x"), None);
    }
}
