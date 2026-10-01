// Shared, portable collection helpers.
//
// Mine collection membership is stored as Obsidian wikilinks in the
// `Mine Collections` frontmatter field. Runtime identity is the wikilink
// target, not a normalized tag.

use crate::domain::block::{parse_markdown_document, DateTime};
use crate::domain::source_patch::{
    body_of, is_top_level_key, properties_layout, replace_top_level_key, source_shape,
    top_level_key_span, verify_other_properties, PropertiesLayout, SourcePatchError, SourceShape,
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

/// Write `collections` as the membership of the note `content`, keeping every
/// other byte (`SPEC_AUDIT_FIXES.md`, Ф1).
///
/// The result is read back before it is returned: it must hold exactly the
/// membership asked for, every other property and the body as they were.
///
/// # Errors
///
/// Properties that are not valid YAML properties (`MalformedFrontmatter`),
/// that cannot take the change in their own layout (`UnsupportedLayout`), or
/// whose patched text reads back differently (`RoundTrip`) are refused rather
/// than rewritten in another form.
pub fn patch_collections_frontmatter(
    content: &str,
    collections: &[String],
) -> Result<String, SourcePatchError> {
    let patched = match source_shape(content) {
        SourceShape::Plain if collections.is_empty() => content.to_string(),
        SourceShape::Plain => format!("---\n{}---\n{}", render_collections(collections), content),
        SourceShape::Malformed => {
            return Err(SourcePatchError::MalformedFrontmatter {
                field: MINE_COLLECTIONS_FIELD,
            })
        }
        SourceShape::Structured {
            yaml_start,
            yaml_end,
            ..
        } => {
            let patched_yaml = patch_collections_yaml(&content[yaml_start..yaml_end], collections)?;
            let mut out = String::with_capacity(content.len() + patched_yaml.len());
            out.push_str(&content[..yaml_start]);
            out.push_str(&patched_yaml);
            out.push_str(&content[yaml_end..]);
            out
        }
    };
    verify_membership_patch(content, &patched, collections)?;
    Ok(patched)
}

/// Write the membership list into the YAML of a note. The value of the
/// `Mine Collections` key is replaced in place, in the layout the properties
/// are written in; user keys, comments and blank lines around it stay.
pub(crate) fn patch_collections_yaml(
    yaml: &str,
    collections: &[String],
) -> Result<String, SourcePatchError> {
    let unsupported = SourcePatchError::UnsupportedLayout {
        field: MINE_COLLECTIONS_FIELD,
    };
    match properties_layout(yaml) {
        PropertiesLayout::Block => Ok(patch_block_collections(yaml, collections)),
        PropertiesLayout::Flow(mapping) => {
            let patched = if collections.is_empty() && !mapping.has_key(LEGACY_TAGS_FIELD) {
                // Removing the entry would take a comment beside it out; an
                // explicit empty list leaves the comment and says the same.
                mapping
                    .remove_key(yaml, MINE_COLLECTIONS_FIELD)
                    .or_else(|| mapping.set_key(yaml, MINE_COLLECTIONS_FIELD, "[]"))
            } else {
                mapping.set_key(yaml, MINE_COLLECTIONS_FIELD, &render_collections_flow(collections))
            };
            patched.ok_or(unsupported)
        }
        PropertiesLayout::UnreadableFlow => Err(unsupported),
    }
}

/// The key that held membership before `Mine Collections`.
const LEGACY_TAGS_FIELD: &str = "tags";

/// Membership in block-style properties: the block of the key is replaced.
fn patch_block_collections(yaml: &str, collections: &[String]) -> String {
    let newline = if yaml.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let has_legacy_tags = lines.iter().any(|line| is_top_level_key(line, LEGACY_TAGS_FIELD));
    // Legacy `tags` once meant membership. An explicit empty list tells a
    // reader that membership now lives here and `tags` are the user's own.
    let replacement = (!collections.is_empty() || has_legacy_tags)
        .then(|| render_collections(collections).replace('\n', newline));
    if top_level_key_span(&lines, MINE_COLLECTIONS_FIELD).is_none() && collections.is_empty() && !has_legacy_tags {
        return yaml.to_string();
    }
    replace_top_level_key(yaml, MINE_COLLECTIONS_FIELD, replacement.as_deref(), newline)
}

/// The membership list as a flow sequence: `["[[A]]", "[[B]]"]`.
fn render_collections_flow(collections: &[String]) -> String {
    let items: Vec<String> = collections
        .iter()
        .map(|collection| normalize_collection_ref(collection))
        .filter(|collection_ref| !collection_ref.is_empty())
        .map(|collection_ref| yaml_quote(&collection_wikilink_value(&collection_ref)))
        .collect();
    format!("[{}]", items.join(", "))
}

/// Slug the patched note is read back under; the membership does not depend
/// on it.
const READ_BACK_SLUG: &str = "note";
/// `saved_at` for reading back a note that has none; it is not compared.
const READ_BACK_SAVED_AT: &str = "1970-01-01T00:00:00Z";

/// Read `patched` back: Mine must read exactly `collections` as its
/// membership, and every other property and the body must be as in `source`.
fn verify_membership_patch(
    source: &str,
    patched: &str,
    collections: &[String],
) -> Result<(), SourcePatchError> {
    let round_trip = |field| SourcePatchError::RoundTrip { field };
    verify_other_properties(source, patched, &[MINE_COLLECTIONS_FIELD])?;
    if body_of(source) != body_of(patched) {
        return Err(round_trip("body"));
    }
    let saved_at = DateTime::new(READ_BACK_SAVED_AT).map_err(|_| round_trip("saved_at"))?;
    let read = parse_markdown_document(READ_BACK_SLUG, patched, saved_at)
        .map_err(|_| round_trip("frontmatter"))?;
    let mut intended: Vec<String> = Vec::with_capacity(collections.len());
    for collection_ref in collections.iter().map(|collection| normalize_collection_ref(collection)) {
        if !collection_ref.is_empty() && !intended.contains(&collection_ref) {
            intended.push(collection_ref);
        }
    }
    if read.block.frontmatter.tags != intended {
        return Err(round_trip(MINE_COLLECTIONS_FIELD));
    }
    Ok(())
}

fn yaml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::source_patch::{frontmatter_bounds, FrontmatterBounds};

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

    /// The properties of `note` as YAML reads them, and the membership Mine
    /// reads from the note.
    fn read_back(note: &str) -> (serde_yaml::Mapping, Vec<String>) {
        let FrontmatterBounds::Valid {
            yaml_start,
            yaml_end,
            ..
        } = frontmatter_bounds(note)
        else {
            panic!("the note lost its properties:\n{note}");
        };
        let properties = match serde_yaml::from_str::<serde_yaml::Value>(&note[yaml_start..yaml_end])
        {
            Ok(serde_yaml::Value::Mapping(mapping)) => mapping,
            other => panic!("the properties are not valid YAML ({other:?}):\n{note}"),
        };
        let parsed = crate::domain::block::parse_markdown_document(
            "Note",
            note,
            crate::domain::block::DateTime::new("2026-01-01").unwrap(),
        )
        .unwrap();
        assert_eq!(parsed.origin, "partial_frontmatter", "{note}");
        (properties, parsed.block.frontmatter.tags)
    }

    #[test]
    fn flow_mapping_properties_take_membership_inside_the_braces() {
        let input = "---\n{aliases: [A]}\n---\nBody";
        let output = patch_collections_frontmatter(input, &["Design".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\n{aliases: [A], Mine Collections: [\"[[Design]]\"]}\n---\nBody"
        );
        let (properties, membership) = read_back(&output);
        assert_eq!(membership, vec!["Design"]);
        assert_eq!(
            properties.get("aliases"),
            Some(&serde_yaml::Value::Sequence(vec!["A".into()]))
        );
    }

    #[test]
    fn flow_mapping_membership_is_replaced_in_place() {
        let input = "---\n{\"Mine Collections\": [\"[[Old]]\"], aliases: [A]} # flow\n---\nBody";
        let output = patch_collections_frontmatter(input, &["New".to_string(), "Old".to_string()])
            .unwrap();
        assert_eq!(
            output,
            "---\n{\"Mine Collections\": [\"[[New]]\", \"[[Old]]\"], aliases: [A]} # flow\n---\nBody"
        );
        assert_eq!(read_back(&output).1, vec!["New", "Old"]);
    }

    #[test]
    fn multi_line_flow_mapping_keeps_its_lines_and_comments() {
        let input = "---\n{\n  aliases: [A], # names\n  rating: 5\n}\n---\nBody";
        let output = patch_collections_frontmatter(input, &["Design".to_string()]).unwrap();
        assert_eq!(
            output,
            "---\n{\n  aliases: [A], # names\n  rating: 5, Mine Collections: [\"[[Design]]\"]\n}\n---\nBody"
        );
        assert_eq!(read_back(&output).1, vec!["Design"]);
    }

    #[test]
    fn last_membership_leaves_a_flow_mapping_as_it_was_before() {
        for (with, without) in [
            ("{aliases: [A], Mine Collections: [\"[[Old]]\"]}", "{aliases: [A]}"),
            ("{Mine Collections: [\"[[Old]]\"], aliases: [A]}", "{aliases: [A]}"),
            ("{Mine Collections: [\"[[Old]]\"]}", "{}"),
            (
                "{\n  aliases: [A],\n  Mine Collections: [\"[[Old]]\"],\n  rating: 5\n}",
                "{\n  aliases: [A],\n  rating: 5\n}",
            ),
            (
                "{\n  aliases: [A],\n  Mine Collections: [\"[[Old]]\"]\n}",
                "{\n  aliases: [A]\n}",
            ),
        ] {
            let output = patch_collections_frontmatter(&format!("---\n{with}\n---\nBody"), &[]).unwrap();
            assert_eq!(output, format!("---\n{without}\n---\nBody"));
            assert!(read_back(&output).1.is_empty());
        }
    }

    #[test]
    fn flow_membership_next_to_a_comment_is_emptied_not_removed() {
        let input = "---\n{\n  aliases: [A], # names\n  Mine Collections: [\"[[Old]]\"]\n}\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(
            output,
            "---\n{\n  aliases: [A], # names\n  Mine Collections: []\n}\n---\nBody"
        );
        assert!(read_back(&output).1.is_empty());
    }

    #[test]
    fn flow_mapping_with_legacy_tags_gets_an_explicit_empty_membership() {
        let input = "---\n{tags: [old]}\n---\nBody";
        let output = patch_collections_frontmatter(input, &[]).unwrap();
        assert_eq!(output, "---\n{tags: [old], Mine Collections: []}\n---\nBody");
    }

    #[test]
    fn membership_value_holding_a_comment_is_refused_not_rewritten() {
        let input = "---\n{\n  Mine Collections: [ # boards\n    \"[[Old]]\"],\n  aliases: [A]\n}\n---\nBody";
        assert_eq!(
            patch_collections_frontmatter(input, &["New".to_string()]),
            Err(SourcePatchError::UnsupportedLayout {
                field: MINE_COLLECTIONS_FIELD
            })
        );
    }

    #[test]
    fn properties_the_writer_would_break_are_refused() {
        // Valid YAML whose keys do not start their lines: an appended key
        // would end the mapping early.
        let input = "---\n  aliases: [A]\n  rating: 5\n---\nBody";
        assert_eq!(
            patch_collections_frontmatter(input, &["Design".to_string()]),
            Err(SourcePatchError::RoundTrip {
                field: "frontmatter"
            })
        );
    }

    #[test]
    fn properties_that_are_not_a_mapping_are_refused() {
        let input = "---\njust a line of text\n---\nBody";
        assert_eq!(
            patch_collections_frontmatter(input, &["Design".to_string()]),
            Err(SourcePatchError::MalformedFrontmatter {
                field: MINE_COLLECTIONS_FIELD
            })
        );
    }

    #[test]
    fn membership_write_never_leaves_properties_yaml_cannot_read() {
        let inputs = [
            "---\n{aliases: [A]}\n---\nBody",
            "---\n{}\n---\nBody",
            "---\n{aliases: [A], Mine Collections: [\"[[Old]]\"]}\n---\nBody",
            "---\n{\n  aliases: [A], # names\n  rating: 5\n}\n---\nBody",
            "---\n{aliases: [A]} # flow\n---\nBody",
            "---\n  aliases: [A]\n  rating: 5\n---\nBody",
            "---\naliases: [A]\n---\nBody",
        ];
        for input in inputs {
            for collections in [vec!["Design".to_string()], Vec::new()] {
                // A refusal leaves the note to its owner; a write must read
                // back as the membership asked for.
                if let Ok(output) = patch_collections_frontmatter(input, &collections) {
                    let (_, membership) = read_back(&output);
                    assert_eq!(membership, collections, "{input:?} -> {output:?}");
                }
            }
        }
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
