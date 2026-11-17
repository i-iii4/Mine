//! Which card rows the index wrote while a command ran.
//!
//! Contract: SPEC_INTEGRATION.md, «Список изменённых карточек». A command
//! that changes a space names the cards it changed, so the tabs read those
//! rows instead of the whole feed. The names come from the index itself:
//! every connection opened through `storage::db` reports each row it writes
//! to the tables a feed row is read from (`blocks`, `block_tags`,
//! `channels`), and a recording collects what was written between its start
//! and its end. No command lists its own writes, so none can leave one out.
//!
//! SQLite tells a write by its table and row number, through the update
//! hook. It does not tell: rows removed by `DELETE` without `WHERE` on a
//! table without triggers, rows a `REPLACE` conflict removes, and rows of
//! `WITHOUT ROWID` tables. The three tables have row numbers and delete
//! triggers, and no statement of the project replaces their rows; the tests
//! below hold the sources and the schema to that.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use anyhow::Result;
use rusqlite::hooks::Action;
use rusqlite::Connection;

/// The table of cards and collection pages as rows of the feed.
const CARDS_TABLE: &str = "blocks";
/// The links of cards to collections: a card's membership.
const MEMBERSHIP_TABLE: &str = "block_tags";
/// The table of collection pages: a card's collections are read through it.
const COLLECTIONS_TABLE: &str = "channels";
/// Every table a row of the feed is read from (`grid_row_columns_sql`,
/// `feed_place_sql` in `block_queries`): the card's own row with its preview,
/// its links to collections, and the collection pages that make a link a
/// membership.
#[cfg(test)]
const FEED_TABLES: [&str; 3] = [CARDS_TABLE, MEMBERSHIP_TABLE, COLLECTIONS_TABLE];

/// How many cards a command names at most. Past it the recording stops
/// keeping them and the cards are not known: the tabs read their feed in
/// full. A pass that writes thousands of rows while a command runs (the
/// first index of a space, a pass over its files) then costs the recording
/// nothing more.
///
/// The number is from the partial read's speed (SPEC_STORAGE.md, «Замер
/// частичного чтения», 15.11.2026): 500 named cards are read in 7.4 ms and
/// 0.78 MB, a seventh of the 50 ms a change has to show in; 2 000 take 30 ms
/// and 3.1 MB and leave the page less than half of that time.
pub const FEED_CHANGE_LIMIT: usize = 500;

/// What one recording has heard so far.
#[derive(Default)]
struct Written {
    /// `blocks.id` of every card row inserted, updated or deleted.
    cards: BTreeSet<i64>,
    /// Row numbers of the `block_tags` rows inserted or updated: the index
    /// tells whose links they are. A deleted link is told by its row number
    /// alone; the two places that delete links (`index::upsert_block`, the
    /// membership backfill) and the cascade of a deleted card write the
    /// card's own row in the same step, and the card is named by it.
    links: BTreeSet<i64>,
    /// `channels.id` of every collection page that appeared.
    new_collections: BTreeSet<i64>,
    /// The cards cannot be told. A collection page was changed or removed:
    /// SQLite tells the row's number only, not what it held, so neither its
    /// former name nor whether its place moved is known. Or more rows were
    /// written than a command may name ([`FEED_CHANGE_LIMIT`]).
    unknown: bool,
    /// The only thread whose writes the recording hears; `None` hears every
    /// thread, as a command does: its writes may run on any thread of the
    /// pool. A test hears its own thread alone, since the tests of the whole
    /// crate write to their own indexes side by side in one process.
    thread: Option<std::thread::ThreadId>,
}

impl Written {
    fn note(&mut self, table: Table, action: Action, row: i64) {
        if self.unknown {
            return;
        }
        match table {
            Table::Cards => {
                self.cards.insert(row);
            }
            Table::Membership => {
                if action != Action::SQLITE_DELETE {
                    self.links.insert(row);
                }
            }
            Table::Collections => {
                if action == Action::SQLITE_INSERT {
                    self.new_collections.insert(row);
                } else {
                    self.unknown = true;
                }
            }
        }
        if self.cards.len() + self.links.len() > FEED_CHANGE_LIMIT {
            self.unknown = true;
        }
        if self.unknown {
            // Nothing is kept past the point where the cards are not known.
            self.cards = BTreeSet::new();
            self.links = BTreeSet::new();
            self.new_collections = BTreeSet::new();
        }
    }
}

#[derive(Clone, Copy)]
enum Table {
    Cards,
    Membership,
    Collections,
}

#[derive(Default)]
struct Recordings {
    /// How many recordings are open, read by every write of every
    /// connection: a write locks nothing while no command records.
    open_count: AtomicUsize,
    open: Mutex<OpenRecordings>,
}

#[derive(Default)]
struct OpenRecordings {
    next: u64,
    by_id: HashMap<u64, Written>,
}

impl Recordings {
    fn open(&self) -> MutexGuard<'_, OpenRecordings> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The recordings of this process. A write of any connection of any space
/// reaches every open recording: what a recording names beyond its own
/// command's writes costs a read of that card's row and breaks nothing.
static RECORDINGS: LazyLock<Recordings> = LazyLock::new(Recordings::default);

/// Report every row `conn` writes to the open recordings. `storage::db`
/// calls it for each connection it opens.
pub fn listen(conn: &Connection) {
    conn.update_hook(Some(|action: Action, _database: &str, table: &str, row: i64| {
        note_write(table, action, row);
    }));
}

fn note_write(table: &str, action: Action, row: i64) {
    if RECORDINGS.open_count.load(Ordering::Acquire) == 0 {
        return;
    }
    let table = match table {
        CARDS_TABLE => Table::Cards,
        MEMBERSHIP_TABLE => Table::Membership,
        COLLECTIONS_TABLE => Table::Collections,
        _ => return,
    };
    let mut open = RECORDINGS.open();
    let mut thread = None;
    for written in open.by_id.values_mut() {
        if let Some(only) = written.thread {
            if only != *thread.get_or_insert_with(|| std::thread::current().id()) {
                continue;
            }
        }
        written.note(table, action, row);
    }
}

/// The card rows written to the index from [`FeedRecording::start`] until
/// [`FeedRecording::finish`].
pub struct FeedRecording {
    id: u64,
}

impl FeedRecording {
    /// Begin hearing the writes of every connection of the process.
    pub fn start() -> Self {
        Self::open(Written::default())
    }

    /// Begin hearing the writes this thread makes, on any connection.
    #[cfg(test)]
    pub(crate) fn start_on_this_thread() -> Self {
        Self::open(Written {
            thread: Some(std::thread::current().id()),
            ..Written::default()
        })
    }

    fn open(written: Written) -> Self {
        let mut open = RECORDINGS.open();
        let id = open.next;
        open.next += 1;
        open.by_id.insert(id, written);
        RECORDINGS.open_count.fetch_add(1, Ordering::AcqRel);
        Self { id }
    }

    /// What was written since the start.
    pub fn finish(self) -> FeedWrites {
        let written = RECORDINGS.open().by_id.remove(&self.id).unwrap_or_default();
        if written.unknown {
            FeedWrites::Unknown
        } else if written.cards.is_empty() && written.links.is_empty() && written.new_collections.is_empty() {
            FeedWrites::Nothing
        } else {
            FeedWrites::Rows(WrittenRows {
                cards: written.cards,
                links: written.links,
                collections: written.new_collections,
            })
        }
    }
}

/// What a recording heard.
pub enum FeedWrites {
    /// No row of the feed's tables was written.
    Nothing,
    /// Rows were written: the index tells which cards they are.
    Rows(WrittenRows),
    /// The cards cannot be told: a collection page was changed or removed,
    /// or more rows were written than a command may name.
    Unknown,
}

/// The rows a recording heard written.
pub struct WrittenRows {
    cards: BTreeSet<i64>,
    links: BTreeSet<i64>,
    collections: BTreeSet<i64>,
}

impl WrittenRows {
    /// The cards, when the card rows written tell them all: no link and no
    /// collection page was written, so the index has nothing to add.
    pub fn told_by_card_rows(&self) -> Option<Vec<i64>> {
        (self.links.is_empty() && self.collections.is_empty())
            .then(|| self.cards.iter().copied().collect())
    }

    /// `blocks.id` of the cards the rows are, in order of id: every card row
    /// inserted, updated or deleted, the cards whose links to collections
    /// were written, and the cards that link a collection page that appeared
    /// (they join it without a write of their own). `conn` reads whose the
    /// links are; `None` when they are more than a command may name
    /// ([`FEED_CHANGE_LIMIT`]).
    pub fn cards(self, conn: &Connection) -> Result<Option<Vec<i64>>> {
        let mut cards = self.cards;
        if !self.links.is_empty() {
            let links = serde_json::to_string(&self.links)?;
            let mut statement = conn.prepare(
                "SELECT DISTINCT block_id FROM block_tags
                 WHERE rowid IN (SELECT value FROM json_each(?1))",
            )?;
            for card in statement.query_map([links], |row| row.get::<_, i64>(0))? {
                cards.insert(card?);
            }
        }
        if !self.collections.is_empty() {
            let pages = serde_json::to_string(&self.collections)?;
            // A link names the page by its ref or by its path
            // (`collection_membership_join_sql`). One row past the limit
            // tells that the cards are too many without reading them all.
            let mut statement = conn.prepare(
                "SELECT DISTINCT link.block_id
                 FROM channels page
                 JOIN block_tags link ON link.tag = page.tag OR link.tag = page.source_slug
                 WHERE page.id IN (SELECT value FROM json_each(?1))
                 LIMIT ?2",
            )?;
            let limit = i64::try_from(FEED_CHANGE_LIMIT + 1)?;
            for card in statement.query_map(rusqlite::params![pages, limit], |row| row.get::<_, i64>(0))? {
                cards.insert(card?);
            }
        }
        if cards.len() > FEED_CHANGE_LIMIT {
            return Ok(None);
        }
        Ok(Some(cards.into_iter().collect()))
    }
}

impl Drop for FeedRecording {
    fn drop(&mut self) {
        RECORDINGS.open().by_id.remove(&self.id);
        RECORDINGS.open_count.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::domain::channel::Channel;
    use crate::storage::{channel_index, db, index};

    fn card(slug: &str, collections: &[&str]) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: None,
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: collections.iter().map(|tag| (*tag).to_string()).collect(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-07-11T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: "Readable body".to_string(),
        }
    }

    fn collection(tag: &str, position: i64) -> Channel {
        Channel {
            tag: tag.to_string(),
            description: None,
            color: None,
            icon: None,
            position,
            created_at: DateTime::new("2026-01-01T00:00:00Z").unwrap(),
        }
    }

    /// The cards a recording names, `None` when it cannot tell them.
    fn named(recording: FeedRecording, conn: &Connection) -> Option<Vec<i64>> {
        match recording.finish() {
            FeedWrites::Nothing => Some(Vec::new()),
            FeedWrites::Rows(rows) => rows.cards(conn).unwrap(),
            FeedWrites::Unknown => None,
        }
    }

    fn id_of(conn: &Connection, slug: &str) -> i64 {
        conn.query_row("SELECT id FROM blocks WHERE slug = ?1", [slug], |row| row.get(0))
            .unwrap()
    }

    /// The space's connections report their writes without being asked to:
    /// `storage::db` installs the listener on each one it opens.
    #[test]
    fn a_recording_names_every_card_row_written() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &card("kept", &[]), None).unwrap();
        index::upsert_block(&conn, &card("edited", &[]), None).unwrap();
        index::upsert_block(&conn, &card("renamed", &[]), None).unwrap();
        index::upsert_block(&conn, &card("removed", &[]), None).unwrap();
        let (kept, edited, renamed, removed) = (
            id_of(&conn, "kept"),
            id_of(&conn, "edited"),
            id_of(&conn, "renamed"),
            id_of(&conn, "removed"),
        );

        let recording = FeedRecording::start_on_this_thread();
        index::upsert_block(&conn, &card("edited", &[]), None).unwrap();
        index::rename_slug(&conn, "renamed", "renamed-again").unwrap();
        index::remove_block(&conn, "removed").unwrap();
        index::upsert_block(&conn, &card("created", &[]), None).unwrap();
        let named = named(recording, &conn).unwrap();

        let created = id_of(&conn, "created");
        for written in [edited, renamed, removed, created] {
            assert!(named.contains(&written), "{written} is not named in {named:?}");
        }
        assert!(!named.contains(&kept));
    }

    /// A write on another connection of the process is heard too: commands
    /// write through connections of their own.
    #[test]
    fn a_recording_hears_every_connection() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        let first = db::open_or_create(&path).unwrap();
        let second = db::open_or_create(&path).unwrap();
        let recording = FeedRecording::start_on_this_thread();
        index::upsert_block(&second, &card("from-second", &[]), None).unwrap();
        let named = named(recording, &first).unwrap();
        assert!(named.contains(&id_of(&first, "from-second")));
    }

    /// A command's recording hears the writes of every thread: its index
    /// writes run on the threads of the pool.
    #[test]
    fn a_commands_recording_hears_another_thread() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("index.db");
        let conn = db::open_or_create(&path).unwrap();
        let recording = FeedRecording::start();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let pooled = db::open_or_create(&path).unwrap();
                index::upsert_block(&pooled, &card("from-the-pool", &[]), None).unwrap();
            });
        });
        // Other tests write beside this one, so the list may hold more.
        let named = match recording.finish() {
            FeedWrites::Rows(rows) => rows.cards(&conn).unwrap(),
            FeedWrites::Nothing => Some(Vec::new()),
            FeedWrites::Unknown => None,
        };
        if let Some(named) = named {
            assert!(named.contains(&id_of(&conn, "from-the-pool")));
        }
    }

    /// A write before the recording began or after it ended is not named.
    #[test]
    fn a_recording_names_only_what_was_written_while_it_was_open() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &card("before", &[]), None).unwrap();
        let recording = FeedRecording::start_on_this_thread();
        let named = named(recording, &conn).unwrap();
        index::upsert_block(&conn, &card("after", &[]), None).unwrap();
        assert!(!named.contains(&id_of(&conn, "before")));
        assert!(!named.contains(&id_of(&conn, "after")));
    }

    /// A collection page that appears names the cards that link it: they
    /// become its members with no write of their own (К3).
    #[test]
    fn a_new_collection_page_names_the_cards_that_link_it() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &card("linking", &["Gamma"]), None).unwrap();
        index::upsert_block(&conn, &card("other", &[]), None).unwrap();
        let recording = FeedRecording::start_on_this_thread();
        channel_index::upsert_channel(&conn, &collection("Gamma", 0)).unwrap();
        let named = named(recording, &conn).unwrap();
        assert!(named.contains(&id_of(&conn, "linking")));
        assert!(!named.contains(&id_of(&conn, "other")));
    }

    /// A collection page changed or removed: SQLite tells the row's number
    /// only, so the cards cannot be told and the feed is read in full.
    #[test]
    fn a_changed_or_removed_collection_page_names_no_list() {
        let conn = db::open_memory().unwrap();
        channel_index::upsert_channel(&conn, &collection("Alpha", 1)).unwrap();

        let moved = FeedRecording::start_on_this_thread();
        channel_index::upsert_channel(&conn, &collection("Alpha", 5)).unwrap();
        assert_eq!(named(moved, &conn), None);

        let removed = FeedRecording::start_on_this_thread();
        channel_index::remove_channel(&conn, "Alpha").unwrap();
        assert_eq!(named(removed, &conn), None);
    }

    /// A link to a collection written without the card's own row still names
    /// the card: the index tells whose link it is.
    #[test]
    fn a_written_link_names_its_card() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &card("linked", &[]), None).unwrap();
        index::upsert_block(&conn, &card("other", &[]), None).unwrap();
        let linked = id_of(&conn, "linked");
        let recording = FeedRecording::start_on_this_thread();
        conn.execute("INSERT INTO block_tags (block_id, tag) VALUES (?1, 'Alpha')", [linked])
            .unwrap();
        assert_eq!(named(recording, &conn), Some(vec![linked]));
    }

    /// The two places that delete links write the card's row in the same
    /// step, so a card whose links were only removed is named: a card
    /// written without its collections (`index::upsert_block`) and the
    /// membership backfill.
    #[test]
    fn a_card_whose_links_were_removed_is_named() {
        let conn = db::open_memory().unwrap();
        channel_index::upsert_channel(&conn, &collection("Alpha", 1)).unwrap();
        index::upsert_block(&conn, &card("member", &["Alpha"]), None).unwrap();
        let member = id_of(&conn, "member");
        let recording = FeedRecording::start_on_this_thread();
        index::upsert_block(&conn, &card("member", &[]), None).unwrap();
        assert_eq!(named(recording, &conn), Some(vec![member]));
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM block_tags WHERE block_id = ?1", [member], |row| row.get(0))
            .unwrap();
        assert_eq!(links, 0);
    }

    /// More rows than a command may name: the recording keeps none of them
    /// and names no list, so a pass over thousands of notes that runs beside
    /// a command costs the recording nothing more.
    #[test]
    fn more_rows_than_a_command_may_name_are_not_kept() {
        let conn = db::open_memory().unwrap();
        let recording = FeedRecording::start_on_this_thread();
        conn.execute_batch("BEGIN").unwrap();
        for index in 0..=FEED_CHANGE_LIMIT {
            index::upsert_block(&conn, &card(&format!("card-{index}"), &[]), None).unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        let kept = {
            let open = RECORDINGS.open();
            let written = &open.by_id[&recording.id];
            (written.unknown, written.cards.len(), written.links.len())
        };
        assert_eq!(kept, (true, 0, 0));
        assert_eq!(named(recording, &conn), None);

        // Exactly the limit is still named.
        let conn = db::open_memory().unwrap();
        let recording = FeedRecording::start_on_this_thread();
        for index in 0..FEED_CHANGE_LIMIT {
            index::upsert_block(&conn, &card(&format!("card-{index}"), &[]), None).unwrap();
        }
        assert_eq!(named(recording, &conn).map(|cards| cards.len()), Some(FEED_CHANGE_LIMIT));
    }

    /// A new collection page that more cards link than a command may name
    /// names no list.
    #[test]
    fn a_new_collection_page_with_too_many_cards_names_no_list() {
        let conn = db::open_memory().unwrap();
        conn.execute_batch("BEGIN").unwrap();
        for index in 0..=FEED_CHANGE_LIMIT {
            index::upsert_block(&conn, &card(&format!("card-{index}"), &["Gamma"]), None).unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        let recording = FeedRecording::start_on_this_thread();
        channel_index::upsert_channel(&conn, &collection("Gamma", 0)).unwrap();
        assert_eq!(named(recording, &conn), None);
    }

    /// SQLite calls the listener for every row of a `DELETE` without `WHERE`
    /// on these tables: each has a delete trigger, and the shortcut that
    /// empties a table without visiting its rows is taken only for a table
    /// without triggers (sqlite.org/lang_delete.html, «The Truncate
    /// Optimization»).
    #[test]
    fn a_delete_of_every_row_is_heard_row_by_row() {
        let conn = db::open_memory().unwrap();
        index::upsert_block(&conn, &card("one", &["Alpha"]), None).unwrap();
        index::upsert_block(&conn, &card("two", &[]), None).unwrap();
        let (one, two) = (id_of(&conn, "one"), id_of(&conn, "two"));
        let recording = FeedRecording::start_on_this_thread();
        conn.execute("DELETE FROM blocks", []).unwrap();
        assert_eq!(named(recording, &conn), Some(vec![one, two]));

        for table in FEED_TABLES {
            let triggers: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'trigger' AND tbl_name = ?1 AND sql LIKE '%AFTER DELETE%'",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(triggers > 0, "{table} has no delete trigger: DELETE without WHERE would not be heard");
        }
    }

    /// The listener is called for tables with row numbers only
    /// (sqlite.org/c3ref/update_hook.html): none of the feed's tables is
    /// `WITHOUT ROWID`.
    #[test]
    fn the_feed_tables_have_row_numbers() {
        let conn = db::open_memory().unwrap();
        for table in FEED_TABLES {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!sql.to_uppercase().contains("WITHOUT ROWID"), "{table} is WITHOUT ROWID");
        }
    }

    /// The text of every Rust source of the app, without its test modules.
    fn production_sources() -> Vec<(String, String)> {
        fn visit(folder: &std::path::Path, sources: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(folder).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path, sources);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let production = text.split("\n#[cfg(test)]\nmod ").next().unwrap_or_default().to_string();
                    sources.push((path.display().to_string(), production));
                }
            }
        }
        let mut sources = Vec::new();
        visit(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut sources);
        sources
    }

    /// SQLite does not call the listener for a row a `REPLACE` conflict
    /// removes (sqlite.org/c3ref/update_hook.html): no statement of the app
    /// replaces a row of the feed's tables. They are written with `INSERT …
    /// ON CONFLICT DO UPDATE`, which is heard as an update.
    #[test]
    fn no_statement_replaces_a_row_of_the_feed_tables() {
        for (path, text) in production_sources() {
            let upper = text.to_uppercase();
            for table in FEED_TABLES {
                let table = table.to_uppercase();
                for statement in [
                    format!("REPLACE INTO {table}"),
                    format!("UPDATE OR REPLACE {table}"),
                ] {
                    assert!(!upper.contains(&statement), "{path}: {statement}");
                }
            }
        }
    }

    /// A deleted or retagged link is told by its row number alone, so the
    /// card is named only through its own row: the statements that delete or
    /// update links are the two that write the card's row in the same step.
    /// A new one fails here and is to be checked for the same.
    #[test]
    fn links_are_deleted_only_where_the_card_row_is_written() {
        let mut places = Vec::new();
        for (path, text) in production_sources() {
            let upper = text.to_uppercase();
            let count = upper.matches("DELETE FROM BLOCK_TAGS").count() + upper.matches("UPDATE BLOCK_TAGS").count();
            if count > 0 {
                places.push((path.rsplit("/src/").next().unwrap().to_string(), count));
            }
        }
        assert_eq!(places, vec![("storage/index.rs".to_string(), 2)]);
    }

    /// A recording dropped without an answer (the command failed) stops
    /// hearing, and the next write locks nothing.
    #[test]
    fn a_dropped_recording_stops_hearing() {
        let recording = FeedRecording::start_on_this_thread();
        let id = recording.id;
        assert!(RECORDINGS.open().by_id.contains_key(&id));
        drop(recording);
        assert!(!RECORDINGS.open().by_id.contains_key(&id));
    }
}
