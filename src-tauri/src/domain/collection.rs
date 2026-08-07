// Collection helpers.
//
// Mine collection membership is stored as Obsidian wikilinks in the
// `Mine Collections` frontmatter field. Runtime identity is the wikilink
// target, not a normalized tag.

use crate::domain::vault::validate_slug;

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
        FrontmatterBounds::Malformed => {
            Err("cannot safely patch collections: malformed frontmatter".to_string())
        }
        FrontmatterBounds::Valid {
            yaml_start,
            yaml_end,
            closing_start,
        } => {
            let yaml = &content[yaml_start..yaml_end];
            if !yaml.trim().is_empty() && serde_yaml::from_str::<serde_yaml::Value>(yaml).is_err() {
                return Err("cannot safely patch collections: malformed frontmatter".to_string());
            }
            let patched_yaml = patch_collections_yaml(yaml, collections)?;
            let mut out = String::with_capacity(content.len() + patched_yaml.len());
            out.push_str(&content[..yaml_start]);
            out.push_str(&patched_yaml);
            out.push_str(&content[closing_start..]);
            Ok(out)
        }
    }
}

enum FrontmatterBounds {
    None,
    Malformed,
    Valid {
        yaml_start: usize,
        yaml_end: usize,
        closing_start: usize,
    },
}

fn frontmatter_bounds(content: &str) -> FrontmatterBounds {
    let Some(first_line_end) = content.find('\n') else {
        return if content.trim_end_matches('\r') == "---" {
            FrontmatterBounds::Malformed
        } else {
            FrontmatterBounds::None
        };
    };
    if content[..first_line_end].trim_end_matches('\r') != "---" {
        return FrontmatterBounds::None;
    }

    let yaml_start = first_line_end + 1;
    let mut cursor = yaml_start;
    for (idx, line) in content[yaml_start..].split_inclusive('\n').enumerate() {
        if idx >= 20 {
            return FrontmatterBounds::None;
        }
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return FrontmatterBounds::Valid {
                yaml_start,
                yaml_end: cursor,
                closing_start: cursor,
            };
        }
        cursor += line.len();
    }
    FrontmatterBounds::None
}

fn patch_collections_yaml(yaml: &str, collections: &[String]) -> Result<String, String> {
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let mut start = None;
    let mut has_legacy_tags = false;
    for (idx, line) in lines.iter().enumerate() {
        if is_top_level_collection_key(line) {
            start = Some(idx);
            break;
        }
        if is_top_level_legacy_tags_key(line) {
            has_legacy_tags = true;
        }
    }

    let Some(start_idx) = start else {
        if collections.is_empty() {
            if has_legacy_tags {
                let mut out = yaml.to_string();
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&render_collections(collections));
                return Ok(out);
            }
            return Ok(yaml.to_string());
        }
        let mut out = yaml.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&render_collections(collections));
        return Ok(out);
    };

    let mut end_idx = start_idx + 1;
    while end_idx < lines.len() {
        let line = lines[end_idx];
        let trimmed = line.trim();
        if trimmed.is_empty() || line.starts_with(' ') || line.starts_with('\t') {
            end_idx += 1;
            continue;
        }
        break;
    }

    let mut out = String::new();
    for line in &lines[..start_idx] {
        if is_top_level_legacy_tags_key(line) {
            has_legacy_tags = true;
        }
        out.push_str(line);
    }
    if !collections.is_empty() || has_legacy_tags {
        out.push_str(&render_collections(collections));
    }
    for line in &lines[end_idx..] {
        out.push_str(line);
    }
    Ok(out)
}

fn is_top_level_collection_key(line: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    line == format!("{MINE_COLLECTIONS_FIELD}:")
        || line.starts_with(&format!("{MINE_COLLECTIONS_FIELD}: "))
}

fn is_top_level_legacy_tags_key(line: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    line == "tags:" || line.starts_with("tags: ")
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
}
