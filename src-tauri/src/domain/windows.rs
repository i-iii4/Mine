//! Tab windows as data: what is saved between launches and the operations on
//! windows and tabs (SPEC_TABS.md, В27 по В33, В51 по В55, В60 по В63).
//!
//! Pure: no files, no screens, no webviews. The shell applies the outcome of
//! each operation to real windows; the store writes the value to disk.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Version of `windows.json` this build reads and writes. Version 2 added the
/// author place (`TabLocation::Author`, SPEC_CARD_ASSOCIATIONS.md): a build
/// that reads only version 1 sets such a file aside as newer instead of
/// reading it as corrupt. Version 1 is a subset and reads as it is.
pub const SAVED_WINDOWS_VERSION: u32 = 2;
/// Height of the tab bar row: 30 px of content and a 1 px separator, the
/// rows of the chrome (DESIGN_SYSTEM.md, ChromeRow).
pub const TAB_BAR_HEIGHT_PX: u32 = 31;
/// Height of a top chrome row's content (`--chrome-row-content-height`): the
/// standard one and the tall one (В83), the tall one a window's default since
/// 07.10.2026. The tall row and its 1 px line step as a row of the sidebar's
/// table, 40 px with its line (`--sidebar-row-height` in global.css;
/// constants.test.ts checks).
pub const CHROME_ROW_HEIGHT_PX: u32 = 30;
pub const CHROME_ROW_TALL_HEIGHT_PX: u32 = 39;

/// The tab bar's height for chrome rows `row_height` tall: the row and its
/// 1 px separator.
pub fn tab_bar_height(row_height: u32) -> u32 {
    row_height + 1
}

/// A chrome row height the app knows; anything else reads as the standard.
pub fn chrome_row_height(value: u32) -> u32 {
    // 40 was the tall row's content before the line counted in its step.
    if value == CHROME_ROW_TALL_HEIGHT_PX || value == 40 {
        CHROME_ROW_TALL_HEIGHT_PX
    } else {
        CHROME_ROW_HEIGHT_PX
    }
}

/// The title bar a window asks AppKit for (В83). AppKit centres the traffic
/// lights in the title bar's height itself, in every layout, live resize and
/// full screen included: 32 pt without a toolbar, the buttons 9 pt from the
/// top, and 40 pt with an empty toolbar in the compact unified style, the
/// buttons 13 pt from the top (measured on macOS 27.0, 04.10.2026). The tall
/// row and its line make 40 px, so it takes the compact title bar; the
/// standard row keeps the system one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBar {
    /// The system's own title bar, no toolbar.
    Standard,
    /// An empty toolbar in the compact unified style.
    Compact,
}

/// The title bar for a tab bar row `row_height` tall.
pub fn title_bar_for(row_height: u32) -> TitleBar {
    if chrome_row_height(row_height) == CHROME_ROW_TALL_HEIGHT_PX {
        TitleBar::Compact
    } else {
        TitleBar::Standard
    }
}

/// The heights of the chrome rows (В83): the tab bar's row and the top rows
/// of the tab pages, apart, so the bar can stay standard over tall pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ChromeRows {
    pub tab_bar: u32,
    pub page: u32,
}

impl ChromeRows {
    pub const STANDARD: Self = Self {
        tab_bar: CHROME_ROW_HEIGHT_PX,
        page: CHROME_ROW_HEIGHT_PX,
    };
    /// Both rows tall: a window's default (user's decision of 07.10.2026).
    pub const TALL: Self = Self {
        tab_bar: CHROME_ROW_TALL_HEIGHT_PX,
        page: CHROME_ROW_TALL_HEIGHT_PX,
    };

    /// One of the two the app offers: the bar and the pages go together
    /// (user's decision of 07.10.2026). The pages' row decides: a short bar
    /// over tall pages, once offered as «Chrome Height 40, Tab Bar 30», reads
    /// as tall, since the rows the person works in were tall already; a bar
    /// never offered over standard pages reads as standard.
    pub fn known(self) -> Self {
        if chrome_row_height(self.page) == CHROME_ROW_TALL_HEIGHT_PX {
            Self::TALL
        } else {
            Self::STANDARD
        }
    }
}

/// What a window has before the person picks other heights: the first window,
/// a new window with none to take them from, and a window saved before rows
/// had heights. A window's saved heights are kept.
impl Default for ChromeRows {
    fn default() -> Self {
        Self::TALL
    }
}

/// The `data-chrome-height` a page shows for its row `row_height` tall, the
/// attribute global.css sizes the top rows by (chromeHeight.ts): `Some("40")`
/// for the tall row, none for the standard one.
pub fn chrome_height_attribute(row_height: u32) -> Option<&'static str> {
    (chrome_row_height(row_height) == CHROME_ROW_TALL_HEIGHT_PX).then_some("40")
}

/// Narrowest a tab gets before the bar scrolls: four or five letters of its
/// label and room for the close button.
pub const TAB_MIN_WIDTH_PX: u32 = 72;
/// Widest a tab gets.
pub const TAB_MAX_WIDTH_PX: u32 = 200;
/// How far below the tab bar the pointer goes before a tab tears off.
pub const TAB_DETACH_THRESHOLD_PX: u32 = 24;
/// How much of the tab bar must stay on some screen, across, for a saved
/// window to come back where it was.
pub const WINDOW_GRAB_MIN_VISIBLE_PX: f64 = 100.0;
/// The strip the sidebar leaves at the right when it lies over the feed in a
/// narrow window (`STRIP`, SPEC_NARROW_WINDOW.md, У4).
pub const SIDEBAR_OVERLAY_STRIP_PX: u32 = 40;
/// Narrowest a tab window gets: the width of a common phone's layout (user's
/// decision of 16.10.2026, instead of the narrowest sidebar and its strip,
/// 354; SPEC_NARROW_WINDOW.md, У3). The sidebar lies over the feed there,
/// `min(W − STRIP, S_max)` wide.
pub const WINDOW_MIN_WIDTH_PX: u32 = 390;
/// Narrowest the feed gets beside the sidebar (`F_min`): always the window's
/// narrowest, one value for both (user's decision of 16.10.2026, instead of
/// the smallest card and two side insets, 304).
pub const APP_MAIN_MIN_WIDTH_PX: u32 = WINDOW_MIN_WIDTH_PX;
/// Narrowest the sidebar gets (`S_min`): the narrowest window less the strip,
/// so the sidebar over the feed of the narrowest window is exactly this wide
/// (user's decision of 16.10.2026, instead of the three equal zones, 314;
/// SPEC_NARROW_WINDOW.md, «Величины»). The rows' three equal zones stay a
/// layout of their own, never wider than this (`sidebarEqualZonesWidth()` in
/// src/lib/appLayout.ts). It does not follow the font.
pub const SIDEBAR_MIN_WIDTH_PX: u32 = WINDOW_MIN_WIDTH_PX - SIDEBAR_OVERLAY_STRIP_PX;
// The narrowest window holds the narrowest sidebar over the feed with its
// strip, and is narrower than the threshold of the sidebar over the feed
// (`S_min + F_min`, 740), so it always shows the sidebar over the feed.
const _: () = assert!(
    WINDOW_MIN_WIDTH_PX >= SIDEBAR_MIN_WIDTH_PX + SIDEBAR_OVERLAY_STRIP_PX
        && WINDOW_MIN_WIDTH_PX < SIDEBAR_MIN_WIDTH_PX + APP_MAIN_MIN_WIDTH_PX
);
/// Smallest content size of a tab window. Across: [`WINDOW_MIN_WIDTH_PX`].
/// Down: the old main window's minimum and the tab bar above it.
pub const WINDOW_MIN_WIDTH: f64 = WINDOW_MIN_WIDTH_PX as f64;
pub const WINDOW_MIN_HEIGHT: f64 = 600.0 + TAB_BAR_HEIGHT_PX as f64;
/// Size of a window with nothing to restore.
pub const WINDOW_DEFAULT_WIDTH: f64 = 1200.0;
pub const WINDOW_DEFAULT_HEIGHT: f64 = 800.0 + TAB_BAR_HEIGHT_PX as f64;
/// Width of the sidebar before the person resizes it: the interface's
/// first-run width; the page still holds it to its own minimum.
pub const SIDEBAR_DEFAULT_WIDTH_PX: u32 = 360;

/// A stable tab identity: 32 lowercase hex characters.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct TabId(pub String);

/// A stable window identity: 32 lowercase hex characters.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct WindowId(pub String);

impl TabId {
    /// The label of the tab's page.
    pub fn label(&self) -> String {
        format!("tab-{}", self.0)
    }

    /// The tab whose page has `label`.
    pub fn from_label(label: &str) -> Option<Self> {
        label.strip_prefix("tab-").map(|id| Self(id.to_string()))
    }
}

impl WindowId {
    /// The label of the native window.
    pub fn label(&self) -> String {
        format!("window-{}", self.0)
    }

    /// The label of the window's tab bar page.
    pub fn bar_label(&self) -> String {
        format!("tabbar-{}", self.0)
    }

    /// The window whose native label or tab bar page label is `label`.
    pub fn from_label(label: &str) -> Option<Self> {
        label
            .strip_prefix("window-")
            .or_else(|| label.strip_prefix("tabbar-"))
            .map(|id| Self(id.to_string()))
    }
}

/// Every tab window restored at launch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedWindows {
    pub version: u32,
    /// The first window is the last window: the one in focus last.
    pub windows: Vec<SavedWindow>,
    /// The chrome colour painted before any page loads (В25), `#rrggbb`.
    #[serde(default)]
    pub window_surface: Option<String>,
}

/// One tab window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedWindow {
    pub id: WindowId,
    pub frame: WindowFrame,
    #[serde(default)]
    pub fullscreen: bool,
    /// Left to right.
    pub tabs: Vec<SavedTab>,
    pub active_tab: TabId,
    /// The sidebar last set in this window: what a tab saved before tabs had
    /// a sidebar of their own takes (В56).
    pub sidebar: SidebarLayout,
    /// The heights of this window's chrome rows (В83): each window has its
    /// own, so two can stand side by side to compare.
    #[serde(default)]
    pub chrome_rows: ChromeRows,
}

impl SavedWindow {
    /// The sidebar of `tab` in this window (В56).
    pub fn tab_sidebar(&self, tab: &TabId) -> SidebarLayout {
        self.tabs
            .iter()
            .find(|candidate| &candidate.id == tab)
            .and_then(|found| found.sidebar)
            .unwrap_or(self.sidebar)
    }

    /// The sidebar of the visible tab: what the tab bar's button acts on.
    pub fn active_sidebar(&self) -> SidebarLayout {
        self.tab_sidebar(&self.active_tab)
    }
}

/// Logical points in global screen coordinates, top left origin.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The sidebar of one tab (РП5, В56: changed 03.10.2026 from one per window).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SidebarLayout {
    pub width_px: u32,
    pub collapsed: bool,
}

impl Default for SidebarLayout {
    fn default() -> Self {
        Self {
            width_px: SIDEBAR_DEFAULT_WIDTH_PX,
            collapsed: false,
        }
    }
}

/// The sidebar of a tab's page as it stands over the feed
/// (SPEC_NARROW_WINDOW.md, У1, У4). The page owns it and reports it
/// (`report_sidebar_overlay`); the backend keeps it in memory only, for the
/// tab bar's button and the View menu, and never saves it (У8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SidebarOverlay {
    /// The window holds the sidebar beside the feed: its `collapsed` decides.
    #[default]
    Beside,
    /// The window is too narrow for it: the sidebar lies over the feed when
    /// open, and is closed now.
    Closed,
    /// The sidebar lies over the feed.
    Open,
}

/// What asks to show or hide the sidebar of a window's visible tab: sent on
/// to the page as `sidebar-overlay-command` when the sidebar lies over the
/// feed (SPEC_NARROW_WINDOW.md, У4, У6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidebarIntent {
    /// The tab bar's button, View → Hide or Show Sidebar, ⌃⌘S.
    Toggle,
    /// A two-finger swipe: right opens, left closes (У11).
    Swipe { open: bool },
}

/// Where an intent goes: the decision table of SPEC_NARROW_WINDOW.md, У4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarRoute {
    /// The sidebar stands beside the feed: store this layout, as before (В56).
    Store(SidebarLayout),
    /// The sidebar lies over the feed: the page opens or closes it.
    Forward(SidebarIntent),
    /// Nothing to change.
    Nothing,
}

/// Where `intent` goes for a tab whose sidebar is `sidebar` and stands as
/// `overlay`. Beside the feed the toggle flips `collapsed` and a swipe sets
/// it, a swipe to the state it has changing nothing. Over the feed the page
/// owns whether the sidebar is open, so every intent goes to it: the mirror
/// here may lag the page by a report, and the page settles a repeat itself.
pub fn route_sidebar_intent(sidebar: SidebarLayout, overlay: SidebarOverlay, intent: SidebarIntent) -> SidebarRoute {
    if overlay != SidebarOverlay::Beside {
        return SidebarRoute::Forward(intent);
    }
    let collapsed = match intent {
        SidebarIntent::Toggle => !sidebar.collapsed,
        SidebarIntent::Swipe { open } => !open,
    };
    if collapsed == sidebar.collapsed {
        SidebarRoute::Nothing
    } else {
        SidebarRoute::Store(SidebarLayout { collapsed, ..sidebar })
    }
}

/// Whether the sidebar is on screen: beside the feed unless collapsed, over
/// it only when open. The tab bar's button and the View menu name it.
pub fn sidebar_shown(sidebar: SidebarLayout, overlay: SidebarOverlay) -> bool {
    match overlay {
        SidebarOverlay::Beside => !sidebar.collapsed,
        SidebarOverlay::Closed => false,
        SidebarOverlay::Open => true,
    }
}

/// One tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedTab {
    pub id: TabId,
    pub space: TabSpace,
    pub view: TabView,
    /// The tab's own sidebar (В56). Absent in a file saved while the window
    /// owned it; reading fills it with the window's.
    #[serde(default)]
    pub sidebar: Option<SidebarLayout>,
}

/// What a tab shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TabSpace {
    /// The space with this identity.
    Space { vault_id: String },
    /// Nothing to show: no spaces yet, or the space was forgotten.
    Picker,
}

/// The memory of a tab (Т2): where it is and what it shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct TabView {
    pub location: TabLocation,
    pub mode: MainViewMode,
    pub open_card: Option<OpenCard>,
    pub scroll_anchor: Option<ScrollAnchor>,
    pub collection_filter: String,
}

impl Default for TabView {
    fn default() -> Self {
        Self {
            location: TabLocation::Everything,
            mode: MainViewMode::Grid,
            open_card: None,
            scroll_anchor: None,
            collection_filter: String::new(),
        }
    }
}

/// Where in the space a tab is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TabLocation {
    Everything,
    Collection { tag: String },
    /// The cards of one author, named as written on the card the person came
    /// from; compared by `card_association::author_key`
    /// (SPEC_CARD_ASSOCIATIONS.md, «Лента автора»).
    Author { author: String },
}

impl TabLocation {
    /// What the place is called in the path and on its tab: the collection,
    /// the author, or nothing for Everything.
    pub fn label(&self) -> Option<&str> {
        match self {
            TabLocation::Everything => None,
            TabLocation::Collection { tag } => Some(tag),
            TabLocation::Author { author } => Some(author),
        }
    }
}

/// How the feed is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MainViewMode {
    Grid,
    Graph,
}

/// The card open in a tab. A session saved before 07.10.2026 also holds the
/// card's `link_mode`, the All / Connected filter removed with its switch;
/// reading ignores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct OpenCard {
    pub slug: String,
    /// The card's visible title, the tab's label while it is open (В47).
    /// Kept so an unloaded tab is labelled without its page; empty in a
    /// session saved before labels named cards.
    #[serde(default)]
    pub title: String,
}

/// The first card whose top edge is at or below the feed's top edge, and
/// how far below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ScrollAnchor {
    pub slug: String,
    pub offset_px: f64,
}

/// A visible area of one screen, logical points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub main: bool,
}

/// What the registry knows of a space a saved tab names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceStatus {
    /// Known to the registry; whether its folder is there is the tab's
    /// business (it shows the unavailable screen, П12).
    Known,
    /// Forgotten or never known.
    Unknown,
}

/// Why the file could not be used as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadIssue {
    /// Unreadable or empty: kept aside as `windows.corrupt.json`.
    Corrupt,
    /// Written by a newer build: kept aside as `windows.v<found>.json`.
    Newer { found: u32 },
}

impl SavedWindows {
    /// One window with one tab: the start with nothing to restore (В32).
    pub fn fresh(space: TabSpace, window: WindowId, tab: TabId, screens: &[ScreenArea]) -> Self {
        Self {
            version: SAVED_WINDOWS_VERSION,
            windows: vec![SavedWindow {
                id: window,
                frame: centered_frame(WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT, screens),
                fullscreen: false,
                tabs: vec![SavedTab {
                    id: tab.clone(),
                    space,
                    view: TabView::default(),
                    sidebar: Some(SidebarLayout::default()),
                }],
                active_tab: tab,
                sidebar: SidebarLayout::default(),
                chrome_rows: ChromeRows::default(),
            }],
            window_surface: None,
        }
    }

    /// The window holding `tab`.
    pub fn window_of(&self, tab: &TabId) -> Option<&SavedWindow> {
        self.windows
            .iter()
            .find(|window| window.tabs.iter().any(|candidate| &candidate.id == tab))
    }

    /// The tab the window of `tab` shows: `shown` holds what each window
    /// shows now, and the model's active tab answers for a window missing
    /// from it. Files dropped on a window go there, whichever of its pages
    /// received them (SPEC_TABS.md, В22).
    pub fn shown_beside(&self, tab: &TabId, shown: &BTreeMap<WindowId, TabId>) -> Option<TabId> {
        let window = self.window_of(tab)?;
        Some(shown.get(&window.id).cloned().unwrap_or_else(|| window.active_tab.clone()))
    }

    fn window_of_mut(&mut self, tab: &TabId) -> Option<&mut SavedWindow> {
        self.windows
            .iter_mut()
            .find(|window| window.tabs.iter().any(|candidate| &candidate.id == tab))
    }

    /// The window `id`.
    pub fn window(&self, id: &WindowId) -> Option<&SavedWindow> {
        self.windows.iter().find(|window| &window.id == id)
    }

    fn window_mut(&mut self, id: &WindowId) -> Option<&mut SavedWindow> {
        self.windows.iter_mut().find(|window| &window.id == id)
    }

    /// The tab `id`.
    pub fn tab(&self, id: &TabId) -> Option<&SavedTab> {
        self.windows
            .iter()
            .flat_map(|window| window.tabs.iter())
            .find(|tab| &tab.id == id)
    }

    fn tab_mut(&mut self, id: &TabId) -> Option<&mut SavedTab> {
        self.windows
            .iter_mut()
            .flat_map(|window| window.tabs.iter_mut())
            .find(|tab| &tab.id == id)
    }

    /// The last window: the one in focus last.
    pub fn last_window(&self) -> Option<&SavedWindow> {
        self.windows.first()
    }

    /// The visible tab of every window.
    pub fn visible_tabs(&self) -> Vec<TabId> {
        self.windows.iter().map(|window| window.active_tab.clone()).collect()
    }

    /// Every tab showing `vault_id`.
    pub fn tabs_of_space(&self, vault_id: &str) -> Vec<TabId> {
        self.windows
            .iter()
            .flat_map(|window| window.tabs.iter())
            .filter(|tab| matches!(&tab.space, TabSpace::Space { vault_id: id } if id == vault_id))
            .map(|tab| tab.id.clone())
            .collect()
    }

    /// The window `id` came into focus: it becomes the last window.
    pub fn focus_window(&mut self, id: &WindowId) {
        if let Some(index) = self.windows.iter().position(|window| &window.id == id) {
            let window = self.windows.remove(index);
            self.windows.insert(0, window);
        }
    }

    /// Add a tab at the end of `window` and make it visible (В51). Returns
    /// whether the window exists.
    pub fn add_tab(&mut self, window: &WindowId, tab: TabId, space: TabSpace, view: TabView) -> bool {
        let Some(target) = self.window_mut(window) else {
            return false;
        };
        // A new tab opens with the sidebar of the tab it was opened from.
        let sidebar = target.active_sidebar();
        target.tabs.push(SavedTab {
            id: tab.clone(),
            space,
            view,
            sidebar: Some(sidebar),
        });
        target.active_tab = tab;
        true
    }

    /// Add a window with one tab, in front (В54).
    pub fn add_window(&mut self, window: SavedWindow) {
        self.windows.insert(0, window);
    }

    /// Make `tab` the visible tab of its window. Returns the tab that was
    /// visible before, when it changes.
    pub fn activate(&mut self, tab: &TabId) -> Option<TabId> {
        let window = self.window_of_mut(tab)?;
        if &window.active_tab == tab {
            return None;
        }
        Some(std::mem::replace(&mut window.active_tab, tab.clone()))
    }

    /// The tab after (`forward`) or before `tab` in its window, round the
    /// end (В55).
    pub fn adjacent(&self, tab: &TabId, forward: bool) -> Option<TabId> {
        let window = self.window_of(tab)?;
        let index = window.tabs.iter().position(|candidate| &candidate.id == tab)?;
        let count = window.tabs.len();
        let next = if forward {
            (index + 1) % count
        } else {
            (index + count - 1) % count
        };
        Some(window.tabs[next].id.clone())
    }

    /// The tab at `position` (0-based) of `window`, the last for `None`
    /// (⌘1 по ⌘8, ⌘9).
    pub fn tab_at(&self, window: &WindowId, position: Option<usize>) -> Option<TabId> {
        let window = self.window(window)?;
        match position {
            Some(position) => window.tabs.get(position),
            None => window.tabs.last(),
        }
        .map(|tab| tab.id.clone())
    }

    /// Close `tab` (В53): the tab to its right becomes visible, else the one
    /// to its left; the last tab closes its window.
    pub fn close_tab(&mut self, tab: &TabId) -> Option<TabClosed> {
        let window_index = self
            .windows
            .iter()
            .position(|window| window.tabs.iter().any(|candidate| &candidate.id == tab))?;
        let window = &mut self.windows[window_index];
        let index = window.tabs.iter().position(|candidate| &candidate.id == tab)?;
        let removed = window.tabs.remove(index);
        if window.tabs.is_empty() {
            let window = self.windows.remove(window_index);
            return Some(TabClosed {
                tab: removed,
                window: window.id,
                window_closed: true,
                now_visible: None,
            });
        }
        let now_visible = if window.active_tab == removed.id {
            let next = window.tabs.get(index).or_else(|| window.tabs.last())?;
            window.active_tab = next.id.clone();
            Some(next.id.clone())
        } else {
            None
        };
        Some(TabClosed {
            tab: removed,
            window: window.id.clone(),
            window_closed: false,
            now_visible,
        })
    }

    /// Close every tab of `tab`'s window but `tab` (В50).
    pub fn close_other_tabs(&mut self, tab: &TabId) -> Vec<SavedTab> {
        let Some(window) = self.window_of_mut(tab) else {
            return Vec::new();
        };
        let (kept, closed): (Vec<_>, Vec<_>) =
            std::mem::take(&mut window.tabs).into_iter().partition(|candidate| &candidate.id == tab);
        window.tabs = kept;
        window.active_tab = tab.clone();
        closed
    }

    /// Move `tab` to `index` within its window (В60). The index is clamped.
    pub fn move_tab(&mut self, tab: &TabId, index: usize) -> bool {
        let Some(window) = self.window_of_mut(tab) else {
            return false;
        };
        let Some(from) = window.tabs.iter().position(|candidate| &candidate.id == tab) else {
            return false;
        };
        let moving = window.tabs.remove(from);
        let to = index.min(window.tabs.len());
        window.tabs.insert(to, moving);
        from != to
    }

    /// Take `tab` out of its window into a new window `window` with `frame`
    /// (В61). The source window keeps at least one tab: a single tab is not
    /// torn off (В62). Returns the tab now visible in the source window.
    pub fn detach(&mut self, tab: &TabId, window: WindowId, frame: WindowFrame) -> Option<Option<TabId>> {
        let source = self.window_of(tab)?;
        if source.tabs.len() < 2 {
            return None;
        }
        let sidebar = source.tab_sidebar(tab);
        // A torn tab takes its window's chrome along.
        let chrome_rows = source.chrome_rows;
        let closed = self.close_tab(tab)?;
        self.add_window(SavedWindow {
            id: window,
            frame,
            fullscreen: false,
            tabs: vec![closed.tab],
            active_tab: tab.clone(),
            sidebar,
            chrome_rows,
        });
        Some(closed.now_visible)
    }

    /// Move `tab` into `target` at `index` and make it visible there (В63).
    /// The window it leaves closes when it empties. Returns the outcome on
    /// the source side.
    pub fn attach(&mut self, tab: &TabId, target: &WindowId, index: usize) -> Option<TabClosed> {
        if self.window(target)?.tabs.iter().any(|candidate| &candidate.id == tab) {
            return None;
        }
        let closed = self.close_tab(tab)?;
        let destination = self.window_mut(target)?;
        let at = index.min(destination.tabs.len());
        destination.tabs.insert(at, closed.tab.clone());
        destination.active_tab = tab.clone();
        Some(closed)
    }

    /// Store the memory of `tab`.
    pub fn set_view(&mut self, tab: &TabId, view: TabView) -> bool {
        match self.tab_mut(tab) {
            Some(target) => {
                target.view = view;
                true
            }
            None => false,
        }
    }

    /// Show `space` in `tab`, from Everything.
    pub fn set_space(&mut self, tab: &TabId, space: TabSpace) -> bool {
        match self.tab_mut(tab) {
            Some(target) => {
                if target.space != space {
                    target.space = space;
                    target.view = TabView {
                        mode: target.view.mode,
                        ..TabView::default()
                    };
                }
                true
            }
            None => false,
        }
    }

    /// The space was forgotten: its tabs go to the space picker (В70).
    pub fn forget_space(&mut self, vault_id: &str) -> Vec<TabId> {
        let tabs = self.tabs_of_space(vault_id);
        for tab in &tabs {
            self.set_space(tab, TabSpace::Picker);
        }
        tabs
    }

    /// Store the chrome rows of `window` (В83).
    pub fn set_chrome_rows(&mut self, window: &WindowId, rows: ChromeRows) -> bool {
        match self.window_mut(window) {
            Some(target) => {
                target.chrome_rows = rows.known();
                true
            }
            None => false,
        }
    }

    /// Store the sidebar of `tab` (В56). The window keeps it as its last.
    pub fn set_tab_sidebar(&mut self, tab: &TabId, sidebar: SidebarLayout) -> bool {
        let Some(window) = self
            .windows
            .iter_mut()
            .find(|window| window.tabs.iter().any(|candidate| &candidate.id == tab))
        else {
            return false;
        };
        window.sidebar = sidebar;
        if let Some(target) = window.tabs.iter_mut().find(|candidate| &candidate.id == tab) {
            target.sidebar = Some(sidebar);
        }
        true
    }

    /// Store where `window` stands.
    pub fn set_frame(&mut self, window: &WindowId, frame: WindowFrame, fullscreen: bool) {
        if let Some(target) = self.window_mut(window) {
            if !fullscreen {
                target.frame = frame;
            }
            target.fullscreen = fullscreen;
        }
    }

    /// Close `window` with every tab in it.
    pub fn close_window(&mut self, window: &WindowId) -> Option<SavedWindow> {
        let index = self.windows.iter().position(|candidate| &candidate.id == window)?;
        Some(self.windows.remove(index))
    }

    /// The steps that bring the saved windows back at launch (В35, В36): the
    /// last window first, with the focus; then the others, back to front,
    /// none taking the focus; then the last window takes it again, so it is
    /// in front of the others it had behind it.
    ///
    /// A window that takes the focus becomes the last window
    /// ([`SavedWindows::focus_window`]). Until 13.10.2026 every restored
    /// window took it as it was created, and the one created last, not the
    /// last window, ended in front: the order turned at every launch and
    /// `vault_path` followed the wrong window (SPEC_DEEP_AUDIT.md, Е2.7).
    pub fn restore_steps(&self) -> Vec<RestoreStep> {
        let Some(last) = self.windows.first() else {
            return Vec::new();
        };
        let mut steps = vec![RestoreStep::Create {
            window: last.id.clone(),
            focus: true,
        }];
        steps.extend(self.windows.iter().skip(1).rev().map(|window| RestoreStep::Create {
            window: window.id.clone(),
            focus: false,
        }));
        if self.windows.len() > 1 {
            steps.push(RestoreStep::Focus(last.id.clone()));
        }
        steps
    }

    /// The windows holding a tab of the space `vault_id`.
    pub fn windows_with_space(&self, vault_id: &str) -> Vec<WindowId> {
        self.windows
            .iter()
            .filter(|window| {
                window
                    .tabs
                    .iter()
                    .any(|tab| matches!(&tab.space, TabSpace::Space { vault_id: id } if id == vault_id))
            })
            .map(|window| window.id.clone())
            .collect()
    }

    /// The tab that takes files dropped on the page `label`: the tab its
    /// window shows, for a drop on any tab page of the window (В22). A drop
    /// on a tab bar goes to no tab (В50): the files stay where they are.
    pub fn drop_target(&self, label: &str, shown: &BTreeMap<WindowId, TabId>) -> Option<TabId> {
        let tab = TabId::from_label(label)?;
        self.shown_beside(&tab, shown)
    }
}

/// One step of bringing the saved windows back ([`SavedWindows::restore_steps`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreStep {
    /// Create the window, taking the focus or not.
    Create { window: WindowId, focus: bool },
    /// Give the window the focus.
    Focus(WindowId),
}

/// What the registry says of the space `vault_id` a saved tab names, when
/// the registry could be read (`Some`, the identities it knows) or not
/// (`None`). A registry that cannot be read forgets nothing: its tabs stay
/// until it can (SPEC_DEEP_AUDIT.md, Е2.8).
pub fn registry_status(known: Option<&std::collections::BTreeSet<String>>, vault_id: &str) -> SpaceStatus {
    match known {
        Some(known) if !known.contains(vault_id) => SpaceStatus::Unknown,
        _ => SpaceStatus::Known,
    }
}

/// What closing a tab did.
#[derive(Debug, Clone, PartialEq)]
pub struct TabClosed {
    pub tab: SavedTab,
    pub window: WindowId,
    /// The tab was the window's last one, and the window went with it.
    pub window_closed: bool,
    /// The tab shown in its place, when the closed tab was visible.
    pub now_visible: Option<TabId>,
}

/// A frame of `width` × `height` centred on the main screen, cut to fit it.
pub fn centered_frame(width: f64, height: f64, screens: &[ScreenArea]) -> WindowFrame {
    let Some(screen) = screens.iter().find(|screen| screen.main).or_else(|| screens.first()) else {
        return WindowFrame {
            x: 0.0,
            y: 0.0,
            width,
            height,
        };
    };
    let width = width.min(screen.width);
    let height = height.min(screen.height);
    WindowFrame {
        x: screen.x + (screen.width - width) / 2.0,
        y: screen.y + (screen.height - height) / 2.0,
        width,
        height,
    }
}

/// A new window that comes from the window at `from` (В54): the same size,
/// one tab bar `step` lower and to the right, so the tab bar of the window
/// behind stays in sight. A window that would cross the right or the bottom
/// edge of its screen starts again at the screen's top left corner.
pub fn cascaded_frame(from: &WindowFrame, step: f64, screens: &[ScreenArea]) -> WindowFrame {
    let contains = |screen: &&ScreenArea| {
        from.x >= screen.x
            && from.x < screen.x + screen.width
            && from.y >= screen.y
            && from.y < screen.y + screen.height
    };
    let Some(screen) = screens
        .iter()
        .find(contains)
        .or_else(|| screens.iter().find(|screen| screen.main))
        .or_else(|| screens.first())
    else {
        return WindowFrame {
            x: from.x + step,
            y: from.y + step,
            ..*from
        };
    };
    let width = from.width.min(screen.width);
    let height = from.height.min(screen.height);
    let (x, y) = (from.x + step, from.y + step);
    let fits = x + width <= screen.x + screen.width && y + height <= screen.y + screen.height;
    let (x, y) = if fits { (x, y) } else { (screen.x, screen.y) };
    WindowFrame { x, y, width, height }
}

/// Whether enough of the tab bar of `frame` is on some screen to grab it.
fn bar_reachable(frame: &WindowFrame, screens: &[ScreenArea]) -> bool {
    let bar_top = frame.y;
    let bar_bottom = frame.y + f64::from(TAB_BAR_HEIGHT_PX);
    screens.iter().any(|screen| {
        let vertical = bar_bottom > screen.y && bar_top < screen.y + screen.height;
        let left = frame.x.max(screen.x);
        let right = (frame.x + frame.width).min(screen.x + screen.width);
        vertical && right - left >= WINDOW_GRAB_MIN_VISIBLE_PX
    })
}

/// Make saved windows safe to restore (В32). `space` tells what the registry
/// knows of a space; `new_id` makes a fresh identity. Tabs of unknown spaces
/// go, repeated identities are renewed, a visible tab out of its window is
/// replaced by the window's first, empty windows go, and a window whose tab
/// bar left every screen comes back centred on the main screen.
pub fn normalize(
    mut saved: SavedWindows,
    space: &dyn Fn(&str) -> SpaceStatus,
    screens: &[ScreenArea],
    new_id: &mut dyn FnMut() -> String,
) -> SavedWindows {
    let mut seen_tabs = std::collections::BTreeSet::new();
    let mut seen_windows = std::collections::BTreeSet::new();
    for window in &mut saved.windows {
        if !seen_windows.insert(window.id.clone()) {
            window.id = WindowId(new_id());
            seen_windows.insert(window.id.clone());
        }
        window.tabs.retain(|tab| match &tab.space {
            TabSpace::Space { vault_id } => space(vault_id) == SpaceStatus::Known,
            TabSpace::Picker => true,
        });
        // A height no longer offered (46 px tried on 03.10.2026) reads as
        // standard; a short bar over tall pages reads as tall (07.10.2026).
        window.chrome_rows = window.chrome_rows.known();
        for tab in &mut window.tabs {
            // A tab saved while the window owned the sidebar takes the window's.
            tab.sidebar.get_or_insert(window.sidebar);
            if !seen_tabs.insert(tab.id.clone()) {
                let old = tab.id.clone();
                tab.id = TabId(new_id());
                seen_tabs.insert(tab.id.clone());
                if window.active_tab == old {
                    window.active_tab = tab.id.clone();
                }
            }
        }
        if !window.tabs.iter().any(|tab| tab.id == window.active_tab) {
            if let Some(first) = window.tabs.first() {
                window.active_tab = first.id.clone();
            }
        }
        window.frame.width = window.frame.width.max(WINDOW_MIN_WIDTH);
        window.frame.height = window.frame.height.max(WINDOW_MIN_HEIGHT);
        if !screens.is_empty() && !bar_reachable(&window.frame, screens) {
            window.frame = centered_frame(window.frame.width, window.frame.height, screens);
        }
    }
    saved.windows.retain(|window| !window.tabs.is_empty());
    saved.version = SAVED_WINDOWS_VERSION;
    saved
}

/// Read saved windows from the file text, or say why it cannot be used.
pub fn parse(text: &str) -> Result<SavedWindows, ReadIssue> {
    #[derive(Deserialize)]
    struct Head {
        version: u32,
    }
    let head: Head = serde_json::from_str(text).map_err(|_| ReadIssue::Corrupt)?;
    if head.version > SAVED_WINDOWS_VERSION {
        return Err(ReadIssue::Newer {
            found: head.version,
        });
    }
    serde_json::from_str(text).map_err(|_| ReadIssue::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_dropped_on_any_page_of_a_window_go_to_the_tab_it_shows() {
        let model = saved(vec![
            window("w", vec![tab("first", "x"), tab("shown", "y")], "first"),
            window("v", vec![tab("other", "x")], "other"),
        ]);
        let shown = BTreeMap::from([(WindowId("w".into()), TabId("shown".into()))]);
        // The window's first page received the drop; the tab it shows takes it.
        assert_eq!(model.shown_beside(&TabId("first".into()), &shown), Some(TabId("shown".into())));
        assert_eq!(model.shown_beside(&TabId("shown".into()), &shown), Some(TabId("shown".into())));
        // A window not yet in `shown` answers with its active tab.
        assert_eq!(model.shown_beside(&TabId("other".into()), &shown), Some(TabId("other".into())));
        assert_eq!(model.shown_beside(&TabId("gone".into()), &shown), None);
    }

    /// Replay restore steps the way AppKit takes them: a window that takes
    /// the focus becomes the last window.
    fn replay(saved: &SavedWindows, steps: &[RestoreStep]) -> SavedWindows {
        let mut model = saved.clone();
        for step in steps {
            match step {
                RestoreStep::Create { window, focus: true } | RestoreStep::Focus(window) => {
                    model.focus_window(window);
                }
                RestoreStep::Create { focus: false, .. } => {}
            }
        }
        model
    }

    /// Е2.7: restoring keeps the order of the windows and the focus on the
    /// last window, launch after launch.
    #[test]
    fn restoring_keeps_the_order_and_the_last_window_in_front() {
        let launched = saved(vec![
            window("last", vec![tab("a", "x")], "a"),
            window("second", vec![tab("b", "y")], "b"),
            window("third", vec![tab("c", "z")], "c"),
        ]);
        let order = |model: &SavedWindows| -> Vec<String> { model.windows.iter().map(|window| window.id.0.clone()).collect() };
        let mut model = launched;
        for _launch in 0..3 {
            model = replay(&model, &model.restore_steps());
            assert_eq!(order(&model), vec!["last", "second", "third"]);
        }
        // Every restored window taking the focus as it was created, as before
        // 13.10.2026, turned the order and put another window in front.
        let old: Vec<RestoreStep> = model
            .restore_steps()
            .into_iter()
            .filter_map(|step| match step {
                RestoreStep::Create { window, .. } => Some(RestoreStep::Create { window, focus: true }),
                RestoreStep::Focus(_) => None,
            })
            .collect();
        assert_eq!(order(&replay(&model, &old)), vec!["second", "third", "last"]);
        assert!(saved(Vec::new()).restore_steps().is_empty());
    }

    /// Е2.8: a registry that cannot be read forgets no tab; one that can and
    /// does not know the space forgets it (В32).
    #[test]
    fn an_unreadable_registry_forgets_no_tab() {
        let value = saved(vec![window("w1", vec![tab("t1", "gone"), tab("t2", "kept")], "t1")]);
        let unreadable = normalize(value.clone(), &|id| registry_status(None, id), &screen(), &mut ids());
        assert_eq!(unreadable.windows[0].tabs.len(), 2);
        let known: std::collections::BTreeSet<String> = ["kept".to_string()].into();
        let read = normalize(value, &|id| registry_status(Some(&known), id), &screen(), &mut ids());
        assert_eq!(read.windows[0].tabs.len(), 1);
    }

    /// Е2.14: files dropped on a tab bar go to no tab (В50), files dropped on
    /// any tab page of a window go to the tab it shows (В22).
    #[test]
    fn files_dropped_on_a_tab_bar_go_to_no_tab() {
        let model = saved(vec![window("w", vec![tab("first", "x"), tab("shown", "y")], "shown")]);
        let shown = BTreeMap::new();
        assert_eq!(model.drop_target(&TabId("first".into()).label(), &shown), Some(TabId("shown".into())));
        assert_eq!(model.drop_target(&WindowId("w".into()).bar_label(), &shown), None);
        assert_eq!(model.drop_target("settings", &shown), None);
    }

    /// Е2.24: the windows whose bars name a space.
    #[test]
    fn the_windows_with_a_space_are_found() {
        let model = saved(vec![
            window("w1", vec![tab("a", "x"), tab("b", "y")], "a"),
            window("w2", vec![tab("c", "y")], "c"),
            window("w3", vec![tab("d", "z")], "d"),
        ]);
        assert_eq!(model.windows_with_space("y"), vec![WindowId("w1".into()), WindowId("w2".into())]);
        assert!(model.windows_with_space("none").is_empty());
    }

    #[test]
    fn the_tall_row_takes_the_compact_title_bar() {
        assert_eq!(title_bar_for(CHROME_ROW_HEIGHT_PX), TitleBar::Standard);
        assert_eq!(title_bar_for(CHROME_ROW_TALL_HEIGHT_PX), TitleBar::Compact);
        // The tall row's content before its line counted in its step.
        assert_eq!(title_bar_for(40), TitleBar::Compact);
        assert_eq!(title_bar_for(12), TitleBar::Standard);
    }

    #[test]
    fn a_window_is_tall_by_default_and_keeps_saved_heights() {
        // The first window and a window saved before rows had heights.
        let fresh = SavedWindows::fresh(TabSpace::Picker, WindowId("w".into()), TabId("t".into()), &screen());
        assert_eq!(fresh.windows[0].chrome_rows, ChromeRows::TALL);
        assert_eq!(ChromeRows::default(), ChromeRows::TALL);
        let mut without_rows = serde_json::to_value(&fresh.windows[0]).expect("the window writes");
        without_rows.as_object_mut().expect("an object").remove("chrome_rows");
        let read: SavedWindow = serde_json::from_value(without_rows).expect("the window reads");
        assert_eq!(read.chrome_rows, ChromeRows::TALL);
        // A window whose heights were saved keeps them, the standard ones too.
        let mut standard = fresh.windows[0].clone();
        standard.chrome_rows = ChromeRows::STANDARD;
        let text = serde_json::to_string(&standard).expect("the window writes");
        let read: SavedWindow = serde_json::from_str(&text).expect("the window reads");
        assert_eq!(read.chrome_rows, ChromeRows::STANDARD);
    }

    #[test]
    fn the_bar_and_the_pages_go_together() {
        let rows = |tab_bar, page| ChromeRows { tab_bar, page };
        assert_eq!(rows(30, 30).known(), ChromeRows::STANDARD);
        assert_eq!(rows(39, 39).known(), ChromeRows::TALL);
        // The tall row's content before its line counted in its step.
        assert_eq!(rows(40, 40).known(), ChromeRows::TALL);
        // Once offered as «Chrome Height 40, Tab Bar 30»: the pages decide.
        assert_eq!(rows(30, 39).known(), ChromeRows::TALL);
        // Never offered, and a height no longer offered.
        assert_eq!(rows(39, 30).known(), ChromeRows::STANDARD);
        assert_eq!(rows(46, 46).known(), ChromeRows::STANDARD);

        let mut model = saved(vec![window("w", vec![tab("t", "x")], "t")]);
        assert!(model.set_chrome_rows(&WindowId("w".into()), rows(30, 39)));
        assert_eq!(model.windows[0].chrome_rows, ChromeRows::TALL);
    }

    #[test]
    fn a_session_saved_with_a_short_bar_over_tall_pages_reads_tall() {
        let mut window = window("w", vec![tab("t", "x")], "t");
        window.chrome_rows = ChromeRows { tab_bar: 30, page: 39 };
        let text = serde_json::to_string(&saved(vec![window])).expect("the session writes");
        let read = normalize(parse(&text).expect("the session reads"), &known, &screen(), &mut ids());
        assert_eq!(read.windows[0].chrome_rows, ChromeRows::TALL);
    }

    #[test]
    fn a_page_is_told_its_row_before_its_first_frame() {
        assert_eq!(chrome_height_attribute(CHROME_ROW_TALL_HEIGHT_PX), Some("40"));
        assert_eq!(chrome_height_attribute(40), Some("40"));
        assert_eq!(chrome_height_attribute(CHROME_ROW_HEIGHT_PX), None);
        assert_eq!(chrome_height_attribute(46), None);
    }

    #[test]
    fn an_open_card_saved_with_the_removed_link_mode_still_reads() {
        let card: OpenCard =
            serde_json::from_str(r#"{"slug":"Cards/Kura","link_mode":"linked","title":"Kura"}"#)
                .expect("a card saved before 07.10.2026 reads");
        assert_eq!(
            card,
            OpenCard { slug: "Cards/Kura".to_owned(), title: "Kura".to_owned() }
        );
        let written = serde_json::to_string(&card).expect("the card writes");
        assert!(!written.contains("link_mode"));
    }

    fn screen() -> Vec<ScreenArea> {
        vec![ScreenArea {
            x: 0.0,
            y: 0.0,
            width: 1728.0,
            height: 1117.0,
            main: true,
        }]
    }

    #[test]
    fn a_new_window_steps_one_tab_bar_from_the_window_it_came_from() {
        let from = WindowFrame { x: 100.0, y: 80.0, width: 1200.0, height: 800.0 };
        let next = cascaded_frame(&from, 31.0, &screen());
        assert_eq!(next, WindowFrame { x: 131.0, y: 111.0, width: 1200.0, height: 800.0 });
    }

    #[test]
    fn a_new_window_past_the_screen_edge_starts_at_its_corner() {
        // 1728 x 1117: one more step would cross the bottom edge.
        let from = WindowFrame { x: 300.0, y: 300.0, width: 1200.0, height: 800.0 };
        let next = cascaded_frame(&from, 31.0, &screen());
        assert_eq!(next, WindowFrame { x: 0.0, y: 0.0, width: 1200.0, height: 800.0 });
    }

    fn tab(id: &str, space: &str) -> SavedTab {
        SavedTab {
            id: TabId(id.into()),
            space: TabSpace::Space {
                vault_id: space.into(),
            },
            view: TabView::default(),
            sidebar: None,
        }
    }

    fn window(id: &str, tabs: Vec<SavedTab>, active: &str) -> SavedWindow {
        SavedWindow {
            id: WindowId(id.into()),
            frame: WindowFrame {
                x: 100.0,
                y: 100.0,
                width: 1200.0,
                height: 831.0,
            },
            fullscreen: false,
            tabs,
            active_tab: TabId(active.into()),
            sidebar: SidebarLayout::default(),
            chrome_rows: ChromeRows::STANDARD,
        }
    }

    fn saved(windows: Vec<SavedWindow>) -> SavedWindows {
        SavedWindows {
            version: SAVED_WINDOWS_VERSION,
            windows,
            window_surface: None,
        }
    }

    fn known(_: &str) -> SpaceStatus {
        SpaceStatus::Known
    }

    fn ids() -> impl FnMut() -> String {
        let mut next = 0;
        move || {
            next += 1;
            format!("new{next}")
        }
    }

    #[test]
    fn labels_round_trip() {
        let tab = TabId("abc".into());
        assert_eq!(TabId::from_label(&tab.label()), Some(tab));
        let window = WindowId("w1".into());
        assert_eq!(WindowId::from_label(&window.label()), Some(window.clone()));
        assert_eq!(WindowId::from_label(&window.bar_label()), Some(window));
        assert_eq!(TabId::from_label("settings"), None);
    }

    #[test]
    fn saved_windows_survive_a_write_and_a_read() {
        let value = saved(vec![window("w1", vec![tab("t1", "x"), tab("t2", "y")], "t2")]);
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(parse(&text), Ok(value));
    }

    #[test]
    fn unreadable_and_newer_files_are_set_aside() {
        assert_eq!(parse(""), Err(ReadIssue::Corrupt));
        assert_eq!(parse("{\"version\":1,\"windows\":7}"), Err(ReadIssue::Corrupt));
        assert_eq!(
            parse("{\"version\":9,\"windows\":[]}"),
            Err(ReadIssue::Newer { found: 9 })
        );
        assert_eq!(
            parse("{\"version\":3,\"windows\":[]}"),
            Err(ReadIssue::Newer { found: 3 })
        );
    }

    #[test]
    fn an_author_place_survives_a_write_and_a_read() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x")], "a")]);
        value.set_view(
            &TabId("a".into()),
            TabView {
                location: TabLocation::Author { author: "@kotecinho".into() },
                ..TabView::default()
            },
        );
        let text = serde_json::to_string(&value).unwrap();
        assert!(text.contains("\"kind\":\"author\""));
        let read = parse(&text).unwrap();
        assert_eq!(
            read.windows[0].tabs[0].view.location,
            TabLocation::Author { author: "@kotecinho".into() }
        );
        assert_eq!(read.windows[0].tabs[0].view.location.label(), Some("@kotecinho"));
    }

    #[test]
    fn a_version_one_file_reads_as_it_is() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x")], "a")]);
        value.version = 1;
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(parse(&text).unwrap().windows, value.windows);
    }

    #[test]
    fn tabs_of_forgotten_spaces_go_and_empty_windows_with_them() {
        let value = saved(vec![
            window("w1", vec![tab("t1", "gone"), tab("t2", "kept")], "t1"),
            window("w2", vec![tab("t3", "gone")], "t3"),
        ]);
        let space = |id: &str| {
            if id == "gone" {
                SpaceStatus::Unknown
            } else {
                SpaceStatus::Known
            }
        };
        let restored = normalize(value, &space, &screen(), &mut ids());
        assert_eq!(restored.windows.len(), 1);
        assert_eq!(restored.windows[0].tabs.len(), 1);
        // The visible tab went: the first left takes its place.
        assert_eq!(restored.windows[0].active_tab, TabId("t2".into()));
    }

    #[test]
    fn repeated_identities_are_renewed() {
        let value = saved(vec![
            window("w1", vec![tab("t1", "x"), tab("t1", "y")], "t1"),
            window("w1", vec![tab("t2", "x")], "t2"),
        ]);
        let restored = normalize(value, &known, &screen(), &mut ids());
        let tabs: Vec<_> = restored.windows[0].tabs.iter().map(|tab| tab.id.0.clone()).collect();
        assert_eq!(tabs, vec!["t1", "new1"]);
        assert_eq!(restored.windows[1].id, WindowId("new2".into()));
    }

    #[test]
    fn a_window_off_every_screen_comes_back_centred() {
        let mut lost = window("w1", vec![tab("t1", "x")], "t1");
        lost.frame.x = 5000.0;
        let mut half = window("w2", vec![tab("t2", "x")], "t2");
        half.frame.x = 1728.0 - 150.0;
        let restored = normalize(saved(vec![lost, half]), &known, &screen(), &mut ids());
        assert_eq!(restored.windows[0].frame.x, (1728.0 - 1200.0) / 2.0);
        // 150 points of its bar stay on screen: enough to grab, it stays.
        assert_eq!(restored.windows[1].frame.x, 1728.0 - 150.0);
    }

    /// The window is no narrower than a common phone's layout, 390 px (user's
    /// decision of 16.10.2026, У3), and still holds the narrowest sidebar
    /// over the feed with its strip.
    #[test]
    fn the_narrowest_window_is_a_phone_wide_and_holds_the_sidebar_over_the_feed() {
        assert_eq!(WINDOW_MIN_WIDTH_PX, 390);
        assert_eq!(WINDOW_MIN_WIDTH, 390.0);
    }

    /// A saved window narrower than the minimum comes back at the minimum; one
    /// between the minimum and the old 618 keeps its width.
    #[test]
    fn a_restored_window_is_held_to_the_minimum_width() {
        let mut narrow = window("w1", vec![tab("t1", "x")], "t1");
        narrow.frame.width = 200.0;
        let mut between = window("w2", vec![tab("t2", "x")], "t2");
        between.frame.width = 400.0;
        let restored = normalize(saved(vec![narrow, between]), &known, &screen(), &mut ids());
        assert_eq!(restored.windows[0].frame.width, WINDOW_MIN_WIDTH);
        assert_eq!(restored.windows[1].frame.width, 400.0);
    }

    /// The decision table of the sidebar's toggles (SPEC_NARROW_WINDOW.md,
    /// У4, PLAN 47.3b): beside the feed the backend stores `collapsed`, over
    /// it the page decides.
    #[test]
    fn a_sidebar_intent_is_stored_beside_the_feed_and_forwarded_over_it() {
        let open = SidebarLayout { width_px: 420, collapsed: false };
        let closed = SidebarLayout { width_px: 420, collapsed: true };
        let toggle = SidebarIntent::Toggle;
        let right = SidebarIntent::Swipe { open: true };
        let left = SidebarIntent::Swipe { open: false };

        // Beside: the toggle flips, a swipe sets, a swipe to the state the
        // sidebar has changes nothing; the width stays.
        assert_eq!(route_sidebar_intent(open, SidebarOverlay::Beside, toggle), SidebarRoute::Store(closed));
        assert_eq!(route_sidebar_intent(closed, SidebarOverlay::Beside, toggle), SidebarRoute::Store(open));
        assert_eq!(route_sidebar_intent(closed, SidebarOverlay::Beside, right), SidebarRoute::Store(open));
        assert_eq!(route_sidebar_intent(open, SidebarOverlay::Beside, left), SidebarRoute::Store(closed));
        assert_eq!(route_sidebar_intent(open, SidebarOverlay::Beside, right), SidebarRoute::Nothing);
        assert_eq!(route_sidebar_intent(closed, SidebarOverlay::Beside, left), SidebarRoute::Nothing);

        // Over the feed: every intent goes to the page, whatever the stored
        // layout and the mirror say; `collapsed` is never touched there.
        for overlay in [SidebarOverlay::Closed, SidebarOverlay::Open] {
            for sidebar in [open, closed] {
                for intent in [toggle, right, left] {
                    assert_eq!(
                        route_sidebar_intent(sidebar, overlay, intent),
                        SidebarRoute::Forward(intent),
                        "{overlay:?} {sidebar:?} {intent:?}",
                    );
                }
            }
        }
    }

    /// The tab bar's button and the View menu name what is on screen.
    #[test]
    fn the_sidebar_is_shown_beside_unless_collapsed_and_over_the_feed_when_open() {
        let open = SidebarLayout { width_px: 360, collapsed: false };
        let closed = SidebarLayout { width_px: 360, collapsed: true };
        assert!(sidebar_shown(open, SidebarOverlay::Beside));
        assert!(!sidebar_shown(closed, SidebarOverlay::Beside));
        for sidebar in [open, closed] {
            assert!(!sidebar_shown(sidebar, SidebarOverlay::Closed));
            assert!(sidebar_shown(sidebar, SidebarOverlay::Open));
        }
        assert_eq!(SidebarOverlay::default(), SidebarOverlay::Beside);
    }

    /// The page reports the overlay and hears the intents in these shapes
    /// (the bindings, `useSidebarOverlay.ts`).
    #[test]
    fn the_overlay_and_the_intents_cross_to_the_page_as_tagged_values() {
        assert_eq!(serde_json::to_value(SidebarOverlay::Closed).ok(), Some(serde_json::json!("closed")));
        assert_eq!(
            serde_json::to_value(SidebarIntent::Swipe { open: true }).ok(),
            Some(serde_json::json!({ "kind": "swipe", "open": true })),
        );
        assert_eq!(
            serde_json::to_value(SidebarIntent::Toggle).ok(),
            Some(serde_json::json!({ "kind": "toggle" })),
        );
    }

    #[test]
    fn closing_a_visible_tab_shows_the_right_one_then_the_left() {
        let mut value = saved(vec![window(
            "w1",
            vec![tab("a", "x"), tab("b", "x"), tab("c", "x")],
            "b",
        )]);
        let closed = value.close_tab(&TabId("b".into())).unwrap();
        assert_eq!(closed.now_visible, Some(TabId("c".into())));
        let closed = value.close_tab(&TabId("c".into())).unwrap();
        assert_eq!(closed.now_visible, Some(TabId("a".into())));
        let closed = value.close_tab(&TabId("a".into())).unwrap();
        assert!(closed.window_closed);
        assert!(value.windows.is_empty());
    }

    #[test]
    fn closing_a_hidden_tab_keeps_the_visible_one() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x"), tab("b", "x")], "b")]);
        let closed = value.close_tab(&TabId("a".into())).unwrap();
        assert_eq!(closed.now_visible, None);
        assert_eq!(value.windows[0].active_tab, TabId("b".into()));
    }

    #[test]
    fn adjacent_tabs_wrap_round_the_ends() {
        let value = saved(vec![window("w1", vec![tab("a", "x"), tab("b", "x"), tab("c", "x")], "a")]);
        assert_eq!(value.adjacent(&TabId("c".into()), true), Some(TabId("a".into())));
        assert_eq!(value.adjacent(&TabId("a".into()), false), Some(TabId("c".into())));
        let w1 = WindowId("w1".into());
        assert_eq!(value.tab_at(&w1, Some(1)), Some(TabId("b".into())));
        assert_eq!(value.tab_at(&w1, None), Some(TabId("c".into())));
        assert_eq!(value.tab_at(&w1, Some(7)), None);
    }

    #[test]
    fn a_tab_moves_within_its_window() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x"), tab("b", "x"), tab("c", "x")], "a")]);
        assert!(value.move_tab(&TabId("a".into()), 9));
        let order: Vec<_> = value.windows[0].tabs.iter().map(|tab| tab.id.0.clone()).collect();
        assert_eq!(order, vec!["b", "c", "a"]);
        assert!(!value.move_tab(&TabId("a".into()), 2));
    }

    #[test]
    fn a_torn_off_tab_takes_a_window_of_its_own_in_front() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x"), tab("b", "y")], "b")]);
        let frame = WindowFrame {
            x: 300.0,
            y: 200.0,
            width: 1200.0,
            height: 831.0,
        };
        let shown = value.detach(&TabId("b".into()), WindowId("w2".into()), frame).unwrap();
        assert_eq!(shown, Some(TabId("a".into())));
        assert_eq!(value.windows[0].id, WindowId("w2".into()));
        assert_eq!(value.windows[0].tabs[0].space, TabSpace::Space { vault_id: "y".into() });
        // A window's only tab moves the window instead (В62).
        assert!(value.detach(&TabId("b".into()), WindowId("w3".into()), frame).is_none());
    }

    #[test]
    fn an_attached_tab_joins_the_other_window_and_its_window_closes() {
        let mut value = saved(vec![
            window("w1", vec![tab("a", "x")], "a"),
            window("w2", vec![tab("b", "x"), tab("c", "x")], "b"),
        ]);
        let closed = value.attach(&TabId("a".into()), &WindowId("w2".into()), 1).unwrap();
        assert!(closed.window_closed);
        assert_eq!(value.windows.len(), 1);
        let order: Vec<_> = value.windows[0].tabs.iter().map(|tab| tab.id.0.clone()).collect();
        assert_eq!(order, vec!["b", "a", "c"]);
        assert_eq!(value.windows[0].active_tab, TabId("a".into()));
    }

    #[test]
    fn a_forgotten_space_sends_its_tabs_to_the_picker() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x"), tab("b", "y")], "a")]);
        assert_eq!(value.forget_space("x"), vec![TabId("a".into())]);
        assert_eq!(value.windows[0].tabs[0].space, TabSpace::Picker);
        assert_eq!(value.windows[0].tabs[1].space, TabSpace::Space { vault_id: "y".into() });
    }

    #[test]
    fn focus_puts_a_window_in_front() {
        let mut value = saved(vec![
            window("w1", vec![tab("a", "x")], "a"),
            window("w2", vec![tab("b", "x")], "b"),
        ]);
        value.focus_window(&WindowId("w2".into()));
        assert_eq!(value.last_window().unwrap().id, WindowId("w2".into()));
    }

    #[test]
    fn a_new_space_in_a_tab_starts_from_everything() {
        let mut value = saved(vec![window("w1", vec![tab("a", "x")], "a")]);
        value.set_view(
            &TabId("a".into()),
            TabView {
                location: TabLocation::Collection { tag: "Art".into() },
                mode: MainViewMode::Graph,
                ..TabView::default()
            },
        );
        value.set_space(&TabId("a".into()), TabSpace::Space { vault_id: "y".into() });
        let view = &value.windows[0].tabs[0].view;
        assert_eq!(view.location, TabLocation::Everything);
        assert_eq!(view.mode, MainViewMode::Graph);
    }

    #[test]
    fn every_tab_keeps_its_own_sidebar() {
        let narrow = SidebarLayout { width_px: 280, collapsed: false };
        let closed = SidebarLayout { width_px: 280, collapsed: true };
        let mut model = saved(vec![window("w1", vec![tab("a", "x"), tab("b", "x")], "a")]);
        model.windows[0].sidebar = narrow;
        // A file saved while the window owned the sidebar: every tab takes it.
        let mut model = normalize(model, &known, &screen(), &mut ids());
        assert_eq!(model.windows[0].tab_sidebar(&TabId("b".into())), narrow);

        assert!(model.set_tab_sidebar(&TabId("a".into()), closed));
        assert_eq!(model.windows[0].tab_sidebar(&TabId("a".into())), closed);
        assert_eq!(model.windows[0].tab_sidebar(&TabId("b".into())), narrow);
        assert_eq!(model.windows[0].active_sidebar(), closed);

        // A new tab opens with the sidebar of the tab it was opened from.
        assert!(model.add_tab(&WindowId("w1".into()), TabId("c".into()), TabSpace::Picker, TabView::default()));
        assert_eq!(model.windows[0].tab_sidebar(&TabId("c".into())), closed);
        assert!(!model.set_tab_sidebar(&TabId("gone".into()), narrow));
    }
}
