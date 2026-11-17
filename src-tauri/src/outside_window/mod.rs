//! The outside window (SPEC_OUTSIDE_WINDOW.md, part В): one clear window of the
//! app above every other, which takes neither the keyboard nor the mouse, and
//! draws what does not fit in an app window: the hover preview window with no
//! room beside its panel (part А) and the dragged card (part Б).
//!
//! The window is made when a page first asks for it, unseen, and is found
//! clear before anything is drawn in it (`native`; the menu panel's check,
//! МО32). It then stays on the screen, empty and clear, so WebKit keeps its
//! page running (МО64).
//!
//! A showing of the preview is one session. The page whose pointer is over
//! the trigger, the source, opens it with the panel and the trigger; this
//! places the window's frame for the whole showing (ПН2, ПН8) and tells the
//! outside window's page where the window may stand. Then the source sends
//! what its pointer's part asks of the window, numbered, and the outside
//! window's page applies it in that order to the same window code the source
//! uses inside (НО6, НО7); what the window does is told back the same way. A
//! session ends when that window closes, when the source closes it, or here:
//! the app window moved, resized or went, the app was hidden, the space or
//! the screens changed (ПН9), the page drew nothing in time (НО9), another
//! showing began (НО5).
//!
//! A dragged card is the window's other use. The tab page that drags it says
//! what the card is; the backend frames the window at the pointer, above the
//! menu bar and the Dock, and moves it with the pointer in the handler of
//! each move of the mouse (`tabs::drag`; ПК1, ПК3). The page of the outside
//! window draws the card once and tells when its pictures are in, so the
//! source page can stop drawing its own (ПК2).
//!
//! Every command runs on the main thread: each one reads or moves a window,
//! and one thread is the one place that sets the order of what is said.

pub mod geometry;
pub(crate) mod native;

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::commands::space_events::emit_to_labels;
use crate::menu_panel::geometry::{ScreenPoint, ScreenRect};
use crate::menu_panel::native::anchor_on_screen;
use crate::storage::index::{LightBlock, TagCount};
use geometry::{
    drag_frame, drag_frame_origin, drag_stack_on_page, on_page, preview_column_left, preview_frame, preview_page_area,
    PageArea, PreviewSide, SHADOW_FIELD_PX,
};
use native::OutsideUse;

/// The outside window's Tauri label; the capability `default` names it.
pub const OUTSIDE_LABEL: &str = "outside-window";
const OUTSIDE_PAGE: &str = "outside-window.html";
/// What the backend tells the outside window's page (`OutsidePageMessage`).
pub const TO_PAGE_EVENT: &str = "outside-window-message";
/// What the backend tells a source page (`OutsideSourceMessage`).
pub const TO_SOURCE_EVENT: &str = "outside-window-report";
/// The dragged card is drawn outside: the source page stops drawing its own
/// (`CardDragViewShown`; ПК2).
pub const DRAG_VIEW_EVENT: &str = "card-drag-view";
/// The one time here (НО9): a preview whose first frame has not come by
/// then is drawn in the app window. The threshold of Doherty, as the menu
/// panel's `PAINT_DEADLINE` (МО40).
const PREVIEW_FIRST_FRAME_DEADLINE: Duration = Duration::from_millis(400);

/// Whether the outside window may be used: made, its page listening, found
/// clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct OutsideWindowStatus {
    pub ready: bool,
}

/// What the source's card needs that its page alone knows: the space, the
/// sidebar's order of collections (`publishCollectionOrder`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OutsideLook {
    pub vault_path: String,
    pub thumbs_root_path: Option<String>,
    pub collection_order: Vec<TagCount>,
}

/// A tile of a collection's window: a card of the row's strip (`PreviewCard`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OutsideTile {
    pub slug: Option<String>,
    pub url: String,
    pub text: bool,
    pub has_thumb: bool,
}

/// What the window shows over a collection's name (С7.12;
/// `CollectionPreviewContent`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OutsideCollection {
    pub row_key: String,
    pub name: String,
    pub count: u32,
    pub cards: Vec<OutsideTile>,
    pub placeholders: u32,
}

/// What the hover preview window holds (С7.11, С7.12).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewContent {
    Card { block: Box<LightBlock>, thumb_version: Option<u32> },
    Collection { collection: OutsideCollection },
}

/// A source opens a showing of the preview outside its app window.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct PreviewOpenRequest {
    /// The source page's load: a page loaded anew counts from one again.
    pub page: String,
    /// The showing's number, the page's own count of them.
    pub show: u32,
    /// The panel the window stands beside, in the page's points.
    pub panel: ScreenRect,
    /// The trigger of the first card, in the page's points.
    pub trigger: ScreenRect,
    pub side: PreviewSide,
    pub look: OutsideLook,
}

/// Why a showing does not go outside: the source draws it inside (НО9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum OutsideRefusal {
    #[error("the outside window is not ready")]
    NotReady,
    #[error("no room beside the panel on the screen")]
    NoRoom,
    #[error("the page's place on the screen is unknown")]
    NoGeometry,
    #[error("the window could not be placed")]
    NotPlaced,
    #[error("a later showing of the page came first")]
    Superseded,
}

/// What the source's pointer asks of the window (`HoverPreviewStage`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewStep {
    /// `card` comes on for `key` once ready; the trigger in the page's points
    /// from the source, in the outside page's points to it.
    Offer { key: String, trigger: ScreenRect, content: PreviewContent },
    /// The trigger the pointer is on now: a card ready for another is a flash.
    Wanted { key: Option<String> },
    DropPending,
    BringBack { key: String, trigger: ScreenRect },
    FadeOut,
    Close,
}

/// One numbered step of a showing.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct PreviewStepRequest {
    pub page: String,
    pub show: u32,
    pub number: u32,
    pub step: PreviewStep,
}

/// The window's state, as the source's pointer reads it of its own window
/// (`HoverPreviewStage`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PreviewPhase {
    Closed,
    Open,
    Leaving,
}

/// Why an offered card was not shown (`HoverPreviewDropReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewDropReason {
    Left,
    UnplacedClosed,
    UnplacedOpen,
}

/// What happened to the window (`HoverPreviewStageHost`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewEvent {
    Settled { key: String },
    Hidden,
    Dropped { reason: PreviewDropReason },
    /// The window that was on screen closed: the showing is over.
    Closed,
}

/// The window's state after a change, and what changed it.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PreviewReport {
    /// The number of the last step the window had taken: the source reads
    /// the state only of a report that has taken every step it sent.
    pub applied: u32,
    pub phase: PreviewPhase,
    pub shown_key: Option<String>,
    pub fading_key: Option<String>,
    pub pending_key: Option<String>,
    pub event: Option<PreviewEvent>,
}

/// What the dragged card is drawn of (`DragCardStackPreview`): the stack's
/// cards, front first, at most its four layers.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CardStack {
    pub blocks: Vec<LightBlock>,
    /// Each card's rebuilt thumbnail's version, where the page keeps one.
    pub thumb_versions: Vec<Option<u32>>,
    pub look: OutsideLook,
}

/// `card-drag-view`: the dragged card of the page's drag `seq` is drawn
/// outside.
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
pub struct CardDragViewShown {
    pub seq: u32,
}

/// Why a showing ended here and not by its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OutsideCloseReason {
    /// The source asked, or loaded anew.
    Source,
    /// The app window moved, resized, went or entered or left full screen.
    Window,
    /// The app was hidden, a window minimized, the space or the screens
    /// changed.
    System,
    /// The outside window's page drew nothing in time (НО9).
    Unresponsive,
    /// Another showing began (НО5).
    Superseded,
}

/// What the backend tells the outside window's page.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutsidePageMessage {
    /// A showing begins: where on the page the window may stand.
    Preview { session: u32, area: PageArea, look: OutsideLook },
    PreviewStep { session: u32, number: u32, step: PreviewStep },
    /// The showing ended here: the window goes at once.
    End { session: u32, reason: OutsideCloseReason },
    /// A dragged card: its front card's top left on the page.
    Drag { session: u32, at: ScreenPoint, stack: CardStack },
    /// The drag is over: the card goes at once.
    DragEnd { session: u32 },
}

/// What the outside window's page tells the backend.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutsidePageReport {
    /// The page listens: after its load, and after an `End` for being
    /// unresponsive, which it heard.
    Ready,
    /// The window's state changed; numbered by the page within the session.
    Preview { session: u32, number: u32, report: PreviewReport },
    /// The session's first frame with the window on screen.
    FirstFrame { session: u32 },
    /// The dragged card is drawn, its pictures in or out of time.
    DragShown { session: u32 },
}

/// What the backend tells a source page.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutsideSourceMessage {
    Preview { show: u32, number: u32, report: PreviewReport },
    /// The last word of a showing that ended here.
    Closed { show: u32, reason: OutsideCloseReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Clearness {
    Unknown,
    Clear,
    NotClear,
}

#[derive(Debug, Clone)]
struct Session {
    id: u32,
    /// The source page's label and load, and the label of its window.
    source: String,
    page: String,
    window: String,
    show: u32,
    frame: ScreenRect,
    painted: bool,
}

/// The card being dragged in the outside window.
#[derive(Debug, Clone)]
struct DragView {
    id: u32,
    source: String,
    seq: u32,
    height: f64,
}

#[derive(Debug)]
struct Book {
    clearness: Clearness,
    page_ready: bool,
    /// Each source page's load and the last showing it opened (МО34, МО37).
    loads: HashMap<String, (String, u32)>,
    session: Option<Session>,
    drag: Option<DragView>,
    last_session: u32,
    /// The app windows whose moves and resizes end a showing (ПН9).
    watched: HashSet<String>,
    watching_system: bool,
}

impl Book {
    fn ready(&self) -> bool {
        self.clearness == Clearness::Clear && self.page_ready
    }

    /// The source page `source` at its load `page`: a load anew forgets its
    /// count; whether it is a load anew.
    fn source_loaded(&mut self, source: &str, page: &str) -> bool {
        let anew = self.loads.get(source).is_none_or(|(load, _)| load != page);
        if anew {
            self.loads.insert(source.to_string(), (page.to_string(), 0));
        }
        anew
    }

    /// Whether `show` of `source` at `page` may open: later than any before.
    fn takes_show(&mut self, source: &str, page: &str, show: u32) -> bool {
        self.source_loaded(source, page);
        let Some(entry) = self.loads.get_mut(source) else { return false };
        if show <= entry.1 {
            return false;
        }
        entry.1 = show;
        true
    }

    fn session_of(&self, source: &str, page: &str, show: u32) -> Option<&Session> {
        self.session.as_ref().filter(|session| session.source == source && session.page == page && session.show == show)
    }
}

static BOOK: LazyLock<Mutex<Book>> = LazyLock::new(|| {
    Mutex::new(Book {
        clearness: Clearness::Unknown,
        page_ready: false,
        loads: HashMap::new(),
        session: None,
        drag: None,
        last_session: 0,
        watched: HashSet::new(),
        watching_system: false,
    })
});

fn book() -> MutexGuard<'static, Book> {
    // A panic while the lock was held leaves a book that is still whole:
    // every change to it is a single assignment.
    BOOK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn status() -> OutsideWindowStatus {
    OutsideWindowStatus { ready: book().ready() }
}

/// Make the outside window unless it exists, and know the source page
/// `caller` at its load `page`; whether the window is ready. A showing the
/// former load left open closes.
pub fn prepare(app: &AppHandle, caller: &Webview, page: &str) -> OutsideWindowStatus {
    let source = caller.label().to_string();
    let orphan = {
        let mut book = book();
        let anew = book.source_loaded(&source, page);
        book.session.as_ref().filter(|session| anew && session.source == source).map(|session| session.id)
    };
    if let Some(session) = orphan {
        end(app, session, OutsideCloseReason::Source);
    }
    watch_window(app, &caller.window());
    if app.get_webview_window(OUTSIDE_LABEL).is_none() {
        make(app);
    }
    status()
}

fn make(app: &AppHandle) {
    let rest = geometry::PREVIEW_WIDTH_PX + 2.0 * SHADOW_FIELD_PX;
    let built = WebviewWindowBuilder::new(app, OUTSIDE_LABEL, WebviewUrl::App(OUTSIDE_PAGE.into()))
        .title("")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .focused(false)
        // tao answers "no" to both key and main for it (НО2).
        .focusable(false)
        .visible(false)
        .skip_taskbar(true)
        .inner_size(rest, rest)
        .position(0.0, 0.0)
        // The page keeps running though nothing on it is seen for long.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            log::warn!("outside window not made, previews stay in the app window: {error}");
            return;
        }
    };
    match native::dress_window(&window).and_then(|dressed| {
        if dressed.holds() {
            native::order_in_window(&window)
        } else {
            Err(format!("the window does not hold its flags: {}", dressed.describe()))
        }
    }) {
        Ok(()) => log::info!("outside window made, unseen until it is found clear"),
        Err(why) => {
            log::warn!("outside window not set up, previews stay in the app window: {why}");
            book().clearness = Clearness::NotClear;
            if let Err(error) = window.destroy() {
                log::warn!("outside window not taken away: {error}");
            }
            return;
        }
    }
    let watching = std::mem::replace(&mut book().watching_system, true);
    if !watching {
        let handle = app.clone();
        native::watch(move || end_current(&handle, OutsideCloseReason::System));
    }
}

/// End the showing the moves and changes of the app window `window` would
/// leave hanging (ПН9). Once per window.
fn watch_window(app: &AppHandle, window: &tauri::Window) {
    let label = window.label().to_string();
    if !book().watched.insert(label.clone()) {
        return;
    }
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            end_of_window(&handle, &label);
        }
        WindowEvent::Destroyed => {
            end_of_window(&handle, &label);
            book().watched.remove(&label);
        }
        _ => {}
    });
}

fn end_of_window(app: &AppHandle, window: &str) {
    let session = book().session.as_ref().filter(|session| session.window == window).map(|session| session.id);
    if let Some(session) = session {
        end(app, session, OutsideCloseReason::Window);
    }
}

fn end_current(app: &AppHandle, reason: OutsideCloseReason) {
    let session = book().session.as_ref().map(|session| session.id);
    if let Some(session) = session {
        end(app, session, reason);
    }
}

/// End `session` here: its page drops the window at once, its source hears
/// why, last.
fn end(app: &AppHandle, session: u32, reason: OutsideCloseReason) {
    let ended = {
        let mut book = book();
        if book.session.as_ref().is_none_or(|current| current.id != session) {
            return;
        }
        book.session.take()
    };
    let Some(ended) = ended else { return };
    emit_to_labels(app, [OUTSIDE_LABEL], TO_PAGE_EVENT, OutsidePageMessage::End { session, reason });
    emit_to_labels(app, [ended.source.clone()], TO_SOURCE_EVENT, OutsideSourceMessage::Closed { show: ended.show, reason });
}

/// The outside window's page reports.
pub fn page_report(app: &AppHandle, caller: &Webview, report: OutsidePageReport) {
    if caller.label() != OUTSIDE_LABEL {
        return;
    }
    match report {
        OutsidePageReport::Ready => page_ready(app),
        OutsidePageReport::DragShown { session } => {
            let source = book().drag.as_ref().filter(|drag| drag.id == session).map(|drag| (drag.source.clone(), drag.seq));
            if let Some((source, seq)) = source {
                emit_to_labels(app, [source], DRAG_VIEW_EVENT, CardDragViewShown { seq });
            }
        }
        OutsidePageReport::FirstFrame { session } => {
            if let Some(current) = book().session.as_mut().filter(|current| current.id == session) {
                current.painted = true;
            }
        }
        OutsidePageReport::Preview { session, number, report } => {
            let target = {
                let mut book = book();
                let Some(current) = book.session.as_ref().filter(|current| current.id == session) else { return };
                let target = (current.source.clone(), current.show);
                // The window that was on screen closed: the showing is over.
                if matches!(report.event, Some(PreviewEvent::Closed)) {
                    book.session = None;
                }
                target
            };
            emit_to_labels(app, [target.0], TO_SOURCE_EVENT, OutsideSourceMessage::Preview { show: target.1, number, report });
        }
    }
}

fn page_ready(app: &AppHandle) {
    book().page_ready = true;
    if book().clearness != Clearness::Unknown {
        return;
    }
    let Some(window) = app.get_webview_window(OUTSIDE_LABEL) else { return };
    let shown = window.clone();
    native::check_window_clear(&window, move |found| {
        let clear = found.clear();
        book().clearness = if clear { Clearness::Clear } else { Clearness::NotClear };
        if clear {
            native::reveal_window(&shown);
            log::info!("outside window found clear: {}", found.describe());
        } else {
            log::warn!("outside window not clear, never shown, previews stay in the app window: {}", found.describe());
        }
    });
}

/// Open a showing of `caller`'s preview outside its app window: the frame
/// set for the whole showing and the page told where the window may stand
/// (ПН2, ПН8). A refusal leaves the preview to the app window (НО9).
///
/// # Errors
///
/// `OutsideRefusal`: why the preview stays in the app window.
pub fn open_preview(app: &AppHandle, caller: &Webview, request: PreviewOpenRequest) -> Result<(), OutsideRefusal> {
    let source = caller.label().to_string();
    if !book().ready() {
        return Err(OutsideRefusal::NotReady);
    }
    if !book().takes_show(&source, &request.page, request.show) {
        return Err(OutsideRefusal::Superseded);
    }
    let window = app.get_webview_window(OUTSIDE_LABEL).ok_or(OutsideRefusal::NotReady)?;
    let trigger = anchor_on_screen(caller, request.trigger).ok_or(OutsideRefusal::NoGeometry)?;
    let panel = anchor_on_screen(caller, request.panel).ok_or(OutsideRefusal::NoGeometry)?;
    let left = preview_column_left(panel.anchor, trigger.bound, request.side).ok_or(OutsideRefusal::NoRoom)?;
    let frame = preview_frame(left, trigger.bound);
    let earlier = book().session.as_ref().map(|session| session.id);
    if let Some(earlier) = earlier {
        end(app, earlier, OutsideCloseReason::Superseded);
    }
    if let Err(why) = native::place_window(&window, frame, OutsideUse::Preview) {
        log::warn!("outside window: showing {} of {source} not placed, drawn in the app window: {why}", request.show);
        return Err(OutsideRefusal::NotPlaced);
    }
    let session = {
        let mut book = book();
        book.last_session += 1;
        let id = book.last_session;
        book.session = Some(Session {
            id,
            source: source.clone(),
            page: request.page.clone(),
            window: caller.window().label().to_string(),
            show: request.show,
            frame,
            painted: false,
        });
        id
    };
    let area = preview_page_area(frame, trigger.bound);
    emit_to_labels(app, [OUTSIDE_LABEL], TO_PAGE_EVENT, OutsidePageMessage::Preview { session, area, look: request.look });
    watch_first_frame(app, session);
    Ok(())
}

/// The one deadline (НО9): a showing with no first frame by then ends, and
/// the window counts as not ready until its page says it listens again.
fn watch_first_frame(app: &AppHandle, session: u32) {
    let handle = app.clone();
    let started = std::thread::Builder::new().name("outside-window-deadline".into()).spawn(move || {
        std::thread::sleep(PREVIEW_FIRST_FRAME_DEADLINE);
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let stalled = {
                let mut book = book();
                let stalled = book.session.as_ref().is_some_and(|current| current.id == session && !current.painted);
                if stalled {
                    book.page_ready = false;
                }
                stalled
            };
            if stalled {
                log::warn!(
                    "outside window: showing {session} drew nothing within {} ms, drawn in the app window until the page listens again",
                    PREVIEW_FIRST_FRAME_DEADLINE.as_millis()
                );
                end(&inner, session, OutsideCloseReason::Unresponsive);
            }
        });
    });
    if let Err(error) = started {
        log::warn!("outside window: no watch over the showing's first frame: {error}");
    }
}

/// A step of `caller`'s showing: to the outside window's page, its trigger
/// moved onto that page.
pub fn preview_step(app: &AppHandle, caller: &Webview, request: PreviewStepRequest) {
    let source = caller.label().to_string();
    let (session, frame) = {
        let book = book();
        let Some(current) = book.session_of(&source, &request.page, request.show) else { return };
        (current.id, current.frame)
    };
    let onto_page = |trigger: ScreenRect| anchor_on_screen(caller, trigger).map(|placed| on_page(placed.anchor, frame));
    let step = match request.step {
        PreviewStep::Offer { key, trigger, content } => {
            let Some(trigger) = onto_page(trigger) else { return };
            PreviewStep::Offer { key, trigger, content }
        }
        PreviewStep::BringBack { key, trigger } => {
            let Some(trigger) = onto_page(trigger) else { return };
            PreviewStep::BringBack { key, trigger }
        }
        other => other,
    };
    emit_to_labels(app, [OUTSIDE_LABEL], TO_PAGE_EVENT, OutsidePageMessage::PreviewStep { session, number: request.number, step });
}

/// Draw the card the tab page `source` drags, its drag `seq`, in the outside
/// window at the pointer `cursor` (ПК1). Whether the window took it: if not,
/// the page keeps drawing its own (НО9).
pub fn begin_drag(app: &AppHandle, source: &str, seq: u32, stack: CardStack, cursor: ScreenPoint) -> bool {
    if !book().ready() {
        return false;
    }
    let Some(window) = app.get_webview_window(OUTSIDE_LABEL) else { return false };
    let Some(tallest) = native::tallest_screen() else { return false };
    // A drag closes the preview at once (С7.8).
    end_current(app, OutsideCloseReason::Superseded);
    end_drag(app);
    let frame = drag_frame(cursor, tallest);
    if let Err(why) = native::place_window(&window, frame, OutsideUse::Drag) {
        log::warn!("outside window: the dragged card of {source} not placed, drawn in its page: {why}");
        return false;
    }
    let session = {
        let mut book = book();
        book.last_session += 1;
        let id = book.last_session;
        book.drag = Some(DragView { id, source: source.to_string(), seq, height: frame.height });
        id
    };
    emit_to_labels(app, [OUTSIDE_LABEL], TO_PAGE_EVENT, OutsidePageMessage::Drag { session, at: drag_stack_on_page(), stack });
    true
}

/// Whether the outside window draws a card the page `source` drags.
pub fn drags_for(source: &str) -> bool {
    book().drag.as_ref().is_some_and(|drag| drag.source == source)
}

/// The dragged card follows the pointer, in the handler of its move (ПК3).
pub fn move_drag(app: &AppHandle, cursor: ScreenPoint) {
    let Some(height) = book().drag.as_ref().map(|drag| drag.height) else { return };
    if let Some(window) = app.get_webview_window(OUTSIDE_LABEL) {
        native::move_window(&window, drag_frame_origin(cursor), height);
    }
}

/// The drag is over: the dragged card goes in this frame.
pub fn end_drag(app: &AppHandle) {
    let ended = book().drag.take();
    if let Some(ended) = ended {
        emit_to_labels(app, [OUTSIDE_LABEL], TO_PAGE_EVENT, OutsidePageMessage::DragEnd { session: ended.id });
    }
}

/// The outside window's number in the window server: the search for the
/// window under a dragged card looks under it (ПК4).
pub fn window_number(app: &AppHandle) -> Option<isize> {
    native::number_of(&app.get_webview_window(OUTSIDE_LABEL)?)
}

#[cfg(test)]
mod tests {
    use super::{Book, Clearness};
    use std::collections::{HashMap, HashSet};

    fn book() -> Book {
        Book {
            clearness: Clearness::Clear,
            page_ready: true,
            loads: HashMap::new(),
            session: None,
            drag: None,
            last_session: 0,
            watched: HashSet::new(),
            watching_system: false,
        }
    }

    #[test]
    fn is_ready_only_found_clear_with_its_page_listening() {
        let mut book = book();
        assert!(book.ready());
        book.page_ready = false;
        assert!(!book.ready());
        book.page_ready = true;
        book.clearness = Clearness::Unknown;
        assert!(!book.ready());
    }

    #[test]
    fn takes_each_pages_showings_in_their_order_and_a_reloaded_page_from_one() {
        let mut book = book();
        assert!(book.takes_show("tab-1", "load-a", 1));
        assert!(book.takes_show("tab-1", "load-a", 3));
        assert!(!book.takes_show("tab-1", "load-a", 2));
        assert!(!book.takes_show("tab-1", "load-a", 3));
        // Another page counts on its own.
        assert!(book.takes_show("tab-2", "load-c", 1));
        // The page loaded anew counts from one again.
        assert!(book.takes_show("tab-1", "load-b", 1));
    }
}
