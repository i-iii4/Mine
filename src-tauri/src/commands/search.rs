// Search command: one page of the search overlay's results, the search
// connection of each open space and the stop of a tab's older search.
//
// Contract: SPEC_INTEGRATION.md#commands/search and SPEC_SEARCH.md,
// «Устройство поиска на большом пространстве»

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::{Connection, InterruptHandle};
use tauri::{AppHandle, Manager, State};

use crate::commands::state::{
    adopt_recovered_projection, current_read_owner, ensure_vault_fresh,
    read_owned_search_projection, tab_layout, AppState, CommandError,
};
use crate::domain::vault::VaultLayout;
use crate::storage::projection::ProjectionRevision;
use crate::storage::search_engine::{open_search_connection, SearchRun, SearchStep};
use crate::storage::{db, index, search_projection};

const MAX_SEARCH_PAGE_SIZE: usize = 200;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ─── Search sessions ────────────────────────────────────────────────────────

/// One search of a tab: the tab's page and the number of the search among
/// that tab's searches (SPEC_SEARCH.md, «Отмена устаревшего запроса»).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchRequest {
    label: String,
    sequence: u64,
}

/// The search connection of one index file. Searches of the tabs of its
/// space take it in turn.
struct SearchConnection {
    conn: Mutex<Connection>,
    interrupt: InterruptHandle,
    /// The search whose statements run on `conn` now. Set and cleared by
    /// the search itself while it holds `conn`, read by a newer search that
    /// decides whether to interrupt.
    running: Mutex<Option<SearchRequest>>,
    /// The number of cards of the space for the timing line, counted again
    /// only when the projection changed.
    cards: Mutex<Option<(ProjectionRevision, usize)>>,
}

/// Clears the running search when it ends, however it ends.
struct RunningSearch<'a>(&'a SearchConnection);

impl Drop for RunningSearch<'_> {
    fn drop(&mut self) {
        *lock(&self.0.running) = None;
    }
}

impl SearchConnection {
    fn open(index: &Path) -> anyhow::Result<Self> {
        let conn = open_search_connection(index)?;
        let interrupt = conn.get_interrupt_handle();
        Ok(Self {
            conn: Mutex::new(conn),
            interrupt,
            running: Mutex::new(None),
            cards: Mutex::new(None),
        })
    }

    /// Run `search` of `request` on the connection once the searches before
    /// it are done. The time waited is the `wait` step of `run`.
    fn run<T>(
        &self,
        request: &SearchRequest,
        run: &mut SearchRun<'_>,
        search: impl FnOnce(&Connection, &mut SearchRun<'_>) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let waited = Instant::now();
        let conn = lock(&self.conn);
        run.add(SearchStep::Wait, waited.elapsed());
        *lock(&self.running) = Some(request.clone());
        // Dropped before `conn` is released: no other search holds the
        // connection while this one is still named as running.
        let _running = RunningSearch(self);
        search(&conn, run)
    }

    /// The number of cards of the space at `generation`.
    fn cards(&self, conn: &Connection, generation: ProjectionRevision) -> anyhow::Result<usize> {
        let mut cards = lock(&self.cards);
        if let Some((counted_at, count)) = *cards {
            if counted_at == generation {
                return Ok(count);
            }
        }
        let count = index::count_grid_blocks(conn)?;
        *cards = Some((generation, count));
        Ok(count)
    }

    /// Stop the running search if it is an older search of the tab `label`.
    /// The lock on `running` is held across the interrupt: a search of
    /// another tab cannot start its statements in between.
    fn supersede(&self, label: &str, sequence: u64) {
        let running = lock(&self.running);
        if is_superseded_by(running.as_ref(), label, sequence) {
            self.interrupt.interrupt();
        }
    }
}

/// Whether the running search gives way to search `sequence` of the tab
/// `label`: only an older search of the same tab does.
fn is_superseded_by(running: Option<&SearchRequest>, label: &str, sequence: u64) -> bool {
    running.is_some_and(|running| running.label == label && running.sequence < sequence)
}

/// The search connections of the open spaces, one per index file, and the
/// number of each tab's latest search (SPEC_SEARCH.md, «Соединение поиска»,
/// «Отмена устаревшего запроса»).
#[derive(Default)]
pub(crate) struct SearchSessions {
    connections: Mutex<HashMap<PathBuf, Arc<SearchConnection>>>,
    latest: Mutex<HashMap<String, u64>>,
}

impl SearchSessions {
    /// Start a search of the tab `label`: it takes the next number of the
    /// tab's searches, and the tab's older search, if one runs now, is
    /// interrupted.
    pub(crate) fn begin(&self, label: &str) -> SearchRequest {
        let sequence = {
            let mut latest = lock(&self.latest);
            let sequence = latest.entry(label.to_string()).or_insert(0);
            *sequence += 1;
            *sequence
        };
        let connections: Vec<Arc<SearchConnection>> =
            lock(&self.connections).values().cloned().collect();
        for connection in connections {
            connection.supersede(label, sequence);
        }
        SearchRequest {
            label: label.to_string(),
            sequence,
        }
    }

    /// Whether no newer search of the same tab has started.
    pub(crate) fn is_latest(&self, request: &SearchRequest) -> bool {
        lock(&self.latest).get(&request.label).copied() == Some(request.sequence)
    }

    /// The connection of the index file `index`, opened on its first search,
    /// and how long the opening took if this call opened it.
    fn connection(&self, index: &Path) -> anyhow::Result<(Arc<SearchConnection>, Option<Duration>)> {
        if let Some(connection) = lock(&self.connections).get(index) {
            return Ok((Arc::clone(connection), None));
        }
        // Opened outside the lock: the schema check must not hold back the
        // searches of other spaces.
        let started = Instant::now();
        let opened = Arc::new(SearchConnection::open(index)?);
        let took = started.elapsed();
        let mut connections = lock(&self.connections);
        let connection = connections
            .entry(index.to_path_buf())
            .or_insert_with(|| Arc::clone(&opened));
        Ok((Arc::clone(connection), Some(took)))
    }

    /// Close the connections whose index file no open space serves and
    /// forget the tabs that are gone.
    fn prune(&self, serves: impl Fn(&Path) -> bool, tab_open: impl Fn(&str) -> bool) {
        lock(&self.connections).retain(|index, _| serves(index));
        lock(&self.latest).retain(|label, _| tab_open(label));
    }

    /// Close the connection of `index`: the next search opens a new one.
    fn forget(&self, index: &Path) {
        lock(&self.connections).remove(index);
    }
}

// ─── Timing ─────────────────────────────────────────────────────────────────

/// How a search ended, for its timing line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchEnd {
    Done { cards: usize, results: usize },
    Superseded,
    Failed,
}

fn milliseconds(duration: Duration) -> String {
    format!("{:.1}", duration.as_secs_f64() * 1000.0)
}

/// The line of one search in `Mine.log` (SPEC_SEARCH.md, «Замер шагов»):
/// numbers and step names only, never the text of the query, a path or a
/// name.
fn search_timing_line(end: SearchEnd, query_chars: usize, run: &SearchRun<'_>, total: Duration) -> String {
    let mut line = match end {
        SearchEnd::Done { .. } => String::from("search timing: done"),
        SearchEnd::Superseded => String::from("search timing: superseded"),
        SearchEnd::Failed => String::from("search timing: failed"),
    };
    line.push_str(&format!(" chars={query_chars} terms={}", run.terms()));
    if let SearchEnd::Done { cards, results } = end {
        line.push_str(&format!(" cards={cards} results={results}"));
    }
    line.push_str(&format!(" total_ms={} steps:", milliseconds(total)));
    for (step, took) in run.steps() {
        line.push_str(&format!(" {}={}", step.name(), milliseconds(*took)));
    }
    line
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// What the overlay asked for.
struct SearchPage {
    current_tag: Option<String>,
    query: String,
    limit: usize,
    cursor: Option<search_projection::SearchPageToken>,
}

/// One revision-safe page of search results for the overlay (SPEC_SEARCH.md).
#[tauri::command(rename_all = "snake_case")]
pub async fn search_grid_blocks(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    current_tag: Option<String>,
    query: String,
    limit: Option<usize>,
    cursor: Option<search_projection::SearchPageToken>,
) -> Result<search_projection::SearchSnapshot, CommandError> {
    let received = Instant::now();
    // Before anything else: this search takes the place of the tab's older one.
    let request = state.search.begin(webview.label());
    let vault = tab_layout(&state, &webview)?;
    ensure_vault_fresh(&app, vault.clone()).await?;
    let page = SearchPage {
        current_tag,
        query,
        limit: limit
            .unwrap_or(MAX_SEARCH_PAGE_SIZE)
            .clamp(1, MAX_SEARCH_PAGE_SIZE),
        cursor,
    };
    tauri::async_runtime::spawn_blocking(move || search_page(&app, &vault, &request, &page, received))
        .await
        .map_err(|error| {
            CommandError::Internal(format!("search_grid_blocks task join failed: {error}"))
        })?
}

/// Search on the space's search connection and write the timing line.
/// `received` is when the command was called: the time up to here went to
/// the index's freshness and to the wait for a thread.
fn search_page(
    app: &AppHandle,
    vault: &VaultLayout,
    request: &SearchRequest,
    page: &SearchPage,
    received: Instant,
) -> Result<search_projection::SearchSnapshot, CommandError> {
    let waited_for_fresh_index = received.elapsed();
    let state = app.state::<AppState>();
    let sessions = &state.search;
    let owned = current_read_owner(app, vault)?;
    let index = owned.index_db_path();
    sessions.prune(
        |path| {
            state
                .spaces
                .all()
                .iter()
                .any(|space| space.layout().is_ok_and(|layout| layout.index_db_path() == path))
        },
        |label| state.space_for(label).is_some(),
    );

    let superseded = || !sessions.is_latest(request);
    let mut run = SearchRun::new(&superseded);
    run.add(SearchStep::Fresh, waited_for_fresh_index);
    let outcome = (|| -> anyhow::Result<(search_projection::SearchSnapshot, usize)> {
        run.check()?;
        let (connection, opened) = sessions.connection(&index)?;
        if let Some(opened) = opened {
            run.add(SearchStep::Open, opened);
        }
        connection.run(request, &mut run, |conn, run| {
            let snapshot = search_projection::read_search_snapshot_observed(
                conn,
                page.current_tag.as_deref(),
                &page.query,
                page.limit,
                page.cursor.as_ref(),
                run,
            )?;
            let cards = connection.cards(conn, snapshot.generation)?;
            Ok((snapshot, cards))
        })
    })();

    let query_chars = page.query.trim().chars().count();
    let line = |end: SearchEnd| {
        log::info!("{}", search_timing_line(end, query_chars, &run, received.elapsed()));
    };
    match outcome {
        Ok((snapshot, cards)) => {
            line(SearchEnd::Done {
                cards,
                results: snapshot.blocks.len(),
            });
            // The answer counts only while the same space and index are open.
            adopt_recovered_projection(app, &owned, owned.clone(), snapshot)
        }
        Err(_) if superseded() => {
            line(SearchEnd::Superseded);
            Err(CommandError::SearchSuperseded)
        }
        Err(error) if db::is_index_corruption(&error) => {
            line(SearchEnd::Failed);
            // The damaged index is rebuilt in another slot: this connection
            // is closed, and the search is repeated the recovering way.
            sessions.forget(&index);
            read_owned_search_projection(app, vault, |conn| {
                search_projection::read_search_snapshot(
                    conn,
                    page.current_tag.as_deref(),
                    &page.query,
                    page.limit,
                    page.cursor.as_ref(),
                )
            })
        }
        Err(error) => {
            line(SearchEnd::Failed);
            Err(error.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(label: &str, sequence: u64) -> SearchRequest {
        SearchRequest {
            label: label.to_string(),
            sequence,
        }
    }

    /// Counts to `rows` on the connection: a statement that runs long enough
    /// to be interrupted, and whose answer proves it was not.
    fn count_to(conn: &Connection, rows: i64) -> anyhow::Result<i64> {
        Ok(conn.query_row(
            "WITH RECURSIVE counted(value) AS (
                 SELECT 1 UNION ALL SELECT value + 1 FROM counted WHERE value < ?1
             )
             SELECT count(*) FROM counted",
            [rows],
            |row| row.get(0),
        )?)
    }

    /// Waits until a search runs on `connection`.
    fn wait_for_running(connection: &SearchConnection) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while lock(&connection.running).is_none() {
            assert!(Instant::now() < deadline, "the search never started");
            std::thread::yield_now();
        }
    }

    #[test]
    fn only_an_older_search_of_the_same_tab_gives_way() {
        let running = request("tab-1", 4);
        assert!(is_superseded_by(Some(&running), "tab-1", 5));
        assert!(!is_superseded_by(Some(&running), "tab-1", 4));
        assert!(!is_superseded_by(Some(&running), "tab-2", 9));
        assert!(!is_superseded_by(None, "tab-1", 5));
    }

    #[test]
    fn a_newer_search_of_a_tab_makes_the_older_one_not_the_latest() {
        let sessions = SearchSessions::default();
        let first = sessions.begin("tab-1");
        let other = sessions.begin("tab-2");
        assert!(sessions.is_latest(&first));
        let second = sessions.begin("tab-1");
        assert!(!sessions.is_latest(&first));
        assert!(sessions.is_latest(&second));
        assert!(sessions.is_latest(&other));
    }

    #[test]
    fn a_space_keeps_one_connection_until_its_index_is_no_longer_served() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.db");
        let sessions = SearchSessions::default();

        let (first, opened) = sessions.connection(&index).unwrap();
        assert!(opened.is_some());
        let (second, opened_again) = sessions.connection(&index).unwrap();
        assert!(opened_again.is_none());
        assert!(Arc::ptr_eq(&first, &second));

        sessions.prune(|_| true, |_| true);
        let (kept, _) = sessions.connection(&index).unwrap();
        assert!(Arc::ptr_eq(&first, &kept));

        sessions.begin("tab-1");
        sessions.prune(|_| false, |_| false);
        let (reopened, opened) = sessions.connection(&index).unwrap();
        assert!(opened.is_some());
        assert!(!Arc::ptr_eq(&first, &reopened));
        // The closed tab's count went with it: its next search is its first.
        assert_eq!(sessions.begin("tab-1").sequence, 1);
    }

    #[test]
    fn a_newer_search_of_the_tab_stops_the_running_one() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.db");
        let sessions = Arc::new(SearchSessions::default());
        let (connection, _) = sessions.connection(&index).unwrap();
        let older = sessions.begin("tab-1");

        let search = {
            let (connection, older) = (Arc::clone(&connection), older.clone());
            std::thread::spawn(move || {
                let mut run = SearchRun::unobserved();
                // Nothing but an interrupt ends this count in the lifetime
                // of the test: the run is not asked between steps.
                connection.run(&older, &mut run, |conn, _| count_to(conn, i64::MAX))
            })
        };
        wait_for_running(&connection);
        // An interrupt that lands before the statement has started is lost,
        // as SQLite defines it; the next search of the tab sends another.
        let mut newer = sessions.begin("tab-1");
        while !search.is_finished() {
            std::thread::sleep(Duration::from_millis(1));
            newer = sessions.begin("tab-1");
        }

        let stopped = search.join().unwrap().unwrap_err();
        let interrupted = stopped.downcast_ref::<rusqlite::Error>().is_some_and(|error| {
            error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted)
        });
        assert!(interrupted, "{stopped:#}");
        assert!(!sessions.is_latest(&older));
        assert!(sessions.is_latest(&newer));
        // The connection serves the next search.
        let mut run = SearchRun::unobserved();
        let counted = connection
            .run(&newer, &mut run, |conn, _| count_to(conn, 10))
            .unwrap();
        assert_eq!(counted, 10);
        assert!(lock(&connection.running).is_none());
    }

    #[test]
    fn a_search_of_another_tab_does_not_stop_the_running_one() {
        const ROWS: i64 = 2_000_000;
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.db");
        let sessions = Arc::new(SearchSessions::default());
        let (connection, _) = sessions.connection(&index).unwrap();
        let running = sessions.begin("tab-1");

        let search = {
            let (connection, running) = (Arc::clone(&connection), running.clone());
            std::thread::spawn(move || {
                let mut run = SearchRun::unobserved();
                connection.run(&running, &mut run, |conn, _| count_to(conn, ROWS))
            })
        };
        wait_for_running(&connection);
        sessions.begin("tab-2");

        // An interrupted count would be an error, not the full count.
        assert_eq!(search.join().unwrap().unwrap(), ROWS);
        assert!(sessions.is_latest(&running));
    }

    #[test]
    fn the_timing_line_holds_numbers_and_step_names_and_never_the_query() {
        let mut run = SearchRun::unobserved();
        run.add(SearchStep::Wait, Duration::from_micros(300));
        run.add(SearchStep::Sync, Duration::from_micros(100));
        run.add(SearchStep::Lexical, Duration::from_micros(20_140));
        run.add(SearchStep::Fuse, Duration::from_micros(1_200));

        let done = search_timing_line(
            SearchEnd::Done {
                cards: 10_000,
                results: 200,
            },
            5,
            &run,
            Duration::from_micros(41_300),
        );
        assert_eq!(
            done,
            "search timing: done chars=5 terms=0 cards=10000 results=200 total_ms=41.3 steps: wait=0.3 sync=0.1 lexical=20.1 fuse=1.2"
        );

        let superseded = search_timing_line(SearchEnd::Superseded, 5, &run, Duration::from_millis(3));
        assert!(superseded.starts_with("search timing: superseded chars=5 terms=0 total_ms=3.0 steps:"));
        assert!(!superseded.contains("results="));
        let failed = search_timing_line(SearchEnd::Failed, 5, &run, Duration::from_millis(3));
        assert!(failed.starts_with("search timing: failed chars=5 "));
    }
}
