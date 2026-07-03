use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

use crate::storage::index;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeKind {
    Card,
    Collection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphLinkKind {
    CollectionMembership,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: GraphNodeKind,
    pub label: String,
    pub slug: Option<String>,
    pub collection_ref: Option<String>,
    pub card_kind: Option<String>,
    pub block_type: Option<String>,
    pub thumbnail: Option<String>,
    pub preview_manifest: Option<String>,
    pub degree: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphLink {
    pub id: String,
    pub kind: GraphLinkKind,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphSnapshot {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
    pub total_cards: usize,
    pub total_collections: usize,
    pub current_collection: Option<String>,
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

pub fn graph_snapshot(
    conn: &Connection,
    current_collection: Option<&str>,
) -> Result<GraphSnapshot> {
    let scope = current_collection
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let cards = load_cards(conn, scope)?;
    let mut nodes = BTreeMap::<String, GraphNode>::new();
    let mut card_slugs = BTreeSet::<String>::new();

    for card in cards {
        let id = card_node_id(&card.slug);
        card_slugs.insert(card.slug.clone());
        nodes.insert(
            id.clone(),
            GraphNode {
                id,
                kind: GraphNodeKind::Card,
                label: card_label(&card),
                slug: Some(card.slug),
                collection_ref: None,
                card_kind: Some(card.card_kind),
                block_type: Some(card.block_type),
                thumbnail: card.thumbnail,
                preview_manifest: card.preview_manifest,
                degree: 0,
            },
        );
    }

    let collection_counts = collection_counts(conn)?;
    let mut visible_collections = BTreeSet::<String>::new();
    if let Some(collection_ref) = scope {
        visible_collections.insert(collection_ref.to_string());
    } else {
        for channel in index::list_channels(conn)? {
            visible_collections.insert(channel.tag);
        }
    }

    let mut links = Vec::<GraphLink>::new();
    for (slug, collection_ref) in load_memberships(conn, scope)? {
        if !card_slugs.contains(&slug) {
            continue;
        }
        visible_collections.insert(collection_ref.clone());
        let source = collection_node_id(&collection_ref);
        let target = card_node_id(&slug);
        links.push(GraphLink {
            id: format!("{source}->{target}"),
            kind: GraphLinkKind::CollectionMembership,
            source,
            target,
        });
    }

    for collection_ref in visible_collections {
        let id = collection_node_id(&collection_ref);
        nodes.entry(id.clone()).or_insert_with(|| GraphNode {
            id,
            kind: GraphNodeKind::Collection,
            label: collection_label(&collection_ref),
            slug: None,
            collection_ref: Some(collection_ref),
            card_kind: None,
            block_type: None,
            thumbnail: None,
            preview_manifest: None,
            degree: 0,
        });
    }

    let mut degree = BTreeMap::<String, usize>::new();
    for link in &links {
        *degree.entry(link.source.clone()).or_default() += 1;
        *degree.entry(link.target.clone()).or_default() += 1;
    }
    for node in nodes.values_mut() {
        let graph_degree = degree.get(&node.id).copied().unwrap_or(0);
        node.degree = match node.collection_ref.as_ref() {
            Some(collection_ref) => {
                graph_degree.max(collection_counts.get(collection_ref).copied().unwrap_or(0))
            }
            None => graph_degree,
        };
    }

    let total_cards = nodes
        .values()
        .filter(|node| node.kind == GraphNodeKind::Card)
        .count();
    let total_collections = nodes
        .values()
        .filter(|node| node.kind == GraphNodeKind::Collection)
        .count();

    Ok(GraphSnapshot {
        nodes: nodes.into_values().collect(),
        links,
        total_cards,
        total_collections,
        current_collection: scope.map(ToOwned::to_owned),
    })
}

fn load_cards(conn: &Connection, scope: Option<&str>) -> Result<Vec<CardRow>> {
    let mut stmt = conn.prepare(
        "SELECT b.slug, b.block_type, b.card_kind, b.title, b.display_title,
                COALESCE(b.fallback_label, b.slug), b.thumbnail, b.preview_manifest
         FROM blocks b
         WHERE b.card_kind != 'channel'
           AND (?1 IS NULL OR EXISTS (
               SELECT 1 FROM block_tags scoped
               WHERE scoped.block_id = b.id AND scoped.tag = ?1
           ))
         ORDER BY b.saved_at DESC, b.slug ASC",
    )?;

    let rows = stmt
        .query_map(params![scope], |row| {
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

fn load_memberships(conn: &Connection, scope: Option<&str>) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT b.slug, bt.tag
         FROM block_tags bt
         JOIN blocks b ON b.id = bt.block_id
         WHERE b.card_kind != 'channel'
           AND (?1 IS NULL OR EXISTS (
               SELECT 1 FROM block_tags scoped
               WHERE scoped.block_id = b.id AND scoped.tag = ?1
           ))
         ORDER BY bt.tag ASC, b.slug ASC",
    )?;

    let rows = stmt
        .query_map(params![scope], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(rows)
}

fn collection_counts(conn: &Connection) -> Result<BTreeMap<String, usize>> {
    Ok(index::get_all_tags(conn)?
        .into_iter()
        .map(|tag| (tag.tag, tag.count))
        .collect())
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
    use crate::storage::db;

    #[test]
    fn graph_snapshot_returns_card_and_collection_nodes() {
        let conn = db::open_memory().unwrap();
        seed_graph_fixture(&conn);

        let snapshot = graph_snapshot(&conn, None).unwrap();

        assert_eq!(snapshot.total_cards, 3);
        assert!(snapshot.nodes.iter().any(|node| node.id == "card:first"));
        assert!(snapshot
            .nodes
            .iter()
            .any(|node| node.id == "collection:Design"));
        assert_eq!(snapshot.links.len(), 4);
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .find(|node| node.id == "collection:Design")
                .unwrap()
                .degree,
            2,
        );
    }

    #[test]
    fn graph_snapshot_scopes_cards_but_keeps_their_other_collections() {
        let conn = db::open_memory().unwrap();
        seed_graph_fixture(&conn);

        let snapshot = graph_snapshot(&conn, Some("Design")).unwrap();
        let ids = snapshot
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<BTreeSet<_>>();

        assert!(ids.contains("card:first"));
        assert!(ids.contains("card:second"));
        assert!(!ids.contains("card:third"));
        assert!(ids.contains("collection:Design"));
        assert!(ids.contains("collection:Research"));
        assert_eq!(snapshot.links.len(), 3);
    }

    fn seed_graph_fixture(conn: &Connection) {
        conn.execute(
            "INSERT INTO channels (tag, title, position, created_at)
             VALUES (?1, ?1, ?2, '2026-01-01T00:00:00Z')",
            params!["Design", 0],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (tag, title, position, created_at)
             VALUES (?1, ?1, ?2, '2026-01-01T00:00:00Z')",
            params!["Research", 1],
        )
        .unwrap();
        insert_card(conn, "first", "First", "2026-01-03T00:00:00Z");
        insert_card(conn, "second", "Second", "2026-01-02T00:00:00Z");
        insert_card(conn, "third", "Third", "2026-01-01T00:00:00Z");
        attach(conn, "first", "Design");
        attach(conn, "first", "Research");
        attach(conn, "second", "Design");
        attach(conn, "third", "Research");
    }

    fn insert_card(conn: &Connection, slug: &str, title: &str, saved_at: &str) {
        conn.execute(
            "INSERT INTO blocks (
                slug, block_type, card_kind, title, fallback_label, saved_at, body, preview_manifest
             )
             VALUES (?1, 'article', 'article', ?2, ?2, ?3, '', NULL)",
            params![slug, title, saved_at],
        )
        .unwrap();
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
}
