use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::{Duration, Instant};

#[cfg(all(not(target_os = "ios"), not(test)))]
use anyhow::Context;
use anyhow::Result;
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

#[cfg(all(not(target_os = "ios"), not(test)))]
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

#[cfg(all(not(target_os = "ios"), not(test)))]
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use crate::storage::block_queries::{
    collection_membership_join_sql, collections_column_sql, grid_rows_by_slug, FeedOrder,
};
use crate::storage::index::{
    light_block_from_row, LightBlock, SearchMatch, SearchMatchField, SearchMatchKind,
    SearchTextRange, LIGHT_BLOCK_BODY_PREVIEW_CHARS,
};

const SEARCH_EMBEDDING_MODEL_ID: &str = "intfloat/multilingual-e5-small";
#[cfg(all(not(target_os = "ios"), not(test)))]
const SEARCH_EMBEDDING_DIM: usize = 384;
const SEARCH_EMBEDDING_BATCH: usize = 32;
const SEMANTIC_CANDIDATE_LIMIT: usize = 200;
const SEARCH_MIN_QUERY_CHARS: usize = 2;
const SEMANTIC_MIN_QUERY_CHARS: usize = 3;
const SEMANTIC_MIN_SCORE: f32 = 0.58;
const TITLE_MATCH_WEIGHT: f64 = 8.0;
const DESCRIPTION_MATCH_WEIGHT: f64 = 3.0;
const AUTHOR_MATCH_WEIGHT: f64 = 3.0;
const BODY_MATCH_WEIGHT: f64 = 1.0;
const URL_MATCH_WEIGHT: f64 = 1.0;
const DEFAULT_EXCERPT_BEFORE_CHARS: usize = 90;
const DEFAULT_EXCERPT_AFTER_CHARS: usize = 150;
const DESCRIPTION_EXCERPT_BEFORE_CHARS: usize = 80;
const DESCRIPTION_EXCERPT_AFTER_CHARS: usize = 140;
const BODY_CHUNK_TARGET_CHARS: usize = 900;
const BODY_CHUNK_OVERLAP_CHARS: usize = 120;
/// The shortest word, of a query or of a text, the typo-tolerant search
/// looks at: the dictionary holds the words from this length on.
const FUZZY_MIN_WORD_CHARS: usize = 4;
/// The longest word the dictionary holds, in bytes: the longest token an
/// FTS5 index keeps whole.
const INDEXED_WORD_MAX_BYTES: usize = 32_768;
/// How many documents one transaction of a sync outside a caller's
/// transaction writes, so a rebuild never holds the index's write lock for
/// its whole length.
const SYNC_BATCH_DOCUMENTS: usize = 200;
/// How many threads build the matches of the cards the lexical search kept
/// ([`build_search_matches`]): four cut the 70 ms the matches of 400 long
/// articles take on one thread to under 20.
const MATCH_WORKERS: usize = 4;
/// The least text, in bytes, whose matches are built on threads: below it
/// one thread is done within a millisecond or two, and starting the threads
/// would cost as much as they save.
const MATCH_PARALLEL_MIN_BYTES: usize = 256 * 1024;
/// How many dictionary words one FTS query of the typo-tolerant search asks
/// for.
const FUZZY_WORDS_PER_QUERY: usize = 200;
/// How many cards the typo-tolerant search reads between two looks at
/// whether it is still wanted.
const FUZZY_CARDS_PER_CHECK: usize = 256;
/// The word that marks, in `search_metadata_terms`, a chunk whose text
/// changes byte lengths when lowercased: `first_match_range` takes offsets
/// from the lowercased text and tests the word boundary in the original, so
/// its answer there does not follow from the chunk's words, and every query
/// asks for such chunks. No word is this one: `§` is no letter or digit.
const UNALIGNED_CASE_TERM: &str = "§";
/// The stamp of a card, in SQL over its `blocks` row aliased `b`: the fields
/// its search document is built from, the body by its hash.
const CARD_STAMP_SQL: &str = "b.slug || char(31) || ifnull(b.description, '') || char(31)      || ifnull(b.author, '') || char(31) || ifnull(b.url, '') || char(31)      || ifnull(b.body_hash, '')";

/// The join that narrows a search to the members of the route's collection
/// (`page.tag = ?`): a link whose name has no collection page is no membership
/// (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К9).
fn collection_route_join_sql() -> String {
    format!(
        " INNER JOIN block_tags bt ON bt.block_id = b.id {}",
        collection_membership_join_sql("bt", "page")
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SearchNeedle {
    term: String,
    kind: SearchMatchKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SearchTermGroup {
    needles: Vec<SearchNeedle>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SearchPlan {
    literal_query: String,
    literal_terms: Vec<String>,
    groups: Vec<SearchTermGroup>,
}

#[derive(Debug, Clone)]
struct SearchDocumentRow {
    block_id: i64,
    slug: String,
    description: Option<String>,
    author: Option<String>,
    url: Option<String>,
    body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchDocument {
    block_id: i64,
    slug: String,
    document_hash: String,
    chunks: Vec<SearchChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchChunk {
    block_id: i64,
    slug: String,
    field: SearchMatchField,
    chunk_index: usize,
    text: String,
    start_char: usize,
    end_char: usize,
    text_hash: String,
}

#[derive(Debug, Clone)]
struct SemanticCandidate {
    slug: String,
    chunk_id: i64,
    text: String,
    similarity: f32,
}

/// A card found through a chunk: by its author or address, or by a typo.
#[derive(Debug, Clone)]
struct FuzzyCandidate {
    slug: String,
    search_match: SearchMatch,
    /// `saved_at` of the card when the chunk's card is in the index under
    /// the chunk's `slug`: its row is then read only if the card is on the
    /// page returned. `None` when the chunk's document lags behind a rename;
    /// the card is then looked up by `slug` before ranking, as before.
    saved_at: Option<String>,
}

/// A card of the answer before the page is cut: what orders it, and its row
/// or the match its row gets once read.
#[derive(Debug, Clone)]
struct RankedBlock {
    slug: String,
    saved_at: String,
    rank_score: f64,
    lexical: bool,
    row: RankedRow,
}

#[derive(Debug, Clone)]
enum RankedRow {
    /// The card's row, read.
    Read(Box<LightBlock>),
    /// A card known to be in the index: only the cards of the page returned
    /// have their rows read (SPEC_SEARCH.md, Performance Contract).
    Unread(SearchMatch),
}

impl RankedBlock {
    fn read(block: LightBlock, rank_score: f64, lexical: bool) -> Self {
        Self {
            slug: block.slug.clone(),
            saved_at: block.saved_at.clone(),
            rank_score,
            lexical,
            row: RankedRow::Read(Box::new(block)),
        }
    }

    /// The card's row with its match; `None` if the card left the index
    /// since it was found, which only a search outside a snapshot can meet.
    fn into_block(self, conn: &Connection) -> Result<Option<LightBlock>> {
        match self.row {
            RankedRow::Read(block) => Ok(Some(*block)),
            RankedRow::Unread(search_match) => {
                Ok(load_light_block_by_slug(conn, &self.slug)?.map(|mut block| {
                    block.search_match = Some(search_match);
                    block
                }))
            }
        }
    }
}

/// How many prepared statements a search connection keeps. A search and a
/// sync of the documents run about twenty different statements between them;
/// the default of 16 would prepare some of them again on every search.
const SEARCH_STATEMENT_CACHE: usize = 64;

/// Open the connection a space searches by (SPEC_SEARCH.md, «Соединение
/// поиска»): a read-write connection, its schema checked here once, that
/// keeps the statements of a search prepared.
///
/// # Errors
/// The index cannot be opened or its schema is not the current one.
pub fn open_search_connection(index: &std::path::Path) -> Result<Connection> {
    let conn = crate::storage::db::open_or_create(index)?;
    conn.set_prepared_statement_cache_capacity(SEARCH_STATEMENT_CACHE);
    Ok(conn)
}

/// A step of one search, for its timing line (SPEC_SEARCH.md, «Замер
/// шагов»).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchStep {
    /// Before the search: the index brought up to the files, and the wait
    /// for a thread to search on.
    Fresh,
    /// The wait for the space's search connection.
    Wait,
    /// The connection opened, with its schema check.
    Open,
    /// The search documents brought up to the cards.
    Sync,
    /// A query of one character: the file names.
    Names,
    /// The words in `blocks_fts` and the matches of the cards found.
    Lexical,
    /// The authors and the addresses.
    Metadata,
    /// The typo-tolerant search.
    Fuzzy,
    /// The search by meaning.
    Semantic,
    /// The candidates fused, ordered, and the page's rows.
    Fuse,
}

impl SearchStep {
    /// The step's name in the timing line.
    pub fn name(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Wait => "wait",
            Self::Open => "open",
            Self::Sync => "sync",
            Self::Names => "names",
            Self::Lexical => "lexical",
            Self::Metadata => "metadata",
            Self::Fuzzy => "fuzzy",
            Self::Semantic => "semantic",
            Self::Fuse => "fuse",
        }
    }
}

/// The search was stopped: a newer search of the same tab took its place
/// (SPEC_SEARCH.md, «Отмена устаревшего запроса»).
#[derive(Debug, thiserror::Error)]
#[error("the search was superseded by a newer one")]
pub struct SearchSuperseded;

/// What its caller follows one search with: whether the search is still
/// wanted, and how long each of its steps took.
pub struct SearchRun<'a> {
    superseded: Option<&'a dyn Fn() -> bool>,
    steps: Vec<(SearchStep, Duration)>,
    terms: usize,
}

impl<'a> SearchRun<'a> {
    /// A search that stops between its steps once `superseded` says so.
    pub fn new(superseded: &'a dyn Fn() -> bool) -> Self {
        Self {
            superseded: Some(superseded),
            steps: Vec::new(),
            terms: 0,
        }
    }

    /// A search nobody stops.
    pub fn unobserved() -> SearchRun<'static> {
        SearchRun {
            superseded: None,
            steps: Vec::new(),
            terms: 0,
        }
    }

    /// Stop here if a newer search took this one's place.
    ///
    /// # Errors
    /// [`SearchSuperseded`] once the search is no longer wanted.
    pub fn check(&self) -> Result<()> {
        if self.superseded.is_some_and(|superseded| superseded()) {
            return Err(SearchSuperseded.into());
        }
        Ok(())
    }

    /// Run `work` as `step` unless the search is no longer wanted, and add
    /// its time. `work` gets the run to look again inside a long step.
    ///
    /// # Errors
    /// [`SearchSuperseded`], or the error of `work`.
    pub fn step<T>(&mut self, step: SearchStep, work: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        self.check()?;
        let started = Instant::now();
        let outcome = work(self);
        self.add(step, started.elapsed());
        outcome
    }

    /// Add `took` to `step`; a step run twice adds up.
    pub fn add(&mut self, step: SearchStep, took: Duration) {
        match self.steps.iter_mut().find(|(known, _)| *known == step) {
            Some((_, total)) => *total += took,
            None => self.steps.push((step, took)),
        }
    }

    /// The steps run so far, in the order they first ran.
    pub fn steps(&self) -> &[(SearchStep, Duration)] {
        &self.steps
    }

    /// How many meaningful words the query has; zero until it is planned.
    pub fn terms(&self) -> usize {
        self.terms
    }
}

pub trait SemanticEmbeddingProvider {
    fn model_id(&self) -> &str;
    fn dimension(&self) -> usize;
    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn embed_query(&self, query: &str) -> Result<Vec<f32>>;
}

pub fn search_grid_blocks(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: &str,
) -> Result<(Vec<LightBlock>, bool)> {
    search_grid_blocks_with_provider(
        conn,
        tag,
        offset,
        limit,
        query,
        production_semantic_provider(),
    )
}

pub fn search_grid_blocks_with_provider(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: &str,
    semantic_provider: Option<&dyn SemanticEmbeddingProvider>,
) -> Result<(Vec<LightBlock>, bool)> {
    sync_search_documents(conn)?;
    search_grid_blocks_prepared_with_provider(
        conn,
        tag,
        offset,
        limit,
        query,
        semantic_provider,
        &mut SearchRun::unobserved(),
    )
}

/// Search without touching the index: no document sync, no writes. The read
/// may lag whatever the app has not yet synced — the honest-freshness contract
/// of SPEC_AI_ACCESS. Semantic reranking applies only when the model is warm
/// in this process; a cold process degrades to the lexical half.
pub fn search_grid_blocks_read_only(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: &str,
) -> Result<(Vec<LightBlock>, bool)> {
    search_grid_blocks_prepared_with_provider(
        conn,
        tag,
        offset,
        limit,
        query,
        production_semantic_provider(),
        &mut SearchRun::unobserved(),
    )
}

/// Search the documents as they are, following the search with `run`: its
/// caller has synced them.
pub(crate) fn search_grid_blocks_prepared(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: &str,
    run: &mut SearchRun<'_>,
) -> Result<(Vec<LightBlock>, bool)> {
    search_grid_blocks_prepared_with_provider(
        conn,
        tag,
        offset,
        limit,
        query,
        production_semantic_provider(),
        run,
    )
}

fn search_grid_blocks_prepared_with_provider(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    query: &str,
    semantic_provider: Option<&dyn SemanticEmbeddingProvider>,
    run: &mut SearchRun<'_>,
) -> Result<(Vec<LightBlock>, bool)> {
    if let Some(initial) = title_initial(query) {
        return run.step(SearchStep::Names, |_| {
            title_initial_search(conn, tag, offset, limit, &initial)
        });
    }
    let Some(plan) = SearchPlan::from_query(query) else {
        return Ok((Vec::new(), false));
    };
    run.terms = plan.literal_terms.len();

    let semantic_provider = semantic_provider.filter(|_| plan.allows_semantic_only());

    let candidate_limit = (offset + limit + SEMANTIC_CANDIDATE_LIMIT).max(limit + 1);
    let lexical_blocks = run.step(SearchStep::Lexical, |_| {
        lexical_grid_search(conn, tag, 0, candidate_limit, &plan)
    })?;
    let mut chunk_candidates =
        run.step(SearchStep::Metadata, |_| metadata_candidates(conn, tag, &plan))?;
    chunk_candidates.extend(run.step(SearchStep::Fuzzy, |run| {
        fuzzy_candidates(conn, tag, &plan, run)
    })?);
    let semantic_candidates = match semantic_provider {
        Some(provider) => run.step(SearchStep::Semantic, |_| {
            Ok(
                match semantic_candidates(conn, tag, provider, &plan.literal_query) {
                    Ok(candidates) => candidates,
                    Err(err) => {
                        log::warn!("semantic search unavailable for {:?}: {err:#}", query);
                        Vec::new()
                    }
                },
            )
        })?,
        None => Vec::new(),
    };

    run.step(SearchStep::Fuse, |_| {
        let mut ranked =
            fuse_candidates(conn, lexical_blocks, chunk_candidates, semantic_candidates)?;
        ranked.sort_by(compare_ranked_blocks);

        let has_more = ranked.len() > offset + limit;
        let mut blocks = Vec::with_capacity(limit.min(ranked.len()));
        for ranked in ranked.into_iter().skip(offset).take(limit) {
            if let Some(block) = ranked.into_block(conn)? {
                blocks.push(block);
            }
        }

        Ok((blocks, has_more))
    })
}

/// The one letter or digit a query of one character is, lowercased: such a
/// query finds the cards with a word of their file name starting with it
/// (user's decision of 15.11.2026, SPEC_SEARCH.md, «Запрос из одного
/// символа»). Any other query, and one character that is neither a letter
/// nor a digit, goes the full way, which plans nothing under two characters.
fn title_initial(query: &str) -> Option<String> {
    let mut chars = query.trim().chars();
    let initial = chars.next()?;
    (chars.next().is_none() && initial.is_alphanumeric()).then(|| initial.to_lowercase().collect())
}

/// A query of one character searches names only: one character over the
/// text, the authors, the addresses or by meaning is noise, and it is no
/// word, so no stop word and no transliteration applies to it. The file name
/// is the name a result shows (SPEC_SEARCH.md, Match Metadata); the cards
/// come newest first, in the order of the recent cards of the empty query
/// (`FeedOrder::Newest`).
///
/// The FTS `title` column holds every name of a card, the file name among
/// them, so its prefix match is the index's superset of the answer; only
/// the slugs of those candidates are read and sorted, and the file name
/// decides. The page's rows are then read as the feed reads them.
fn title_initial_search(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    limit: usize,
    initial: &str,
) -> Result<(Vec<LightBlock>, bool)> {
    let mut sql = String::from(
        "SELECT b.slug FROM blocks b JOIN blocks_fts ON blocks_fts.rowid = b.id",
    );
    let mut params = vec![Value::Text(format!("title : {}", fts5_prefix_term(initial)))];
    if tag.is_some() {
        sql.push_str(&collection_route_join_sql());
    }
    sql.push_str(" WHERE b.card_kind != 'channel' AND blocks_fts MATCH ?1");
    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(" AND page.tag = ?2");
    }
    sql.push_str(&format!(" ORDER BY {}", FeedOrder::Newest.order_by("b.")));

    let wanted = offset.saturating_add(limit).saturating_add(1);
    let mut slugs = Vec::new();
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    while let Some(row) = rows.next()? {
        let slug: String = row.get(0)?;
        if title_initial_match(&slug, initial).is_some() {
            slugs.push(slug);
            if slugs.len() == wanted {
                break;
            }
        }
    }

    let has_more = slugs.len() > offset.saturating_add(limit);
    let page: Vec<String> = slugs.into_iter().skip(offset).take(limit).collect();
    let mut blocks = grid_rows_by_slug(conn, &page)?;
    for block in &mut blocks {
        block.search_match = title_initial_match(&block.slug, initial);
    }
    Ok((blocks, has_more))
}

/// The match of a one-character query in the file name: the first word that
/// starts with it, case aside, as any typed prefix is highlighted.
fn title_initial_match(slug: &str, initial: &str) -> Option<SearchMatch> {
    let file_name = search_file_name(slug)?;
    let (start, end) =
        first_prefix_token_match_range(&file_name, &file_name.to_lowercase(), initial)?;
    let needle = SearchNeedle {
        term: initial.to_string(),
        kind: SearchMatchKind::Prefix,
    };
    Some(SearchMatch {
        field: SearchMatchField::Title,
        kind: match_kind_for_text(&file_name, &needle, start, end),
        ranges: vec![full_text_search_range(&file_name, start, end)],
        excerpt: file_name,
        score: TITLE_MATCH_WEIGHT,
        explanation: None,
    })
}

pub fn warm_search_index(
    conn: &Connection,
    semantic_provider: Option<&dyn SemanticEmbeddingProvider>,
) -> Result<usize> {
    let changed_chunks = sync_search_documents(conn)?;
    let embedded = match semantic_provider {
        Some(provider) => ensure_semantic_embeddings(conn, provider, None)?,
        None => 0,
    };
    Ok(changed_chunks + embedded)
}

#[cfg(all(not(target_os = "ios"), not(test)))]
pub fn warm_search_index_with_default_provider(conn: &Connection) -> Result<usize> {
    warm_search_index(conn, Some(&FASTEMBED_WARM_PROVIDER))
}

#[cfg(any(target_os = "ios", test))]
pub fn warm_search_index_with_default_provider(conn: &Connection) -> Result<usize> {
    warm_search_index(conn, None)
}

/// The cards the words of the query are found in by `blocks_fts`, best
/// first, each with its match.
///
/// The cards are found and ordered by their ids alone, and only the rows of
/// the `fetch_limit` cards kept are read: ordering every found card with its
/// whole row read the text of each (AUDIT_PERFORMANCE.md, П5). The order is
/// the one a single statement over whole rows gives.
fn lexical_grid_search(
    conn: &Connection,
    tag: Option<&str>,
    offset: usize,
    fetch_limit: usize,
    plan: &SearchPlan,
) -> Result<Vec<LightBlock>> {
    let (sql, params) = lexical_ids_sql(tag, offset, fetch_limit, plan);
    let ids = conn
        .prepare_cached(&sql)?
        .query_map(params_from_iter(params.iter()), |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut read_row = conn.prepare_cached(&lexical_row_sql())?;
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        let row = read_row
            .query_row(params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, id], lexical_row)
            .optional()?;
        // A card can leave between the two statements only outside a
        // snapshot (`search_grid_blocks_read_only`).
        rows.extend(row);
    }

    let matches = build_search_matches(&rows, plan);
    Ok(rows
        .into_iter()
        .zip(matches)
        .map(|(row, search_match)| {
            let mut block = row.block;
            block.search_match = search_match;
            block
        })
        .collect())
}

/// A card the lexical search kept, with what its match is built from.
struct LexicalRow {
    block: LightBlock,
    description: Option<String>,
    body: String,
}

fn lexical_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LexicalRow> {
    Ok(LexicalRow {
        block: light_block_from_row(row)?,
        description: row.get(22)?,
        body: row.get(23)?,
    })
}

/// The match of each of `rows`, in their order.
///
/// A card found by its text has the whole text flattened and lowercased for
/// its match, about 0.2 ms for an article of 20 KB, and the search keeps up
/// to 400 cards: the matches are built on [`MATCH_WORKERS`] threads once the
/// texts are long enough for the threads to pay off. Every match is built by
/// [`build_search_match`] from its own row alone, so the threads change
/// nothing in the answer.
fn build_search_matches(rows: &[LexicalRow], plan: &SearchPlan) -> Vec<Option<SearchMatch>> {
    let build = |row: &LexicalRow| {
        build_search_match(&row.block, row.description.as_deref(), &row.body, plan)
    };
    let text_bytes: usize = rows.iter().map(|row| row.body.len()).sum();
    if text_bytes < MATCH_PARALLEL_MIN_BYTES || rows.len() < MATCH_WORKERS {
        return rows.iter().map(build).collect();
    }
    let share = rows.len().div_ceil(MATCH_WORKERS);
    std::thread::scope(|scope| {
        let workers: Vec<_> = rows
            .chunks(share)
            .map(|rows| scope.spawn(move || rows.iter().map(build).collect::<Vec<_>>()))
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    })
}

/// The ids of the cards the lexical search finds, best first.
fn lexical_ids_sql(
    tag: Option<&str>,
    offset: usize,
    fetch_limit: usize,
    plan: &SearchPlan,
) -> (String, Vec<Value>) {
    let (candidates, required_groups) = plan.lexical_fts5_queries();
    let mut sql = String::from(
        "SELECT b.id
         FROM blocks b
         JOIN blocks_fts ON blocks_fts.rowid = b.id",
    );
    let mut params = vec![Value::Text(candidates)];
    if tag.is_some() {
        sql.push_str(&collection_route_join_sql());
    }

    sql.push_str(" WHERE b.card_kind != 'channel' AND blocks_fts MATCH ?1");

    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(&format!(" AND page.tag = ?{}", params.len()));
    }

    for group_query in required_groups {
        params.push(Value::Text(group_query));
        sql.push_str(&format!(
            " AND b.id IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?{})",
            params.len()
        ));
    }

    params.push(Value::Integer(fetch_limit as i64));
    let limit_index = params.len();
    params.push(Value::Integer(offset as i64));
    let offset_index = params.len();
    // The FTS `title` column holds every name of a card (display title, legacy
    // title, file name) and only orders the candidate window, so a card whose
    // H1 matches stays inside it. Which field matched, and the rank, come from
    // `build_search_match`: there `title` is the file name alone.
    sql.push_str(&format!(
        " ORDER BY bm25(blocks_fts, 8.0, 3.0, 1.0) ASC, b.saved_at DESC LIMIT ?{} OFFSET ?{}",
        limit_index, offset_index
    ));

    (sql, params)
}

/// The row of one card the lexical search found: the `LightBlock` columns,
/// then the description and the body its match is built from. `?1` is the
/// body preview length, `?2` the card's id.
fn lexical_row_sql() -> String {
    let collections = collections_column_sql("b.id");
    format!(
        "SELECT b.id, b.slug, b.block_type, b.card_kind, b.title, b.content_heading, b.display_title, COALESCE(b.fallback_label, b.slug), b.url, b.media_file,
                    b.thumbnail, b.saved_at, b.width, b.height, b.author,
                    CASE WHEN b.card_kind = 'article' THEN SUBSTR(b.body, 1, ?1) ELSE '' END,
                    b.preview_text, b.first_image, b.media_urls, b.media_dimensions,
                    CASE WHEN b.preview_state = 'ready'
                              AND b.preview_source_stamp = (
                                  SELECT source.source_stamp FROM source_index_state source
                                  WHERE source.slug = b.slug
                              )
                         THEN b.preview_manifest END,
                    CASE WHEN b.preview_state = 'ready'
                              AND b.preview_source_stamp = (
                                  SELECT source.source_stamp FROM source_index_state source
                                  WHERE source.slug = b.slug
                              )
                         THEN b.feed_playback END,
                    b.description, b.body,
                    {collections}
             FROM blocks b
             WHERE b.id = ?2"
    )
}

/// The cards whose search document is not built from their fields as they
/// are now: no document, a document without a stamp, or a stamp that differs
/// from the card's (SPEC_SEARCH.md, «Отметка документа»). The comparison runs
/// in SQL and reads no body.
fn stale_search_documents(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT b.id
         FROM blocks b
         LEFT JOIN search_document_state s ON s.block_id = b.id
         WHERE b.card_kind != 'channel'
           AND s.source_stamp IS NOT ({CARD_STAMP_SQL})
         ORDER BY b.id"
    ))?;
    let stale = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(stale)
}

/// Bring the search documents up to the cards and return how many chunks
/// changed.
///
/// While no card changed a field a document depends on since the last sync
/// (`search_state.source_revision` equals `synced_source_revision`), this
/// reads one row and nothing else. Otherwise the stale documents are found
/// by their stamps and only their bodies are read. The sync leaves nothing
/// in the memory of the process: a new connection, or a new process, finds
/// the documents as synced as the index says.
///
/// Inside a caller's transaction the writes belong to it and go with it if
/// it is rolled back, the synced revision among them. Outside one, the
/// documents are written in transactions of [`SYNC_BATCH_DOCUMENTS`], and
/// the synced revision is recorded after the last: an interrupted rebuild
/// goes on from where it stopped.
pub(crate) fn sync_search_documents(conn: &Connection) -> Result<usize> {
    sync_search_documents_observed(conn, &SearchRun::unobserved())
}

/// [`sync_search_documents`] that stops between documents once `run` is no
/// longer wanted.
pub(crate) fn sync_search_documents_observed(conn: &Connection, run: &SearchRun<'_>) -> Result<usize> {
    let (source_revision, synced_revision): (i64, Option<i64>) = conn.query_row(
        "SELECT source_revision, synced_source_revision FROM search_state WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if synced_revision == Some(source_revision) {
        return Ok(0);
    }

    let stale = stale_search_documents(conn)?;
    let mut changed = 0;
    // The dictionary words this sync has already written.
    let mut written_words = HashSet::new();
    for batch in stale.chunks(SYNC_BATCH_DOCUMENTS) {
        run.check()?;
        changed += in_sync_savepoint(conn, || {
            let mut changed = 0;
            for block_id in batch {
                if let Some(document) = load_search_document(conn, *block_id)? {
                    changed += write_search_document(conn, &document, &mut written_words)?;
                }
            }
            Ok(changed)
        })?;
    }
    // The revision read before the comparison: a card changed since then
    // moved `source_revision` past it, and the next sync compares again.
    conn.execute(
        "UPDATE search_state SET synced_source_revision = ?1 WHERE singleton = 1",
        [source_revision],
    )?;
    Ok(changed)
}

/// Run `work` in a savepoint: a transaction of its own outside a caller's
/// transaction, a part of the caller's inside one.
fn in_sync_savepoint<T>(conn: &Connection, work: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("SAVEPOINT search_document_sync")?;
    match work() {
        Ok(value) => {
            conn.execute_batch("RELEASE SAVEPOINT search_document_sync")?;
            Ok(value)
        }
        Err(error) => {
            let rollback = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT search_document_sync;
                 RELEASE SAVEPOINT search_document_sync;",
            );
            match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "search document sync rollback also failed: {rollback_error}"
                ))),
            }
        }
    }
}

/// Write one document and return how many chunks changed.
///
/// A document whose hash is the stored one keeps its chunks and their
/// vectors: only its stamp moves. If it was written before the word indexes
/// existed (no stamp), the words of its stored chunks are indexed. Any other
/// document is written anew, chunks and words.
fn write_search_document(
    conn: &Connection,
    document: &SearchDocument,
    written_words: &mut HashSet<String>,
) -> Result<usize> {
    let stored = conn
        .prepare_cached(
            "SELECT document_hash, source_stamp IS NOT NULL
             FROM search_document_state WHERE block_id = ?1",
        )?
        .query_row([document.block_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })
        .optional()?;

    let mut changed = 0;
    match stored {
        Some((hash, stamped)) if hash == document.document_hash => {
            if !stamped {
                index_stored_chunk_terms(conn, document.block_id, written_words)?;
            }
        }
        _ => {
            // The trigger `search_chunk_terms_ad` takes the words of the
            // deleted chunks out of both word indexes.
            conn.prepare_cached("DELETE FROM search_chunks WHERE block_id = ?1")?
                .execute([document.block_id])?;
            let mut insert = conn.prepare_cached(
                "INSERT INTO search_chunks(
                    block_id, slug, field, chunk_index, text, start_char, end_char, text_hash
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for chunk in &document.chunks {
                insert.execute(params![
                    chunk.block_id,
                    chunk.slug,
                    search_field_to_db(chunk.field),
                    chunk.chunk_index as i64,
                    chunk.text,
                    chunk.start_char as i64,
                    chunk.end_char as i64,
                    chunk.text_hash,
                ])?;
                index_chunk_terms(
                    conn,
                    conn.last_insert_rowid(),
                    chunk.field,
                    &chunk.text,
                    written_words,
                )?;
            }
            changed = document.chunks.len();
        }
    }

    // The stamp is taken from the row the document was read from, in the
    // same transaction.
    conn.prepare_cached(&format!(
        "INSERT INTO search_document_state(block_id, slug, document_hash, source_stamp, updated_at)
         SELECT b.id, ?2, ?3, {CARD_STAMP_SQL}, datetime('now')
         FROM blocks b
         WHERE b.id = ?1
         ON CONFLICT(block_id) DO UPDATE SET
            slug = excluded.slug,
            document_hash = excluded.document_hash,
            source_stamp = excluded.source_stamp,
            updated_at = excluded.updated_at"
    ))?
    .execute(params![document.block_id, document.slug, document.document_hash])?;

    Ok(changed)
}

/// Index the words of the chunks a document already has: the chunks written
/// before the word indexes existed.
fn index_stored_chunk_terms(
    conn: &Connection,
    block_id: i64,
    written_words: &mut HashSet<String>,
) -> Result<()> {
    let chunks = conn
        .prepare_cached("SELECT id, field, text FROM search_chunks WHERE block_id = ?1 ORDER BY id")?
        .query_map([block_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                search_field_from_db_lossy(&row.get::<_, String>(1)?),
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (chunk_id, field, text) in chunks {
        // A chunk has one row in each word index: none is left from before.
        conn.prepare_cached("DELETE FROM search_word_chunks WHERE rowid = ?1")?
            .execute([chunk_id])?;
        conn.prepare_cached("DELETE FROM search_metadata_terms WHERE rowid = ?1")?
            .execute([chunk_id])?;
        index_chunk_terms(conn, chunk_id, field, &text, written_words)?;
    }
    Ok(())
}

/// Write the words of one chunk (SPEC_SEARCH.md, «Словарь слов», «Авторы и
/// адреса»): its words of [`FUZZY_MIN_WORD_CHARS`] or more into the
/// dictionary and into `search_word_chunks`, and every word of an author or
/// address chunk into `search_metadata_terms`.
///
/// A word is what the typo-tolerant search has always cut a text into: a run
/// of letters and digits of the lowercased text ([`token_ranges`]). Such a
/// word passes the `ascii` tokenizer of both indexes unchanged.
fn index_chunk_terms(
    conn: &Connection,
    chunk_id: i64,
    field: SearchMatchField,
    text: &str,
    written_words: &mut HashSet<String>,
) -> Result<()> {
    let lower = text.to_lowercase();
    let metadata = is_hidden_metadata_field(field);
    let mut fuzzy_words = BTreeSet::new();
    let mut metadata_terms = BTreeSet::new();
    for (_, word) in token_ranges(&lower) {
        if word.len() > INDEXED_WORD_MAX_BYTES {
            continue;
        }
        if metadata {
            metadata_terms.insert(word);
        }
        if word.chars().count() >= FUZZY_MIN_WORD_CHARS {
            fuzzy_words.insert(word);
        }
    }

    if !fuzzy_words.is_empty() {
        let mut insert_word =
            conn.prepare_cached("INSERT OR IGNORE INTO search_words(chars, word) VALUES (?1, ?2)")?;
        for word in &fuzzy_words {
            if !written_words.contains(*word) {
                insert_word.execute(params![word.chars().count() as i64, word])?;
                written_words.insert((*word).to_string());
            }
        }
        conn.prepare_cached("INSERT INTO search_word_chunks(rowid, words) VALUES (?1, ?2)")?
            .execute(params![chunk_id, joined_terms(&fuzzy_words)])?;
    }

    if metadata {
        if lowercase_moves_bytes(text) {
            metadata_terms.insert(UNALIGNED_CASE_TERM);
        }
        if !metadata_terms.is_empty() {
            conn.prepare_cached("INSERT INTO search_metadata_terms(rowid, terms) VALUES (?1, ?2)")?
                .execute(params![chunk_id, joined_terms(&metadata_terms)])?;
        }
    }
    Ok(())
}

fn joined_terms(terms: &BTreeSet<&str>) -> String {
    terms.iter().copied().collect::<Vec<_>>().join(" ")
}

/// Whether lowercasing changes the byte length of a character of `text`, so
/// byte offsets into the lowercased text do not point at the same characters
/// of the original.
fn lowercase_moves_bytes(text: &str) -> bool {
    text.chars()
        .any(|ch| ch.to_lowercase().map(char::len_utf8).sum::<usize>() != ch.len_utf8())
}

/// The document of the card `block_id`, built from its fields as they are
/// now; `None` for a collection page or a card that is gone.
fn load_search_document(conn: &Connection, block_id: i64) -> Result<Option<SearchDocument>> {
    let row = conn
        .prepare_cached(
            "SELECT id, slug, description, author, url, body
             FROM blocks
             WHERE id = ?1 AND card_kind != 'channel'",
        )?
        .query_row([block_id], |row| {
            Ok(SearchDocumentRow {
                block_id: row.get(0)?,
                slug: row.get(1)?,
                description: row.get(2)?,
                author: row.get(3)?,
                url: row.get(4)?,
                body: row.get(5)?,
            })
        })
        .optional()?;
    Ok(row.map(build_search_document))
}

/// The search document of a card: its chunks and their hash.
///
/// What a document is built from is its card's stamp ([`CARD_STAMP_SQL`]),
/// and a document whose stamp is the card's is never built again. A change
/// of this rule (another field, another chunk size) therefore comes with a
/// migration that clears `search_document_state.source_stamp` and
/// `search_state.synced_source_revision`, so every document is compared once.
fn build_search_document(row: SearchDocumentRow) -> SearchDocument {
    let mut chunks = Vec::new();

    // The `title` chunk is the card's file name; the note's H1 is searched
    // where it lives, in the body chunks.
    if let Some(file_name) = search_file_name(&row.slug) {
        chunks.push(search_chunk(
            row.block_id,
            &row.slug,
            SearchMatchField::Title,
            0,
            file_name,
            0,
        ));
    }

    if let Some(description) = row.description.as_deref().and_then(non_empty_trimmed) {
        chunks.push(search_chunk(
            row.block_id,
            &row.slug,
            SearchMatchField::Description,
            0,
            normalize_excerpt_text(description),
            0,
        ));
    }

    if let Some(author) = row.author.as_deref().and_then(non_empty_trimmed) {
        chunks.push(search_chunk(
            row.block_id,
            &row.slug,
            SearchMatchField::Author,
            0,
            normalize_excerpt_text(author),
            0,
        ));
    }

    if let Some(url) = row.url.as_deref().and_then(non_empty_trimmed) {
        chunks.push(search_chunk(
            row.block_id,
            &row.slug,
            SearchMatchField::Url,
            0,
            normalize_excerpt_text(url),
            0,
        ));
    }

    chunks.extend(body_search_chunks(row.block_id, &row.slug, &row.body));

    let mut hash_input = String::new();
    hash_input.push_str(&row.slug);
    for chunk in &chunks {
        hash_input.push('\n');
        hash_input.push_str(search_field_to_db(chunk.field));
        hash_input.push(':');
        hash_input.push_str(&chunk.text_hash);
    }

    SearchDocument {
        block_id: row.block_id,
        slug: row.slug,
        document_hash: hash_text(&hash_input),
        chunks,
    }
}

/// The search `title` field: the card's file name, its slug without the
/// folder (a slug never carries `.md`), kept verbatim so the ranges a title
/// match returns index the very text the result list shows. Search names a
/// result by its file name (user's decision of 05.10.2026, SPEC_SEARCH.md).
fn search_file_name(slug: &str) -> Option<String> {
    let file_name = crate::domain::block::fallback_title_from_slug(slug);
    (!file_name.trim().is_empty()).then_some(file_name)
}

fn body_search_chunks(block_id: i64, slug: &str, body: &str) -> Vec<SearchChunk> {
    let normalized = normalize_excerpt_text(body);
    if normalized.is_empty() {
        return Vec::new();
    }

    let total_chars = normalized.chars().count();
    if total_chars <= BODY_CHUNK_TARGET_CHARS {
        return vec![search_chunk(
            block_id,
            slug,
            SearchMatchField::Body,
            0,
            normalized,
            0,
        )];
    }

    let mut chunks = Vec::new();
    let mut start_char = 0;
    let mut chunk_index = 0;
    while start_char < total_chars {
        let mut end_char = (start_char + BODY_CHUNK_TARGET_CHARS).min(total_chars);
        if end_char < total_chars {
            end_char = previous_word_boundary_char(&normalized, end_char).max(start_char + 1);
        }
        let start = byte_index_for_char(&normalized, start_char);
        let end = byte_index_for_char(&normalized, end_char);
        chunks.push(search_chunk(
            block_id,
            slug,
            SearchMatchField::Body,
            chunk_index,
            normalized[start..end].to_string(),
            start_char,
        ));
        if end_char == total_chars {
            break;
        }
        start_char = end_char.saturating_sub(BODY_CHUNK_OVERLAP_CHARS);
        chunk_index += 1;
    }

    chunks
}

fn previous_word_boundary_char(text: &str, target_char: usize) -> usize {
    let mut last_boundary = target_char;
    for (char_index, ch) in text.chars().enumerate() {
        if char_index > target_char {
            break;
        }
        if ch.is_whitespace() {
            last_boundary = char_index;
        }
    }
    last_boundary
}

fn search_chunk(
    block_id: i64,
    slug: &str,
    field: SearchMatchField,
    chunk_index: usize,
    text: String,
    start_char: usize,
) -> SearchChunk {
    let end_char = start_char + text.chars().count();
    SearchChunk {
        block_id,
        slug: slug.to_string(),
        field,
        chunk_index,
        text_hash: hash_text(&text),
        text,
        start_char,
        end_char,
    }
}

fn ensure_semantic_embeddings(
    conn: &Connection,
    provider: &dyn SemanticEmbeddingProvider,
    limit: Option<usize>,
) -> Result<usize> {
    let stale = stale_embedding_chunks(conn, provider.model_id(), limit)?;
    if stale.is_empty() {
        return Ok(0);
    }

    let mut embedded = 0;
    for batch in stale.chunks(SEARCH_EMBEDDING_BATCH) {
        let texts = batch
            .iter()
            .map(|chunk| chunk.text.clone())
            .collect::<Vec<_>>();
        let embeddings = provider.embed_passages(&texts)?;
        for (chunk, embedding) in batch.iter().zip(embeddings.iter()) {
            if embedding.len() != provider.dimension() {
                continue;
            }
            conn.execute(
                "INSERT INTO search_embeddings(chunk_id, model_id, dim, vector, text_hash, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
                 ON CONFLICT(chunk_id, model_id) DO UPDATE SET
                    dim = excluded.dim,
                    vector = excluded.vector,
                    text_hash = excluded.text_hash,
                    updated_at = excluded.updated_at",
                params![
                    chunk.chunk_id,
                    provider.model_id(),
                    provider.dimension() as i64,
                    vector_to_blob(embedding),
                    chunk.text_hash,
                ],
            )?;
            embedded += 1;
        }
    }

    Ok(embedded)
}

#[derive(Debug, Clone)]
struct StoredChunk {
    chunk_id: i64,
    text: String,
    text_hash: String,
}

fn stale_embedding_chunks(
    conn: &Connection,
    model_id: &str,
    limit: Option<usize>,
) -> Result<Vec<StoredChunk>> {
    let sql = match limit {
        Some(_) => {
            "SELECT c.id, c.text, c.text_hash
             FROM search_chunks c
             LEFT JOIN search_embeddings e
                ON e.chunk_id = c.id AND e.model_id = ?1
             WHERE e.chunk_id IS NULL OR e.text_hash != c.text_hash
             ORDER BY c.id ASC
             LIMIT ?2"
        }
        None => {
            "SELECT c.id, c.text, c.text_hash
             FROM search_chunks c
             LEFT JOIN search_embeddings e
                ON e.chunk_id = c.id AND e.model_id = ?1
             WHERE e.chunk_id IS NULL OR e.text_hash != c.text_hash
             ORDER BY c.id ASC"
        }
    };
    let mut stmt = conn.prepare(sql)?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(StoredChunk {
            chunk_id: row.get(0)?,
            text: row.get(1)?,
            text_hash: row.get(2)?,
        })
    };
    let chunks = if let Some(limit) = limit {
        stmt.query_map(params![model_id, limit as i64], mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map([model_id], mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(chunks)
}

fn semantic_candidates(
    conn: &Connection,
    tag: Option<&str>,
    provider: &dyn SemanticEmbeddingProvider,
    query: &str,
) -> Result<Vec<SemanticCandidate>> {
    let query_embedding = provider.embed_query(query)?;
    if query_embedding.len() != provider.dimension() {
        return Ok(Vec::new());
    }

    let mut sql = String::from(
        "SELECT c.id, c.slug, c.text, e.vector
         FROM search_chunks c
         INNER JOIN search_embeddings e ON e.chunk_id = c.id
         INNER JOIN blocks b ON b.id = c.block_id",
    );
    if tag.is_some() {
        sql.push_str(&collection_route_join_sql());
    }
    sql.push_str(
        " WHERE b.card_kind != 'channel'
          AND e.model_id = ?1
          AND e.dim = ?2
          AND c.field NOT IN ('author', 'url')",
    );
    let mut params = vec![
        Value::Text(provider.model_id().to_string()),
        Value::Integer(provider.dimension() as i64),
    ];
    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(&format!(" AND page.tag = ?{}", params.len()));
    }

    let mut stmt = conn.prepare(&sql)?;
    let mut candidates = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            let blob = row.get::<_, Vec<u8>>(3)?;
            let embedding = blob_to_vector(&blob).unwrap_or_default();
            let similarity = cosine_similarity(&query_embedding, &embedding);
            Ok(SemanticCandidate {
                chunk_id: row.get(0)?,
                slug: row.get(1)?,
                text: row.get(2)?,
                similarity,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    candidates.retain(|candidate| candidate.similarity >= SEMANTIC_MIN_SCORE);
    candidates.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.slug.cmp(&b.slug))
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
    });

    let mut seen = BTreeSet::new();
    let mut deduped = Vec::new();
    for candidate in candidates {
        if seen.insert(candidate.slug.clone()) {
            deduped.push(candidate);
        }
        if deduped.len() >= SEMANTIC_CANDIDATE_LIMIT {
            break;
        }
    }
    Ok(deduped)
}

/// The words of the query the typo-tolerant search looks for: those of
/// [`FUZZY_MIN_WORD_CHARS`] or more made of letters and digits only.
fn fuzzy_terms(plan: &SearchPlan) -> Vec<&String> {
    plan.literal_terms
        .iter()
        .filter(|term| {
            term.chars().count() >= FUZZY_MIN_WORD_CHARS
                && term.chars().all(|ch| ch.is_alphanumeric())
        })
        .collect()
}

/// The cards with a word that is a typo of a word of the query, each with
/// its match (SPEC_SEARCH.md, «Словарь слов»).
///
/// The query's words are compared with the dictionary, not with the texts:
/// the dictionary words that are typos of them name their chunks through
/// `search_word_chunks`, and only the text of the chunk a card is matched by
/// is read. A card's match is the one a pass over all its chunks in the
/// order of their ids gives: the first chunk of the weightiest field that
/// holds a typo, as [`first_typo`] finds it in the chunk's text.
fn fuzzy_candidates(
    conn: &Connection,
    tag: Option<&str>,
    plan: &SearchPlan,
    run: &SearchRun<'_>,
) -> Result<Vec<FuzzyCandidate>> {
    let terms = fuzzy_terms(plan);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let words = fuzzy_dictionary_words(conn, &terms)?;
    if words.is_empty() {
        return Ok(Vec::new());
    }

    // The chunks that hold one of the words, by id.
    let mut chunks = BTreeMap::<i64, (i64, String, SearchMatchField)>::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT c.id, c.block_id, c.slug, c.field
             FROM search_chunks c
             WHERE c.id IN (
                 SELECT rowid FROM search_word_chunks WHERE search_word_chunks MATCH ?1
             )",
        )?;
        for batch in words.chunks(FUZZY_WORDS_PER_QUERY) {
            run.check()?;
            let mut rows = stmt.query([fts5_any_of(batch.iter().map(String::as_str))])?;
            while let Some(row) = rows.next()? {
                let field = search_field_from_db_lossy(row.get_ref(3)?.as_str()?);
                chunks.insert(row.get(0)?, (row.get(1)?, row.get(2)?, field));
            }
        }
    }

    // The chunks of the cards of the route, by the slug their document was
    // written under, with what the index says of each card.
    let mut cards = SearchedCards::new(conn, tag)?;
    let mut chunks_by_slug = BTreeMap::<String, Vec<(i64, i64, SearchMatchField)>>::new();
    for (chunk_id, (block_id, slug, field)) in chunks {
        if cards.card(block_id)?.is_some() {
            chunks_by_slug
                .entry(slug)
                .or_default()
                .push((chunk_id, block_id, field));
        }
    }

    let typos: HashSet<&str> = words.iter().map(String::as_str).collect();
    let mut read_text = conn.prepare_cached("SELECT text FROM search_chunks WHERE id = ?1")?;
    let mut candidates = Vec::with_capacity(chunks_by_slug.len());
    for (index, (slug, mut chunks)) in chunks_by_slug.into_iter().enumerate() {
        if index % FUZZY_CARDS_PER_CHECK == 0 {
            run.check()?;
        }
        // The weightiest field first, then the smaller id: the chunk a pass
        // in the order of ids keeps, since it replaces a match only with one
        // of a weightier field.
        chunks.sort_by(|(left_id, _, left), (right_id, _, right)| {
            fuzzy_field_score(*right)
                .partial_cmp(&fuzzy_field_score(*left))
                .unwrap_or(Ordering::Equal)
                .then_with(|| left_id.cmp(right_id))
        });
        for (chunk_id, block_id, field) in chunks {
            let text: String = read_text.query_row([chunk_id], |row| row.get(0))?;
            if let Some(search_match) = fuzzy_search_match(field, &text, &terms, &typos) {
                let saved_at = cards.saved_at_under(block_id, &slug)?;
                candidates.push(FuzzyCandidate {
                    slug,
                    search_match,
                    saved_at,
                });
                break;
            }
        }
    }
    Ok(candidates)
}

/// What the index says of the cards chunks belong to: whether a card is a
/// card of the searched route, and its name and `saved_at`. Each card is
/// asked about once.
struct SearchedCards<'conn> {
    read: rusqlite::CachedStatement<'conn>,
    tag: Option<String>,
    known: std::collections::HashMap<i64, Option<(String, String)>>,
}

impl<'conn> SearchedCards<'conn> {
    fn new(conn: &'conn Connection, tag: Option<&str>) -> Result<Self> {
        let mut sql = String::from("SELECT b.slug, b.saved_at FROM blocks b");
        if tag.is_some() {
            sql.push_str(&collection_route_join_sql());
        }
        sql.push_str(" WHERE b.id = ?1 AND b.card_kind != 'channel'");
        if tag.is_some() {
            sql.push_str(" AND page.tag = ?2");
        }
        Ok(Self {
            read: conn.prepare_cached(&sql)?,
            tag: tag.map(ToOwned::to_owned),
            known: std::collections::HashMap::new(),
        })
    }

    /// The name and `saved_at` of the card `block_id`; `None` for a
    /// collection page and for a card outside the route.
    fn card(&mut self, block_id: i64) -> Result<Option<&(String, String)>> {
        if !self.known.contains_key(&block_id) {
            let read = |row: &rusqlite::Row<'_>| Ok((row.get(0)?, row.get(1)?));
            let card = match &self.tag {
                Some(tag) => self.read.query_row(params![block_id, tag], read),
                None => self.read.query_row([block_id], read),
            }
            .optional()?;
            self.known.insert(block_id, card);
        }
        Ok(self.known.get(&block_id).and_then(Option::as_ref))
    }

    /// `saved_at` of the card `block_id` if `slug`, the name its chunk was
    /// written under, is still the card's name.
    fn saved_at_under(&mut self, block_id: i64, slug: &str) -> Result<Option<String>> {
        Ok(self
            .card(block_id)?
            .filter(|(name, _)| name == slug)
            .map(|(_, saved_at)| saved_at.clone()))
    }
}

/// The dictionary words that are typos of one of `terms`, in the order of
/// the words. Only the words whose length allows the distance are read.
fn fuzzy_dictionary_words(conn: &Connection, terms: &[&String]) -> Result<Vec<String>> {
    let mut words = BTreeSet::new();
    let mut stmt =
        conn.prepare_cached("SELECT word FROM search_words WHERE chars BETWEEN ?1 AND ?2")?;
    for term in terms {
        let chars = term.chars().count();
        let threshold = fuzzy_distance_threshold(chars);
        let shortest = chars.saturating_sub(threshold).max(FUZZY_MIN_WORD_CHARS);
        let mut rows = stmt.query(params![shortest as i64, (chars + threshold) as i64])?;
        while let Some(row) = rows.next()? {
            let word = row.get_ref(0)?.as_str()?;
            if is_typo_of(word, term) {
                words.insert(word.to_string());
            }
        }
    }
    Ok(words.into_iter().collect())
}

/// Whether `word`, a word of a text, is a typo of `term`, a word of the
/// query: neither starts with the other (that is a prefix match, or none),
/// and their distance is at least one and at most what the term's length
/// allows.
fn is_typo_of(word: &str, term: &str) -> bool {
    if word.starts_with(term) || term.starts_with(word) {
        return false;
    }
    let distance = levenshtein(word, term);
    distance != 0 && distance <= fuzzy_distance_threshold(term.chars().count())
}

/// The match of a chunk's text with a typo of one of `terms`, if it has one.
fn fuzzy_search_match(
    field: SearchMatchField,
    text: &str,
    terms: &[&String],
    typos: &HashSet<&str>,
) -> Option<SearchMatch> {
    let (term, start, end) = first_typo(text, terms, typos)?;
    Some(if is_hidden_metadata_field(field) {
        hidden_metadata_search_match(
            field,
            text,
            SearchMatchKind::Fuzzy,
            fuzzy_field_score(field),
            Some(format!("fuzzy: {}", term)),
        )
    } else {
        let (excerpt, range) = excerpt_for_field(field, text, start, end);
        SearchMatch {
            field,
            kind: SearchMatchKind::Fuzzy,
            excerpt,
            ranges: vec![range],
            score: fuzzy_field_score(field),
            explanation: Some(format!("fuzzy: {}", term)),
        }
    })
}

/// The cards whose author or address holds a string of the query from the
/// start of a word, each with its match (SPEC_SEARCH.md, «Авторы и адреса»).
///
/// `search_metadata_terms` picks the chunks and [`first_match_range`] decides
/// over their text, as it did over every author and address chunk before.
fn metadata_candidates(
    conn: &Connection,
    tag: Option<&str>,
    plan: &SearchPlan,
) -> Result<Vec<FuzzyCandidate>> {
    let mut sql = String::from(
        "SELECT c.slug, c.field, c.text, b.slug, b.saved_at
         FROM search_chunks c
         INNER JOIN blocks b ON b.id = c.block_id",
    );
    if tag.is_some() {
        sql.push_str(&collection_route_join_sql());
    }
    sql.push_str(
        " WHERE c.id IN (
              SELECT rowid FROM search_metadata_terms WHERE search_metadata_terms MATCH ?1
          )
          AND b.card_kind != 'channel' AND c.field IN ('author', 'url')",
    );
    let mut params = vec![Value::Text(metadata_match_expression(plan))];
    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(&format!(" AND page.tag = ?{}", params.len()));
    }
    // A card's chunks in the order of their ids: the author before the
    // address, which the fold below relies on as the full pass did.
    sql.push_str(" ORDER BY c.id");

    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                search_field_from_db_lossy(&row.get::<_, String>(1)?),
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut by_slug = BTreeMap::<String, FuzzyCandidate>::new();
    for (slug, field, text, card_slug, saved_at) in rows {
        let Some((needle, start, end)) = first_match_range(&text, plan) else {
            continue;
        };
        let candidate = FuzzyCandidate {
            saved_at: (card_slug == slug).then_some(saved_at),
            slug: slug.clone(),
            search_match: hidden_metadata_search_match(
                field,
                &text,
                match_kind_for_text(&text, needle, start, end),
                metadata_field_score(field),
                match_explanation(needle),
            ),
        };
        by_slug
            .entry(slug)
            .and_modify(|existing| {
                if metadata_field_score(candidate.search_match.field)
                    > metadata_field_score(existing.search_match.field)
                {
                    *existing = candidate.clone();
                }
            })
            .or_insert(candidate);
    }

    Ok(by_slug.into_values().collect())
}

/// The FTS5 expression that picks the author and address chunks a string of
/// the query can stand in from the start of a word.
///
/// A string of the query is cut into words by the rule the chunks are cut
/// by. Where it stands in a text from the start of a word, every word of it
/// but the last is a whole word of the text and the last begins one; a chunk
/// with those words is picked, whatever their order. A chunk whose case does
/// not keep byte lengths is always picked ([`UNALIGNED_CASE_TERM`]).
fn metadata_match_expression(plan: &SearchPlan) -> String {
    let mut alternatives = vec![fts5_term(UNALIGNED_CASE_TERM)];
    for needle in plan.needles() {
        let words: Vec<(usize, &str)> = token_ranges(&needle.term).collect();
        let Some(((_, last), whole)) = words.split_last() else {
            continue;
        };
        let mut required: Vec<String> = whole.iter().map(|(_, word)| fts5_term(word)).collect();
        required.push(fts5_prefix_term(last));
        alternatives.push(format!("({})", required.join(" AND ")));
    }
    alternatives.join(" OR ")
}

/// One whole word as an FTS5 string.
fn fts5_term(term: &str) -> String {
    let escaped = term.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Any of `terms`, as whole words, as an FTS5 expression.
fn fts5_any_of<'a>(terms: impl Iterator<Item = &'a str>) -> String {
    terms.map(fts5_term).collect::<Vec<_>>().join(" OR ")
}

/// The first word of `text` that is a typo of one of `terms`: the term and
/// the word's byte range.
///
/// `typos` holds the dictionary words that are typos of the terms, so a word
/// of the text is one of them or is no typo. The range is taken in the
/// lowercased text and used in `text`; a word whose range does not fall on
/// character boundaries of `text` is passed over.
fn first_typo(text: &str, terms: &[&String], typos: &HashSet<&str>) -> Option<(String, usize, usize)> {
    let lower = text.to_lowercase();
    for (start, word) in token_ranges(&lower) {
        if !typos.contains(word) {
            continue;
        }
        let Some(term) = terms.iter().find(|term| is_typo_of(word, term)) else {
            continue;
        };
        let end = start + word.len();
        if text.is_char_boundary(start) && text.is_char_boundary(end) {
            return Some(((*term).to_string(), start, end));
        }
    }
    None
}

/// The words of `text` with their byte offsets: its runs of letters and
/// digits. Called over a lowercased text, this is the rule the dictionary is
/// built by and the typo-tolerant search has always read a text by.
fn token_ranges(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut chars = text.char_indices().peekable();
    std::iter::from_fn(move || {
        let start = loop {
            let (index, ch) = chars.next()?;
            if ch.is_alphanumeric() {
                break index;
            }
        };
        let mut end = text.len();
        while let Some(&(index, ch)) = chars.peek() {
            if !ch.is_alphanumeric() {
                end = index;
                break;
            }
            chars.next();
        }
        Some((start, &text[start..end]))
    })
}

fn fuzzy_distance_threshold(chars: usize) -> usize {
    if chars >= 6 {
        2
    } else {
        1
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b_chars = b.chars().collect::<Vec<_>>();
    let mut costs = (0..=b_chars.len()).collect::<Vec<_>>();
    for (i, a_ch) in a.chars().enumerate() {
        let mut previous = costs[0];
        costs[0] = i + 1;
        for (j, b_ch) in b_chars.iter().enumerate() {
            let temp = costs[j + 1];
            let substitution = previous + usize::from(a_ch != *b_ch);
            costs[j + 1] = (costs[j + 1] + 1).min(costs[j] + 1).min(substitution);
            previous = temp;
        }
    }
    costs[b_chars.len()]
}

fn excerpt_for_field(
    field: SearchMatchField,
    text: &str,
    start: usize,
    end: usize,
) -> (String, SearchTextRange) {
    match field {
        SearchMatchField::Title => (text.to_string(), full_text_search_range(text, start, end)),
        SearchMatchField::Description => excerpt_around_match(
            text,
            start,
            end,
            DESCRIPTION_EXCERPT_BEFORE_CHARS,
            DESCRIPTION_EXCERPT_AFTER_CHARS,
        ),
        SearchMatchField::Author | SearchMatchField::Url => {
            (text.to_string(), full_text_search_range(text, start, end))
        }
        SearchMatchField::Body | SearchMatchField::Semantic => excerpt_around_match(
            text,
            start,
            end,
            DEFAULT_EXCERPT_BEFORE_CHARS,
            DEFAULT_EXCERPT_AFTER_CHARS,
        ),
    }
}

fn fuzzy_field_score(field: SearchMatchField) -> f64 {
    match field {
        SearchMatchField::Title => TITLE_MATCH_WEIGHT,
        SearchMatchField::Description => DESCRIPTION_MATCH_WEIGHT,
        SearchMatchField::Author => AUTHOR_MATCH_WEIGHT,
        SearchMatchField::Body | SearchMatchField::Semantic => BODY_MATCH_WEIGHT,
        SearchMatchField::Url => URL_MATCH_WEIGHT,
    }
}

fn metadata_field_score(field: SearchMatchField) -> f64 {
    match field {
        SearchMatchField::Author => AUTHOR_MATCH_WEIGHT,
        SearchMatchField::Url => URL_MATCH_WEIGHT,
        _ => 0.0,
    }
}

fn is_hidden_metadata_field(field: SearchMatchField) -> bool {
    matches!(field, SearchMatchField::Author | SearchMatchField::Url)
}

fn hidden_metadata_search_match(
    field: SearchMatchField,
    text: &str,
    kind: SearchMatchKind,
    score: f64,
    explanation: Option<String>,
) -> SearchMatch {
    SearchMatch {
        field,
        kind,
        excerpt: text.to_string(),
        ranges: Vec::new(),
        score,
        explanation,
    }
}

fn fuse_candidates(
    conn: &Connection,
    lexical_blocks: Vec<LightBlock>,
    fuzzy_candidates: Vec<FuzzyCandidate>,
    semantic_candidates: Vec<SemanticCandidate>,
) -> Result<Vec<RankedBlock>> {
    let mut by_slug = BTreeMap::<String, RankedBlock>::new();

    for (index, block) in lexical_blocks.into_iter().enumerate() {
        let score = lexical_rank_score(block.search_match.as_ref(), index);
        by_slug.insert(block.slug.clone(), RankedBlock::read(block, score, true));
    }

    for candidate in fuzzy_candidates {
        if by_slug.contains_key(&candidate.slug) {
            continue;
        }
        let rank_score = lexical_rank_score(Some(&candidate.search_match), 0);
        match candidate.saved_at {
            Some(saved_at) => {
                by_slug.insert(
                    candidate.slug.clone(),
                    RankedBlock {
                        slug: candidate.slug,
                        saved_at,
                        rank_score,
                        lexical: true,
                        row: RankedRow::Unread(candidate.search_match),
                    },
                );
            }
            None => {
                if let Some(mut block) = load_light_block_by_slug(conn, &candidate.slug)? {
                    block.search_match = Some(candidate.search_match);
                    by_slug.insert(candidate.slug, RankedBlock::read(block, rank_score, true));
                }
            }
        }
    }

    for candidate in semantic_candidates {
        let semantic_score = semantic_rank_score(candidate.similarity);
        if let Some(existing) = by_slug.get_mut(&candidate.slug) {
            existing.rank_score += semantic_score * 0.35;
            // A card found through a chunk always has its match.
            if let RankedRow::Read(block) = &mut existing.row {
                if block.search_match.is_none() {
                    block.search_match = Some(semantic_search_match(&candidate));
                }
            }
            continue;
        }

        if let Some(mut block) = load_light_block_by_slug(conn, &candidate.slug)? {
            block.search_match = Some(semantic_search_match(&candidate));
            by_slug.insert(
                candidate.slug.clone(),
                RankedBlock::read(block, semantic_score, false),
            );
        }
    }

    Ok(by_slug.into_values().collect())
}

fn lexical_rank_score(search_match: Option<&SearchMatch>, lexical_index: usize) -> f64 {
    let Some(search_match) = search_match else {
        return 10.0 - lexical_index as f64 * 0.001;
    };
    let field_score = match search_match.field {
        SearchMatchField::Title => 120.0,
        SearchMatchField::Description => 88.0,
        SearchMatchField::Author => 84.0,
        SearchMatchField::Body => 72.0,
        SearchMatchField::Url => 56.0,
        SearchMatchField::Semantic => 0.0,
    };
    let kind_score = match search_match.kind {
        SearchMatchKind::Exact => 30.0,
        SearchMatchKind::Prefix => 22.0,
        SearchMatchKind::Alias => 18.0,
        SearchMatchKind::Fuzzy => 14.0,
        SearchMatchKind::Semantic => 0.0,
    };
    field_score + kind_score - lexical_index as f64 * 0.001
}

fn semantic_rank_score(similarity: f32) -> f64 {
    (similarity as f64) * 100.0
}

fn compare_ranked_blocks(a: &RankedBlock, b: &RankedBlock) -> Ordering {
    b.rank_score
        .partial_cmp(&a.rank_score)
        .unwrap_or(Ordering::Equal)
        .then_with(|| b.lexical.cmp(&a.lexical))
        .then_with(|| b.saved_at.cmp(&a.saved_at))
        .then_with(|| a.slug.cmp(&b.slug))
}

fn load_light_block_by_slug(conn: &Connection, slug: &str) -> Result<Option<LightBlock>> {
    // Column 22 is the preview error kind `light_block_from_row` reads by
    // position; this reader reports none, as before the collections column
    // followed it.
    let collections = collections_column_sql("blocks.id");
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT id, slug, block_type, card_kind, title, content_heading, display_title, COALESCE(fallback_label, slug), url, media_file,
                thumbnail, saved_at, width, height, author,
                CASE WHEN card_kind = 'article' THEN SUBSTR(body, 1, ?1) ELSE '' END,
                preview_text, first_image, media_urls, media_dimensions,
                CASE WHEN preview_state = 'ready'
                          AND preview_source_stamp = (
                              SELECT source.source_stamp FROM source_index_state source
                              WHERE source.slug = blocks.slug
                          )
                     THEN preview_manifest END,
                CASE WHEN preview_state = 'ready'
                          AND preview_source_stamp = (
                              SELECT source.source_stamp FROM source_index_state source
                              WHERE source.slug = blocks.slug
                          )
                     THEN feed_playback END,
                NULL,
                {collections}
         FROM blocks
         WHERE slug = ?2 AND card_kind != 'channel'"
    ))?;
    let block = stmt
        .query_row(
            params![LIGHT_BLOCK_BODY_PREVIEW_CHARS, slug],
            light_block_from_row,
        )
        .optional()?;
    Ok(block)
}

fn semantic_search_match(candidate: &SemanticCandidate) -> SearchMatch {
    SearchMatch {
        field: SearchMatchField::Semantic,
        kind: SearchMatchKind::Semantic,
        excerpt: candidate.text.clone(),
        ranges: Vec::new(),
        score: candidate.similarity as f64,
        explanation: Some(format!(
            "semantic: {} ({:.3})",
            SEARCH_EMBEDDING_MODEL_ID, candidate.similarity
        )),
    }
}

impl SearchPlan {
    fn from_query(query: &str) -> Option<Self> {
        let literal_query = query.trim().to_string();
        let mut literal_terms = Vec::new();
        let mut groups = Vec::new();
        for raw in query.split_whitespace() {
            if let Some(term) = normalize_query_term(raw) {
                if !is_stop_word(&term) {
                    literal_terms.push(term);
                }
            }
            if let Some(group) = search_term_group(raw) {
                groups.push(group);
            }
        }

        let plan = Self {
            literal_query,
            literal_terms,
            groups,
        };

        (!plan.groups.is_empty() && plan.meaningful_char_count() >= SEARCH_MIN_QUERY_CHARS)
            .then_some(plan)
    }

    fn candidate_fts5_query(&self) -> String {
        let mut terms = Vec::<String>::new();
        for needle in self.needles() {
            if !terms.iter().any(|term| term == &needle.term) {
                terms.push(needle.term.clone());
            }
        }
        fts5_or_query(terms.iter().map(String::as_str))
    }

    fn required_group_queries(&self) -> Vec<String> {
        self.groups
            .iter()
            .map(SearchTermGroup::fts5_query)
            .collect()
    }

    /// The FTS5 expression the lexical search finds its cards by, and the
    /// group expressions each of them must match besides.
    ///
    /// A card must match every group of the query. With one group, or with
    /// groups that share no term, that is one expression: the groups joined
    /// by `AND`. It finds the cards the expression of every term joined by
    /// `OR` finds once they are narrowed to each group, and `bm25` gives them
    /// the same scores: a score sums over the phrases of the expression, and
    /// the phrases are the same terms in the same order.
    ///
    /// Groups that share a term keep the `OR` expression, where the shared
    /// term stands once, and the narrowing by group: joined by `AND` the term
    /// would stand twice and count twice in the score.
    fn lexical_fts5_queries(&self) -> (String, Vec<String>) {
        let groups = self.required_group_queries();
        let mut seen = BTreeSet::new();
        let shares_a_term = !self.needles().all(|needle| seen.insert(needle.term.as_str()));
        if shares_a_term {
            return (self.candidate_fts5_query(), groups);
        }
        let expression = if groups.len() == 1 {
            groups.into_iter().next().unwrap_or_default()
        } else {
            groups
                .iter()
                .map(|group| format!("({group})"))
                .collect::<Vec<_>>()
                .join(" AND ")
        };
        (expression, Vec::new())
    }

    fn needles(&self) -> impl Iterator<Item = &SearchNeedle> {
        self.groups.iter().flat_map(|group| group.needles.iter())
    }

    fn allows_semantic_only(&self) -> bool {
        self.meaningful_char_count() >= SEMANTIC_MIN_QUERY_CHARS
            && (self.literal_terms.len() > 1
                || self
                    .literal_terms
                    .iter()
                    .any(|term| term.chars().any(is_cyrillic)))
    }

    fn meaningful_char_count(&self) -> usize {
        self.literal_terms
            .iter()
            .map(|term| term.chars().filter(|ch| ch.is_alphanumeric()).count())
            .sum()
    }
}

impl SearchTermGroup {
    fn fts5_query(&self) -> String {
        fts5_or_query(self.needles.iter().map(|needle| needle.term.as_str()))
    }
}

fn fts5_or_query<'a>(terms: impl Iterator<Item = &'a str>) -> String {
    terms.map(fts5_prefix_term).collect::<Vec<_>>().join(" OR ")
}

fn search_term_group(raw: &str) -> Option<SearchTermGroup> {
    let term = normalize_query_term(raw)?;
    if is_stop_word(&term) {
        return None;
    }

    let mut needles = Vec::<SearchNeedle>::new();
    push_unique_needle(&mut needles, term.clone(), SearchMatchKind::Prefix);

    if let Some(transliterated) = transliterate_cyrillic_to_latin(&term) {
        push_unique_needle(&mut needles, transliterated, SearchMatchKind::Alias);
    }

    for alias in aliases_for_term(&term) {
        push_unique_needle(&mut needles, alias.to_string(), SearchMatchKind::Alias);
    }

    Some(SearchTermGroup { needles })
}

fn normalize_query_term(raw: &str) -> Option<String> {
    let normalized = raw
        .trim_matches(|ch: char| !ch.is_alphanumeric())
        .to_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn push_unique_needle(needles: &mut Vec<SearchNeedle>, term: String, kind: SearchMatchKind) {
    if term.is_empty() || needles.iter().any(|needle| needle.term == term) {
        return;
    }
    needles.push(SearchNeedle { term, kind });
}

fn fts5_prefix_term(term: &str) -> String {
    let escaped = term.replace('"', "\"\"");
    format!("\"{escaped}\"*")
}

fn is_stop_word(term: &str) -> bool {
    matches!(
        term,
        "a" | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "by"
            | "for"
            | "from"
            | "in"
            | "is"
            | "of"
            | "on"
            | "or"
            | "the"
            | "to"
            | "with"
            | "а"
            | "без"
            | "в"
            | "во"
            | "для"
            | "и"
            | "из"
            | "к"
            | "как"
            | "на"
            | "о"
            | "об"
            | "от"
            | "по"
            | "с"
            | "со"
            | "у"
            | "что"
            | "это"
    )
}

fn aliases_for_term(term: &str) -> &'static [&'static str] {
    match term {
        "mine" => &["майн"],
        "майн" | "маин" | "майне" | "майна" => &["mine"],
        "память" | "памяти" | "памятью" | "воспоминание" | "воспоминания" => {
            &["memory", "memories", "remember"]
        }
        "memory" | "memories" => &["память", "воспоминания"],
        "стая" | "стаи" | "стаю" | "стаей" => &["flock"],
        "flock" => &["стая"],
        "птица" | "птицы" | "птиц" | "птицей" => &["bird", "birds"],
        "bird" | "birds" => &["птица", "птицы"],
        "нейрон" | "нейроны" | "нейронов" => &["neuron", "neurons"],
        "neuron" | "neurons" => &["нейрон", "нейроны"],
        "сеть" | "сети" => &["network"],
        "network" => &["сеть"],
        "поиск" | "искать" | "найти" => &["search", "find"],
        "search" | "find" => &["поиск", "найти"],
        "коллекция" | "коллекции" | "канал" | "каналы" => {
            &["collection", "channel"]
        }
        "collection" | "channel" => &["коллекция", "канал"],
        "визуальный" | "визуальная" | "визуальное" => &["visual"],
        "visual" => &["визуальный", "визуальная"],
        "навигация" | "навигации" => &["navigation"],
        "navigation" => &["навигация"],
        _ => &[],
    }
}

fn transliterate_cyrillic_to_latin(term: &str) -> Option<String> {
    if !term.chars().any(is_cyrillic) {
        return None;
    }
    let mut out = String::new();
    for ch in term.chars() {
        let mapped = match ch {
            'а' => "a",
            'б' => "b",
            'в' => "v",
            'г' => "g",
            'д' => "d",
            'е' | 'э' => "e",
            'ё' => "yo",
            'ж' => "zh",
            'з' => "z",
            'и' | 'й' => "i",
            'к' => "k",
            'л' => "l",
            'м' => "m",
            'н' => "n",
            'о' => "o",
            'п' => "p",
            'р' => "r",
            'с' => "s",
            'т' => "t",
            'у' => "u",
            'ф' => "f",
            'х' => "h",
            'ц' => "ts",
            'ч' => "ch",
            'ш' => "sh",
            'щ' => "sch",
            'ы' => "y",
            'ю' => "yu",
            'я' => "ya",
            'ь' | 'ъ' => "",
            _ => return None,
        };
        out.push_str(mapped);
    }
    (!out.is_empty() && out != term).then_some(out)
}

fn is_cyrillic(ch: char) -> bool {
    ('\u{0400}'..='\u{04FF}').contains(&ch)
}

fn build_search_match(
    block: &LightBlock,
    description: Option<&str>,
    body: &str,
    plan: &SearchPlan,
) -> Option<SearchMatch> {
    // Every result row shows its file name, social cards included, so a match
    // in the name is always a visible one. The H1 is found in the body below.
    if let Some(file_name) = search_file_name(&block.slug) {
        if let Some((needle, start, end)) = first_match_range(&file_name, plan) {
            return Some(SearchMatch {
                field: SearchMatchField::Title,
                kind: match_kind_for_text(&file_name, needle, start, end),
                ranges: vec![full_text_search_range(&file_name, start, end)],
                excerpt: file_name,
                score: TITLE_MATCH_WEIGHT,
                explanation: match_explanation(needle),
            });
        }
    }

    if let Some(description) = description.and_then(non_empty_trimmed) {
        let normalized = normalize_excerpt_text(description);
        if let Some((needle, start, end)) = first_match_range(&normalized, plan) {
            let (excerpt, range) = excerpt_around_match(
                &normalized,
                start,
                end,
                DESCRIPTION_EXCERPT_BEFORE_CHARS,
                DESCRIPTION_EXCERPT_AFTER_CHARS,
            );
            return Some(SearchMatch {
                field: SearchMatchField::Description,
                kind: match_kind_for_text(&normalized, needle, start, end),
                excerpt,
                ranges: vec![range],
                score: DESCRIPTION_MATCH_WEIGHT,
                explanation: match_explanation(needle),
            });
        }
    }

    let normalized_body = normalize_excerpt_text(body);
    if let Some((needle, start, end)) = first_match_range(&normalized_body, plan) {
        let (excerpt, range) = excerpt_around_match(
            &normalized_body,
            start,
            end,
            DEFAULT_EXCERPT_BEFORE_CHARS,
            DEFAULT_EXCERPT_AFTER_CHARS,
        );
        return Some(SearchMatch {
            field: SearchMatchField::Body,
            kind: match_kind_for_text(&normalized_body, needle, start, end),
            excerpt,
            ranges: vec![range],
            score: BODY_MATCH_WEIGHT,
            explanation: match_explanation(needle),
        });
    }

    None
}

fn match_kind_for_text(
    text: &str,
    needle: &SearchNeedle,
    start: usize,
    end: usize,
) -> SearchMatchKind {
    if needle.kind == SearchMatchKind::Alias {
        return SearchMatchKind::Alias;
    }
    let token = &text[start..end];
    if token.eq_ignore_ascii_case(&needle.term) && is_token_end(text, end) {
        SearchMatchKind::Exact
    } else {
        SearchMatchKind::Prefix
    }
}

fn match_explanation(needle: &SearchNeedle) -> Option<String> {
    (needle.kind == SearchMatchKind::Alias).then(|| format!("alias: {}", needle.term))
}

fn full_text_search_range(text: &str, start: usize, end: usize) -> SearchTextRange {
    SearchTextRange {
        start: byte_to_char_index(text, start),
        end: byte_to_char_index(text, end),
    }
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn normalize_excerpt_text(input: &str) -> String {
    // Share the preview-text plain-text flattening so search excerpts never
    // surface raw markdown: `#` headings and Obsidian `![[name]]` embeds (which
    // article clips place at the top of the body) must not leak into the
    // result preview. Matching still runs over this flattened text, so excerpt
    // and highlight stay computed on one representation.
    crate::domain::block::markdown_to_plain_text(input)
}

fn first_match_range<'a>(
    text: &str,
    plan: &'a SearchPlan,
) -> Option<(&'a SearchNeedle, usize, usize)> {
    let haystack = text.to_lowercase();
    plan.needles()
        .filter_map(|needle| {
            first_prefix_token_match_range(text, &haystack, &needle.term)
                .map(|(start, end)| (needle, start, end))
        })
        .min_by_key(|(_, start, end)| (*start, usize::MAX - (*end - *start)))
}

fn first_prefix_token_match_range(
    text: &str,
    haystack: &str,
    term: &str,
) -> Option<(usize, usize)> {
    let mut search_start = 0;
    while search_start < haystack.len() {
        let relative_start = haystack[search_start..].find(term)?;
        let start = search_start + relative_start;
        let end = start + term.len();
        if text.is_char_boundary(start) && text.is_char_boundary(end) && is_token_start(text, start)
        {
            return Some((start, end));
        }
        search_start = next_char_boundary(haystack, start + 1);
    }
    None
}

fn is_token_start(text: &str, start: usize) -> bool {
    start == 0
        || text[..start]
            .chars()
            .next_back()
            .is_none_or(|ch| !ch.is_alphanumeric())
}

fn is_token_end(text: &str, end: usize) -> bool {
    end >= text.len()
        || text[end..]
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_alphanumeric())
}

fn next_char_boundary(text: &str, start: usize) -> usize {
    let mut next = start.min(text.len());
    while next < text.len() && !text.is_char_boundary(next) {
        next += 1;
    }
    next
}

fn excerpt_around_match(
    text: &str,
    start: usize,
    end: usize,
    before_chars: usize,
    after_chars: usize,
) -> (String, SearchTextRange) {
    let start_char = byte_to_char_index(text, start);
    let end_char = byte_to_char_index(text, end);
    let total_chars = text.chars().count();
    let window_start_char = start_char.saturating_sub(before_chars);
    let window_end_char = (end_char + after_chars).min(total_chars);
    let window_start = byte_index_for_char(text, window_start_char);
    let window_end = byte_index_for_char(text, window_end_char);
    let prefix = if window_start > 0 { "..." } else { "" };
    let suffix = if window_end < text.len() { "..." } else { "" };
    let mut excerpt = String::new();
    excerpt.push_str(prefix);
    excerpt.push_str(&text[window_start..window_end]);
    excerpt.push_str(suffix);
    let prefix_chars = prefix.chars().count();
    let adjusted_start = prefix_chars + start_char.saturating_sub(window_start_char);
    let adjusted_end = prefix_chars + end_char.saturating_sub(window_start_char);
    (
        excerpt,
        SearchTextRange {
            start: adjusted_start,
            end: adjusted_end,
        },
    )
}

fn byte_to_char_index(text: &str, byte_index: usize) -> usize {
    text[..byte_index].chars().count()
}

fn byte_index_for_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

fn search_field_to_db(field: SearchMatchField) -> &'static str {
    match field {
        SearchMatchField::Title => "title",
        SearchMatchField::Description => "description",
        SearchMatchField::Author => "author",
        SearchMatchField::Body => "body",
        SearchMatchField::Url => "url",
        SearchMatchField::Semantic => "semantic",
    }
}

fn search_field_from_db_lossy(value: &str) -> SearchMatchField {
    match value {
        "title" => SearchMatchField::Title,
        "description" => SearchMatchField::Description,
        "author" => SearchMatchField::Author,
        "body" => SearchMatchField::Body,
        "url" => SearchMatchField::Url,
        _ => SearchMatchField::Semantic,
    }
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        blob.extend_from_slice(&value.to_le_bytes());
    }
    blob
}

fn blob_to_vector(blob: &[u8]) -> Option<Vec<f32>> {
    if !blob.len().is_multiple_of(4) {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect(),
    )
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (left, right) in a.iter().zip(b.iter()) {
        dot += left * right;
        norm_a += left * left;
        norm_b += right * right;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

#[cfg(all(not(target_os = "ios"), not(test)))]
fn production_semantic_provider() -> Option<&'static dyn SemanticEmbeddingProvider> {
    Some(&FASTEMBED_QUERY_PROVIDER)
}

#[cfg(any(target_os = "ios", test))]
fn production_semantic_provider() -> Option<&'static dyn SemanticEmbeddingProvider> {
    None
}

#[cfg(all(not(target_os = "ios"), not(test)))]
struct FastEmbedSemanticProvider {
    allow_initialize: bool,
}

#[cfg(all(not(target_os = "ios"), not(test)))]
static FASTEMBED_QUERY_PROVIDER: FastEmbedSemanticProvider = FastEmbedSemanticProvider {
    allow_initialize: false,
};

#[cfg(all(not(target_os = "ios"), not(test)))]
static FASTEMBED_WARM_PROVIDER: FastEmbedSemanticProvider = FastEmbedSemanticProvider {
    allow_initialize: true,
};

#[cfg(all(not(target_os = "ios"), not(test)))]
static FASTEMBED_MODEL: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();

/// The turns at the one model every open space shares.
#[cfg(all(not(target_os = "ios"), not(test)))]
static FASTEMBED_GATE: OnceLock<EmbeddingGate> = OnceLock::new();

#[cfg(all(not(target_os = "ios"), not(test)))]
impl FastEmbedSemanticProvider {
    fn embed_with_prefix(&self, prefix: &str, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let usage = if prefix == "query" {
            EmbeddingUse::Query
        } else {
            EmbeddingUse::Passages
        };
        let _turn = FASTEMBED_GATE.get_or_init(EmbeddingGate::default).acquire(usage)?;
        let model = FASTEMBED_MODEL.get_or_init(|| Mutex::new(None));
        let mut model = model
            .lock()
            .map_err(|_| anyhow::anyhow!("semantic model mutex poisoned"))?;
        if model.is_none() {
            if !self.allow_initialize {
                anyhow::bail!("semantic model is not ready");
            }
            let cache_dir = fastembed_cache_dir();
            std::fs::create_dir_all(&cache_dir).with_context(|| {
                format!(
                    "failed to create fastembed cache directory {}",
                    cache_dir.display()
                )
            })?;
            *model = Some(TextEmbedding::try_new(
                InitOptions::new(EmbeddingModel::MultilingualE5Small)
                    .with_cache_dir(cache_dir)
                    .with_show_download_progress(false),
            )?);
        }
        let prefixed = texts
            .iter()
            .map(|text| format!("{prefix}: {text}"))
            .collect::<Vec<_>>();
        Ok(model
            .as_mut()
            .expect("fastembed model is initialized")
            .embed(prefixed, Some(SEARCH_EMBEDDING_BATCH))?)
    }
}

/// Longest a search waits for the embedding model while another space warms
/// or indexes with it (SPEC_TABS.md, В13). Past it the search answers
/// without the semantic layer.
pub const EMBEDDING_MODEL_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Who asks for the embedding model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingUse {
    /// A search a person waits on: served first, waits a bounded time.
    Query,
    /// Background warming and indexing: waits as long as it takes and lets
    /// every waiting query go first.
    Passages,
}

/// The model was busy past [`EMBEDDING_MODEL_WAIT`].
#[derive(Debug, thiserror::Error)]
#[error("the semantic model is busy with another space")]
pub struct EmbeddingBusy;

#[derive(Debug, Default)]
struct GateState {
    busy: bool,
    queries_waiting: usize,
}

/// One embedding model shared by every open space, used in turn instead of
/// failing whoever comes second (В13).
#[derive(Debug, Default)]
pub struct EmbeddingGate {
    state: std::sync::Mutex<GateState>,
    released: std::sync::Condvar,
}

/// A turn at the model; the next one starts when it drops.
#[derive(Debug)]
pub struct EmbeddingTurn<'a> {
    gate: &'a EmbeddingGate,
}

impl Drop for EmbeddingTurn<'_> {
    fn drop(&mut self) {
        self.gate
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .busy = false;
        self.gate.released.notify_all();
    }
}

impl EmbeddingGate {
    /// Wait for a turn at the model.
    ///
    /// # Errors
    /// A query still waiting after [`EMBEDDING_MODEL_WAIT`].
    pub fn acquire(&self, usage: EmbeddingUse) -> std::result::Result<EmbeddingTurn<'_>, EmbeddingBusy> {
        self.acquire_within(usage, EMBEDDING_MODEL_WAIT)
    }

    fn acquire_within(
        &self,
        usage: EmbeddingUse,
        wait: std::time::Duration,
    ) -> std::result::Result<EmbeddingTurn<'_>, EmbeddingBusy> {
        let deadline = std::time::Instant::now() + wait;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if usage == EmbeddingUse::Query {
            state.queries_waiting += 1;
        }
        loop {
            let blocked = state.busy
                || (usage == EmbeddingUse::Passages && state.queries_waiting > 0);
            if !blocked {
                if usage == EmbeddingUse::Query {
                    state.queries_waiting -= 1;
                }
                state.busy = true;
                return Ok(EmbeddingTurn { gate: self });
            }
            if usage == EmbeddingUse::Passages {
                state = self
                    .released
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                continue;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                state.queries_waiting -= 1;
                drop(state);
                // A passage batch held back for this query may go now.
                self.released.notify_all();
                return Err(EmbeddingBusy);
            }
            state = self
                .released
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }
}

#[cfg(all(not(target_os = "ios"), not(test)))]
fn fastembed_cache_dir() -> PathBuf {
    if let Some(cache_dir) = std::env::var_os("FASTEMBED_CACHE_DIR") {
        return PathBuf::from(cache_dir);
    }

    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.mine.app")
            .join("cache")
            .join("fastembed");
    }

    std::env::temp_dir()
        .join("com.mine.app")
        .join("cache")
        .join("fastembed")
}

#[cfg(all(not(target_os = "ios"), not(test)))]
impl SemanticEmbeddingProvider for FastEmbedSemanticProvider {
    fn model_id(&self) -> &str {
        SEARCH_EMBEDDING_MODEL_ID
    }

    fn dimension(&self) -> usize {
        SEARCH_EMBEDDING_DIM
    }

    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed_with_prefix("passage", texts)
    }

    fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let embeddings = self.embed_with_prefix("query", &[query.to_string()])?;
        embeddings
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("fastembed returned no query embedding"))
    }
}

#[cfg(test)]
mod embedding_gate_tests {
    use super::{EmbeddingGate, EmbeddingUse};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn a_waiting_query_goes_before_a_waiting_passage_batch() {
        let gate = Arc::new(EmbeddingGate::default());
        let warming = gate.acquire(EmbeddingUse::Passages).unwrap();
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));

        let passages = {
            let (gate, order) = (Arc::clone(&gate), Arc::clone(&order));
            std::thread::spawn(move || {
                let _turn = gate.acquire(EmbeddingUse::Passages).unwrap();
                order.lock().unwrap().push("passages");
            })
        };
        let query = {
            let (gate, order) = (Arc::clone(&gate), Arc::clone(&order));
            std::thread::spawn(move || {
                let _turn = gate.acquire(EmbeddingUse::Query).unwrap();
                order.lock().unwrap().push("query");
            })
        };
        // The query waits for its turn before the model is free: the order
        // below is decided by the gate, not by which thread runs first.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while gate.state.lock().unwrap().queries_waiting == 0 {
            assert!(std::time::Instant::now() < deadline, "the query never asked for a turn");
            std::thread::yield_now();
        }
        drop(warming);
        query.join().unwrap();
        passages.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["query", "passages"]);
    }

    #[test]
    fn a_query_gives_up_after_the_wait_and_the_model_stays_usable() {
        let gate = EmbeddingGate::default();
        let held = gate.acquire(EmbeddingUse::Passages).unwrap();
        let started = Instant::now();
        assert!(gate
            .acquire_within(EmbeddingUse::Query, Duration::from_millis(40))
            .is_err());
        assert!(started.elapsed() >= Duration::from_millis(40));
        drop(held);
        assert!(gate.acquire(EmbeddingUse::Query).is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::storage::db;
    use crate::storage::index::{upsert_block, SearchMatchField, SearchMatchKind};

    struct FakeSemanticProvider;
    struct PanicSemanticProvider;

    impl SemanticEmbeddingProvider for FakeSemanticProvider {
        fn model_id(&self) -> &str {
            "test-semantic"
        }

        fn dimension(&self) -> usize {
            3
        }

        fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            Ok(texts.iter().map(|text| fake_embedding(text)).collect())
        }

        fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
            Ok(fake_embedding(query))
        }
    }

    impl SemanticEmbeddingProvider for PanicSemanticProvider {
        fn model_id(&self) -> &str {
            "panic-semantic"
        }

        fn dimension(&self) -> usize {
            3
        }

        fn embed_passages(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>> {
            panic!("single-token Latin search must not warm semantic embeddings")
        }

        fn embed_query(&self, _query: &str) -> Result<Vec<f32>> {
            panic!("single-token Latin search must not run semantic query")
        }
    }

    fn fake_embedding(text: &str) -> Vec<f32> {
        let lower = text.to_lowercase();
        if lower.contains("memory")
            || lower.contains("experience")
            || lower.contains("remember")
            || lower.contains("память")
            || lower.contains("воспомин")
        {
            vec![1.0, 0.0, 0.0]
        } else if lower.contains("coffee") || lower.contains("кофе") {
            vec![0.0, 1.0, 0.0]
        } else {
            vec![0.0, 0.0, 1.0]
        }
    }

    fn test_conn() -> Connection {
        db::open_memory().unwrap()
    }

    fn make_block_full(
        slug: &str,
        block_type: &str,
        title: Option<&str>,
        saved_at: &str,
        tags: &[&str],
        body: &str,
    ) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::from_str(block_type).unwrap(),
                title: title.map(ToOwned::to_owned),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new(saved_at).unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: body.to_string(),
        }
    }

    #[test]
    fn plan_expands_russian_memory_phrase_to_english_aliases() {
        let plan = SearchPlan::from_query("память как стая птиц").unwrap();
        assert_eq!(plan.groups.len(), 3);
        let query = plan.candidate_fts5_query();
        assert!(query.contains("\"memory\"*"));
        assert!(query.contains("\"flock\"*"));
        assert!(query.contains("\"birds\"*"));
        assert!(!query.contains("как"));
    }

    #[test]
    fn cyrillic_mine_query_expands_to_product_alias() {
        let plan = SearchPlan::from_query("майн").unwrap();
        let query = plan.candidate_fts5_query();
        assert!(query.contains("\"mine\"*"));
    }

    #[test]
    fn prefix_match_highlights_only_the_typed_prefix() {
        let text = "someone called Zizako Mindo inked over blank postcards";
        let plan = SearchPlan::from_query("mi").unwrap();
        let (_needle, start, end) = first_match_range(text, &plan).unwrap();
        assert_eq!(&text[start..end], "Mi");
    }

    #[test]
    fn sync_search_documents_persists_chunks_and_hashes() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-note",
                "article",
                Some("Memory Note"),
                "2026-01-01T00:00:00Z",
                &["research"],
                "A short note about memory.",
            ),
            None,
        )
        .unwrap();

        let changed = sync_search_documents(&conn).unwrap();
        assert_eq!(changed, 2);

        let chunk_count: i64 = conn
            .query_row("SELECT count(*) FROM search_chunks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(chunk_count, 2);

        let unchanged = sync_search_documents(&conn).unwrap();
        assert_eq!(unchanged, 0);
    }

    /// The revisions the sync compares: the count of the changes a document
    /// depends on, and the count the documents were last compared at.
    fn source_revisions(conn: &Connection) -> (i64, Option<i64>) {
        conn.query_row(
            "SELECT source_revision, synced_source_revision FROM search_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    fn chunk_text(conn: &Connection, slug: &str) -> String {
        conn.query_row(
            "SELECT group_concat(text, ' ') FROM search_chunks WHERE slug = ?1",
            [slug],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_search_reads_only_the_texts_that_changed() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open_or_create(&dir.path().join("index.db")).unwrap();
        for (slug, body) in [("one", "First body."), ("two", "Second body.")] {
            upsert_block(
                &conn,
                &make_block_full(slug, "article", Some(slug), "2026-01-01T00:00:00Z", &[], body),
                None,
            )
            .unwrap();
        }
        assert_eq!(stale_search_documents(&conn).unwrap().len(), 2);
        assert!(sync_search_documents(&conn).unwrap() > 0);

        // Nothing changed: no document is stale, and nothing is compared.
        assert!(stale_search_documents(&conn).unwrap().is_empty());
        let (source, synced) = source_revisions(&conn);
        assert_eq!(synced, Some(source));
        assert_eq!(sync_search_documents(&conn).unwrap(), 0);

        // One card changed: only its document is stale and rebuilt.
        upsert_block(
            &conn,
            &make_block_full("two", "article", Some("two"), "2026-01-01T00:00:00Z", &[], "Edited body."),
            None,
        )
        .unwrap();
        let two: i64 = conn
            .query_row("SELECT id FROM blocks WHERE slug = 'two'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stale_search_documents(&conn).unwrap(), vec![two]);
        assert!(sync_search_documents(&conn).unwrap() > 0);
        assert!(chunk_text(&conn, "two").contains("Edited"));
        assert!(stale_search_documents(&conn).unwrap().is_empty());
    }

    /// П2: what is synced is written in the index, not kept by the process.
    /// A new connection to an index whose documents are written compares
    /// nothing and reads no body: a body changed behind its hash, which only
    /// a read of the body could notice, leaves the document as it is.
    #[test]
    fn a_new_connection_reads_no_body_of_a_synced_document() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.db");
        {
            let conn = db::open_or_create(&index).unwrap();
            upsert_block(
                &conn,
                &make_block_full("one", "article", Some("one"), "2026-01-01T00:00:00Z", &[], "First body."),
                None,
            )
            .unwrap();
            assert!(sync_search_documents(&conn).unwrap() > 0);
            conn.execute("UPDATE blocks SET body = 'Other text.' WHERE slug = 'one'", [])
                .unwrap();
        }

        let conn = db::open_or_create(&index).unwrap();
        let (source, synced) = source_revisions(&conn);
        assert_eq!(synced, Some(source));
        assert_eq!(sync_search_documents(&conn).unwrap(), 0);
        crate::storage::search_projection::read_search_snapshot(&conn, None, "body", 5, None)
            .unwrap();
        assert!(chunk_text(&conn, "one").contains("First body."));
    }

    /// A write of a field no document depends on (a preview, a collection)
    /// does not make the next search compare the stamps.
    #[test]
    fn a_change_outside_the_stamp_fields_leaves_the_documents_synced() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full("one", "article", Some("one"), "2026-01-01T00:00:00Z", &[], "First body."),
            None,
        )
        .unwrap();
        sync_search_documents(&conn).unwrap();
        let synced = source_revisions(&conn);

        conn.execute("UPDATE blocks SET preview_state = 'ready', thumb_mtime = 7 WHERE slug = 'one'", [])
            .unwrap();
        // The same card indexed again with nothing changed.
        upsert_block(
            &conn,
            &make_block_full("one", "article", Some("one"), "2026-01-01T00:00:00Z", &["research"], "First body."),
            None,
        )
        .unwrap();
        assert_eq!(source_revisions(&conn), synced);

        conn.execute("UPDATE blocks SET author = 'Someone' WHERE slug = 'one'", [])
            .unwrap();
        let (source, synced_at) = source_revisions(&conn);
        assert_ne!(Some(source), synced_at);
        assert_eq!(sync_search_documents(&conn).unwrap(), 3);
    }

    #[test]
    fn synced_documents_count_only_once_committed() {
        // Б2.5: a sync rolled back with its transaction is not counted as
        // done. The synced revision is written in the same transaction, so
        // it goes back with the documents and the next sync writes them.
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open_or_create(&dir.path().join("index.db")).unwrap();
        upsert_block(
            &conn,
            &make_block_full("one", "article", Some("one"), "2026-01-01T00:00:00Z", &[], "First body."),
            None,
        )
        .unwrap();

        conn.execute_batch("SAVEPOINT pending_sync").unwrap();
        assert!(sync_search_documents(&conn).unwrap() > 0);
        let (source, synced) = source_revisions(&conn);
        assert_eq!(synced, Some(source));
        conn.execute_batch("ROLLBACK TO SAVEPOINT pending_sync; RELEASE SAVEPOINT pending_sync;")
            .unwrap();
        assert_eq!(source_revisions(&conn).1, None);

        crate::storage::search_projection::read_search_snapshot(&conn, None, "first", 5, None)
            .unwrap();
        let (source, synced) = source_revisions(&conn);
        assert_eq!(synced, Some(source));
        assert!(chunk_text(&conn, "one").contains("First body"));
    }

    /// A document written before the word indexes existed has no stamp. The
    /// first sync keeps its chunks, and with them their vectors, and writes
    /// their words; a typo then finds the card.
    #[test]
    fn a_document_without_a_stamp_keeps_its_chunks_and_gets_its_words() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-body",
                "article",
                None,
                "2026-01-01T00:00:00Z",
                &[],
                "This paragraph discusses memory machines.",
            ),
            None,
        )
        .unwrap();
        sync_search_documents(&conn).unwrap();
        let chunk_ids = |conn: &Connection| -> Vec<i64> {
            conn.prepare("SELECT id FROM search_chunks ORDER BY id")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let chunks = chunk_ids(&conn);
        // The index as version 7 left it: documents and chunks, no stamps,
        // no words, never compared.
        conn.execute_batch(
            "UPDATE search_document_state SET source_stamp = NULL;
             UPDATE search_state SET synced_source_revision = NULL;
             DELETE FROM search_words;
             INSERT INTO search_word_chunks(search_word_chunks) VALUES ('delete-all');
             INSERT INTO search_metadata_terms(search_metadata_terms) VALUES ('delete-all');",
        )
        .unwrap();

        assert_eq!(sync_search_documents(&conn).unwrap(), 0);

        assert_eq!(chunk_ids(&conn), chunks);
        assert!(stale_search_documents(&conn).unwrap().is_empty());
        let (blocks, _) = search_grid_blocks_with_provider(&conn, None, 0, 20, "memroy", None).unwrap();
        assert_eq!(slugs_of(&blocks), vec!["memory-body"]);
    }

    /// A deleted card takes its chunks out of both word indexes, and the
    /// words of a rewritten document replace the old ones.
    #[test]
    fn the_word_indexes_follow_the_chunks() {
        let conn = test_conn();
        let mut block = make_block_full(
            "lighthouse",
            "article",
            None,
            "2026-01-01T00:00:00Z",
            &[],
            "A lighthouse keeper writes letters.",
        );
        block.frontmatter.author = Some("Virginia Woolf".to_string());
        upsert_block(&conn, &block, None).unwrap();
        sync_search_documents(&conn).unwrap();
        let chunks_with = |table: &str, word: &str| -> i64 {
            conn.query_row(
                &format!("SELECT count(*) FROM {table} WHERE {table} MATCH ?1"),
                [fts5_term(word)],
                |row| row.get(0),
            )
            .unwrap()
        };
        // The dictionary holds the words of four characters or more; the
        // author index holds every word of the author.
        let dictionary: Vec<String> = conn
            .prepare("SELECT word FROM search_words ORDER BY word")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            dictionary,
            vec!["keeper", "letters", "lighthouse", "virginia", "woolf", "writes"]
        );
        assert_eq!(chunks_with("search_word_chunks", "lighthouse"), 2);
        assert_eq!(chunks_with("search_metadata_terms", "woolf"), 1);
        assert_eq!(chunks_with("search_metadata_terms", "lighthouse"), 0);

        block.body = "A harbour keeper writes letters.".to_string();
        upsert_block(&conn, &block, None).unwrap();
        sync_search_documents(&conn).unwrap();
        // The file name still holds the word; the body no longer does.
        assert_eq!(chunks_with("search_word_chunks", "lighthouse"), 1);
        assert_eq!(chunks_with("search_word_chunks", "harbour"), 1);

        conn.execute("DELETE FROM blocks WHERE slug = 'lighthouse'", []).unwrap();
        assert_eq!(chunks_with("search_word_chunks", "harbour"), 0);
        assert_eq!(chunks_with("search_word_chunks", "lighthouse"), 0);
        assert_eq!(chunks_with("search_metadata_terms", "woolf"), 0);
    }

    #[test]
    fn semantic_only_result_uses_excerpt_without_fake_highlight() {
        let conn = test_conn();
        // The route's collection has a page: its links are memberships
        // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К9).
        crate::storage::index::upsert_channel(
            &conn,
            &crate::domain::channel::Channel::new("research", DateTime::new("2026-01-01T00:00:00Z").unwrap())
                .unwrap(),
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "experience-archive",
                "article",
                Some("Neural archive"),
                "2026-01-01T00:00:00Z",
                &["research"],
                "A neural archive keeps experience available for later recall.",
            ),
            None,
        )
        .unwrap();

        let provider = FakeSemanticProvider;
        warm_search_index(&conn, Some(&provider)).unwrap();
        let (blocks, has_more) = search_grid_blocks_with_provider(
            &conn,
            Some("research"),
            0,
            20,
            "воспоминания",
            Some(&provider),
        )
        .unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].slug, "experience-archive");
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Semantic);
        assert_eq!(search_match.kind, SearchMatchKind::Semantic);
        assert!(search_match.ranges.is_empty());
        assert!(search_match.excerpt.contains("experience"));
    }

    #[test]
    fn search_exposes_preview_only_after_ready_state() {
        let conn = test_conn();
        let mut block = make_block_full(
            "preview-ready",
            "image",
            Some("Preview ready"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.file = Some("photo.jpg".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let (stale, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "preview", None).unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].preview_manifest, None);

        conn.execute(
            "INSERT INTO source_index_state (slug, source_kind, source_stamp)
             VALUES ('preview-ready', 'block', 'source-v1')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE blocks
             SET preview_state = 'ready', preview_source_stamp = 'source-v1'
             WHERE slug = 'preview-ready'",
            [],
        )
        .unwrap();
        let (ready, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "preview", None).unwrap();
        assert!(ready[0].preview_manifest.is_some());
    }

    #[test]
    fn body_excerpt_omits_raw_wikilink_and_heading() {
        // Article clip: H1 + an inline-media wikilink at the top of the body.
        // A body-term match must yield a clean excerpt — no `![[...]]`, no `#`.
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "ai-labor-market",
                "article",
                Some("Как искусственный интеллект повлияет на рынок труда"),
                "2026-01-01T00:00:00Z",
                &["research"],
                "# Как искусственный интеллект повлияет на рынок труда\n\n![[Как искусственный интеллект повлияет на рынок труда (image 1).webp]]\n\nSmith Collection / Gado / Getty Images\n\nАмериканский The Wall Street Journal провёл опрос экономистов.",
            ),
            None,
        )
        .unwrap();

        warm_search_index(&conn, None).unwrap();
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "экономистов", None).unwrap();

        let block = blocks
            .iter()
            .find(|block| block.slug == "ai-labor-market")
            .expect("article present in results");
        let search_match = block.search_match.as_ref().expect("body match present");
        assert_eq!(search_match.field, SearchMatchField::Body);
        assert!(
            !search_match.excerpt.contains("![["),
            "excerpt leaked a raw wikilink: {}",
            search_match.excerpt
        );
        assert!(!search_match.excerpt.contains(".webp"));
        assert!(search_match.excerpt.contains("экономистов"));
    }

    fn highlighted_text(search_match: &SearchMatch) -> String {
        let range = search_match.ranges.first().expect("a visible range");
        search_match
            .excerpt
            .chars()
            .skip(range.start)
            .take(range.end - range.start)
            .collect()
    }

    fn title_chunk_text(conn: &Connection, slug: &str) -> String {
        conn.query_row(
            "SELECT text FROM search_chunks WHERE slug = ?1 AND field = 'title'",
            [slug],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn title_field_is_the_file_name_and_the_h1_is_found_through_the_body() {
        // Search names a result by its file name (05.10.2026): the `title`
        // field is the slug's last segment, the note's H1 is body text.
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "Cards/Шуховская башня",
                "article",
                None,
                "2026-01-01T00:00:00Z",
                &[],
                "# Radio tower\n\nSteel lattice over Shabolovka.",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "Cards/tower-notes",
                "article",
                None,
                "2026-01-02T00:00:00Z",
                &[],
                "# Шуховская башня\n\nГиперболоидная конструкция на Шаболовке.",
            ),
            None,
        )
        .unwrap();
        warm_search_index(&conn, None).unwrap();

        assert_eq!(title_chunk_text(&conn, "Cards/Шуховская башня"), "Шуховская башня");
        assert_eq!(title_chunk_text(&conn, "Cards/tower-notes"), "tower-notes");
        let body_chunk: String = conn
            .query_row(
                "SELECT text FROM search_chunks WHERE slug = 'Cards/tower-notes' AND field = 'body'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(body_chunk.starts_with("Шуховская башня"), "{body_chunk}");

        // The H1 of a card named otherwise is still found, the snippet shows it.
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "шуховская", None).unwrap();
        let slugs = blocks.iter().map(|block| block.slug.as_str()).collect::<Vec<_>>();
        assert_eq!(slugs, vec!["Cards/Шуховская башня", "Cards/tower-notes"]);

        let name_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(name_match.field, SearchMatchField::Title);
        assert_eq!(name_match.excerpt, "Шуховская башня");
        assert_eq!(highlighted_text(name_match), "Шуховская");

        let heading_match = blocks[1].search_match.as_ref().unwrap();
        assert_eq!(heading_match.field, SearchMatchField::Body);
        assert!(heading_match.excerpt.starts_with("Шуховская башня"), "{}", heading_match.excerpt);
        assert_eq!(highlighted_text(heading_match), "Шуховская");

        // A word only in the H1 of the card named after the tower: body match.
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "radio", None).unwrap();
        assert_eq!(blocks.len(), 1);
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Body);
        assert_eq!(highlighted_text(search_match), "Radio");
    }

    #[test]
    fn a_typo_in_the_file_name_is_a_fuzzy_title_match_over_the_name() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "Cards/Lighthouse keeper",
                "article",
                None,
                "2026-01-01T00:00:00Z",
                &[],
                "# Coastal notes\n\nNothing about the name here.",
            ),
            None,
        )
        .unwrap();

        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "lighthuose", None).unwrap();

        assert_eq!(blocks.len(), 1);
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Title);
        assert_eq!(search_match.kind, SearchMatchKind::Fuzzy);
        assert_eq!(search_match.excerpt, "Lighthouse keeper");
        assert_eq!(highlighted_text(search_match), "Lighthouse");
    }

    #[test]
    fn an_index_cut_from_the_visible_title_resyncs_chunks_and_embeddings() {
        // An index written before 05.10.2026 holds the H1 as the title chunk.
        // Its document hash no longer matches, so the next sync rewrites the
        // chunks and the embeddings follow. Like every index written before
        // schema 8, it has no stamps and was never compared: the first sync
        // reads each of its documents.
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "Cards/tower-notes",
                "article",
                None,
                "2026-01-01T00:00:00Z",
                &[],
                "# Шуховская башня\n\nA memory of steel lattice.",
            ),
            None,
        )
        .unwrap();
        let provider = FakeSemanticProvider;
        warm_search_index(&conn, Some(&provider)).unwrap();

        let old_title = "Шуховская башня";
        conn.execute(
            "UPDATE search_chunks SET text = ?1, text_hash = ?2 WHERE field = 'title'",
            params![old_title, hash_text(old_title)],
        )
        .unwrap();
        conn.execute_batch(
            "UPDATE search_embeddings SET text_hash = (
                 SELECT text_hash FROM search_chunks WHERE search_chunks.id = chunk_id
             );
             UPDATE search_document_state
                SET document_hash = 'written-before-05.10.2026', source_stamp = NULL;
             UPDATE search_state SET synced_source_revision = NULL;",
        )
        .unwrap();

        assert!(warm_search_index(&conn, Some(&provider)).unwrap() > 0);

        assert_eq!(title_chunk_text(&conn, "Cards/tower-notes"), "tower-notes");
        let (chunks, embedded, current): (i64, i64, i64) = conn
            .query_row(
                "SELECT
                    (SELECT count(*) FROM search_chunks),
                    (SELECT count(*) FROM search_embeddings),
                    (SELECT count(*) FROM search_embeddings e
                     JOIN search_chunks c ON c.id = e.chunk_id AND c.text_hash = e.text_hash)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(chunks, 2);
        assert_eq!(embedded, chunks);
        assert_eq!(current, chunks);
    }

    #[test]
    fn single_latin_token_query_does_not_inject_semantic_only_results() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-title",
                "article",
                Some("Memory"),
                "2026-01-01T00:00:00Z",
                &[],
                "Plain title hit.",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "semantic-body",
                "article",
                Some("Archive"),
                "2026-01-02T00:00:00Z",
                &[],
                "A neural archive keeps experience available for later recall.",
            ),
            None,
        )
        .unwrap();

        let provider = FakeSemanticProvider;
        warm_search_index(&conn, Some(&provider)).unwrap();
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "memory", Some(&provider))
                .unwrap();

        assert_eq!(
            blocks
                .iter()
                .map(|block| block.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["memory-title"]
        );
    }

    #[test]
    fn single_latin_token_query_bypasses_semantic_provider() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-title",
                "article",
                Some("Memory"),
                "2026-01-01T00:00:00Z",
                &[],
                "Plain title hit.",
            ),
            None,
        )
        .unwrap();

        let provider = PanicSemanticProvider;
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "memory", Some(&provider))
                .unwrap();

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].slug, "memory-title");
    }

    /// A card for the one-character tests: `slug` names its file, the rest
    /// of it can hold the letter anywhere but in a word of that name.
    fn upsert_initial_card(
        conn: &Connection,
        slug: &str,
        saved_at: &str,
        description: Option<&str>,
        author: Option<&str>,
        url: Option<&str>,
        body: &str,
    ) {
        let mut block = make_block_full(slug, "article", None, saved_at, &[], body);
        block.frontmatter.description = description.map(ToOwned::to_owned);
        block.frontmatter.author = author.map(ToOwned::to_owned);
        block.frontmatter.url = url.map(ToOwned::to_owned);
        upsert_block(conn, &block, None).unwrap();
    }

    fn slugs_of(blocks: &[LightBlock]) -> Vec<&str> {
        blocks.iter().map(|block| block.slug.as_str()).collect()
    }

    /// One character searches names only (user's decision of 15.11.2026): a
    /// word of the file name starting with it, case aside, newest first; the
    /// text, the H1, the description, the author, the address and meaning
    /// find nothing, and the semantic provider is never asked.
    #[test]
    fn one_character_finds_file_names_with_a_word_starting_with_it_newest_first() {
        let conn = test_conn();
        upsert_initial_card(&conn, "Cards/Город света", "2026-01-03T00:00:00Z", None, None, None, "Plain body.");
        upsert_initial_card(&conn, "Cards/Старый город", "2026-01-05T00:00:00Z", None, None, None, "Plain body.");
        upsert_initial_card(&conn, "Cards/огород", "2026-01-09T00:00:00Z", None, None, None, "Plain body.");
        upsert_initial_card(
            &conn,
            "Cards/Notes",
            "2026-01-10T00:00:00Z",
            Some("Город в описании"),
            Some("Горький"),
            Some("https://gorod.example/г"),
            "# Город в заголовке\n\nГород в тексте.",
        );

        let provider = PanicSemanticProvider;
        let (blocks, has_more) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "г", Some(&provider)).unwrap();
        assert!(!has_more);
        assert_eq!(slugs_of(&blocks), ["Cards/Старый город", "Cards/Город света"]);

        let (upper, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, " Г ", Some(&provider)).unwrap();
        assert_eq!(slugs_of(&upper), slugs_of(&blocks), "case and the trimmed spaces aside");

        let found = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(found.field, SearchMatchField::Title);
        assert_eq!(found.excerpt, "Старый город");
        assert_eq!(found.ranges, vec![SearchTextRange { start: 7, end: 8 }]);
        assert_eq!(blocks[1].search_match.as_ref().unwrap().ranges, vec![SearchTextRange { start: 0, end: 1 }]);
    }

    /// The character is the start of a word, not a word: no stop word drops
    /// it, no transliteration widens it, and a digit counts as a letter.
    #[test]
    fn one_character_has_no_stop_words_and_no_transliteration() {
        let conn = test_conn();
        upsert_initial_card(&conn, "Cards/A frame house", "2026-01-01T00:00:00Z", None, None, None, "");
        upsert_initial_card(&conn, "Cards/Gorod", "2026-01-02T00:00:00Z", None, None, None, "");
        upsert_initial_card(&conn, "Cards/2025 plans", "2026-01-03T00:00:00Z", None, None, None, "");
        upsert_initial_card(&conn, "Cards/Year 2025", "2026-01-04T00:00:00Z", None, None, None, "");

        let provider = PanicSemanticProvider;
        let search = |query: &str| {
            search_grid_blocks_with_provider(&conn, None, 0, 20, query, Some(&provider)).unwrap().0
        };
        assert_eq!(slugs_of(&search("a")), ["Cards/A frame house"], "the stop word `a` is a letter here");
        assert!(search("г").is_empty(), "`г` is not `g*`");
        assert_eq!(slugs_of(&search("2")), ["Cards/Year 2025", "Cards/2025 plans"]);
    }

    /// A character that is neither a letter nor a digit is still waiting,
    /// as before (SPEC_SEARCH_OVERLAY.md, «Минимальная длина запроса»).
    #[test]
    fn one_character_that_is_no_letter_or_digit_finds_nothing() {
        let conn = test_conn();
        upsert_initial_card(&conn, "Cards/#tag and - dash", "2026-01-01T00:00:00Z", None, None, None, "# - .");
        let provider = PanicSemanticProvider;
        for query in ["#", "-", ".", "\"", "*"] {
            let (blocks, has_more) =
                search_grid_blocks_with_provider(&conn, None, 0, 20, query, Some(&provider)).unwrap();
            assert!(blocks.is_empty() && !has_more, "{query:?}");
        }
    }

    /// Pages of a one-character search follow the overlay's paging: `limit`
    /// rows from `offset`, `has_more` while more names match.
    #[test]
    fn one_character_pages_by_offset_and_limit() {
        let conn = test_conn();
        for day in 1..=5 {
            upsert_initial_card(&conn, &format!("Cards/Note {day}"), &format!("2026-01-0{day}T00:00:00Z"), None, None, None, "");
        }
        let (first, has_more) =
            search_grid_blocks_prepared(&conn, None, 0, 2, "n", &mut SearchRun::unobserved()).unwrap();
        assert_eq!(slugs_of(&first), ["Cards/Note 5", "Cards/Note 4"]);
        assert!(has_more);
        let (last, has_more) =
            search_grid_blocks_prepared(&conn, None, 4, 2, "n", &mut SearchRun::unobserved()).unwrap();
        assert_eq!(slugs_of(&last), ["Cards/Note 1"]);
        assert!(!has_more);
    }

    /// From two characters on, the full search is unchanged: the text and
    /// the description find cards again, with the ranking as before.
    #[test]
    fn two_characters_keep_the_full_search() {
        let conn = test_conn();
        upsert_initial_card(&conn, "Cards/Город света", "2026-01-03T00:00:00Z", None, None, None, "Plain body.");
        upsert_initial_card(&conn, "Cards/Notes", "2026-01-10T00:00:00Z", Some("Город в описании"), None, None, "Город в тексте.");
        let provider = PanicSemanticProvider;
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "го", Some(&provider)).unwrap();
        assert_eq!(slugs_of(&blocks), ["Cards/Город света", "Cards/Notes"]);
        assert_eq!(blocks[1].search_match.as_ref().unwrap().field, SearchMatchField::Description);
    }

    /// The speed of a one-character search on a large space: 10 000 cards
    /// whose names start with the same few letters, so the letter matches
    /// thousands of them. The limit is the search's (SPEC_SEARCH.md,
    /// Performance Contract: first results under 100 ms on a warm index), an
    /// optimised build's: a speed test, run by `test:rust-speed` alone
    /// (ARCHITECTURE.md, «Тесты скорости Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_one_character_search_of_a_large_space_answers_within_its_limit() {
        const CARDS: usize = 10_000;
        const READS: usize = 12;
        const LIMIT: std::time::Duration = std::time::Duration::from_millis(100);
        let words = ["город", "дом", "сад", "Garden", "house", "street", "мост", "река"];
        let conn = test_conn();
        conn.execute_batch("BEGIN").unwrap();
        for card in 0..CARDS {
            let name = format!("{} {} {card}", words[card % words.len()], words[(card / 8) % words.len()]);
            let saved_at = format!("2026-01-01T{:02}:{:02}:{:02}Z", card / 3600 % 24, card / 60 % 60, card % 60);
            let body = format!("Текст заметки {card}: город, дом и сад вдоль реки.");
            upsert_initial_card(&conn, &format!("Cards/{name}"), &saved_at, None, None, None, &body);
        }
        conn.execute_batch("COMMIT").unwrap();
        sync_search_documents(&conn).unwrap();

        let time = |query: &str| {
            let mut timings = Vec::with_capacity(READS);
            let mut found = (0, false);
            for _ in 0..READS {
                let started = std::time::Instant::now();
                let (blocks, has_more) =
                    search_grid_blocks_prepared(&conn, None, 0, 200, query, &mut SearchRun::unobserved()).unwrap();
                timings.push(started.elapsed());
                found = (blocks.len(), has_more);
            }
            timings.sort();
            (timings[READS / 2], timings[READS - 1], found)
        };
        let (median, slowest, found) = time("г");
        assert_eq!(found, (200, true));
        let (two_median, two_slowest, _) = time("го");
        eprintln!(
            "one-character search, {CARDS} cards: median {median:?}, slowest {slowest:?}; two characters: median {two_median:?}, slowest {two_slowest:?}; limit {LIMIT:?}, asserted",
        );
        assert!(slowest <= LIMIT, "one-character search {slowest:?} over {LIMIT:?} (median {median:?})");
    }

    #[test]
    fn short_cyrillic_query_bypasses_semantic_provider() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "available-title",
                "article",
                Some("Available notes"),
                "2026-01-01T00:00:00Z",
                &[],
                "Plain lexical alias hit.",
            ),
            None,
        )
        .unwrap();

        let provider = PanicSemanticProvider;
        let (blocks, has_more) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "ав", Some(&provider)).unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].slug, "available-title");
        assert_eq!(
            blocks[0].search_match.as_ref().unwrap().kind,
            SearchMatchKind::Alias
        );
    }

    #[test]
    fn alias_title_match_outranks_semantic_body_match() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-title",
                "article",
                Some("Memory"),
                "2026-01-01T00:00:00Z",
                &[],
                "Plain title hit.",
            ),
            None,
        )
        .unwrap();
        upsert_block(
            &conn,
            &make_block_full(
                "semantic-body",
                "article",
                Some("Archive"),
                "2026-01-02T00:00:00Z",
                &[],
                "A neural archive keeps experience available for later recall.",
            ),
            None,
        )
        .unwrap();

        let provider = FakeSemanticProvider;
        warm_search_index(&conn, Some(&provider)).unwrap();
        let (blocks, _) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "память", Some(&provider))
                .unwrap();

        assert_eq!(blocks[0].slug, "memory-title");
        assert!(blocks.iter().any(|block| block.slug == "semantic-body"));
    }

    #[test]
    fn fuzzy_typo_match_returns_real_text_range() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "memory-body",
                "article",
                Some("Archive"),
                "2026-01-01T00:00:00Z",
                &[],
                "This paragraph discusses memory machines.",
            ),
            None,
        )
        .unwrap();

        let (blocks, has_more) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "memroy", None).unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.kind, SearchMatchKind::Fuzzy);
        let range = search_match.ranges.first().unwrap();
        let highlighted = search_match
            .excerpt
            .chars()
            .skip(range.start)
            .take(range.end - range.start)
            .collect::<String>();
        assert_eq!(highlighted, "memory");
    }

    #[test]
    fn author_match_returns_card_without_visible_highlight_ranges() {
        let conn = test_conn();
        let mut block = make_block_full(
            "author-only",
            "article",
            Some("Unrelated title"),
            "2026-01-01T00:00:00Z",
            &[],
            "No visible body match.",
        );
        block.frontmatter.author = Some("@poetengineer__".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let (blocks, has_more) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "poet", None).unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].slug, "author-only");
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Author);
        assert_eq!(search_match.kind, SearchMatchKind::Prefix);
        assert!(search_match.ranges.is_empty());
    }

    #[test]
    fn url_match_returns_card_without_visible_highlight_ranges() {
        let conn = test_conn();
        let mut block = make_block_full(
            "url-only",
            "link",
            Some("Unrelated title"),
            "2026-01-01T00:00:00Z",
            &[],
            "",
        );
        block.frontmatter.url = Some("https://example.com/memory-lab".to_string());
        upsert_block(&conn, &block, None).unwrap();

        let (blocks, has_more) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "example", None).unwrap();

        assert!(!has_more);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].slug, "url-only");
        let search_match = blocks[0].search_match.as_ref().unwrap();
        assert_eq!(search_match.field, SearchMatchField::Url);
        assert_eq!(search_match.kind, SearchMatchKind::Exact);
        assert!(search_match.ranges.is_empty());
    }

    /// A generated space: half its cards are pictures with a short
    /// description or none, a quarter links with an address, 15 % articles,
    /// 10 % posts with an author; every card is in up to three of its
    /// collections. The words come from a vocabulary of Latin and Cyrillic
    /// words drawn by Zipf's law, as the words of a real text are.
    struct TextSpace {
        _dir: tempfile::TempDir,
        index: std::path::PathBuf,
        /// The vocabulary, most frequent word first.
        words: Vec<String>,
    }

    #[derive(Clone, Copy)]
    struct TextSpaceSize {
        cards: usize,
        words: usize,
        collections: usize,
        text_bytes: usize,
    }

    /// The size the search limits are set for (AUDIT_PERFORMANCE.md, plan
    /// row 2 and Пр6): 10 000 cards with 30 MB of text, articles of 2 to
    /// 38 KB.
    const LARGE_TEXT_SPACE: TextSpaceSize = TextSpaceSize {
        cards: 10_000,
        words: 20_000,
        collections: 100,
        text_bytes: 30_000_000,
    };

    /// A fixed sequence of numbers: the same space on every run.
    struct Sequence(u64);

    impl Sequence {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, bound: usize) -> usize {
            (self.next() % bound as u64) as usize
        }
    }

    fn text_space_vocabulary(sequence: &mut Sequence, size: usize) -> Vec<String> {
        const LATIN: (&[&str], &[&str]) = (
            &["b", "c", "d", "f", "g", "h", "k", "l", "m", "n", "p", "r", "s", "t", "v", "st", "tr", "ch"],
            &["a", "e", "i", "o", "u", "ea", "ou"],
        );
        const CYRILLIC: (&[&str], &[&str]) = (
            &["б", "в", "г", "д", "ж", "з", "к", "л", "м", "н", "п", "р", "с", "т", "ст", "пр"],
            &["а", "е", "и", "о", "у", "ы", "я"],
        );
        let mut seen = std::collections::HashSet::new();
        let mut words = Vec::with_capacity(size);
        while words.len() < size {
            let (consonants, vowels) = if sequence.below(3) == 0 { CYRILLIC } else { LATIN };
            let mut word = String::new();
            for _ in 0..=sequence.below(4) {
                word.push_str(consonants[sequence.below(consonants.len())]);
                word.push_str(vowels[sequence.below(vowels.len())]);
            }
            if sequence.below(2) == 0 {
                word.push_str(consonants[sequence.below(consonants.len())]);
            }
            if !is_stop_word(&word) && seen.insert(word.clone()) {
                words.push(word);
            }
        }
        words
    }

    /// Draws words by Zipf's law: the word of rank `r` comes `1 / r` as often
    /// as the first.
    struct ZipfWords<'a> {
        words: &'a [String],
        cumulative: Vec<f64>,
    }

    impl<'a> ZipfWords<'a> {
        fn new(words: &'a [String]) -> Self {
            let mut total = 0.0;
            let cumulative = (1..=words.len())
                .map(|rank| {
                    total += 1.0 / rank as f64;
                    total
                })
                .collect();
            Self { words, cumulative }
        }

        fn word(&self, sequence: &mut Sequence) -> &'a str {
            let total = self.cumulative[self.cumulative.len() - 1];
            let at = (sequence.next() % 1_000_000_007) as f64 / 1_000_000_007.0 * total;
            let rank = self.cumulative.partition_point(|sum| *sum < at);
            &self.words[rank.min(self.words.len() - 1)]
        }

        fn sentence(&self, sequence: &mut Sequence, words: usize) -> String {
            let mut sentence = String::new();
            for index in 0..words {
                if index > 0 {
                    sentence.push(' ');
                }
                sentence.push_str(self.word(sequence));
            }
            sentence
        }

        fn text(&self, sequence: &mut Sequence, bytes: usize) -> String {
            let mut text = String::with_capacity(bytes + 64);
            while text.len() < bytes {
                if sequence.below(12) == 0 {
                    text.push_str("## ");
                    text.push_str(&self.sentence(sequence, 4));
                    text.push_str("\n\n");
                }
                let words = 30 + sequence.below(60);
                text.push_str(&self.sentence(sequence, words));
                text.push_str(".\n\n");
            }
            text
        }
    }

    /// Build the space and its search documents.
    fn text_space(size: TextSpaceSize) -> TextSpace {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index.db");
        let conn = db::open_or_create(&index).unwrap();
        let mut sequence = Sequence(0x9E37_79B9_7F4A_7C15);
        let words = text_space_vocabulary(&mut sequence, size.words);
        let zipf = ZipfWords::new(&words);
        // The articles are 15 % of the cards and hold the text.
        let article_bytes = size.text_bytes / (size.cards * 3 / 20);
        let mut text_bytes = 0;

        conn.execute_batch("BEGIN").unwrap();
        for collection in 0..size.collections {
            crate::storage::index::upsert_channel(
                &conn,
                &crate::domain::channel::Channel::new(
                    &format!("collection-{collection}"),
                    DateTime::new("2026-01-01T00:00:00Z").unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        }
        for card in 0..size.cards {
            let name = format!("Cards/{} {} {card}", zipf.word(&mut sequence), zipf.word(&mut sequence));
            let saved_at = format!(
                "2026-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                1 + card / 28 / 24 / 60 % 12,
                1 + card / 24 / 60 % 28,
                card / 60 % 24,
                card % 60,
                card % 60,
            );
            let tags: BTreeSet<String> = (0..sequence.below(4))
                .map(|_| format!("collection-{}", sequence.below(size.collections)))
                .collect();
            let tags: Vec<&str> = tags.iter().map(String::as_str).collect();
            let (block_type, body) = match card % 20 {
                0..=9 => ("image", String::new()),
                10..=14 => ("link", String::new()),
                15..=17 => {
                    // From 2 KB to twice the mean less 2 KB: the mean holds.
                    let bytes = 2_000 + sequence.below(2 * article_bytes - 4_000);
                    ("article", zipf.text(&mut sequence, bytes))
                }
                _ => {
                    let bytes = 200 + sequence.below(400);
                    ("article", zipf.text(&mut sequence, bytes))
                }
            };
            text_bytes += body.len();
            let mut block = make_block_full(&name, block_type, None, &saved_at, &tags, &body);
            match card % 20 {
                0..=9 if card % 2 == 0 => {
                    block.frontmatter.description = Some(zipf.sentence(&mut sequence, 8));
                }
                10..=14 => {
                    block.frontmatter.description = Some(zipf.sentence(&mut sequence, 18));
                    block.frontmatter.url = Some(format!(
                        "https://{}.example/{}-{}",
                        zipf.word(&mut sequence),
                        zipf.word(&mut sequence),
                        zipf.word(&mut sequence),
                    ));
                }
                15..=17 if card % 2 == 0 => {
                    block.frontmatter.author = Some(zipf.sentence(&mut sequence, 2));
                }
                18..=19 => {
                    block.frontmatter.author =
                        Some(format!("@{}_{}", zipf.word(&mut sequence), zipf.word(&mut sequence)));
                }
                _ => {}
            }
            upsert_block(&conn, &block, None).unwrap();
        }
        sync_search_documents(&conn).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        assert!(
            text_bytes >= size.text_bytes * 9 / 10,
            "the space holds {text_bytes} bytes of text"
        );
        TextSpace { _dir: dir, index, words }
    }

    impl TextSpace {
        /// The first word from `rank` on that every layer of the search
        /// takes, the typo-tolerant one at its wider distance included.
        fn word_from(&self, rank: usize, cyrillic: bool) -> &str {
            self.words[rank..]
                .iter()
                .find(|word| word.chars().count() >= 6 && word.is_ascii() != cyrillic)
                .unwrap()
        }

        /// The queries the limits are set for: what a person types on the
        /// way to a word, words of different frequency, and words the space
        /// does not hold.
        fn queries(&self) -> Vec<(&'static str, String)> {
            let frequent = self.word_from(2, false).to_string();
            let mut typo = self.word_from(40, false).to_string();
            typo.insert(2, 'x');
            vec![
                ("two characters", frequent.chars().take(2).collect()),
                ("three characters", frequent.chars().take(3).collect()),
                ("frequent word", frequent),
                ("word of middle frequency", self.word_from(self.words.len() / 10, false).to_string()),
                ("cyrillic word", self.word_from(100, true).to_string()),
                (
                    "two words",
                    format!("{} {}", self.word_from(5, false), self.word_from(300, false)),
                ),
                ("word with a typo", typo),
                ("absent word", "qwzxqwzxq".to_string()),
            ]
        }
    }

    /// The search as it was until 15.11.2026, kept as the reference the
    /// search is compared with: the lexical search in one statement over
    /// whole rows, the passes over the text of every chunk and over every
    /// author and address chunk, and the fusion that read the row of every
    /// candidate. The functions are the former ones, unchanged.
    mod as_before {
        use super::super::*;

        #[derive(Debug, Clone)]
        pub(super) struct FuzzyCandidate {
            pub(super) slug: String,
            pub(super) search_match: SearchMatch,
        }

        #[derive(Debug, Clone)]
        struct RankedBlock {
            block: LightBlock,
            rank_score: f64,
            lexical: bool,
        }

        fn search_light_block_from_row(
            row: &rusqlite::Row<'_>,
            plan: &SearchPlan,
        ) -> rusqlite::Result<LightBlock> {
            let mut block = light_block_from_row(row)?;
            let description = row.get::<_, Option<String>>(22)?;
            let body = row.get::<_, String>(23)?;
            block.search_match = build_search_match(&block, description.as_deref(), &body, plan);
            Ok(block)
        }

        /// The former search without the layer of meaning.
        pub(super) fn search(
            conn: &Connection,
            tag: Option<&str>,
            offset: usize,
            limit: usize,
            query: &str,
        ) -> Result<(Vec<LightBlock>, bool)> {
            let Some(plan) = SearchPlan::from_query(query) else {
                return Ok((Vec::new(), false));
            };

            let candidate_limit = (offset + limit + SEMANTIC_CANDIDATE_LIMIT).max(limit + 1);
            let lexical_blocks = lexical_grid_search(conn, tag, 0, candidate_limit, &plan)?;
            let mut chunk_candidates = metadata_candidates(conn, tag, &plan)?;
            chunk_candidates.extend(fuzzy_candidates(conn, tag, &plan)?);

            let mut ranked = fuse_candidates(conn, lexical_blocks, chunk_candidates, Vec::new())?;
            ranked.sort_by(compare_ranked_blocks);

            let has_more = ranked.len() > offset + limit;
            let blocks = ranked
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|ranked| ranked.block)
                .collect();

            Ok((blocks, has_more))
        }

        pub(super) fn lexical_grid_search(
            conn: &Connection,
            tag: Option<&str>,
            offset: usize,
            fetch_limit: usize,
            plan: &SearchPlan,
        ) -> Result<Vec<LightBlock>> {
            let (sql, params) = grid_search_sql(tag, offset, fetch_limit, plan);
            let mut stmt = conn.prepare(&sql)?;
            let blocks = stmt
                .query_map(params_from_iter(params.iter()), |row| {
                    search_light_block_from_row(row, plan)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(blocks)
        }

        fn grid_search_sql(
            tag: Option<&str>,
            offset: usize,
            fetch_limit: usize,
            plan: &SearchPlan,
        ) -> (String, Vec<Value>) {
            let collections = collections_column_sql("b.id");
            let mut sql = format!(
                "SELECT b.id, b.slug, b.block_type, b.card_kind, b.title, b.content_heading, b.display_title, COALESCE(b.fallback_label, b.slug), b.url, b.media_file,
                            b.thumbnail, b.saved_at, b.width, b.height, b.author,
                            CASE WHEN b.card_kind = 'article' THEN SUBSTR(b.body, 1, ?1) ELSE '' END,
                            b.preview_text, b.first_image, b.media_urls, b.media_dimensions,
                            CASE WHEN b.preview_state = 'ready'
                                      AND b.preview_source_stamp = (
                                          SELECT source.source_stamp FROM source_index_state source
                                          WHERE source.slug = b.slug
                                      )
                                 THEN b.preview_manifest END,
                            CASE WHEN b.preview_state = 'ready'
                                      AND b.preview_source_stamp = (
                                          SELECT source.source_stamp FROM source_index_state source
                                          WHERE source.slug = b.slug
                                      )
                                 THEN b.feed_playback END,
                            b.description, b.body,
                            {collections}
                     FROM blocks b
                     JOIN blocks_fts ON blocks_fts.rowid = b.id"
            );
            let mut params = vec![
                Value::Integer(LIGHT_BLOCK_BODY_PREVIEW_CHARS),
                Value::Text(plan.candidate_fts5_query()),
            ];
            if tag.is_some() {
                sql.push_str(&collection_route_join_sql());
            }

            sql.push_str(" WHERE b.card_kind != 'channel' AND blocks_fts MATCH ?2");

            if let Some(tag) = tag {
                params.push(Value::Text(tag.to_string()));
                sql.push_str(&format!(" AND page.tag = ?{}", params.len()));
            }

            for group_query in plan.required_group_queries() {
                params.push(Value::Text(group_query));
                sql.push_str(&format!(
                    " AND b.id IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?{})",
                    params.len()
                ));
            }

            params.push(Value::Integer(fetch_limit as i64));
            let limit_index = params.len();
            params.push(Value::Integer(offset as i64));
            let offset_index = params.len();
            // The FTS `title` column holds every name of a card (display title, legacy
            // title, file name) and only orders the candidate window, so a card whose
            // H1 matches stays inside it. Which field matched, and the rank, come from
            // `build_search_match`: there `title` is the file name alone.
            sql.push_str(&format!(
                " ORDER BY bm25(blocks_fts, 8.0, 3.0, 1.0) ASC, b.saved_at DESC LIMIT ?{} OFFSET ?{}",
                limit_index, offset_index
            ));

            (sql, params)
        }

        pub(super) fn fuzzy_candidates(
            conn: &Connection,
            tag: Option<&str>,
            plan: &SearchPlan,
        ) -> Result<Vec<FuzzyCandidate>> {
            let terms = plan
                .literal_terms
                .iter()
                .filter(|term| term.chars().count() >= 4 && term.chars().all(|ch| ch.is_alphanumeric()))
                .collect::<Vec<_>>();
            if terms.is_empty() {
                return Ok(Vec::new());
            }

            let mut sql = String::from(
                "SELECT c.slug, c.field, c.text
                 FROM search_chunks c
                 INNER JOIN blocks b ON b.id = c.block_id",
            );
            if tag.is_some() {
                sql.push_str(&collection_route_join_sql());
            }
            sql.push_str(" WHERE b.card_kind != 'channel'");
            let mut params = Vec::<Value>::new();
            if let Some(tag) = tag {
                params.push(Value::Text(tag.to_string()));
                sql.push_str(&format!(" AND page.tag = ?{}", params.len()));
            }

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(params.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        search_field_from_db_lossy(&row.get::<_, String>(1)?),
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut by_slug = BTreeMap::<String, FuzzyCandidate>::new();
            for (slug, field, text) in rows {
                let Some((term, start, end)) = first_fuzzy_match_for_terms(&text, &terms) else {
                    continue;
                };
                let search_match = if is_hidden_metadata_field(field) {
                    hidden_metadata_search_match(
                        field,
                        &text,
                        SearchMatchKind::Fuzzy,
                        fuzzy_field_score(field),
                        Some(format!("fuzzy: {}", term)),
                    )
                } else {
                    let (excerpt, range) = excerpt_for_field(field, &text, start, end);
                    SearchMatch {
                        field,
                        kind: SearchMatchKind::Fuzzy,
                        excerpt,
                        ranges: vec![range],
                        score: fuzzy_field_score(field),
                        explanation: Some(format!("fuzzy: {}", term)),
                    }
                };
                let candidate = FuzzyCandidate {
                    slug: slug.clone(),
                    search_match,
                };
                by_slug
                    .entry(slug)
                    .and_modify(|existing| {
                        if fuzzy_field_score(candidate.search_match.field)
                            > fuzzy_field_score(existing.search_match.field)
                        {
                            *existing = candidate.clone();
                        }
                    })
                    .or_insert(candidate);
            }

            Ok(by_slug.into_values().collect())
        }

        pub(super) fn metadata_candidates(
            conn: &Connection,
            tag: Option<&str>,
            plan: &SearchPlan,
        ) -> Result<Vec<FuzzyCandidate>> {
            let mut sql = String::from(
                "SELECT c.slug, c.field, c.text
                 FROM search_chunks c
                 INNER JOIN blocks b ON b.id = c.block_id",
            );
            if tag.is_some() {
                sql.push_str(&collection_route_join_sql());
            }
            sql.push_str(" WHERE b.card_kind != 'channel' AND c.field IN ('author', 'url')");
            let mut params = Vec::<Value>::new();
            if let Some(tag) = tag {
                params.push(Value::Text(tag.to_string()));
                sql.push_str(&format!(" AND page.tag = ?{}", params.len()));
            }

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(params.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        search_field_from_db_lossy(&row.get::<_, String>(1)?),
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut by_slug = BTreeMap::<String, FuzzyCandidate>::new();
            for (slug, field, text) in rows {
                let Some((needle, start, end)) = first_match_range(&text, plan) else {
                    continue;
                };
                let candidate = FuzzyCandidate {
                    slug: slug.clone(),
                    search_match: hidden_metadata_search_match(
                        field,
                        &text,
                        match_kind_for_text(&text, needle, start, end),
                        metadata_field_score(field),
                        match_explanation(needle),
                    ),
                };
                by_slug
                    .entry(slug)
                    .and_modify(|existing| {
                        if metadata_field_score(candidate.search_match.field)
                            > metadata_field_score(existing.search_match.field)
                        {
                            *existing = candidate.clone();
                        }
                    })
                    .or_insert(candidate);
            }

            Ok(by_slug.into_values().collect())
        }

        fn first_fuzzy_match_for_terms(text: &str, terms: &[&String]) -> Option<(String, usize, usize)> {
            let lower = text.to_lowercase();
            let mut best: Option<(String, usize, usize)> = None;
            for (start, token) in token_ranges(&lower) {
                let token_chars = token.chars().count();
                if token_chars < 4 {
                    continue;
                }
                for term in terms {
                    if token.starts_with(term.as_str()) || term.starts_with(token) {
                        continue;
                    }
                    let distance = levenshtein(token, term);
                    let threshold = fuzzy_distance_threshold(term.chars().count());
                    if distance == 0 || distance > threshold {
                        continue;
                    }
                    let end = start + token.len();
                    if text.is_char_boundary(start) && text.is_char_boundary(end) {
                        let next = (term.to_string(), start, end);
                        if best
                            .as_ref()
                            .is_none_or(|(_, current_start, _)| start < *current_start)
                        {
                            best = Some(next);
                        }
                    }
                }
            }
            best
        }

        fn token_ranges(text: &str) -> Vec<(usize, &str)> {
            let mut ranges = Vec::new();
            let mut start: Option<usize> = None;
            for (index, ch) in text.char_indices() {
                if ch.is_alphanumeric() {
                    start.get_or_insert(index);
                } else if let Some(token_start) = start.take() {
                    ranges.push((token_start, &text[token_start..index]));
                }
            }
            if let Some(token_start) = start {
                ranges.push((token_start, &text[token_start..]));
            }
            ranges
        }

        fn fuse_candidates(
            conn: &Connection,
            lexical_blocks: Vec<LightBlock>,
            fuzzy_candidates: Vec<FuzzyCandidate>,
            semantic_candidates: Vec<SemanticCandidate>,
        ) -> Result<Vec<RankedBlock>> {
            let mut by_slug = BTreeMap::<String, RankedBlock>::new();

            for (index, block) in lexical_blocks.into_iter().enumerate() {
                let score = lexical_rank_score(block.search_match.as_ref(), index);
                by_slug.insert(
                    block.slug.clone(),
                    RankedBlock {
                        block,
                        rank_score: score,
                        lexical: true,
                    },
                );
            }

            for candidate in fuzzy_candidates {
                if by_slug.contains_key(&candidate.slug) {
                    continue;
                }
                if let Some(mut block) = load_light_block_by_slug(conn, &candidate.slug)? {
                    let rank_score = lexical_rank_score(Some(&candidate.search_match), 0);
                    block.search_match = Some(candidate.search_match);
                    by_slug.insert(
                        candidate.slug,
                        RankedBlock {
                            block,
                            rank_score,
                            lexical: true,
                        },
                    );
                }
            }

            for candidate in semantic_candidates {
                let semantic_score = semantic_rank_score(candidate.similarity);
                if let Some(existing) = by_slug.get_mut(&candidate.slug) {
                    existing.rank_score += semantic_score * 0.35;
                    if existing.block.search_match.is_none() {
                        existing.block.search_match = Some(semantic_search_match(&candidate));
                    }
                    continue;
                }

                if let Some(mut block) = load_light_block_by_slug(conn, &candidate.slug)? {
                    block.search_match = Some(semantic_search_match(&candidate));
                    by_slug.insert(
                        candidate.slug.clone(),
                        RankedBlock {
                            block,
                            rank_score: semantic_score,
                            lexical: false,
                        },
                    );
                }
            }

            Ok(by_slug.into_values().collect())
        }

        fn compare_ranked_blocks(a: &RankedBlock, b: &RankedBlock) -> Ordering {
            b.rank_score
                .partial_cmp(&a.rank_score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| b.lexical.cmp(&a.lexical))
                .then_with(|| b.block.saved_at.cmp(&a.block.saved_at))
                .then_with(|| a.block.slug.cmp(&b.block.slug))
        }
    }

    fn matches_by_slug(candidates: Vec<FuzzyCandidate>) -> Vec<(String, SearchMatch)> {
        candidates
            .into_iter()
            .map(|candidate| (candidate.slug, candidate.search_match))
            .collect()
    }

    fn matches_by_slug_as_before(
        candidates: Vec<as_before::FuzzyCandidate>,
    ) -> Vec<(String, SearchMatch)> {
        candidates
            .into_iter()
            .map(|candidate| (candidate.slug, candidate.search_match))
            .collect()
    }

    /// The rules of 15.11.2026 change how much a search reads, never what
    /// it finds. Over a space of generated cards every layer and the whole
    /// answer, page by page, are the ones of the search as it was: on the
    /// whole space and inside a collection, for words, prefixes, typos,
    /// several words, aliases, strings with punctuation, and authors and
    /// addresses whose lowercase form moves their bytes.
    #[test]
    fn the_search_finds_what_it_found_when_it_read_every_text() {
        // A small vocabulary: many words have neighbours a typo away.
        let space = text_space(TextSpaceSize {
            cards: 300,
            words: 1_500,
            collections: 8,
            text_bytes: 150_000,
        });
        let conn = db::open_or_create(&space.index).unwrap();
        // Authors and addresses the words of a query do not predict: `İ`
        // and the Kelvin sign change their byte length in lowercase.
        for (card, author, url) in [
            (0, "\u{212A} .xfoo bar", "https://example.com/\u{130}stanbul/xfoo"),
            (1, "\u{130}smail foo", "https://foo.example/\u{212A}elvin"),
            (2, "Foo-Bar baz", "https://example.com/foo.bar_baz"),
        ] {
            let mut block = make_block_full(
                &format!("Cards/unaligned {card}"),
                "link",
                None,
                "2026-02-01T00:00:00Z",
                &["collection-3"],
                "",
            );
            block.frontmatter.author = Some(author.to_string());
            block.frontmatter.url = Some(url.to_string());
            upsert_block(&conn, &block, None).unwrap();
        }
        // Words with aliases in the other language.
        for (name, body) in [
            ("Cards/Memory palace", "Memory is a flock of birds over the network."),
            ("Cards/Память", "Память как стая птиц, а поиск как сеть."),
            ("Cards/Mine notes", "Mine keeps a visual collection."),
        ] {
            upsert_block(
                &conn,
                &make_block_full(name, "article", None, "2026-02-02T00:00:00Z", &["collection-3"], body),
                None,
            )
            .unwrap();
        }
        sync_search_documents(&conn).unwrap();

        let mut queries: Vec<String> = [
            "foo", "xfoo", "bar", "foo-bar", "foo.bar", "foo.bar_baz", "example.com", "stanbul",
            "elvin", "kelvin", "smail", "ismail", "fooo", "exampel", "https", "ba", "fo",
            "память", "memory память", "память как стая птиц", "стая птиц", "майн", "memroy",
            "flock birds network", "visual colection",
        ]
        .iter()
        .map(|query| (*query).to_string())
        .collect();
        for rank in [0, 2, 13, 89, 610, 1_400] {
            let word = &space.words[rank];
            queries.push(word.clone());
            queries.push(word.chars().take(2).collect());
            queries.push(word.chars().take(3).collect());
            // A typo of each kind: a character added, changed and dropped.
            let chars: Vec<char> = word.chars().collect();
            let middle = chars.len() / 2;
            let mut added = chars.clone();
            added.insert(middle, 'x');
            queries.push(added.into_iter().collect());
            let mut changed = chars.clone();
            changed[middle] = if chars[middle] == 'o' { 'a' } else { 'o' };
            queries.push(changed.into_iter().collect());
            let mut dropped = chars.clone();
            dropped.remove(middle);
            queries.push(dropped.into_iter().collect());
            queries.push(format!("{word} {}", space.words[rank + 7]));
            queries.push(format!("{word} {} {}", space.words[rank + 3], space.words[rank + 11]));
            queries.push(format!("@{word}_{}", space.words[rank + 1]));
        }

        let (mut lexical_found, mut fuzzy_found, mut metadata_found) = (0, 0, 0);
        for query in &queries {
            let Some(plan) = SearchPlan::from_query(query) else {
                continue;
            };
            for tag in [None, Some("collection-3")] {
                let lexical = lexical_grid_search(&conn, tag, 0, 400, &plan).unwrap();
                let lexical_before = as_before::lexical_grid_search(&conn, tag, 0, 400, &plan).unwrap();
                assert_eq!(lexical, lexical_before, "lexical search of {query:?} in {tag:?}");

                let fuzzy = matches_by_slug(
                    fuzzy_candidates(&conn, tag, &plan, &SearchRun::unobserved()).unwrap(),
                );
                let fuzzy_before =
                    matches_by_slug_as_before(as_before::fuzzy_candidates(&conn, tag, &plan).unwrap());
                assert_eq!(fuzzy, fuzzy_before, "typo-tolerant search of {query:?} in {tag:?}");

                let metadata = matches_by_slug(metadata_candidates(&conn, tag, &plan).unwrap());
                let metadata_before =
                    matches_by_slug_as_before(as_before::metadata_candidates(&conn, tag, &plan).unwrap());
                assert_eq!(metadata, metadata_before, "author and address search of {query:?} in {tag:?}");

                for (offset, limit) in [(0, 200), (7, 7)] {
                    let page = search_grid_blocks_prepared_with_provider(
                        &conn,
                        tag,
                        offset,
                        limit,
                        query,
                        None,
                        &mut SearchRun::unobserved(),
                    )
                    .unwrap();
                    let page_before = as_before::search(&conn, tag, offset, limit, query).unwrap();
                    assert_eq!(page, page_before, "page {offset}+{limit} of {query:?} in {tag:?}");
                }
                lexical_found += lexical.len();
                fuzzy_found += fuzzy.len();
                metadata_found += metadata.len();
            }
        }
        // The comparison is of answers, not of empty lists.
        assert!(lexical_found > 1_000, "{lexical_found} lexical results compared");
        assert!(fuzzy_found > 500, "{fuzzy_found} typo matches compared");
        assert!(metadata_found > 100, "{metadata_found} author and address matches compared");
    }

    /// The limit of a search on a warm index (SPEC_SEARCH.md, Performance
    /// Contract) over a space of 10 000 cards with 30 MB of text, on the
    /// connection a space searches by. An optimised build's: a speed test,
    /// run by `test:rust-speed` alone (ARCHITECTURE.md, «Тесты скорости
    /// Rust»).
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn a_search_of_a_large_space_with_text_answers_within_its_limit() {
        const READS: usize = 12;
        const LIMIT: Duration = Duration::from_millis(100);
        let built = Instant::now();
        let space = text_space(LARGE_TEXT_SPACE);
        eprintln!("space of {} cards built in {:?}", LARGE_TEXT_SPACE.cards, built.elapsed());
        let conn = open_search_connection(&space.index).unwrap();

        let mut worst = (Duration::ZERO, "");
        for (name, query) in space.queries() {
            let mut timings = Vec::with_capacity(READS);
            let mut found = (0, false);
            let mut steps = String::new();
            for _ in 0..READS {
                let mut run = SearchRun::unobserved();
                let started = Instant::now();
                let snapshot = crate::storage::search_projection::read_search_snapshot_observed(
                    &conn, None, &query, 200, None, &mut run,
                )
                .unwrap();
                timings.push(started.elapsed());
                found = (snapshot.blocks.len(), snapshot.has_more);
                steps = run
                    .steps()
                    .iter()
                    .map(|(step, took)| format!("{}={:.1}", step.name(), took.as_secs_f64() * 1000.0))
                    .collect::<Vec<_>>()
                    .join(" ");
            }
            timings.sort();
            let (median, slowest) = (timings[READS / 2], timings[READS - 1]);
            eprintln!(
                "{name} ({} characters): median {median:?}, slowest {slowest:?}, found {found:?}; last read: {steps}",
                query.chars().count(),
            );
            if slowest > worst.0 {
                worst = (slowest, name);
            }
        }
        eprintln!("worst search: {} at {:?}; limit {LIMIT:?}, asserted", worst.1, worst.0);
        assert!(worst.0 <= LIMIT, "the search of a {} took {:?}, over {LIMIT:?}", worst.1, worst.0);
    }

    /// П2: the first search of a process costs what any search costs plus
    /// the opening of the connection, because what is synced is written in
    /// the index. Every start below is a new connection to the written
    /// index, as a new process has; nothing of the search lives in the
    /// process between them.
    #[test]
    #[ignore = "asserts a speed limit of an optimised build: bun run test:rust-speed"]
    fn the_first_search_of_a_process_in_a_large_space_answers_within_its_limit() {
        const STARTS: usize = 5;
        const LIMIT: Duration = Duration::from_millis(150);
        let space = text_space(LARGE_TEXT_SPACE);
        let query = space.word_from(2, false).to_string();

        let mut timings = Vec::with_capacity(STARTS);
        for _ in 0..STARTS {
            let started = Instant::now();
            let conn = open_search_connection(&space.index).unwrap();
            let snapshot =
                crate::storage::search_projection::read_search_snapshot(&conn, None, &query, 200, None)
                    .unwrap();
            timings.push(started.elapsed());
            assert_eq!(snapshot.blocks.len(), 200);
        }
        timings.sort();
        let (median, slowest) = (timings[STARTS / 2], timings[STARTS - 1]);
        eprintln!(
            "first search of a process, {} cards: median {median:?}, slowest {slowest:?}; limit {LIMIT:?}, asserted",
            LARGE_TEXT_SPACE.cards,
        );
        assert!(slowest <= LIMIT, "the first search took {slowest:?}, over {LIMIT:?} (median {median:?})");
    }

    #[test]
    fn warm_search_index_is_safe_without_provider() {
        let conn = db::open_memory().unwrap();
        let updated = warm_search_index(&conn, None).unwrap();
        assert_eq!(updated, 0);
    }
}
