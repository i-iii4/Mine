//! The tab windows of the app (SPEC_TABS.md): one native window per window,
//! a tab bar page on top, a page per live tab below.
//!
//! `SavedWindows` (domain/windows.rs) is the one description of windows and
//! tabs; every operation changes it first and then brings the native windows
//! and pages in line, tells the tab bars and schedules a save.

pub mod drag;
pub mod native;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, TitleBarStyle, Webview,
    WebviewUrl, Window, WindowEvent,
};

use crate::commands::space_events;
use crate::commands::state::AppState;
use crate::domain::windows::{
    centered_frame, normalize, ScreenArea, SavedTab, SavedWindow, SavedWindows, SidebarLayout,
    ChromeRows, SpaceStatus, TabId, TabSpace, TabView, WindowFrame, WindowId,
    WINDOW_DEFAULT_HEIGHT, WINDOW_DEFAULT_WIDTH, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH,
};
use crate::storage::window_store::{load, Loaded, WindowStore};

/// Longest a tab switch waits for the new page's first frame (В5).
pub const TAB_ACTIVATION_PAINT_TIMEOUT: Duration = Duration::from_millis(250);
/// Most tabs with a live page in the process (В38).
pub const LIVE_TAB_LIMIT: usize = 6;
/// Shortest time between two forced refreshes of one space on focus (В42).
pub const FOCUS_REFRESH_INTERVAL: Duration = Duration::from_secs(10);
/// The page every tab loads.
const TAB_PAGE: &str = "index.html";
/// The page of every tab bar.
const TAB_BAR_PAGE: &str = "tabbar.html";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A fresh identity: 32 lowercase hex characters.
fn new_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // The clock is unique enough within one process when the system
        // random source fails.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        bytes.copy_from_slice(&nanos.to_le_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One tab as the tab bar shows it (В47).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TabBarTab {
    pub id: TabId,
    /// The space's folder name; `None` for a tab choosing a space.
    pub space_name: Option<String>,
    /// The collection the tab is in; `None` on Everything.
    pub collection: Option<String>,
    /// The title of the card open in the tab; `None` with no card open.
    pub card: Option<String>,
    /// The tab has a page now.
    pub live: bool,
    /// The tab's page has places to go back and forward to (В81). An
    /// unloaded tab has neither: its history went with its page.
    pub history: TabHistory,
}

/// Whether a tab's page can go back and forward through its places (В81).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, specta::Type)]
pub struct TabHistory {
    pub back: bool,
    pub forward: bool,
}

/// Which way the tab bar asks a tab to step through its places (В81).
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
pub struct TabHistoryStep {
    pub forward: bool,
}

/// The event that tells a tab page to step through its places (В81).
pub const TAB_HISTORY_GO_EVENT: &str = "tab-history-go";

/// What one window's tab bar shows (`tabbar-state`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TabBarState {
    pub window_id: WindowId,
    pub tabs: Vec<TabBarTab>,
    pub active_tab: TabId,
    pub sidebar: SidebarLayout,
    pub fullscreen: bool,
    /// The heights of the chrome rows' content (В83).
    pub chrome_rows: ChromeRows,
}

/// What a tab page needs to start (`get_tab_bootstrap`).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TabBootstrap {
    pub tab_id: TabId,
    pub window_id: WindowId,
    pub space: TabSpace,
    pub view: TabView,
    pub sidebar: SidebarLayout,
    /// The tab leads its space: it does the space's page work and shows its
    /// notices (В19).
    pub lead: bool,
    /// No saved windows were read at this launch: the page may carry its
    /// old single-window settings over once (В79).
    pub fresh_start: bool,
    /// The heights of the chrome rows' content (В83).
    pub chrome_rows: ChromeRows,
}

/// `tab-visibility-changed`: the tab was shown or hidden (В41).
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TabVisibility {
    pub visible: bool,
}

/// `space-lead-changed`: the tab became or stopped being its space's lead.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SpaceLead {
    pub lead: bool,
}

#[derive(Default)]
struct Live {
    /// Tabs with a page, the most recently shown first (В38).
    pages: Vec<TabId>,
    /// First frames reported by pages being shown (В5).
    painted: BTreeMap<TabId, Instant>,
    /// Spaces refreshed on focus, and when (В42).
    refreshed: BTreeMap<String, Instant>,
    /// Folders asked to open before the windows were restored (В72).
    pending_open: Vec<PathBuf>,
    /// The space the config names as current (В74).
    current_space: Option<String>,
    /// The tab whose page is shown in each window.
    shown: BTreeMap<WindowId, TabId>,
    /// Where each page can step through its places (В81).
    history: BTreeMap<TabId, TabHistory>,
}

/// The tab windows of the running app.
pub struct TabShell {
    model: Mutex<SavedWindows>,
    store: WindowStore,
    live: Mutex<Live>,
    restored: AtomicBool,
    rest_created: AtomicBool,
    fresh_start: AtomicBool,
}

impl TabShell {
    /// The shell writing `windows.json` into `dir`, or nowhere for `None`.
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            model: Mutex::new(SavedWindows {
                version: crate::domain::windows::SAVED_WINDOWS_VERSION,
                windows: Vec::new(),
                window_surface: None,
            }),
            store: WindowStore::new(dir),
            live: Mutex::new(Live::default()),
            restored: AtomicBool::new(false),
            rest_created: AtomicBool::new(false),
            fresh_start: AtomicBool::new(false),
        }
    }

    /// A copy of the windows as they stand.
    pub fn snapshot(&self) -> SavedWindows {
        lock(&self.model).clone()
    }

    fn change<T>(&self, change: impl FnOnce(&mut SavedWindows) -> T) -> T {
        let mut model = lock(&self.model);
        let outcome = change(&mut model);
        self.store.schedule(model.clone());
        outcome
    }

    /// The app is quitting: write the windows as they are (В33), or as they
    /// were before a tab drag still running (В68).
    pub fn quit(&self) {
        let snapshot = drag::windows_before_drag().unwrap_or_else(|| self.snapshot());
        self.store.flush_for_exit(&snapshot);
    }

    fn quitting(&self) -> bool {
        self.store.quitting()
    }
}

/// The screens, as areas a window may stand on.
fn screens(app: &AppHandle) -> Vec<ScreenArea> {
    let primary = app.primary_monitor().ok().flatten();
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            ScreenArea {
                x: f64::from(area.position.x) / scale,
                y: f64::from(area.position.y) / scale,
                width: f64::from(area.size.width) / scale,
                height: f64::from(area.size.height) / scale,
                main: primary
                    .as_ref()
                    .is_some_and(|main| main.position() == monitor.position()),
            }
        })
        .collect()
}

/// The folder of every known space, by identity.
fn space_paths(app: &AppHandle) -> BTreeMap<String, String> {
    let serde_json::Value::Object(cfg) = crate::commands::vault::load_config(app) else {
        return BTreeMap::new();
    };
    crate::space_registry::records(&cfg)
        .into_iter()
        .filter_map(|record| record.vault_id.map(|id| (id, record.path)))
        .collect()
}

/// The identity of the space the config names as current, if known.
fn configured_space(app: &AppHandle) -> Option<String> {
    let serde_json::Value::Object(cfg) = crate::commands::vault::load_config(app) else {
        return None;
    };
    let current = crate::space_registry::current_path(&cfg)?;
    crate::space_registry::records(&cfg)
        .into_iter()
        .find(|record| crate::space_registry::same_path(&record.path, &current))
        .and_then(|record| record.vault_id)
}

fn folder_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |name| name.to_string_lossy().into_owned())
}

fn shell(app: &AppHandle) -> tauri::State<'_, TabShell> {
    app.state::<TabShell>()
}

/// Restore the windows at launch (В35): read `windows.json`, make it safe,
/// and create the last window with its visible tab. The other windows wait
/// for the first route of this one ([`restore_rest`]).
pub fn restore(app: &AppHandle) -> anyhow::Result<()> {
    let shell = shell(app);
    let screens = screens(app);
    let paths = space_paths(app);
    let loaded = match crate::commands::native_shell_smoke::enabled() {
        true => Loaded::Missing,
        false => match app.path().app_data_dir() {
            Ok(dir) => load(&dir).unwrap_or_else(|error| {
                log::warn!("{error}");
                Loaded::Missing
            }),
            Err(_) => Loaded::Missing,
        },
    };
    let saved = match loaded {
        Loaded::Windows(saved) => saved,
        Loaded::Missing => {
            shell.fresh_start.store(true, Ordering::SeqCst);
            fresh_windows(app, &screens)
        }
        Loaded::SetAside(issue) => {
            log::warn!("saved windows set aside: {issue:?}");
            shell.fresh_start.store(true, Ordering::SeqCst);
            fresh_windows(app, &screens)
        }
    };
    let space = |vault_id: &str| {
        if paths.contains_key(vault_id) {
            SpaceStatus::Known
        } else {
            SpaceStatus::Unknown
        }
    };
    let mut saved = normalize(saved, &space, &screens, &mut new_id);
    if saved.windows.is_empty() {
        saved = fresh_windows(app, &screens);
    }
    let first = saved.windows.first().cloned();
    *lock(&shell.model) = saved;
    lock(&shell.live).current_space = configured_space(app);
    if let Some(first) = first {
        let window = create_window(app, &first)?;
        // Before the event loop runs, the screens may not be known yet: a
        // window made from nothing is centred by the system instead.
        if screens.is_empty() && shell.fresh_start.load(Ordering::SeqCst) {
            window.center()?;
        }
    }
    shell.restored.store(true, Ordering::SeqCst);
    let pressured = app.clone();
    native::on_memory_pressure(move || {
        let main = pressured.clone();
        let _ = pressured.run_on_main_thread(move || unload_for_memory_pressure(&main));
    });
    let pending = std::mem::take(&mut lock(&shell.live).pending_open);
    for path in pending {
        open_space_from_outside(app, &path);
    }
    Ok(())
}

/// Create the windows after the last one, once its first route is on
/// screen (В36). Runs once.
pub fn restore_rest(app: &AppHandle) {
    let shell = shell(app);
    if shell.rest_created.swap(true, Ordering::SeqCst) {
        return;
    }
    let rest: Vec<SavedWindow> = shell.snapshot().windows.into_iter().skip(1).collect();
    for window in rest.iter().rev() {
        if let Err(error) = create_window(app, window) {
            log::warn!("failed to restore a window: {error:#}");
        }
    }
}

fn fresh_windows(app: &AppHandle, screens: &[ScreenArea]) -> SavedWindows {
    let space = configured_space(app).map_or(TabSpace::Picker, |vault_id| TabSpace::Space { vault_id });
    SavedWindows::fresh(space, WindowId(new_id()), TabId(new_id()), screens)
}

/// The chrome rows of the window `window_id` (В83).
fn chrome_rows_of(app: &AppHandle, window_id: &WindowId) -> ChromeRows {
    shell(app).snapshot().window(window_id).map_or(ChromeRows::STANDARD, |window| window.chrome_rows)
}

/// The tab bar's height in `window_id`: its row and its line (В83).
fn bar_height(app: &AppHandle, window_id: &WindowId) -> f64 {
    f64::from(crate::domain::windows::tab_bar_height(chrome_rows_of(app, window_id).tab_bar))
}

/// Set the chrome rows of the window whose bar is `bar_label` (В83): store
/// them, lay the window out again, move its traffic lights to the bar's row
/// and tell its bar and its tab pages. Other windows keep theirs, so two can
/// stand side by side to compare.
pub fn set_chrome_rows(app: &AppHandle, bar_label: &str, rows: ChromeRows) {
    let Some(window_id) = WindowId::from_label(bar_label) else {
        return;
    };
    let shell = shell(app);
    if !shell.change(|model| model.set_chrome_rows(&window_id, rows)) {
        return;
    }
    layout(app, &window_id);
    let rows = chrome_rows_of(app, &window_id);
    if let Some(window) = app.get_window(&window_id.label()) {
        native::set_traffic_light_row(&window, rows.tab_bar);
    }
    let mut labels: Vec<String> = shell
        .snapshot()
        .window(&window_id)
        .map(|window| window.tabs.iter().map(|tab| tab.id.label()).collect())
        .unwrap_or_default();
    labels.push(window_id.bar_label());
    space_events::emit_to_labels(app, labels, CHROME_ROWS_EVENT, rows);
}

/// The event every bar and page re-reads the chrome rows' heights on (В83).
pub const CHROME_ROWS_EVENT: &str = "chrome-rows-changed";

/// Create the native window `saved` with its tab bar and its visible tab.
fn create_window(app: &AppHandle, saved: &SavedWindow) -> anyhow::Result<Window> {
    let label = saved.id.label();
    let frame = saved.frame;
    let window = WindowBuilder::new(app, &label)
        .title("")
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .inner_size(frame.width, frame.height)
        .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
        .position(frame.x, frame.y)
        .build()?;
    if saved.fullscreen {
        window.set_fullscreen(true)?;
    }
    if let Some(surface) = shell(app).snapshot().window_surface {
        native::set_window_background(&window, &surface);
    }
    let bar = WebviewBuilder::new(saved.id.bar_label(), WebviewUrl::App(TAB_BAR_PAGE.into()));
    let bar = window.add_child(
        bar,
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(frame.width, bar_height(app, &saved.id)),
    )?;
    native::keep_traffic_lights(&window, saved.chrome_rows.tab_bar);
    native::clear_page_background(&bar);
    let window_id = saved.id.clone();
    let handle = app.clone();
    window.on_window_event(move |event| on_window_event(&handle, &window_id, event));
    let page = create_page(app, &window, &saved.active_tab)?;
    let _ = page.show();
    lock(&shell(app).live)
        .shown
        .insert(saved.id.clone(), saved.active_tab.clone());
    set_tab_visible(app, &saved.active_tab, true);
    layout(app, &saved.id);
    emit_bar_state(app, &saved.id);
    Ok(window)
}

/// The page of `tab` in `window`: the live one, moved here from another
/// window without reloading (В61, В66), or a new one. The caller decides
/// when it shows.
fn create_page(app: &AppHandle, window: &Window, tab: &TabId) -> anyhow::Result<Webview> {
    let (width, height) = logical_size(window);
    let window_id = WindowId::from_label(window.label());
    let rows = window_id.as_ref().map_or(ChromeRows::STANDARD, |id| chrome_rows_of(app, id));
    let bar = f64::from(crate::domain::windows::tab_bar_height(rows.tab_bar));
    if let Some(existing) = app.get_webview(&tab.label()) {
        if existing.window().label() == window.label() {
            return Ok(existing);
        }
        match existing.reparent(window) {
            Ok(()) => {
                // The page keeps the frame of its old window until told, and
                // the height of its old window's rows (В83).
                let _ = existing.set_bounds(bounds(0.0, bar, width, (height - bar).max(0.0)));
                space_events::emit_to_labels(app, [tab.label()], CHROME_ROWS_EVENT, rows);
                return Ok(existing);
            }
            Err(error) => {
                // The runtime already took the page out of its old window
                // and dropped it; the tab gets a new page from its memory
                // (В67).
                log::warn!("moving a tab page failed, it is created again: {error}");
                let _ = existing.close();
                app.state::<AppState>().tabs.remove(&tab.label());
            }
        }
    }
    let page = window.add_child(
        WebviewBuilder::new(tab.label(), WebviewUrl::App(tab_page_url().into())),
        LogicalPosition::new(0.0, bar),
        LogicalSize::new(width, height - bar),
    )?;
    native::clear_page_background(&page);
    crate::frame_context_menu::register_page(&page);
    let shell = shell(app);
    let mut live = lock(&shell.live);
    live.pages.retain(|candidate| candidate != tab);
    live.pages.insert(0, tab.clone());
    drop(live);
    Ok(page)
}

/// The page a tab loads; the native shell check asks for its report there.
fn tab_page_url() -> String {
    if crate::commands::native_shell_smoke::enabled() {
        format!(
            "{TAB_PAGE}?{}=1",
            crate::commands::native_shell_smoke::QUERY_FLAG
        )
    } else {
        TAB_PAGE.to_string()
    }
}

fn logical_size(window: &Window) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window.inner_size().map_or((WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT), |size| {
        (f64::from(size.width) / scale, f64::from(size.height) / scale)
    })
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width, height)),
    }
}

/// Lay out the tab bar and the pages of `window` (В3).
fn layout(app: &AppHandle, window_id: &WindowId) {
    let Some(window) = app.get_window(&window_id.label()) else {
        return;
    };
    let (width, height) = logical_size(&window);
    let bar = bar_height(app, window_id);
    if let Some(page) = app.get_webview(&window_id.bar_label()) {
        let _ = page.set_bounds(bounds(0.0, 0.0, width, bar));
    }
    let tabs: Vec<TabId> = shell(app)
        .snapshot()
        .window(window_id)
        .map(|saved| saved.tabs.iter().map(|tab| tab.id.clone()).collect())
        .unwrap_or_default();
    for tab in tabs {
        if let Some(page) = app.get_webview(&tab.label()) {
            let _ = page.set_bounds(bounds(0.0, bar, width, (height - bar).max(0.0)));
        }
    }
}

fn on_window_event(app: &AppHandle, window_id: &WindowId, event: &WindowEvent) {
    let shell = shell(app);
    match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            layout(app, window_id);
            if let Some(window) = app.get_window(&window_id.label()) {
                let fullscreen = window.is_fullscreen().unwrap_or(false);
                let was_fullscreen = shell
                    .snapshot()
                    .window(window_id)
                    .is_some_and(|saved| saved.fullscreen);
                if let Some(frame) = window_frame(&window) {
                    if !shell.quitting() {
                        shell.change(|model| model.set_frame(window_id, frame, fullscreen));
                    }
                }
                // The bar keeps the traffic-light room or gives it up.
                if fullscreen != was_fullscreen {
                    emit_bar_state(app, window_id);
                }
            }
        }
        WindowEvent::Focused(true) => on_window_focused(app, window_id),
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            close_window(app, window_id);
        }
        _ => {}
    }
}

fn window_frame(window: &Window) -> Option<WindowFrame> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(WindowFrame {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    })
}

/// A tab window came into focus: it is the last window now (В21, В42, В74).
fn on_window_focused(app: &AppHandle, window_id: &WindowId) {
    let shell = shell(app);
    if shell.quitting() {
        return;
    }
    shell.change(|model| model.focus_window(window_id));
    crate::commands::startup::nudge_clipper_upkeep();
    let Some(visible) = shell.snapshot().window(window_id).map(|window| window.active_tab.clone()) else {
        return;
    };
    let state = app.state::<AppState>();
    state.tabs.touch(&visible.label());
    if let Some(space) = state.space_for(&visible.label()) {
        refresh_leads(app, space.vault_id());
    }
    project_current_space(app);
    request_focus_refresh(app, &visible);
}

/// Ask the visible tab of a focused window to catch up with the disk, once
/// per space and interval (В42).
fn request_focus_refresh(app: &AppHandle, tab: &TabId) {
    let Some(space) = app.state::<AppState>().space_for(&tab.label()) else {
        return;
    };
    let shell = shell(app);
    let due = {
        let mut live = lock(&shell.live);
        let now = Instant::now();
        let due = live
            .refreshed
            .get(space.vault_id())
            .is_none_or(|at| now.duration_since(*at) >= FOCUS_REFRESH_INTERVAL);
        if due {
            live.refreshed.insert(space.vault_id().to_string(), now);
        }
        due
    };
    if due {
        space_events::emit_to_labels(app, [tab.label()], "tab-refresh-requested", ());
    }
}

/// Keep `vault_path` in the config on the space of the last window's
/// visible tab, written only when that space changes (В74).
pub fn project_current_space(app: &AppHandle) {
    let shell = shell(app);
    let snapshot = shell.snapshot();
    let Some(window) = snapshot.last_window() else {
        return;
    };
    let Some(tab) = snapshot.tab(&window.active_tab) else {
        return;
    };
    let TabSpace::Space { vault_id } = &tab.space else {
        return;
    };
    {
        let mut live = lock(&shell.live);
        if live.current_space.as_deref() == Some(vault_id.as_str()) {
            return;
        }
        live.current_space = Some(vault_id.clone());
    }
    if let Some(path) = space_paths(app).get(vault_id) {
        crate::commands::vault::record_current_space(app, path);
    }
}

/// Record whether `tab`'s page is shown and tell it (В41); its space's lead
/// may change with it (В19).
fn set_tab_visible(app: &AppHandle, tab: &TabId, visible: bool) {
    let state = app.state::<AppState>();
    let label = tab.label();
    state.tabs.set_visible(&label, visible);
    space_events::emit_to_labels(app, [label.clone()], "tab-visibility-changed", TabVisibility { visible });
    if let Some(space) = state.space_for(&label) {
        refresh_leads(app, space.vault_id());
    }
}

/// Tell every tab of `vault_id` whether it leads the space now (В19, В20).
/// Sent whenever the lead may have changed; a tab told again what it already
/// knows does nothing.
pub fn refresh_leads(app: &AppHandle, vault_id: &str) {
    let state = app.state::<AppState>();
    let lead = state.tabs.lead(vault_id);
    for label in state.tabs.labels_of(vault_id) {
        let leads = lead.as_deref() == Some(label.as_str());
        space_events::emit_to_labels(app, [label], "space-lead-changed", SpaceLead { lead: leads });
    }
}

/// Whether `label` leads its space now.
pub fn is_lead(app: &AppHandle, label: &str) -> bool {
    let state = app.state::<AppState>();
    state
        .space_for(label)
        .and_then(|space| state.tabs.lead(space.vault_id()))
        .is_some_and(|lead| lead == label)
}

/// What the tab bar of `window_id` shows now.
pub fn bar_state(app: &AppHandle, window_id: &WindowId) -> Option<TabBarState> {
    let shell = shell(app);
    let snapshot = shell.snapshot();
    let window = snapshot.window(window_id)?;
    let paths = space_paths(app);
    let (live, history): (BTreeSet<TabId>, BTreeMap<TabId, TabHistory>) = {
        let live = lock(&shell.live);
        (live.pages.iter().cloned().collect(), live.history.clone())
    };
    let tabs = window
        .tabs
        .iter()
        .map(|tab| TabBarTab {
            id: tab.id.clone(),
            space_name: match &tab.space {
                TabSpace::Space { vault_id } => paths.get(vault_id).map(|path| folder_name(path)),
                TabSpace::Picker => None,
            },
            collection: match &tab.view.location {
                crate::domain::windows::TabLocation::Collection { tag } => Some(tag.clone()),
                crate::domain::windows::TabLocation::Everything => None,
            },
            card: open_card_title(&tab.view),
            live: live.contains(&tab.id),
            history: history.get(&tab.id).copied().unwrap_or_default(),
        })
        .collect();
    Some(TabBarState {
        window_id: window.id.clone(),
        tabs,
        active_tab: window.active_tab.clone(),
        // The bar's sidebar button acts on the visible tab's sidebar (В56).
        sidebar: window.active_sidebar(),
        fullscreen: window.fullscreen,
        chrome_rows: window.chrome_rows,
    })
}

/// The title a tab is labelled with while a card is open in it.
fn open_card_title(view: &TabView) -> Option<String> {
    view.open_card
        .as_ref()
        .map(|card| card.title.trim().to_string())
        .filter(|title| !title.is_empty())
}

/// Send the tab bar of `window_id` what it shows now.
pub fn emit_bar_state(app: &AppHandle, window_id: &WindowId) {
    if let Some(state) = bar_state(app, window_id) {
        space_events::emit_to_labels(app, [window_id.bar_label()], "tabbar-state", state);
    }
}

/// What the page `label` needs to start.
pub fn bootstrap(app: &AppHandle, label: &str) -> Option<TabBootstrap> {
    let tab = TabId::from_label(label)?;
    log::info!("tab page started: {label}");
    let snapshot = shell(app).snapshot();
    let window = snapshot.window_of(&tab)?;
    let saved = snapshot.tab(&tab)?;
    Some(TabBootstrap {
        tab_id: tab.clone(),
        window_id: window.id.clone(),
        space: saved.space.clone(),
        view: saved.view.clone(),
        sidebar: window.tab_sidebar(&tab),
        lead: is_lead(app, label),
        fresh_start: shell(app).fresh_start.load(Ordering::SeqCst),
        chrome_rows: window.chrome_rows,
    })
}

/// The folder of the space `label`'s tab shows, from the registry.
pub fn tab_space_path(app: &AppHandle, label: &str) -> Option<Option<String>> {
    let tab = TabId::from_label(label)?;
    let snapshot = shell(app).snapshot();
    let saved = snapshot.tab(&tab)?;
    Some(match &saved.space {
        TabSpace::Space { vault_id } => space_paths(app).get(vault_id).cloned(),
        TabSpace::Picker => None,
    })
}

/// Show `tab`: its page is placed under the visible one, shown, and the old
/// page hides once the new one drew its first frame (В5).
pub fn activate(app: &AppHandle, tab: &TabId) {
    let shell = shell(app);
    let Some(window_id) = shell.snapshot().window_of(tab).map(|window| window.id.clone()) else {
        return;
    };
    let Some(window) = app.get_window(&window_id.label()) else {
        return;
    };
    shell.change(|model| model.activate(tab));
    // The View menu names the visible tab's sidebar action (В56).
    if let Some(saved) = shell.snapshot().window(&window_id) {
        crate::commands::window_chrome::reflect_sidebar(app, saved.active_sidebar().collapsed);
    }
    let Ok(page) = create_page(app, &window, tab) else {
        log::warn!("failed to create a tab page");
        emit_bar_state(app, &window_id);
        return;
    };
    // The page shown now in the window, whatever the model said before.
    let previous = {
        let mut live = lock(&shell.live);
        live.pages.retain(|candidate| candidate != tab);
        live.pages.insert(0, tab.clone());
        live.painted.remove(tab);
        live.shown
            .insert(window_id.clone(), tab.clone())
            .filter(|shown| shown != tab)
    };
    layout(app, &window_id);
    app.state::<AppState>().tabs.touch(&tab.label());
    let Some(previous) = previous else {
        let _ = page.show();
        let _ = page.set_focus();
        set_tab_visible(app, tab, true);
        emit_bar_state(app, &window_id);
        return;
    };
    let old_page = app.get_webview(&previous.label());
    if let Some(old_page) = &old_page {
        native::order_below(old_page, &page);
    }
    let _ = page.show();
    set_tab_visible(app, tab, true);
    emit_bar_state(app, &window_id);
    project_current_space(app);
    let handle = app.clone();
    let tab = tab.clone();
    let started = Instant::now();
    let waiter = std::thread::Builder::new()
        .name("tab-activation".into())
        .spawn(move || {
            let waiting = shell_of(&handle);
            while started.elapsed() < TAB_ACTIVATION_PAINT_TIMEOUT {
                if lock(&waiting.live).painted.contains_key(&tab) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(4));
            }
            let still_visible = waiting
                .snapshot()
                .window_of(&tab)
                .is_some_and(|window| window.active_tab == tab);
            let main = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(old_page) = old_page {
                    // A switch back to the old tab meanwhile keeps it shown.
                    let old_visible = lock(&shell_of(&main).live)
                        .shown
                        .values()
                        .any(|shown| shown == &previous);
                    if !old_visible {
                        let _ = old_page.hide();
                        set_tab_visible(&main, &previous, false);
                    }
                }
                if still_visible {
                    if let Some(page) = main.get_webview(&tab.label()) {
                        let _ = page.set_focus();
                    }
                }
                unload_over_limit(&main);
            });
        });
    if let Err(error) = waiter {
        log::warn!("cannot wait for the tab's first frame: {error}");
    }
}

fn shell_of(app: &AppHandle) -> tauri::State<'_, TabShell> {
    app.state::<TabShell>()
}

/// The page `label` drew its first frame since it was shown (В5).
pub fn page_painted(app: &AppHandle, label: &str) {
    if let Some(tab) = TabId::from_label(label) {
        lock(&shell(app).live).painted.insert(tab, Instant::now());
    }
}

/// Close the page of `tab`, keeping the tab (В40), or as part of closing it.
fn close_page(app: &AppHandle, tab: &TabId) {
    let shell = shell(app);
    {
        let mut live = lock(&shell.live);
        live.pages.retain(|candidate| candidate != tab);
        live.shown.retain(|_, shown| shown != tab);
        live.history.remove(tab);
    }
    let label = tab.label();
    crate::frame_context_menu::unregister_page(&label);
    if let Some(page) = app.get_webview(&label) {
        let _ = page.close();
    }
    let state = app.state::<AppState>();
    let space = state.space_for(&label);
    state.tabs.remove(&label);
    if let Some(space) = space {
        refresh_leads(app, space.vault_id());
    }
}

/// Keep at most [`LIVE_TAB_LIMIT`] pages: the hidden page shown longest ago
/// goes first; visible pages never go (В38).
fn unload_over_limit(app: &AppHandle) {
    let shell = shell(app);
    let visible: BTreeSet<TabId> = shell.snapshot().visible_tabs().into_iter().collect();
    let extra: Vec<TabId> = {
        let live = lock(&shell.live);
        let hidden: Vec<TabId> = live
            .pages
            .iter()
            .filter(|tab| !visible.contains(tab))
            .cloned()
            .collect();
        let over = live.pages.len().saturating_sub(LIVE_TAB_LIMIT);
        hidden.into_iter().rev().take(over).collect()
    };
    for tab in extra {
        close_page(app, &tab);
        if let Some(window) = shell.snapshot().window_of(&tab) {
            emit_bar_state(app, &window.id.clone());
        }
    }
}

/// The system is short of memory: every hidden page goes except the one shown
/// last in each window (В39).
pub fn unload_for_memory_pressure(app: &AppHandle) {
    let shell = shell(app);
    let snapshot = shell.snapshot();
    let visible: BTreeSet<TabId> = snapshot.visible_tabs().into_iter().collect();
    let pages = lock(&shell.live).pages.clone();
    let mut kept_per_window: BTreeSet<WindowId> = BTreeSet::new();
    for tab in pages {
        if visible.contains(&tab) {
            continue;
        }
        let Some(window) = snapshot.window_of(&tab) else {
            continue;
        };
        if kept_per_window.insert(window.id.clone()) {
            continue;
        }
        close_page(app, &tab);
    }
    for window in &snapshot.windows {
        emit_bar_state(app, &window.id);
    }
}

/// Open a new tab at the end of `window_id` with `space`, and show it (В51).
pub fn new_tab(app: &AppHandle, window_id: &WindowId, space: TabSpace) {
    new_tab_at(app, window_id, space, TabView::default());
}

/// Open a tab showing `space` at the place `view` at the end of
/// `window_id`, and show it (В82).
pub fn new_tab_at(app: &AppHandle, window_id: &WindowId, space: TabSpace, view: TabView) {
    let shell = shell(app);
    let tab = TabId(new_id());
    let added = shell.change(|model| model.add_tab(window_id, tab.clone(), space, view));
    if added {
        activate(app, &tab);
    }
}

/// Open a new window with one tab showing `space` (В54).
pub fn new_window(app: &AppHandle, space: TabSpace) {
    new_window_at(app, space, TabView::default());
}

/// Open a place of the space of the tab page `label` in a new tab of its
/// window, or in a new window (В82).
pub fn open_place(app: &AppHandle, label: &str, view: TabView, new_window: bool) {
    let Some(tab) = TabId::from_label(label) else {
        return;
    };
    let snapshot = shell(app).snapshot();
    let Some(space) = snapshot.tab(&tab).map(|saved| saved.space.clone()) else {
        return;
    };
    if new_window {
        new_window_at(app, space, view);
    } else if let Some(window) = snapshot.window_of(&tab).map(|window| window.id.clone()) {
        new_tab_at(app, &window, space, view);
    }
}

/// Open a new window with one tab showing `space` at the place `view` (В82).
pub fn new_window_at(app: &AppHandle, space: TabSpace, view: TabView) {
    let shell = shell(app);
    let screens = screens(app);
    let last = shell.snapshot().last_window().cloned();
    let sidebar = last.as_ref().map_or_else(SidebarLayout::default, SavedWindow::active_sidebar);
    // A new window opens with the chrome of the window it came from (В83).
    let chrome_rows = last.as_ref().map_or(ChromeRows::STANDARD, |window| window.chrome_rows);
    let tab = TabId(new_id());
    let window = SavedWindow {
        id: WindowId(new_id()),
        frame: centered_frame(WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT, &screens),
        fullscreen: false,
        tabs: vec![SavedTab {
            id: tab.clone(),
            space,
            view,
            sidebar: Some(sidebar),
        }],
        active_tab: tab,
        sidebar,
        chrome_rows,
    };
    shell.change(|model| model.add_window(window.clone()));
    if let Err(error) = create_window(app, &window) {
        log::warn!("failed to open a window: {error:#}");
    }
}

/// The space the visible tab of the last window shows (В51, В54).
pub fn last_visible_space(app: &AppHandle) -> TabSpace {
    let snapshot = shell(app).snapshot();
    snapshot
        .last_window()
        .and_then(|window| snapshot.tab(&window.active_tab))
        .map_or(TabSpace::Picker, |tab| tab.space.clone())
}

/// The last window, if any.
pub fn last_window(app: &AppHandle) -> Option<WindowId> {
    shell(app).snapshot().last_window().map(|window| window.id.clone())
}

/// The visible tab of the last window.
pub fn last_visible_tab(app: &AppHandle) -> Option<TabId> {
    shell(app).snapshot().last_window().map(|window| window.active_tab.clone())
}

/// The window holding `tab`.
pub fn window_of(app: &AppHandle, tab: &TabId) -> Option<WindowId> {
    shell(app).snapshot().window_of(tab).map(|window| window.id.clone())
}

/// Close `tab` (В53): the last tab of the last window ends the app (В33).
pub fn close_tab(app: &AppHandle, tab: &TabId) {
    let shell = shell(app);
    let snapshot = shell.snapshot();
    let Some(window) = snapshot.window_of(tab) else {
        return;
    };
    if window.tabs.len() == 1 {
        close_window(app, &window.id.clone());
        return;
    }
    let closed = shell.change(|model| model.close_tab(tab));
    close_page(app, tab);
    if let Some(closed) = closed {
        if let Some(now_visible) = closed.now_visible {
            activate(app, &now_visible);
        } else {
            emit_bar_state(app, &closed.window);
        }
    }
}

/// Close every tab of `tab`'s window but `tab` (В50).
pub fn close_other_tabs(app: &AppHandle, tab: &TabId) {
    let shell = shell(app);
    let closed = shell.change(|model| model.close_other_tabs(tab));
    for closed_tab in &closed {
        close_page(app, &closed_tab.id);
    }
    activate(app, tab);
    if let Some(window) = window_of(app, tab) {
        emit_bar_state(app, &window);
    }
}

/// Close `window_id` with its tabs. The last tab window ends the app and
/// stays saved, to come back at the next launch (В33).
pub fn close_window(app: &AppHandle, window_id: &WindowId) {
    let shell = shell(app);
    if shell.snapshot().windows.len() <= 1 {
        shell.quit();
        app.exit(0);
        return;
    }
    let Some(closed) = shell.change(|model| model.close_window(window_id)) else {
        return;
    };
    for tab in &closed.tabs {
        close_page(app, &tab.id);
    }
    if let Some(window) = app.get_window(&window_id.label()) {
        native::release_traffic_lights(&window);
        let _ = window.destroy();
    }
    project_current_space(app);
}

/// How far a window opened from another stands from it.
const NEW_WINDOW_OFFSET: f64 = 30.0;

/// Move `tab` into a window of its own, beside its old one (В50, В65). A
/// window's only tab stays where it is.
pub fn move_tab_to_new_window(app: &AppHandle, tab: &TabId) {
    let shell = shell(app);
    let snapshot = shell.snapshot();
    let Some(source) = snapshot.window_of(tab) else {
        return;
    };
    if source.tabs.len() < 2 {
        return;
    }
    let screens = screens(app);
    let frame = if source.fullscreen {
        centered_frame(source.frame.width, source.frame.height, &screens)
    } else {
        WindowFrame {
            x: source.frame.x + NEW_WINDOW_OFFSET,
            y: source.frame.y + NEW_WINDOW_OFFSET,
            ..source.frame
        }
    };
    let source_id = source.id.clone();
    let new_window = WindowId(new_id());
    let Some(now_visible) = shell.change(|model| model.detach(tab, new_window.clone(), frame)) else {
        return;
    };
    lock(&shell.live).shown.retain(|_, shown| shown != tab);
    let Some(saved) = shell.snapshot().window(&new_window).cloned() else {
        return;
    };
    if let Err(error) = create_window(app, &saved) {
        log::warn!("failed to open a window for the tab: {error:#}");
    }
    match now_visible {
        Some(next) => activate(app, &next),
        None => emit_bar_state(app, &source_id),
    }
}

/// A two-finger swipe opens (right) or closes (left) the sidebar of the
/// visible tab of the window in front (В56).
pub fn swipe_sidebar(app: &AppHandle, open: bool) {
    let Some(window) = focused_tab_window(app).or_else(|| last_window(app)) else {
        return;
    };
    let Some(saved) = shell(app).snapshot().window(&window).cloned() else {
        return;
    };
    let current = saved.active_sidebar();
    if current.collapsed == open {
        set_tab_sidebar(
            app,
            &saved.active_tab,
            SidebarLayout {
                collapsed: !open,
                ..current
            },
        );
    }
}

/// Move `tab` to `index` in its window (В60).
pub fn move_tab(app: &AppHandle, tab: &TabId, index: usize) {
    let moved = shell(app).change(|model| model.move_tab(tab, index));
    if moved {
        if let Some(window) = window_of(app, tab) {
            emit_bar_state(app, &window);
        }
    }
}

/// Store the memory of the tab `label` (В31).
pub fn report_view(app: &AppHandle, label: &str, view: TabView) {
    let Some(tab) = TabId::from_label(label) else {
        return;
    };
    let shell = shell(app);
    // The label follows the place and the open card (В47).
    let label_changed = shell.snapshot().tab(&tab).is_some_and(|saved| {
        saved.view.location != view.location || open_card_title(&saved.view) != open_card_title(&view)
    });
    shell.change(|model| model.set_view(&tab, view));
    if label_changed {
        if let Some(window) = window_of(app, &tab) {
            emit_bar_state(app, &window);
        }
    }
}

/// Where the page `label` can step through its places now (В81).
pub fn report_history(app: &AppHandle, label: &str, history: TabHistory) {
    let Some(tab) = TabId::from_label(label) else {
        return;
    };
    let shell = shell(app);
    let changed = lock(&shell.live).history.insert(tab.clone(), history) != Some(history);
    if changed {
        if let Some(window) = window_of(app, &tab) {
            emit_bar_state(app, &window);
        }
    }
}

/// The bar of a window asks its visible tab to step back or forward (В81).
pub fn step_history(app: &AppHandle, bar_label: &str, forward: bool) {
    let Some(window) = WindowId::from_label(bar_label) else {
        return;
    };
    let Some(tab) = shell(app).snapshot().window(&window).map(|window| window.active_tab.clone()) else {
        return;
    };
    space_events::emit_to_labels(app, [tab.label()], TAB_HISTORY_GO_EVENT, TabHistoryStep { forward });
}

/// The tab `label` shows the space `vault_id` now (В10).
pub fn space_shown(app: &AppHandle, label: &str, vault_id: &str) {
    let Some(tab) = TabId::from_label(label) else {
        return;
    };
    let space = TabSpace::Space {
        vault_id: vault_id.to_string(),
    };
    let changed = shell(app).change(|model| {
        let changed = model.tab(&tab).is_some_and(|saved| saved.space != space);
        model.set_space(&tab, space);
        changed
    });
    if changed {
        emit_spaces_in_tabs(app);
        if let Some(window) = window_of(app, &tab) {
            emit_bar_state(app, &window);
        }
        project_current_space(app);
    }
    // The tab's lead role may change with its space.
    refresh_leads(app, vault_id);
}

/// A space was forgotten: its tabs go to the space picker (В70).
pub fn space_forgotten(app: &AppHandle, vault_id: &str) {
    let shell = shell(app);
    let tabs = shell.change(|model| model.forget_space(vault_id));
    for tab in &tabs {
        app.state::<AppState>().tabs.remove(&tab.label());
        space_events::emit_to_labels(app, [tab.label()], "tab-space-forgotten", ());
    }
    for window in shell.snapshot().windows {
        emit_bar_state(app, &window.id);
    }
}

/// Store and spread the sidebar of `tab` (В56): to the tab's page, and to
/// its window's bar and the View menu when the tab is the visible one.
pub fn set_tab_sidebar(app: &AppHandle, tab: &TabId, sidebar: SidebarLayout) {
    let shell = shell(app);
    if !shell.change(|model| model.set_tab_sidebar(tab, sidebar)) {
        return;
    }
    let mut labels = vec![tab.label()];
    let window = shell.snapshot().window_of(tab).cloned();
    let visible = window.as_ref().is_some_and(|window| &window.active_tab == tab);
    if let (Some(window), true) = (&window, visible) {
        labels.push(window.id.bar_label());
    }
    space_events::emit_to_labels(app, labels, "window-sidebar-changed", sidebar);
    if visible {
        crate::commands::window_chrome::reflect_sidebar(app, sidebar.collapsed);
    }
}

/// The sidebar of a page: its own for a tab page, the visible tab's for a
/// window's tab bar (В56).
pub fn set_sidebar_of_label(app: &AppHandle, label: &str, sidebar: SidebarLayout) {
    let tab = TabId::from_label(label).or_else(|| {
        let window = WindowId::from_label(label)?;
        shell(app).snapshot().window(&window).map(|window| window.active_tab.clone())
    });
    if let Some(tab) = tab {
        set_tab_sidebar(app, &tab, sidebar);
    }
}

/// Toggle the sidebar of the visible tab of `window_id` (menu, В56).
pub fn toggle_sidebar(app: &AppHandle, window_id: &WindowId) {
    let Some(window) = shell(app).snapshot().window(window_id).cloned() else {
        return;
    };
    let current = window.active_sidebar();
    set_tab_sidebar(
        app,
        &window.active_tab,
        SidebarLayout {
            collapsed: !current.collapsed,
            ..current
        },
    );
}

/// Store the chrome colour and paint every window with it (В25).
pub fn set_window_surface(app: &AppHandle, color: String) {
    let shell = shell(app);
    let changed = shell.change(|model| {
        if model.window_surface.as_deref() == Some(color.as_str()) {
            false
        } else {
            model.window_surface = Some(color.clone());
            true
        }
    });
    if !changed {
        return;
    }
    for window in shell.snapshot().windows {
        if let Some(native_window) = app.get_window(&window.id.label()) {
            native::set_window_background(&native_window, &color);
        }
    }
}

/// A folder of a known space was opened from outside (В72): the tab of that
/// space used last shows it on Everything, or a new tab in the last window
/// opens it. Asked before the windows exist, it waits for them.
pub fn open_space_from_outside(app: &AppHandle, path: &std::path::Path) {
    let shell = shell(app);
    if !shell.restored.load(Ordering::SeqCst) {
        lock(&shell.live).pending_open.push(path.to_path_buf());
        return;
    }
    let vault_id = space_paths(app)
        .into_iter()
        .find(|(_, known)| crate::space_registry::same_path(known, &path.to_string_lossy()))
        .map(|(id, _)| id);
    let Some(vault_id) = vault_id else {
        return;
    };
    let snapshot = shell.snapshot();
    let recent = app.state::<AppState>().tabs.lead(&vault_id).or_else(|| {
        snapshot
            .tabs_of_space(&vault_id)
            .first()
            .map(TabId::label)
    });
    match recent.and_then(|label| TabId::from_label(&label)) {
        Some(tab) => {
            shell.change(|model| {
                if let Some(saved) = model.tab(&tab).cloned() {
                    model.set_view(
                        &tab,
                        TabView {
                            mode: saved.view.mode,
                            ..TabView::default()
                        },
                    );
                }
            });
            activate(app, &tab);
            space_events::emit_to_labels(app, [tab.label()], "tab-go-everything", ());
            if let Some(window) = window_of(app, &tab) {
                if let Some(native_window) = app.get_window(&window.label()) {
                    let _ = native_window.set_focus();
                }
            }
        }
        None => match last_window(app) {
            Some(window) => new_tab(app, &window, TabSpace::Space { vault_id }),
            None => new_window(app, TabSpace::Space { vault_id }),
        },
    }
}

/// Show the space at `path` without moving its tab (В69): the tab of that
/// space used last, or a new tab in the last window.
pub fn show_space(app: &AppHandle, path: &std::path::Path) {
    let Some(vault_id) = space_paths(app)
        .into_iter()
        .find(|(_, known)| crate::space_registry::same_path(known, &path.to_string_lossy()))
        .map(|(id, _)| id)
    else {
        return;
    };
    let state = app.state::<AppState>();
    let snapshot = shell(app).snapshot();
    let tab = state
        .tabs
        .lead(&vault_id)
        .and_then(|label| TabId::from_label(&label))
        .or_else(|| snapshot.tabs_of_space(&vault_id).into_iter().next());
    match tab {
        Some(tab) => {
            activate(app, &tab);
            if let Some(window) = window_of(app, &tab) {
                if let Some(native_window) = app.get_window(&window.label()) {
                    let _ = native_window.set_focus();
                }
            }
        }
        None => match last_window(app) {
            Some(window) => new_tab(app, &window, TabSpace::Space { vault_id }),
            None => new_window(app, TabSpace::Space { vault_id }),
        },
    }
    emit_spaces_in_tabs(app);
}

/// The ids of every space shown in some tab (`spaces-open-changed`, В69).
pub fn spaces_in_tabs(app: &AppHandle) -> Vec<String> {
    let snapshot = shell(app).snapshot();
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for window in &snapshot.windows {
        for tab in &window.tabs {
            if let TabSpace::Space { vault_id } = &tab.space {
                ids.insert(vault_id.clone());
            }
        }
    }
    ids.into_iter().collect()
}

/// Tell the settings window which spaces are open in tabs (В69).
pub fn emit_spaces_in_tabs(app: &AppHandle) {
    space_events::emit_to_labels(
        app,
        [space_events::SETTINGS_LABEL],
        "spaces-open-changed",
        spaces_in_tabs(app),
    );
}

/// The window of the page `label`: a tab page or a tab bar.
pub fn window_of_label(app: &AppHandle, label: &str) -> Option<WindowId> {
    if let Some(tab) = TabId::from_label(label) {
        return window_of(app, &tab);
    }
    WindowId::from_label(label)
}

/// The focused window: a tab window, or `None` when another window (the
/// settings) is in front.
pub fn focused_tab_window(app: &AppHandle) -> Option<WindowId> {
    app.windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .and_then(|window| WindowId::from_label(window.label()))
}

/// Whether some window that is not a tab window is in focus (the settings).
pub fn other_window_focused(app: &AppHandle) -> Option<Window> {
    app.windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false) && WindowId::from_label(window.label()).is_none())
}
