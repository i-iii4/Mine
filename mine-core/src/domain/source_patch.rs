// Source-preserving writes of an existing Markdown note.
//
// Contract: SPEC_AUDIT_FIXES.md, Ф1.
//
// `Block` is a read model: a closed set of Mine fields plus the body. Writing
// it back with `serialize_block` rebuilds the note from that model and drops
// everything the model does not know: user properties (`aliases`, `rating`,
// Obsidian `tags`), YAML comments, blank lines, the order of keys. An
// operation that changes an existing note goes through `apply_block_changes`
// instead: only the Mine fields and the body the operation changed are
// carried into the original text, and every other byte stays where it was.

use thiserror::Error;

use crate::domain::block::{
    parse_markdown_document, render_frontmatter_fields, serialize_frontmatter, Block,
    Frontmatter, MINE_FRONTMATTER_KEYS,
};
use crate::domain::collection::{patch_collections_yaml, MINE_COLLECTIONS_FIELD};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SourcePatchError {
    /// The note's fenced block is not valid YAML properties; a field cannot be
    /// placed into it without guessing at the user's intent.
    #[error("cannot change {field}: the note's frontmatter is not valid YAML")]
    MalformedFrontmatter { field: &'static str },

    /// The patched text reads back differently from the intended model.
    #[error("the patched note reads back with a different {field}")]
    RoundTrip { field: &'static str },
}

/// Where the frontmatter of a note sits, by byte offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontmatterBounds {
    /// No opening fence, or an opening fence that never closes: the whole
    /// text is body (a leading `---` is then a horizontal rule).
    None,
    Valid {
        /// First byte of the YAML, right after the opening fence line.
        yaml_start: usize,
        /// First byte of the closing fence line.
        yaml_end: usize,
        /// First byte after the closing fence line.
        body_start: usize,
    },
}

/// Find the frontmatter fences the way Obsidian does: the first line is `---`
/// and the block runs to the next `---` line, however long it is.
pub fn frontmatter_bounds(content: &str) -> FrontmatterBounds {
    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return FrontmatterBounds::None;
    };
    if first.trim_end_matches(['\r', '\n']) != "---" || !first.ends_with('\n') {
        return FrontmatterBounds::None;
    }
    let yaml_start = first.len();
    let mut cursor = yaml_start;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return FrontmatterBounds::Valid {
                yaml_start,
                yaml_end: cursor,
                body_start: cursor + line.len(),
            };
        }
        cursor += line.len();
    }
    FrontmatterBounds::None
}

/// Carry the changes between `before` and `after` into `source`.
///
/// `before` is the note as it was read from `source`; `after` is the same
/// note after the operation. A Mine field is written only when its rendering
/// differs between the two, the body only when it differs. A note without
/// frontmatter gets one only when a field actually changed, and then only
/// with the changed fields: no `saved_at` is invented for a plain note.
///
/// The result is verified by reading it back: every Mine field and the body
/// must come out as `after` says, otherwise the patch is refused rather than
/// written.
pub fn apply_block_changes(
    source: &str,
    before: &Block,
    after: &Block,
) -> Result<String, SourcePatchError> {
    let before_fields = render_frontmatter_fields(&before.frontmatter);
    let after_fields = render_frontmatter_fields(&after.frontmatter);
    let changed: Vec<usize> = (0..MINE_FRONTMATTER_KEYS.len())
        .filter(|&index| before_fields[index] != after_fields[index])
        .collect();
    let body_changed = before.body != after.body;
    if changed.is_empty() && !body_changed {
        return Ok(source.to_string());
    }

    let shape = source_shape(source);
    let patched = match shape {
        SourceShape::Structured {
            yaml_start,
            yaml_end,
            body_start,
        } => {
            let mut yaml = source[yaml_start..yaml_end].to_string();
            let newline = if yaml.contains("\r\n") { "\r\n" } else { "\n" };
            for &index in &changed {
                yaml = patch_field(&yaml, index, &after.frontmatter, &after_fields, newline);
            }
            let body = if body_changed {
                after.body.as_str()
            } else {
                &source[body_start..]
            };
            let mut out = String::with_capacity(source.len() + 64);
            out.push_str(&source[..yaml_start]);
            out.push_str(&yaml);
            out.push_str(&source[yaml_end..body_start]);
            out.push_str(body);
            out
        }
        SourceShape::Plain | SourceShape::Malformed => {
            if let (SourceShape::Malformed, Some(&index)) = (shape, changed.first()) {
                return Err(SourcePatchError::MalformedFrontmatter {
                    field: MINE_FRONTMATTER_KEYS[index],
                });
            }
            let body = if body_changed { after.body.as_str() } else { source };
            if changed.is_empty() {
                body.to_string()
            } else {
                let mut yaml = String::new();
                for &index in &changed {
                    yaml = patch_field(&yaml, index, &after.frontmatter, &after_fields, "\n");
                }
                if yaml.is_empty() {
                    // The change removes a field the note never had.
                    body.to_string()
                } else {
                    format!("---\n{yaml}---\n{body}")
                }
            }
        }
    };

    verify_round_trip(&patched, after)?;
    Ok(patched)
}

#[derive(Debug, Clone, Copy)]
enum SourceShape {
    /// Fenced YAML properties followed by the body.
    Structured {
        yaml_start: usize,
        yaml_end: usize,
        body_start: usize,
    },
    /// No frontmatter: the whole text is body.
    Plain,
    /// Fences around text that is not YAML properties: read as body, but a
    /// field cannot be placed into it.
    Malformed,
}

fn source_shape(source: &str) -> SourceShape {
    match frontmatter_bounds(source) {
        FrontmatterBounds::None => SourceShape::Plain,
        FrontmatterBounds::Valid {
            yaml_start,
            yaml_end,
            body_start,
        } => {
            let yaml = &source[yaml_start..yaml_end];
            let is_properties = yaml.trim().is_empty()
                || matches!(
                    serde_yaml::from_str::<serde_yaml::Value>(yaml),
                    Ok(serde_yaml::Value::Mapping(_) | serde_yaml::Value::Null)
                );
            if is_properties {
                SourceShape::Structured {
                    yaml_start,
                    yaml_end,
                    body_start,
                }
            } else {
                SourceShape::Malformed
            }
        }
    }
}

/// Write one Mine field into `yaml`: replace its key block in place, remove
/// it, or append it at the end when the note did not have it.
fn patch_field(
    yaml: &str,
    index: usize,
    frontmatter: &Frontmatter,
    rendered: &[Option<String>],
    newline: &str,
) -> String {
    let key = MINE_FRONTMATTER_KEYS[index];
    if key == MINE_COLLECTIONS_FIELD {
        // Membership has one writer, shared with the collection toggles.
        return patch_collections_yaml(yaml, &frontmatter.tags);
    }
    let replacement = rendered[index]
        .as_ref()
        .map(|value| format!("{}{newline}", value.replace('\n', newline)));
    replace_top_level_key(yaml, key, replacement.as_deref(), newline)
}

/// Replace the block of a top-level key (its line and value lines) with
/// `replacement`, remove it when `replacement` is `None`, or append
/// `replacement` when the key is absent. Every other line is kept as is.
pub(crate) fn replace_top_level_key(
    yaml: &str,
    key: &str,
    replacement: Option<&str>,
    newline: &str,
) -> String {
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    match top_level_key_span(&lines, key) {
        Some((start, end)) => {
            let mut out = String::with_capacity(yaml.len());
            for line in &lines[..start] {
                out.push_str(line);
            }
            if let Some(replacement) = replacement {
                out.push_str(replacement);
            }
            for line in &lines[end..] {
                out.push_str(line);
            }
            out
        }
        None => {
            let mut out = yaml.to_string();
            if let Some(replacement) = replacement {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push_str(newline);
                }
                out.push_str(replacement);
            }
            out
        }
    }
}

/// Line range `[start, end)` of a top-level key and the lines of its value:
/// indented lines and a sequence written at column zero. Blank lines belong
/// to the value only when more of the value follows them; blank lines after
/// the value stay with the note.
pub(crate) fn top_level_key_span(lines: &[&str], key: &str) -> Option<(usize, usize)> {
    let start = lines.iter().position(|line| is_top_level_key(line, key))?;
    let mut end = start + 1;
    let mut cursor = start + 1;
    while cursor < lines.len() {
        let line = lines[cursor];
        let text = line.trim_end_matches(['\r', '\n']);
        if text.trim().is_empty() {
            cursor += 1;
            continue;
        }
        let continues = line.starts_with(' ')
            || line.starts_with('\t')
            || text == "-"
            || text.starts_with("- ");
        if !continues {
            break;
        }
        cursor += 1;
        end = cursor;
    }
    Some((start, end))
}

/// Whether `line` opens the top-level key `key`, written bare or quoted.
pub(crate) fn is_top_level_key(line: &str, key: &str) -> bool {
    let text = line.trim_end_matches(['\r', '\n']);
    [
        key.to_string(),
        format!("\"{key}\""),
        format!("'{key}'"),
    ]
    .iter()
    .any(|form| {
        text.strip_prefix(form.as_str())
            .and_then(|rest| rest.strip_prefix(':'))
            .is_some_and(|value| value.is_empty() || value.starts_with([' ', '\t']))
    })
}

/// Read the patched text back and compare it with the intended model.
fn verify_round_trip(patched: &str, after: &Block) -> Result<(), SourcePatchError> {
    let parsed = parse_markdown_document(&after.slug, patched, after.frontmatter.saved_at.clone())
        .map_err(|_| SourcePatchError::RoundTrip {
            field: "frontmatter",
        })?;
    if parsed.block.body != after.body {
        return Err(SourcePatchError::RoundTrip { field: "body" });
    }
    // Compare through the same parser on both sides: the intended model is
    // rendered as a fresh note and read back, so both sides carry the
    // parser's normalization (deduplicated collections, attachment targets).
    let intended = format!("---\n{}\n---\n", serialize_frontmatter(&after.frontmatter));
    let intended = parse_markdown_document(&after.slug, &intended, after.frontmatter.saved_at.clone())
        .map_err(|_| SourcePatchError::RoundTrip {
            field: "frontmatter",
        })?;
    let actual_fields = render_frontmatter_fields(&parsed.block.frontmatter);
    let intended_fields = render_frontmatter_fields(&intended.block.frontmatter);
    for index in 0..MINE_FRONTMATTER_KEYS.len() {
        if actual_fields[index] != intended_fields[index] {
            return Err(SourcePatchError::RoundTrip {
                field: MINE_FRONTMATTER_KEYS[index],
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::DateTime;

    fn read(slug: &str, source: &str) -> Block {
        parse_markdown_document(slug, source, DateTime::new("2026-01-01T00:00:00Z").unwrap())
            .unwrap()
            .block
    }

    #[test]
    fn bounds_have_no_line_limit() {
        let mut source = String::from("---\n");
        for index in 0..40 {
            source.push_str(&format!("key{index}: {index}\n"));
        }
        source.push_str("saved_at: 2026-01-01\n---\nBody");
        let FrontmatterBounds::Valid { body_start, .. } = frontmatter_bounds(&source) else {
            panic!("a long frontmatter is still a frontmatter");
        };
        assert_eq!(&source[body_start..], "Body");
    }

    #[test]
    fn unclosed_fence_is_body() {
        assert_eq!(frontmatter_bounds("---\ntext"), FrontmatterBounds::None);
        assert_eq!(frontmatter_bounds("---"), FrontmatterBounds::None);
        assert_eq!(frontmatter_bounds("# Note"), FrontmatterBounds::None);
    }

    #[test]
    fn unchanged_model_returns_source_byte_for_byte() {
        let source = "---\n# comment\nrating: 5\ntitle: A\n\nsaved_at: 2026-01-01\n---\nBody\n\n\n\nEnd";
        let before = read("Note", source);
        assert_eq!(
            apply_block_changes(source, &before, &before.clone()).unwrap(),
            source
        );
    }

    #[test]
    fn changed_field_keeps_unknown_keys_comments_order_and_blank_lines() {
        let source = "---\naliases:\n  - Foo\n# a comment\ntags:\n  - personal\nfile: \"[[old.jpg]]\"\n\nrating: 5\nsaved_at: 2026-01-01\n---\nBody\n\n\n\nEnd";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.file = Some("new.jpg".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\naliases:\n  - Foo\n# a comment\ntags:\n  - personal\nfile: \"[[new.jpg]]\"\n\nrating: 5\nsaved_at: 2026-01-01\n---\nBody\n\n\n\nEnd"
        );
    }

    #[test]
    fn multi_line_field_is_replaced_as_a_whole_block() {
        let source = "---\nMine Related Notes:\n  - \"[[Old]]\"\n  - \"[[Other]]\"\n\nrating: 5\nsaved_at: 2026-01-01\n---\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.related_notes = vec!["New".to_string(), "Other".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nMine Related Notes:\n  - \"[[New]]\"\n  - \"[[Other]]\"\n\nrating: 5\nsaved_at: 2026-01-01\n---\nBody"
        );
    }

    #[test]
    fn removed_field_takes_only_its_own_lines() {
        let source = "---\nthumbnail: a.jpg\n# keep\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.thumbnail = None;
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\n# keep\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn missing_field_is_appended_at_the_end_of_the_properties() {
        let source = "---\nrating: 5\nsaved_at: 2026-01-01\n---\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.position = Some(3);
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nrating: 5\nsaved_at: 2026-01-01\nposition: 3\n---\nBody"
        );
    }

    #[test]
    fn body_change_leaves_frontmatter_bytes_alone() {
        let source = "---\nrating: 5   # stars\nsaved_at: 2026-01-01\n---\nSee [[Old]].\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.body = "See [[New]].\n".to_string();
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nrating: 5   # stars\nsaved_at: 2026-01-01\n---\nSee [[New]].\n"
        );
    }

    #[test]
    fn plain_note_gets_no_frontmatter_for_a_body_change() {
        let source = "# Title\n\nSee [[Old]].";
        let before = read("Note", source);
        let mut after = before.clone();
        after.body = "# Title\n\nSee [[New]].".to_string();
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "# Title\n\nSee [[New]]."
        );
    }

    #[test]
    fn plain_note_gets_only_the_changed_field_without_saved_at() {
        let source = "# Title\n\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.related_notes = vec!["Source".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nMine Related Notes:\n  - \"[[Source]]\"\n---\n# Title\n\nBody"
        );
    }

    #[test]
    fn collections_change_goes_through_the_membership_writer() {
        let source = "---\ntags:\n  - personal\nMine Collections:\n  - \"[[Old]]\"\nrating: 5\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.tags = vec!["New".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\ntags:\n  - personal\nMine Collections:\n  - \"[[New]]\"\nrating: 5\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn crlf_note_keeps_its_line_endings() {
        let source = "---\r\nrating: 5\r\nfile: \"[[a.jpg]]\"\r\nsaved_at: 2026-01-01\r\n---\r\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.file = Some("b.jpg".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\r\nrating: 5\r\nfile: \"[[b.jpg]]\"\r\nsaved_at: 2026-01-01\r\n---\r\nBody"
        );
    }

    #[test]
    fn quoted_key_is_found() {
        let source = "---\n\"thumbnail\": a.jpg\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.thumbnail = Some("b.jpg".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nthumbnail: b.jpg\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn malformed_frontmatter_refuses_a_field_change_but_allows_a_body_change() {
        let source = "---\ntitle: [unclosed\n---\nSee [[Old]].";
        let before = read("Note", source);
        let mut field = before.clone();
        field.frontmatter.thumbnail = Some("a.jpg".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &field),
            Err(SourcePatchError::MalformedFrontmatter { field: "thumbnail" })
        );
        let mut body = before.clone();
        body.body = before.body.replace("[[Old]]", "[[New]]");
        assert_eq!(
            apply_block_changes(source, &before, &body).unwrap(),
            "---\ntitle: [unclosed\n---\nSee [[New]]."
        );
    }

    #[test]
    fn long_frontmatter_is_patched_in_place_not_duplicated() {
        let mut source = String::from("---\n");
        for index in 0..30 {
            source.push_str(&format!("prop{index}: {index}\n"));
        }
        source.push_str("thumbnail: a.jpg\nsaved_at: 2026-01-01\n---\nBody");
        let before = read("Note", &source);
        let mut after = before.clone();
        after.frontmatter.thumbnail = Some("b.jpg".to_string());
        let patched = apply_block_changes(&source, &before, &after).unwrap();
        assert_eq!(patched, source.replace("thumbnail: a.jpg", "thumbnail: b.jpg"));
        assert_eq!(patched.matches("---\n").count(), 2);
    }

    #[test]
    fn channel_marker_is_added_and_removed_as_a_field() {
        let source = "---\nsaved_at: 2026-01-01\nrating: 5\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.block_type = crate::domain::block::BlockType::Channel;
        let patched = apply_block_changes(source, &before, &after).unwrap();
        assert_eq!(patched, "---\nsaved_at: 2026-01-01\nrating: 5\ntype: channel\n---\n");
        let reread = read("Note", &patched);
        assert_eq!(apply_block_changes(&patched, &reread, &before).unwrap(), source);
    }

    #[test]
    fn horizontal_rules_are_not_properties() {
        let source = "---\nIntro paragraph.\n---\nRest";
        let block = read("Note", source);
        assert_eq!(block.body, source);
    }
}
