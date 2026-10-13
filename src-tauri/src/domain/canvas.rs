//! What an Obsidian canvas (`.canvas`, the JSON Canvas format) names as files
//! of the space (SPEC_DEEP_AUDIT.md, Н5, Е5.6).
//!
//! Pure: the caller reads the canvas and resolves what it names. A canvas is
//! a JSON object whose `nodes` hold the cards on the board. Three kinds name
//! a file: a file node by its `file`, a group by its `background` image, and
//! a text node by the links and embeds of its Markdown `text`. Links, edges
//! and anything unknown name none.

use serde_json::Value;

use crate::domain::block::{iter_file_references, FileReference};

/// The files one canvas names.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CanvasFileReferences {
    /// Paths from the space root, as Obsidian writes them for file nodes
    /// and group backgrounds.
    pub root_paths: Vec<String>,
    /// The references in the Markdown of text nodes. Obsidian reads them as
    /// it reads a note's: a wikilink by name, a Markdown path from the
    /// canvas's folder.
    pub text_references: Vec<FileReference>,
}

/// The files the canvas `json` names, in node order. A canvas that is not a
/// JSON object, or has no `nodes`, names none; a node of a shape this does
/// not know is skipped, not refused.
///
/// # Errors
///
/// The text is not JSON.
pub fn canvas_file_references(json: &str) -> Result<CanvasFileReferences, serde_json::Error> {
    let canvas: Value = serde_json::from_str(json)?;
    let mut found = CanvasFileReferences::default();
    let Some(nodes) = canvas.get("nodes").and_then(Value::as_array) else {
        return Ok(found);
    };
    for node in nodes {
        let text_field = |key: &str| {
            node.get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        };
        match node.get("type").and_then(Value::as_str) {
            Some("file") => found.root_paths.extend(text_field("file").map(str::to_string)),
            Some("group") => found
                .root_paths
                .extend(text_field("background").map(str::to_string)),
            Some("text") => {
                if let Some(text) = text_field("text") {
                    found.text_references.extend(iter_file_references(text));
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(references: &[FileReference]) -> Vec<&str> {
        references.iter().map(|reference| reference.target.as_str()).collect()
    }

    #[test]
    fn file_nodes_group_backgrounds_and_text_embeds_name_files() {
        let json = r##"{
            "nodes": [
                {"id": "a", "type": "file", "file": "Media/photo one.jpg", "x": 0, "y": 0, "width": 10, "height": 10},
                {"id": "b", "type": "group", "label": "Board", "background": "Media/bg.png"},
                {"id": "c", "type": "text", "text": "Look: ![[shot.png]] and [doc](../Docs/a%20b.pdf)"},
                {"id": "d", "type": "link", "url": "https://example.com/x.jpg"},
                {"id": "e", "type": "file", "file": "Cards/Note.md", "subpath": "#Part"}
            ],
            "edges": [{"id": "f", "fromNode": "a", "toNode": "b"}]
        }"##;

        let found = canvas_file_references(json).unwrap();

        assert_eq!(found.root_paths, ["Media/photo one.jpg", "Media/bg.png", "Cards/Note.md"]);
        assert_eq!(targets(&found.text_references), ["shot.png", "../Docs/a b.pdf"]);
    }

    #[test]
    fn a_canvas_without_nodes_or_with_odd_nodes_names_nothing() {
        assert_eq!(canvas_file_references("{}").unwrap(), CanvasFileReferences::default());
        assert_eq!(canvas_file_references("[]").unwrap(), CanvasFileReferences::default());
        let odd = r#"{"nodes": [1, "x", {"type": "file"}, {"type": "file", "file": 3}, {"type": "text", "text": ""}]}"#;
        assert_eq!(canvas_file_references(odd).unwrap(), CanvasFileReferences::default());
    }

    #[test]
    fn text_that_is_not_json_is_refused() {
        assert!(canvas_file_references("not a canvas").is_err());
    }
}
