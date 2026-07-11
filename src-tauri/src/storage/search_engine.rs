use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

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

use crate::storage::index::{
    is_social_url, light_block_from_row, LightBlock, SearchMatch, SearchMatchField,
    SearchMatchKind, SearchTextRange, LIGHT_BLOCK_BODY_PREVIEW_CHARS,
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
    title: Option<String>,
    content_heading: Option<String>,
    display_title: Option<String>,
    fallback_label: String,
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

#[derive(Debug, Clone)]
struct FuzzyCandidate {
    slug: String,
    search_match: SearchMatch,
}

#[derive(Debug, Clone)]
struct RankedBlock {
    block: LightBlock,
    rank_score: f64,
    lexical: bool,
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
    let Some(plan) = SearchPlan::from_query(query) else {
        return Ok((Vec::new(), false));
    };

    let semantic_provider = semantic_provider.filter(|_| plan.allows_semantic_only());

    sync_search_documents(conn)?;
    let candidate_limit = (offset + limit + SEMANTIC_CANDIDATE_LIMIT).max(limit + 1);
    let lexical_blocks = lexical_grid_search(conn, tag, 0, candidate_limit, &plan)?;
    let mut chunk_candidates = metadata_candidates(conn, tag, &plan)?;
    chunk_candidates.extend(fuzzy_candidates(conn, tag, &plan)?);
    let semantic_candidates = match semantic_provider {
        Some(provider) => match semantic_candidates(conn, tag, provider, &plan.literal_query) {
            Ok(candidates) => candidates,
            Err(err) => {
                log::warn!("semantic search unavailable for {:?}: {err:#}", query);
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let mut ranked = fuse_candidates(conn, lexical_blocks, chunk_candidates, semantic_candidates)?;
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

fn lexical_grid_search(
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
    let mut sql = String::from(
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
                    b.description, b.body
             FROM blocks b
             JOIN blocks_fts ON blocks_fts.rowid = b.id",
    );
    let mut params = vec![
        Value::Integer(LIGHT_BLOCK_BODY_PREVIEW_CHARS),
        Value::Text(plan.candidate_fts5_query()),
    ];
    if tag.is_some() {
        sql.push_str(" INNER JOIN block_tags bt ON bt.block_id = b.id");
    }

    sql.push_str(" WHERE b.card_kind != 'channel' AND blocks_fts MATCH ?2");

    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(&format!(" AND bt.tag = ?{}", params.len()));
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
    sql.push_str(&format!(
        " ORDER BY bm25(blocks_fts, 8.0, 3.0, 1.0) ASC, b.saved_at DESC LIMIT ?{} OFFSET ?{}",
        limit_index, offset_index
    ));

    (sql, params)
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

fn sync_search_documents(conn: &Connection) -> Result<usize> {
    let documents = load_search_documents(conn)?;
    let mut changed = 0;

    for document in documents {
        let current_hash = conn
            .query_row(
                "SELECT document_hash FROM search_document_state WHERE block_id = ?1",
                [document.block_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if current_hash.as_deref() == Some(document.document_hash.as_str()) {
            continue;
        }

        conn.execute(
            "DELETE FROM search_chunks WHERE block_id = ?1",
            [document.block_id],
        )?;
        for chunk in &document.chunks {
            conn.execute(
                "INSERT INTO search_chunks(
                    block_id, slug, field, chunk_index, text, start_char, end_char, text_hash
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    chunk.block_id,
                    chunk.slug,
                    search_field_to_db(chunk.field),
                    chunk.chunk_index as i64,
                    chunk.text,
                    chunk.start_char as i64,
                    chunk.end_char as i64,
                    chunk.text_hash,
                ],
            )?;
        }
        conn.execute(
            "INSERT INTO search_document_state(block_id, slug, document_hash, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(block_id) DO UPDATE SET
                slug = excluded.slug,
                document_hash = excluded.document_hash,
                updated_at = excluded.updated_at",
            params![document.block_id, document.slug, document.document_hash],
        )?;
        changed += document.chunks.len();
    }

    Ok(changed)
}

fn load_search_documents(conn: &Connection) -> Result<Vec<SearchDocument>> {
    let mut stmt = conn.prepare(
        "SELECT id, slug, title, content_heading, display_title,
                COALESCE(fallback_label, slug), description, author, url, body
         FROM blocks
         WHERE card_kind != 'channel'",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SearchDocumentRow {
                block_id: row.get(0)?,
                slug: row.get(1)?,
                title: row.get(2)?,
                content_heading: row.get(3)?,
                display_title: row.get(4)?,
                fallback_label: row.get(5)?,
                description: row.get(6)?,
                author: row.get(7)?,
                url: row.get(8)?,
                body: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(rows.into_iter().map(build_search_document).collect())
}

fn build_search_document(row: SearchDocumentRow) -> SearchDocument {
    let mut chunks = Vec::new();

    if let Some(title) = visible_title_for_row(&row).and_then(non_empty_trimmed_owned) {
        chunks.push(search_chunk(
            row.block_id,
            &row.slug,
            SearchMatchField::Title,
            0,
            title,
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

fn visible_title_for_row(row: &SearchDocumentRow) -> Option<String> {
    row.content_heading
        .as_deref()
        .and_then(non_empty_trimmed)
        .or_else(|| row.display_title.as_deref().and_then(non_empty_trimmed))
        .or_else(|| row.title.as_deref().and_then(non_empty_trimmed))
        .or_else(|| non_empty_trimmed(&row.fallback_label))
        .map(ToOwned::to_owned)
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
        sql.push_str(" INNER JOIN block_tags bt ON bt.block_id = b.id");
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
        sql.push_str(&format!(" AND bt.tag = ?{}", params.len()));
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

fn fuzzy_candidates(
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
        sql.push_str(" INNER JOIN block_tags bt ON bt.block_id = b.id");
    }
    sql.push_str(" WHERE b.card_kind != 'channel'");
    let mut params = Vec::<Value>::new();
    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(&format!(" AND bt.tag = ?{}", params.len()));
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

fn metadata_candidates(
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
        sql.push_str(" INNER JOIN block_tags bt ON bt.block_id = b.id");
    }
    sql.push_str(" WHERE b.card_kind != 'channel' AND c.field IN ('author', 'url')");
    let mut params = Vec::<Value>::new();
    if let Some(tag) = tag {
        params.push(Value::Text(tag.to_string()));
        sql.push_str(&format!(" AND bt.tag = ?{}", params.len()));
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
        .then_with(|| b.block.saved_at.cmp(&a.block.saved_at))
        .then_with(|| a.block.slug.cmp(&b.block.slug))
}

fn load_light_block_by_slug(conn: &Connection, slug: &str) -> Result<Option<LightBlock>> {
    let mut stmt = conn.prepare(
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
                     THEN feed_playback END
         FROM blocks
         WHERE slug = ?2 AND card_kind != 'channel'",
    )?;
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
    if !is_social_url(block.url.as_deref()) {
        let visible_title = block
            .content_heading
            .as_deref()
            .and_then(non_empty_trimmed)
            .or_else(|| block.display_title.as_deref().and_then(non_empty_trimmed))
            .or_else(|| block.title.as_deref().and_then(non_empty_trimmed));

        if let Some(title) = visible_title {
            if let Some((needle, start, end)) = first_match_range(title, plan) {
                return Some(SearchMatch {
                    field: SearchMatchField::Title,
                    kind: match_kind_for_text(title, needle, start, end),
                    excerpt: title.to_string(),
                    ranges: vec![full_text_search_range(title, start, end)],
                    score: TITLE_MATCH_WEIGHT,
                    explanation: match_explanation(needle),
                });
            }
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

fn non_empty_trimmed_owned(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
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

#[cfg(all(not(target_os = "ios"), not(test)))]
impl FastEmbedSemanticProvider {
    fn embed_with_prefix(&self, prefix: &str, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let model = FASTEMBED_MODEL.get_or_init(|| Mutex::new(None));
        let mut model = model
            .try_lock()
            .map_err(|_| anyhow::anyhow!("semantic model is warming"))?;
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

    #[test]
    fn semantic_only_result_uses_excerpt_without_fake_highlight() {
        let conn = test_conn();
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

    #[test]
    fn one_character_query_does_not_create_search_plan() {
        let conn = test_conn();
        upsert_block(
            &conn,
            &make_block_full(
                "available-title",
                "article",
                Some("Available notes"),
                "2026-01-01T00:00:00Z",
                &[],
                "Plain lexical body.",
            ),
            None,
        )
        .unwrap();

        let provider = PanicSemanticProvider;
        let (blocks, has_more) =
            search_grid_blocks_with_provider(&conn, None, 0, 20, "г", Some(&provider)).unwrap();

        assert!(!has_more);
        assert!(blocks.is_empty());
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

    #[test]
    fn warm_search_index_is_safe_without_provider() {
        let conn = db::open_memory().unwrap();
        let updated = warm_search_index(&conn, None).unwrap();
        assert_eq!(updated, 0);
    }
}
