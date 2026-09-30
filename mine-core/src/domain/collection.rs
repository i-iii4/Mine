// Shared, portable collection helpers.
//
// Mine collection membership is stored as Obsidian wikilinks in the
// `Mine Collections` frontmatter field. Runtime identity is the wikilink
// target, not a normalized tag.

use crate::domain::source_patch::{
    frontmatter_bounds, is_top_level_key, replace_top_level_key, top_level_key_span,
    FrontmatterBounds,
};
use crate::domain::vault::validate_slug;
use crate::links::LinkIndex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MINE_COLLECTIONS_FIELD: &str = "Mine Collections";

pub fn normalize_collection_ref(raw: &str) -> String {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(trimmed);
    inner.split('|').next().unwrap_or("").trim().to_string()
}

/// The name a collection is referred to by, given the slug of its document.
///
/// Membership is written as `[[Каталоги]]` — a wikilink target, which Obsidian
/// resolves by name anywhere in the vault. The document's slug, on the other
/// hand, is its path: once collections live in their own folder it becomes
/// `Collections/Каталоги`. Registering the channel under the path while cards
/// are tagged by the name splits one collection into two — an empty one from
/// the document and a real one from the cards.
pub fn collection_ref_from_slug(slug: &str) -> String {
    let normalized = normalize_collection_ref(slug);
    normalized
        .rsplit('/')
        .next()
        .unwrap_or(&normalized)
        .to_string()
}

/// Choose an unambiguous Obsidian target for a collection document.
///
/// A unique filename keeps its historical short target. Documents sharing a
/// filename require their vault-relative paths so neither page overwrites the
/// other in the collection index.
pub fn collection_ref_for_slug(slug: &str, all_channel_slugs: &BTreeSet<String>) -> String {
    let target = format!("{}.md", normalize_collection_ref(slug));
    LinkIndex::new(all_channel_slugs.iter().map(|slug| format!("{slug}.md")))
        .shortest_link(&target, true)
        .unwrap_or_else(|| normalize_collection_ref(slug))
}

pub fn collection_ref_from_canonical_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !(trimmed.starts_with("[[") && trimmed.ends_with("]]")) {
        return None;
    }
    let target = normalize_collection_ref(trimmed);
    (!target.is_empty()).then_some(target)
}

pub fn collection_wikilink_value(collection_ref: &str) -> String {
    format!("[[{}]]", normalize_collection_ref(collection_ref))
}

pub fn validate_collection_ref(raw: &str) -> Result<String, String> {
    let collection_ref = normalize_collection_ref(raw);
    if collection_ref.is_empty() {
        return Err("collection ref is empty".to_string());
    }
    validate_slug(&collection_ref).map_err(|error| error.to_string())?;
    Ok(collection_ref)
}

/// A collection page found among the notes, with its manual position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CollectionPage {
    pub slug: String,
    #[serde(default)]
    pub position: Option<u32>,
}

/// One collection of a space: the reference cards use and how many name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CollectionCount {
    pub tag: String,
    pub block_count: usize,
}

/// The collections of a space from its notes alone, by the rule the index
/// follows: collection pages in their manual order (position, then name),
/// then collections that only cards name, most used first. `memberships`
/// holds each card's `Mine Collections`. A space read without an index (the
/// browser folder) lists the same collections the app does.
pub fn list_collections(pages: &[CollectionPage], memberships: &[Vec<String>]) -> Vec<CollectionCount> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for card in memberships {
        let refs: BTreeSet<String> = card
            .iter()
            .map(|raw| normalize_collection_ref(raw))
            .filter(|collection_ref| !collection_ref.is_empty())
            .collect();
        for collection_ref in refs {
            *counts.entry(collection_ref).or_insert(0) += 1;
        }
    }
    let page_slugs: BTreeSet<String> = pages.iter().map(|page| page.slug.clone()).collect();
    let mut listed: Vec<(u32, String)> = pages
        .iter()
        .map(|page| {
            (
                page.position.unwrap_or(u32::MAX),
                collection_ref_for_slug(&page.slug, &page_slugs),
            )
        })
        .collect();
    listed.sort();
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(listed.len() + counts.len());
    for (_, tag) in listed {
        if seen.insert(tag.clone()) {
            out.push(CollectionCount {
                block_count: counts.get(&tag).copied().unwrap_or(0),
                tag,
            });
        }
    }
    let mut named_only: Vec<(&String, &usize)> =
        counts.iter().filter(|(tag, _)| !seen.contains(*tag)).collect();
    named_only.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    out.extend(named_only.into_iter().map(|(tag, count)| CollectionCount {
        tag: tag.clone(),
        block_count: *count,
    }));
    out
}

pub fn render_collections(collections: &[String]) -> String {
    if collections.is_empty() {
        return format!("{MINE_COLLECTIONS_FIELD}: []\n");
    }

    let mut out = format!("{MINE_COLLECTIONS_FIELD}:\n");
    for collection in collections {
        let collection_ref = normalize_collection_ref(collection);
        if collection_ref.is_empty() {
            continue;
        }
        out.push_str("  - ");
        out.push_str(&yaml_quote(&collection_wikilink_value(&collection_ref)));
        out.push('\n');
    }
    if out == format!("{MINE_COLLECTIONS_FIELD}:\n") {
        return format!("{MINE_COLLECTIONS_FIELD}: []\n");
    }
    out
}

pub fn patch_collections_frontmatter(
    content: &str,
    collections: &[String],
) -> Result<String, String> {
    match frontmatter_bounds(content) {
        FrontmatterBounds::None => {
            if collections.is_empty() {
                return Ok(content.to_string());
            }
            Ok(format!(
                "---\n{}---\n{}",
                render_collections(collections),
                content
            ))
        }
        FrontmatterBounds::Valid {
            yaml_start,
            yaml_end,
            ..
        } => {
            let yaml = &content[yaml_start..yaml_end];
            if !yaml.trim().is_empty() && serde_yaml::from_str::<serde_yaml::Value>(yaml).is_err() {
                return Err("cannot safely patch collections: malformed frontmatter".to_string());
            }
            let patched_yaml = patch_collections_yaml(yaml, collections);
            let mut out = String::with_capacity(content.len() + patched_yaml.len());
            out.push_str(&content[..yaml_start]);
            out.push_str(&patched_yaml);
            out.push_str(&content[yaml_end..]);
            Ok(out)
        }
    }
}

/// Write the membership list into the YAML of a note. The block of the
/// `Mine Collections` key is replaced in place; user keys, comments and blank
/// lines around it stay.
pub(crate) fn patch_collections_yaml(yaml: &str, collections: &[String]) -> String {
    let newline = if yaml.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let has_legacy_tags = lines.iter().any(|line| is_top_level_key(line, "tags"));
    // Legacy `tags` once meant membership. An explicit empty list tells a
    // reader that membership now lives here and `tags` are the user's own.
    let replacement = (!collections.is_empty() || has_legacy_tags)
        .then(|| render_collections(collections).replace('\n', newline));
    if top_level_key_span(&lines, MINE_COLLECTIONS_FIELD).is_none() && collections.is_empty() && !has_legacy_tags {
        return yaml.to_string();
    }
    replace_top_level_key(yaml, MINE_COLLECTIONS_FIELD, replacement.as_deref(), newline)
}

fn yaml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_value_extracts_target() {
        assert_eq!(
            collection_ref_from_canonical_value("[[Красивый веб]]"),
            Some("Красивый веб".to_string())
        );
        assert_eq!(
            collection_ref_from_canonical_value("[[Research|Board]]"),
            Some("Research".to_string())
        );
        assert_eq!(collection_ref_from_canonical_value("research"), None);
    }

    #[test]
    fn render_collections_writes_quoted_wikilinks() {
        assert_eq!(
            render_collections(&["Красивый веб".to_string(), "Research".to_string()]),
            "Mine Collections:\n  - \"[[Красивый веб]]\"\n  - \"[[Research]]\"\n"
        );
    }

    #[test]
    fn patch_collections_frontmatter_inserts_minimal_frontmatter_for_foreign_markdown() {
        let input = "# Note\n\nBody";
        let output = patch_collections_frontmatter(input, &["Design".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\nMine Collections:\n  - \"[[Design]]\"\n---\n# Note\n\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_preserves_unknown_fields_and_obsidian_tags() {
        let input = "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\n---\nBody";
        let output =
            patch_collections_frontmatter(input, &["Design/Typography".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\naliases:\n  - A\n# keep me\ntags:\n  - old\ncssclasses: wide\nMine Collections:\n  - \"[[Design/Typography]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_keeps_comments_of_the_membership_block() {
        let input = "---\nMine Collections: # boards\n  - \"[[Design]]\" # main\n  # archived: Old board\n  - \"[[Research]]\"\nrating: 5\n---\nBody";
        let output = patch_collections_frontmatter(
            input,
            &["Design".to_string(), "Typography".to_string()],
        )
        .unwrap();
        assert_eq!(
            output,
            "---\nMine Collections: # boards\n  # archived: Old board\n  - \"[[Design]]\" # main\n  - \"[[Typography]]\"\nrating: 5\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_updates_existing_mine_collections() {
        let input = "---\ntags: design typography\nMine Collections:\n  - old\n---\nBody";
        let output = patch_collections_frontmatter(
            input,
            &[
                "Design".to_string(),
                "Typography".to_string(),
                "Local First".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            output,
            "---\ntags: design typography\nMine Collections:\n  - \"[[Design]]\"\n  - \"[[Typography]]\"\n  - \"[[Local First]]\"\n---\nBody"
        );
    }

    #[test]
    fn patch_collections_frontmatter_removes_collections_but_preserves_obsidian_tags() {
        let input = "---\ntags:\n  - old\nMine Collections:\n  - \"[[Design]]\"\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(
            output,
            "---\ntags:\n  - old\nMine Collections: []\n---\nBody"
        );
    }

    #[test]
    fn collections_list_pages_in_manual_order_then_named_only_by_use() {
        let pages = vec![
            CollectionPage { slug: "Collections/Travel".into(), position: Some(1) },
            CollectionPage { slug: "Collections/Art".into(), position: Some(0) },
            CollectionPage { slug: "Collections/Empty".into(), position: None },
        ];
        let memberships = vec![
            vec!["[[Travel]]".to_string(), "[[Recipes]]".to_string()],
            vec!["Recipes".to_string(), "[[Travel|Trips]]".to_string()],
            vec!["[[Books]]".to_string(), "[[Books]]".to_string()],
        ];
        assert_eq!(
            list_collections(&pages, &memberships),
            vec![
                CollectionCount { tag: "Art".into(), block_count: 0 },
                CollectionCount { tag: "Travel".into(), block_count: 2 },
                CollectionCount { tag: "Empty".into(), block_count: 0 },
                CollectionCount { tag: "Recipes".into(), block_count: 2 },
                CollectionCount { tag: "Books".into(), block_count: 1 },
            ]
        );
    }

    #[test]
    fn collection_ref_uses_the_document_name_not_its_folder() {
        // Cards tag themselves `[[Каталоги]]`, so a collection whose document
        // moved into a folder must keep answering to that name. Registering it
        // under the path split one collection into two in the sidebar: an empty
        // one from the document, a populated one from the cards.
        assert_eq!(collection_ref_from_slug("Collections/Каталоги"), "Каталоги");
        assert_eq!(collection_ref_from_slug("a/b/c/Design"), "Design");
        assert_eq!(collection_ref_from_slug("Каталоги"), "Каталоги");
        assert_eq!(collection_ref_from_slug("[[Collections/Design]]"), "Design");
        assert_eq!(collection_ref_from_slug(""), "");
    }

    #[test]
    fn duplicate_collection_names_keep_distinct_path_targets() {
        let slugs = BTreeSet::from([
            "Collections/Design".to_string(),
            "Archive/Design".to_string(),
            "Collections/Research".to_string(),
        ]);
        assert_eq!(
            collection_ref_for_slug("Collections/Design", &slugs),
            "Collections/Design"
        );
        assert_eq!(
            collection_ref_for_slug("Archive/Design", &slugs),
            "Archive/Design"
        );
        assert_eq!(
            collection_ref_for_slug("Collections/Research", &slugs),
            "Research"
        );
    }
}
