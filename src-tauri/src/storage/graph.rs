use anyhow::{Context, Result};
#[cfg(test)]
use rusqlite::params;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use crate::domain::block::{BlockType, CardKind};
use crate::storage::{index, projection};

pub const FULL_LIBRARY_NODE_LIMIT: usize = 1_000;
pub const EXPLICIT_LARGE_LIBRARY_LIMIT: usize = 5_000;
pub const MATERIALIZED_CARD_LIMIT: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeKind {
    Card,
    Collection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GraphLinkKind {
    CollectionMembership,
    Wikilink,
    RelatedNote,
}

impl GraphLinkKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::CollectionMembership => "collection_membership",
            Self::Wikilink => "wikilink",
            Self::RelatedNote => "related_note",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GraphScopeKind {
    CurrentRoute,
    #[default]
    Library,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct GraphScope {
    pub kind: GraphScopeKind,
    pub collection_ref: Option<String>,
}

impl Default for GraphScope {
    fn default() -> Self {
        Self {
            kind: GraphScopeKind::Library,
            collection_ref: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct GraphOptions {
    pub include_collections: bool,
    pub include_wikilinks: bool,
    pub include_related_notes: bool,
    pub materialize_large_library: bool,
}

impl Default for GraphOptions {
    fn default() -> Self {
        Self {
            include_collections: true,
            include_wikilinks: true,
            include_related_notes: true,
            materialize_large_library: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GraphTruncationReason {
    LargeLibrary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct GraphNode {
    pub id: String,
    pub kind: GraphNodeKind,
    pub label: String,
    pub slug: Option<String>,
    pub collection_ref: Option<String>,
    pub card_kind: Option<CardKind>,
    pub block_type: Option<BlockType>,
    pub thumbnail: Option<String>,
    pub preview_manifest: Option<String>,
    pub degree: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct GraphLink {
    pub id: String,
    pub kind: GraphLinkKind,
    pub source: String,
    pub target: String,
    pub directed: bool,
    pub count: usize,
    pub target_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct GraphSnapshot {
    pub generation: projection::ProjectionRevision,
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
    pub total_cards: usize,
    pub total_collections: usize,
    pub current_collection: Option<String>,
    pub truncated: bool,
    pub truncation_reason: Option<GraphTruncationReason>,
    pub can_materialize_full: bool,
    pub visible_nodes: usize,
    pub visible_links: usize,
    pub total_nodes: usize,
    pub total_links: usize,
}

#[derive(Debug)]
struct CardRow {
    slug: String,
    block_type: String,
    card_kind: String,
    title: Option<String>,
    display_title: Option<String>,
    fallback_label: String,
    thumbnail: Option<String>,
    preview_manifest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct EdgeKey {
    kind: GraphLinkKind,
    source: String,
    target: String,
}

#[derive(Debug, Default)]
struct GraphModel {
    nodes: BTreeMap<String, GraphNode>,
    links: BTreeMap<EdgeKey, GraphLink>,
    card_order: Vec<String>,
    card_slugs: BTreeSet<String>,
    collection_refs: BTreeSet<String>,
    adjacency: BTreeMap<String, BTreeSet<String>>,
}

pub fn graph_snapshot(
    conn: &Connection,
    scope: &GraphScope,
    options: &GraphOptions,
) -> Result<GraphSnapshot> {
    projection::read_projection_snapshot(conn, |conn, generation| {
        build_graph_snapshot(conn, scope, options, generation)
    })
}

fn build_graph_snapshot(
    conn: &Connection,
    scope: &GraphScope,
    options: &GraphOptions,
    generation: projection::ProjectionRevision,
) -> Result<GraphSnapshot> {
    let model = build_graph_model(conn, options)?;
    let total_nodes = model.nodes.len();
    let total_links = model.links.len();
    let library_card_count = model.card_slugs.len();
    let (mut selected, mut truncated) = select_scope(&model, scope, options);
    let explicit_full_library = options.materialize_large_library
        && library_card_count <= EXPLICIT_LARGE_LIBRARY_LIMIT
        && matches!(
            scope.kind,
            GraphScopeKind::Library | GraphScopeKind::CurrentRoute
        )
        && scope
            .collection_ref
            .as_deref()
            .map(str::trim)
            .map_or(true, str::is_empty);

    if !explicit_full_library && selected_card_count(&model, &selected) > MATERIALIZED_CARD_LIMIT {
        cap_selected_cards(&model, &mut selected, MATERIALIZED_CARD_LIMIT);
        truncated = true;
    }

    let mut links = model
        .links
        .values()
        .filter(|link| selected.contains(&link.source) && selected.contains(&link.target))
        .cloned()
        .collect::<Vec<_>>();
    links.sort_by(|left, right| left.id.cmp(&right.id));

    let mut degree = BTreeMap::<String, usize>::new();
    for link in &links {
        *degree.entry(link.source.clone()).or_default() += 1;
        *degree.entry(link.target.clone()).or_default() += 1;
    }
    let mut nodes = selected
        .iter()
        .filter_map(|node_id| model.nodes.get(node_id).cloned())
        .map(|mut node| {
            node.degree = degree.get(&node.id).copied().unwrap_or(0);
            node
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| left.id.cmp(&right.id));

    let total_cards = nodes
        .iter()
        .filter(|node| node.kind == GraphNodeKind::Card)
        .count();
    let total_collections = nodes
        .iter()
        .filter(|node| node.kind == GraphNodeKind::Collection)
        .count();
    let visible_nodes = nodes.len();
    let visible_links = links.len();
    let large_library = library_card_count > FULL_LIBRARY_NODE_LIMIT;

    Ok(GraphSnapshot {
        generation,
        nodes,
        links,
        total_cards,
        total_collections,
        current_collection: scope
            .collection_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        truncated,
        truncation_reason: (truncated && large_library)
            .then_some(GraphTruncationReason::LargeLibrary),
        can_materialize_full: large_library && library_card_count <= EXPLICIT_LARGE_LIBRARY_LIMIT,
        visible_nodes,
        visible_links,
        total_nodes,
        total_links,
    })
}

fn build_graph_model(conn: &Connection, options: &GraphOptions) -> Result<GraphModel> {
    let cards = load_cards(conn)?;
    let mut model = GraphModel::default();
    for card in cards {
        let card_kind = CardKind::from_str(&card.card_kind)
            .with_context(|| format!("invalid graph card_kind for {}", card.slug))?;
        let block_type = BlockType::from_str(&card.block_type)
            .with_context(|| format!("invalid graph block_type for {}", card.slug))?;
        let id = card_node_id(&card.slug);
        model.card_order.push(id.clone());
        model.card_slugs.insert(card.slug.clone());
        model.nodes.insert(
            id.clone(),
            GraphNode {
                id,
                kind: GraphNodeKind::Card,
                label: card_label(&card),
                slug: Some(card.slug),
                collection_ref: None,
                card_kind: Some(card_kind),
                block_type: Some(block_type),
                thumbnail: card.thumbnail,
                preview_manifest: card.preview_manifest,
                degree: 0,
            },
        );
    }

    if options.include_collections {
        for channel in index::list_channels(conn)? {
            model.collection_refs.insert(channel.tag.clone());
            insert_collection_node(&mut model.nodes, &channel.tag);
        }
        for (slug, collection_ref) in load_memberships(conn)? {
            if !model.card_slugs.contains(&slug) {
                continue;
            }
            model.collection_refs.insert(collection_ref.clone());
            insert_collection_node(&mut model.nodes, &collection_ref);
            insert_or_increment_edge(
                &mut model.links,
                GraphLinkKind::CollectionMembership,
                collection_node_id(&collection_ref),
                card_node_id(&slug),
                false,
                Some(collection_ref),
            );
        }
    }

    if options.include_wikilinks {
        for (source, target_ref) in load_reference_links(conn, GraphLinkKind::Wikilink)? {
            insert_reference_edge(
                &mut model,
                options,
                GraphLinkKind::Wikilink,
                source,
                target_ref,
            );
        }
    }
    if options.include_related_notes {
        for (source, target_ref) in load_reference_links(conn, GraphLinkKind::RelatedNote)? {
            insert_reference_edge(
                &mut model,
                options,
                GraphLinkKind::RelatedNote,
                source,
                target_ref,
            );
        }
    }
    model.adjacency = build_adjacency(&model.links);
    Ok(model)
}

fn insert_reference_edge(
    model: &mut GraphModel,
    options: &GraphOptions,
    kind: GraphLinkKind,
    source_slug: String,
    target_ref: String,
) {
    if !model.card_slugs.contains(&source_slug) {
        return;
    }
    let normalized = normalize_graph_target(&target_ref);
    if normalized.is_empty() || normalized == source_slug {
        return;
    }

    let target = if model.card_slugs.contains(&normalized) {
        card_node_id(&normalized)
    } else if options.include_collections && model.collection_refs.contains(&normalized) {
        collection_node_id(&normalized)
    } else {
        return;
    };

    insert_or_increment_edge(
        &mut model.links,
        kind,
        card_node_id(&source_slug),
        target,
        true,
        Some(target_ref),
    );
}

fn insert_or_increment_edge(
    links: &mut BTreeMap<EdgeKey, GraphLink>,
    kind: GraphLinkKind,
    source: String,
    target: String,
    directed: bool,
    target_ref: Option<String>,
) {
    let key = EdgeKey {
        kind,
        source: source.clone(),
        target: target.clone(),
    };
    if let Some(existing) = links.get_mut(&key) {
        existing.count = existing.count.saturating_add(1);
        return;
    }
    links.insert(
        key,
        GraphLink {
            id: format!("{}|{}|{}", kind.as_str(), source, target),
            kind,
            source,
            target,
            directed,
            count: 1,
            target_ref,
        },
    );
}

fn select_scope(
    model: &GraphModel,
    scope: &GraphScope,
    options: &GraphOptions,
) -> (BTreeSet<String>, bool) {
    match scope.kind {
        GraphScopeKind::CurrentRoute => {
            let collection = scope
                .collection_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            collection.map_or_else(
                || select_library_scope(model, options),
                |collection_ref| (select_current_route(model, collection_ref), false),
            )
        }
        GraphScopeKind::Library => select_library_scope(model, options),
    }
}

fn select_library_scope(model: &GraphModel, options: &GraphOptions) -> (BTreeSet<String>, bool) {
    let card_count = model.card_slugs.len();
    let full_allowed = card_count <= FULL_LIBRARY_NODE_LIMIT
        || (options.materialize_large_library && card_count <= EXPLICIT_LARGE_LIBRARY_LIMIT);
    if full_allowed {
        return (model.nodes.keys().cloned().collect(), false);
    }

    let selected = model
        .nodes
        .values()
        .filter(|node| node.kind == GraphNodeKind::Collection)
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    (selected, true)
}

fn select_current_route(model: &GraphModel, collection_ref: &str) -> BTreeSet<String> {
    let collection_id = collection_node_id(collection_ref);
    let mut selected = BTreeSet::from([collection_id.clone()]);
    let members = model
        .links
        .values()
        .filter(|link| {
            link.kind == GraphLinkKind::CollectionMembership && link.source == collection_id
        })
        .map(|link| link.target.clone())
        .collect::<BTreeSet<_>>();
    selected.extend(members.iter().cloned());
    expand_neighbors(model, &mut selected, &members);

    let selected_cards = selected
        .iter()
        .filter(|node_id| {
            model
                .nodes
                .get(*node_id)
                .is_some_and(|node| node.kind == GraphNodeKind::Card)
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    for link in model.links.values() {
        if link.kind == GraphLinkKind::CollectionMembership && selected_cards.contains(&link.target)
        {
            selected.insert(link.source.clone());
        }
    }
    selected
}

fn expand_neighbors(model: &GraphModel, selected: &mut BTreeSet<String>, seeds: &BTreeSet<String>) {
    for seed in seeds {
        selected.extend(neighbors(model, seed));
    }
}

fn neighbors(model: &GraphModel, node_id: &str) -> Vec<String> {
    model
        .adjacency
        .get(node_id)
        .map(|neighbors| neighbors.iter().cloned().collect())
        .unwrap_or_default()
}

fn build_adjacency(links: &BTreeMap<EdgeKey, GraphLink>) -> BTreeMap<String, BTreeSet<String>> {
    let mut adjacency = BTreeMap::<String, BTreeSet<String>>::new();
    for link in links.values() {
        adjacency
            .entry(link.source.clone())
            .or_default()
            .insert(link.target.clone());
        adjacency
            .entry(link.target.clone())
            .or_default()
            .insert(link.source.clone());
    }
    adjacency
}

fn cap_selected_cards(model: &GraphModel, selected: &mut BTreeSet<String>, limit: usize) {
    let keep = model
        .card_order
        .iter()
        .filter(|node_id| selected.contains(*node_id))
        .take(limit)
        .cloned()
        .collect::<BTreeSet<_>>();
    selected.retain(|node_id| {
        model.nodes.get(node_id).map_or(true, |node| {
            node.kind != GraphNodeKind::Card || keep.contains(node_id)
        })
    });
}

fn selected_card_count(model: &GraphModel, selected: &BTreeSet<String>) -> usize {
    selected
        .iter()
        .filter(|node_id| {
            model
                .nodes
                .get(*node_id)
                .is_some_and(|node| node.kind == GraphNodeKind::Card)
        })
        .count()
}

fn load_cards(conn: &Connection) -> Result<Vec<CardRow>> {
    let mut stmt = conn.prepare(
        "SELECT b.slug, b.block_type, b.card_kind, b.title, b.display_title,
                COALESCE(b.fallback_label, b.slug), b.thumbnail,
                CASE WHEN b.preview_state = 'ready' THEN b.preview_manifest END
         FROM blocks b
         WHERE b.card_kind != 'channel'
         ORDER BY b.saved_at DESC, b.slug ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CardRow {
                slug: row.get(0)?,
                block_type: row.get(1)?,
                card_kind: row.get(2)?,
                title: row.get(3)?,
                display_title: row.get(4)?,
                fallback_label: row.get(5)?,
                thumbnail: row.get(6)?,
                preview_manifest: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn load_memberships(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT b.slug, bt.tag
         FROM block_tags bt
         JOIN blocks b ON b.id = bt.block_id
         WHERE b.card_kind != 'channel'
         ORDER BY bt.tag ASC, b.slug ASC",
    )?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn load_reference_links(conn: &Connection, kind: GraphLinkKind) -> Result<Vec<(String, String)>> {
    let table = match kind {
        GraphLinkKind::Wikilink => "wikilinks",
        GraphLinkKind::RelatedNote => "related_note_links",
        GraphLinkKind::CollectionMembership => return Ok(Vec::new()),
    };
    let sql = format!(
        "SELECT source.slug, link.target_slug
         FROM {table} link
         JOIN blocks source ON source.id = link.source_id
         WHERE source.card_kind != 'channel'
         ORDER BY source.slug ASC, link.target_slug ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn insert_collection_node(nodes: &mut BTreeMap<String, GraphNode>, collection_ref: &str) {
    let id = collection_node_id(collection_ref);
    nodes.entry(id.clone()).or_insert_with(|| GraphNode {
        id,
        kind: GraphNodeKind::Collection,
        label: collection_label(collection_ref),
        slug: None,
        collection_ref: Some(collection_ref.to_string()),
        card_kind: None,
        block_type: None,
        thumbnail: None,
        preview_manifest: None,
        degree: 0,
    });
}

fn normalize_graph_target(target: &str) -> String {
    let trimmed = target.trim();
    let boundary = [trimmed.find('#'), trimmed.find('|')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(trimmed.len());
    let base = trimmed[..boundary].trim().trim_start_matches("./");
    base.strip_suffix(".md").unwrap_or(base).trim().to_string()
}

fn card_node_id(slug: &str) -> String {
    format!("card:{slug}")
}

fn collection_node_id(collection_ref: &str) -> String {
    format!("collection:{collection_ref}")
}

fn card_label(card: &CardRow) -> String {
    card.display_title
        .as_deref()
        .or(card.title.as_deref())
        .unwrap_or(&card.fallback_label)
        .trim()
        .to_string()
}

fn collection_label(collection_ref: &str) -> String {
    collection_ref
        .rsplit('/')
        .next()
        .unwrap_or(collection_ref)
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::storage::{db, index};

    fn options() -> GraphOptions {
        GraphOptions::default()
    }

    fn library_scope() -> GraphScope {
        GraphScope::default()
    }

    fn block(slug: &str, body: &str, related: &[&str]) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some(slug.to_string()),
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: Vec::new(),
                related_notes: related.iter().map(|value| (*value).to_string()).collect(),
                source_media: None,
                saved_at: DateTime::new("2026-01-01T00:00:00Z").unwrap(),
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

    fn insert_block(conn: &Connection, slug: &str, body: &str, related: &[&str]) {
        index::upsert_block(conn, &block(slug, body, related), None).unwrap();
    }

    fn attach(conn: &Connection, slug: &str, tag: &str) {
        let block_id: i64 = conn
            .query_row("SELECT id FROM blocks WHERE slug = ?1", [slug], |row| {
                row.get(0)
            })
            .unwrap();
        conn.execute(
            "INSERT INTO block_tags (block_id, tag) VALUES (?1, ?2)",
            params![block_id, tag],
        )
        .unwrap();
    }

    fn seed_collection(conn: &Connection, tag: &str) {
        conn.execute(
            "INSERT INTO channels (tag, title, position, created_at)
             VALUES (?1, ?1, 0, '2026-01-01T00:00:00Z')",
            [tag],
        )
        .unwrap();
    }

    #[test]
    fn snapshot_returns_card_collection_and_membership() {
        let conn = db::open_memory().unwrap();
        insert_block(&conn, "first", "", &[]);
        seed_collection(&conn, "Design");
        attach(&conn, "first", "Design");

        let snapshot = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        assert_eq!(
            snapshot.generation,
            projection::current_generation(&conn).unwrap()
        );
        assert!(snapshot.nodes.iter().any(|node| node.id == "card:first"));
        assert!(snapshot
            .nodes
            .iter()
            .any(|node| node.id == "collection:Design"));
        assert_eq!(snapshot.links[0].kind, GraphLinkKind::CollectionMembership);
        assert!(!snapshot.links[0].directed);
    }

    #[test]
    fn body_wikilink_becomes_directed_card_edge() {
        let conn = db::open_memory().unwrap();
        insert_block(&conn, "source", "See [[target]]", &[]);
        insert_block(&conn, "target", "", &[]);

        let snapshot = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        let link = snapshot
            .links
            .iter()
            .find(|link| link.kind == GraphLinkKind::Wikilink)
            .unwrap();
        assert_eq!(link.source, "card:source");
        assert_eq!(link.target, "card:target");
        assert!(link.directed);
    }

    #[test]
    fn related_note_fragment_resolves_to_base_slug() {
        let conn = db::open_memory().unwrap();
        insert_block(&conn, "extract", "", &["source#^block-id"]);
        insert_block(&conn, "source", "", &[]);

        let snapshot = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        let link = snapshot
            .links
            .iter()
            .find(|link| link.kind == GraphLinkKind::RelatedNote)
            .unwrap();
        assert_eq!(link.target, "card:source");
        assert_eq!(link.target_ref.as_deref(), Some("source#^block-id"));
    }

    #[test]
    fn missing_targets_are_omitted_with_their_edges() {
        let conn = db::open_memory().unwrap();
        insert_block(
            &conn,
            "source",
            "See [[missing]] and ![[existing #1.jpg|Preview]]",
            &["also-missing#^fragment"],
        );

        let snapshot = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["card:source"]
        );
        assert!(snapshot.links.is_empty());
    }

    #[test]
    fn current_route_includes_members_and_one_hop_neighbors() {
        let conn = db::open_memory().unwrap();
        insert_block(&conn, "member", "[[neighbor]]", &[]);
        insert_block(&conn, "neighbor", "", &[]);
        insert_block(&conn, "outside", "", &[]);
        seed_collection(&conn, "Design");
        seed_collection(&conn, "Research");
        attach(&conn, "member", "Design");
        attach(&conn, "neighbor", "Research");

        let scope = GraphScope {
            kind: GraphScopeKind::CurrentRoute,
            collection_ref: Some("Design".to_string()),
            ..GraphScope::default()
        };
        let snapshot = graph_snapshot(&conn, &scope, &options()).unwrap();
        let ids = snapshot
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<BTreeSet<_>>();
        assert!(ids.contains("card:member"));
        assert!(ids.contains("card:neighbor"));
        assert!(ids.contains("collection:Research"));
        assert!(!ids.contains("card:outside"));
    }

    #[test]
    fn duplicate_edge_increments_count() {
        let mut links = BTreeMap::new();
        for target_ref in ["b#first", "b#second"] {
            insert_or_increment_edge(
                &mut links,
                GraphLinkKind::Wikilink,
                "card:a".to_string(),
                "card:b".to_string(),
                true,
                Some(target_ref.to_string()),
            );
        }
        assert_eq!(links.len(), 1);
        let link = links.values().next().unwrap();
        assert_eq!(link.count, 2);
        assert_eq!(link.target_ref.as_deref(), Some("b#first"));
    }

    #[test]
    fn large_library_is_truncated_until_explicit_materialization() {
        let conn = db::open_memory().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for index in 0..=FULL_LIBRARY_NODE_LIMIT {
            tx.execute(
                "INSERT INTO blocks (
                    slug, block_type, card_kind, title, fallback_label, saved_at, body,
                    graph_link_index_version
                 ) VALUES (?1, 'article', 'article', ?1, ?1, '2026-01-01T00:00:00Z', '', ?2)",
                params![format!("note-{index:04}"), db::GRAPH_LINK_INDEX_VERSION],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        seed_collection(&conn, "Design");

        let overview = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        assert!(overview.truncated);
        assert_eq!(
            overview.truncation_reason,
            Some(GraphTruncationReason::LargeLibrary)
        );
        assert_eq!(overview.total_cards, 0);
        assert_eq!(overview.total_nodes, FULL_LIBRARY_NODE_LIMIT + 2);
        assert!(overview.can_materialize_full);

        let mut explicit = options();
        explicit.materialize_large_library = true;
        let full = graph_snapshot(&conn, &library_scope(), &explicit).unwrap();
        assert!(!full.truncated);
        assert_eq!(full.total_cards, FULL_LIBRARY_NODE_LIMIT + 1);
    }

    #[test]
    fn preview_manifest_is_visible_only_when_ready() {
        let conn = db::open_memory().unwrap();
        insert_block(&conn, "preview", "", &[]);
        conn.execute(
            "UPDATE blocks
             SET preview_manifest = '{\"kind\":\"image\",\"primary_preview_path\":\"preview.jpg\",\"width\":1,\"height\":1,\"tiles\":[],\"overflow_count\":0}',
                 preview_state = 'stale'
             WHERE slug = 'preview'",
            [],
        )
        .unwrap();
        let stale = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        assert_eq!(stale.nodes[0].preview_manifest, None);
        conn.execute(
            "UPDATE blocks SET preview_state = 'ready' WHERE slug = 'preview'",
            [],
        )
        .unwrap();
        let ready = graph_snapshot(&conn, &library_scope(), &options()).unwrap();
        assert!(ready.nodes[0].preview_manifest.is_some());
    }
}
