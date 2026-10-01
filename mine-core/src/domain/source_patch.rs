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

    /// The properties are valid YAML written in a layout the in-place writer
    /// cannot change without breaking it or taking the user's comments out.
    #[error("cannot change {field}: the note's properties are written in a layout Mine cannot edit in place")]
    UnsupportedLayout { field: &'static str },

    /// The patched text reads back differently from the intended model.
    #[error("the patched note reads back with a different {field}")]
    RoundTrip { field: &'static str },
}

/// The `field` of a round-trip mismatch in the user's own properties: a key
/// the operation does not own came out different.
const OTHER_PROPERTIES: &str = "properties";

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
                yaml = patch_field(&yaml, index, &after.frontmatter, &after_fields, newline)?;
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
                    yaml = patch_field(&yaml, index, &after.frontmatter, &after_fields, "\n")?;
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
    verify_other_properties(source, &patched, &MINE_FRONTMATTER_KEYS)?;
    Ok(patched)
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum SourceShape {
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

pub(crate) fn source_shape(source: &str) -> SourceShape {
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
) -> Result<String, SourcePatchError> {
    let key = MINE_FRONTMATTER_KEYS[index];
    if key == MINE_COLLECTIONS_FIELD {
        // Membership has one writer, shared with the collection toggles.
        return patch_collections_yaml(yaml, &frontmatter.tags);
    }
    let replacement = rendered[index]
        .as_ref()
        .map(|value| format!("{}{newline}", value.replace('\n', newline)));
    Ok(replace_top_level_key(yaml, key, replacement.as_deref(), newline))
}

/// Replace the block of a top-level key (its line and value lines) with
/// `replacement`, remove it when `replacement` is `None`, or append
/// `replacement` when the key is absent. Every other line is kept as is.
///
/// Comments inside the replaced block are the user's text, not part of the
/// value, so they survive the replacement: the trailing comment of the key
/// line stays on the new key line, a trailing comment of a value line stays
/// on the identical new line, and every other comment is kept as a comment
/// line right after the new key line, in its original order.
pub(crate) fn replace_top_level_key(
    yaml: &str,
    key: &str,
    replacement: Option<&str>,
    newline: &str,
) -> String {
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    match top_level_key_span(&lines, key) {
        Some((start, end)) => {
            let comments = SpanComments::collect(&lines[start..end]);
            let mut out = String::with_capacity(yaml.len());
            for line in &lines[..start] {
                out.push_str(line);
            }
            match replacement {
                Some(replacement) => out.push_str(&comments.carry_into(replacement, newline)),
                None => out.push_str(&comments.standalone(&[], false, newline)),
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
/// indented lines, a sequence written at column zero, and the lines a quoted
/// scalar runs on. Blank and comment lines belong to the value only when more
/// of the value follows them; the ones after the value stay with the note.
pub(crate) fn top_level_key_span(lines: &[&str], key: &str) -> Option<(usize, usize)> {
    let start = lines.iter().position(|line| is_top_level_key(line, key))?;
    let mut scanner = YamlLineScanner::default();
    scanner.scan(line_text(lines[start]));
    let mut end = start + 1;
    let mut cursor = start + 1;
    while cursor < lines.len() {
        let line = lines[cursor];
        let text = line_text(line);
        let continues = match scanner.scan(text) {
            YamlLine::Blank | YamlLine::Comment => {
                cursor += 1;
                continue;
            }
            YamlLine::Value {
                continues_scalar, ..
            } => {
                continues_scalar
                    || line.starts_with(' ')
                    || line.starts_with('\t')
                    || text == "-"
                    || text.starts_with("- ")
            }
        };
        if !continues {
            break;
        }
        cursor += 1;
        end = cursor;
    }
    Some((start, end))
}

/// A line without its line break.
fn line_text(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

/// How one YAML line reads for the comment rules: a `#` opens a comment only
/// after whitespace, outside a quoted scalar and outside the text of a block
/// scalar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum YamlLine {
    /// Nothing but whitespace.
    Blank,
    /// A comment line: `#` is the first character after the indentation.
    Comment,
    /// A line of the document. `continues_scalar`: the line is the text of a
    /// scalar that opened on an earlier line (a quoted scalar running on, or
    /// the body of a block scalar). `comment_at`: first byte of the
    /// whitespace before the trailing comment.
    Value {
        continues_scalar: bool,
        comment_at: Option<usize>,
    },
}

/// Line-by-line YAML reader that knows just enough to tell comments from
/// text: which quoted scalar is still open and whether the lines are the body
/// of a block scalar.
#[derive(Debug, Default)]
struct YamlLineScanner {
    /// Quote character of a quoted scalar still open at the end of the
    /// previous line.
    open_quote: Option<char>,
    /// Indentation of the line that opened a block scalar (`|`, `>`): deeper
    /// lines are its text.
    block_scalar_indent: Option<usize>,
}

impl YamlLineScanner {
    /// Whether a comment line may follow the lines scanned so far without
    /// becoming the text of a scalar.
    fn is_settled(&self) -> bool {
        self.open_quote.is_none() && self.block_scalar_indent.is_none()
    }

    /// Classify `text`, a line without its line break, and advance the state.
    fn scan(&mut self, text: &str) -> YamlLine {
        let indent = text.len() - text.trim_start_matches([' ', '\t']).len();
        if let Some(block_indent) = self.block_scalar_indent {
            if text.trim().is_empty() {
                return YamlLine::Blank;
            }
            if indent > block_indent {
                return YamlLine::Value {
                    continues_scalar: true,
                    comment_at: None,
                };
            }
            self.block_scalar_indent = None;
        }
        let continues_scalar = self.open_quote.is_some();
        if !continues_scalar && text.trim().is_empty() {
            return YamlLine::Blank;
        }

        let mut quote = self.open_quote;
        let mut previous: Option<char> = None;
        let mut after_space = true;
        let mut comment_at = None;
        let mut chars = text.char_indices().peekable();
        while let Some((index, ch)) = chars.next() {
            match quote {
                Some('"') => {
                    if ch == '\\' {
                        chars.next();
                    } else if ch == '"' {
                        quote = None;
                        previous = Some(ch);
                    }
                    after_space = false;
                    continue;
                }
                Some(_) => {
                    // Single-quoted: `''` is an escaped quote.
                    if ch == '\'' {
                        if chars.peek().is_some_and(|&(_, next)| next == '\'') {
                            chars.next();
                        } else {
                            quote = None;
                            previous = Some(ch);
                        }
                    }
                    after_space = false;
                    continue;
                }
                None => {}
            }
            if ch == ' ' || ch == '\t' {
                after_space = true;
                continue;
            }
            if ch == '#' && after_space {
                comment_at = Some(text[..index].trim_end_matches([' ', '\t']).len());
                break;
            }
            if (ch == '"' || ch == '\'') && opens_quoted_scalar(previous, after_space) {
                quote = Some(ch);
            }
            previous = Some(ch);
            after_space = false;
        }

        if !continues_scalar && comment_at == Some(0) {
            return YamlLine::Comment;
        }
        self.open_quote = quote;
        if quote.is_none() && opens_block_scalar(&text[..comment_at.unwrap_or(text.len())]) {
            self.block_scalar_indent = Some(indent);
        }
        YamlLine::Value {
            continues_scalar,
            comment_at,
        }
    }
}

/// A quote character starts a quoted scalar only where a scalar starts: at
/// the start of the line, after `key: `, `- `, `? ` or inside flow brackets.
/// Elsewhere it is text of a plain scalar, like the apostrophe in `it's`.
fn opens_quoted_scalar(previous: Option<char>, after_space: bool) -> bool {
    match previous {
        None | Some('[' | '{' | ',') => true,
        Some(':' | '-' | '?') => after_space,
        Some(_) => false,
    }
}

/// Whether the YAML text of a line (its comment removed) ends with a block
/// scalar header: `key: |`, `- >-`, `key: !!str |2`.
fn opens_block_scalar(structure: &str) -> bool {
    let trimmed = structure.trim_end();
    let (before, last) = match trimmed.rsplit_once([' ', '\t']) {
        Some((before, last)) => (before.trim_end(), last),
        None => ("", trimmed),
    };
    let is_header = last.starts_with(['|', '>'])
        && last[1..]
            .chars()
            .all(|ch| ch == '+' || ch == '-' || ch.is_ascii_digit());
    if !is_header {
        return false;
    }
    match before.split_whitespace().last() {
        None => true,
        Some(token) => token == "-" || token.ends_with(':') || token.starts_with(['!', '&']),
    }
}

/// A comment inside the lines a key replacement takes out.
#[derive(Debug)]
enum DisplacedComment<'a> {
    /// A whole comment line, indentation included, without its line break.
    Line(&'a str),
    /// A comment after YAML on a value line.
    Trailing {
        /// Indentation of the line.
        indent: &'a str,
        /// The YAML before the comment, without surrounding whitespace.
        structure: &'a str,
        /// The comment with the whitespace before it.
        comment: &'a str,
    },
}

/// Comments of a key block, collected before the block is replaced.
#[derive(Debug, Default)]
struct SpanComments<'a> {
    /// Trailing comment of the key line with the whitespace before it.
    key_line: Option<&'a str>,
    /// Comments of the value lines in their original order.
    value_lines: Vec<DisplacedComment<'a>>,
}

impl<'a> SpanComments<'a> {
    /// Read the comments of `span`, whose first line is the key line.
    fn collect(span: &[&'a str]) -> Self {
        let mut scanner = YamlLineScanner::default();
        let mut comments = Self::default();
        for (position, line) in span.iter().enumerate() {
            let text = line_text(line);
            match scanner.scan(text) {
                YamlLine::Blank
                | YamlLine::Value {
                    comment_at: None, ..
                } => {}
                YamlLine::Comment => comments.value_lines.push(DisplacedComment::Line(text)),
                YamlLine::Value {
                    comment_at: Some(at),
                    ..
                } if position == 0 => comments.key_line = Some(&text[at..]),
                YamlLine::Value {
                    comment_at: Some(at),
                    ..
                } => {
                    let indent_len = text.len() - text.trim_start_matches([' ', '\t']).len();
                    comments.value_lines.push(DisplacedComment::Trailing {
                        indent: &text[..indent_len.min(at)],
                        structure: text[..at].trim(),
                        comment: &text[at..],
                    });
                }
            }
        }
        comments
    }

    fn is_empty(&self) -> bool {
        self.key_line.is_none() && self.value_lines.is_empty()
    }

    /// `replacement` with the comments carried into it.
    fn carry_into(&self, replacement: &str, newline: &str) -> String {
        if self.is_empty() {
            return replacement.to_string();
        }
        let lines: Vec<&str> = replacement.split_inclusive('\n').collect();
        if lines.is_empty() {
            return self.standalone(&[], false, newline);
        }
        // Where a comment may be added after a line: the line is YAML
        // structure with no comment of its own and leaves no scalar open.
        let mut scanner = YamlLineScanner::default();
        let takes_comment: Vec<bool> = lines
            .iter()
            .map(|line| {
                let kind = scanner.scan(line_text(line));
                kind == YamlLine::Value {
                    continues_scalar: false,
                    comment_at: None,
                } && scanner.is_settled()
            })
            .collect();

        let key_comment_attached = self.key_line.is_some() && takes_comment.first() == Some(&true);
        let mut used = vec![false; self.value_lines.len()];
        let mut line_comments: Vec<Option<&str>> = vec![None; lines.len()];
        for (index, line) in lines.iter().enumerate().skip(1) {
            if !takes_comment[index] {
                continue;
            }
            let text = line_text(line).trim();
            let matched = self
                .value_lines
                .iter()
                .enumerate()
                .find_map(|(slot, displaced)| match displaced {
                    DisplacedComment::Trailing {
                        structure, comment, ..
                    } if !used[slot] && *structure == text => Some((slot, *comment)),
                    _ => None,
                });
            if let Some((slot, comment)) = matched {
                used[slot] = true;
                line_comments[index] = Some(comment);
            }
        }
        if key_comment_attached {
            line_comments[0] = self.key_line;
        }

        let standalone = self.standalone(&used, key_comment_attached, newline);
        // Right after the key line when a comment line may stand there;
        // otherwise the key line opened a scalar and they follow the block.
        let insert_after = if takes_comment.first() == Some(&true) {
            0
        } else {
            lines.len().saturating_sub(1)
        };
        let mut out = String::with_capacity(replacement.len() + standalone.len() + 16);
        for (index, line) in lines.iter().enumerate() {
            let text = line_text(line);
            let mut line_break = &line[text.len()..];
            out.push_str(text);
            if let Some(comment) = line_comments[index] {
                out.push_str(comment);
            }
            if index == insert_after && !standalone.is_empty() && line_break.is_empty() {
                line_break = newline;
            }
            out.push_str(line_break);
            if index == insert_after {
                out.push_str(&standalone);
            }
        }
        out
    }

    /// The comments not attached to a line, each as a comment line of its
    /// own. `used[slot]` marks trailing comments already attached.
    fn standalone(&self, used: &[bool], key_comment_attached: bool, newline: &str) -> String {
        let mut out = String::new();
        if let (Some(comment), false) = (self.key_line, key_comment_attached) {
            out.push_str(comment.trim_start());
            out.push_str(newline);
        }
        for (slot, comment) in self.value_lines.iter().enumerate() {
            if used.get(slot) == Some(&true) {
                continue;
            }
            match comment {
                DisplacedComment::Line(text) => out.push_str(text),
                DisplacedComment::Trailing { indent, comment, .. } => {
                    out.push_str(indent);
                    out.push_str(comment.trim_start());
                }
            }
            out.push_str(newline);
        }
        out
    }
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

/// How the properties of a note are written.
#[derive(Debug)]
pub(crate) enum PropertiesLayout {
    /// Keys at the start of their own lines (block style), or no keys.
    Block,
    /// One flow mapping, `{key: value, ...}`, on one line or several.
    Flow(FlowMapping),
    /// A flow mapping this reader cannot take apart into entries.
    UnreadableFlow,
}

/// Tell block-style properties from a flow mapping. The line patcher finds
/// keys only at the start of a line: inside `{aliases: [A]}` it finds none
/// and would append a key after the closing brace, which YAML cannot read.
pub(crate) fn properties_layout(yaml: &str) -> PropertiesLayout {
    match first_node_byte(yaml) {
        Some(open) if yaml.as_bytes()[open] == b'{' => {
            FlowMapping::scan(yaml, open).map_or(PropertiesLayout::UnreadableFlow, PropertiesLayout::Flow)
        }
        _ => PropertiesLayout::Block,
    }
}

/// First byte of the YAML document past blank space and comment lines.
fn first_node_byte(yaml: &str) -> Option<usize> {
    let bytes = yaml.as_bytes();
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => index += 1,
            // Only blank space precedes it, so `#` opens a comment.
            b'#' => index = line_end(yaml, index),
            _ => return Some(index),
        }
    }
    None
}

/// The byte of the line break that ends the line holding `index`, or the end
/// of the text.
fn line_end(text: &str, index: usize) -> usize {
    text[index..].find('\n').map_or(text.len(), |offset| index + offset)
}

/// A YAML document that is one flow mapping, taken apart by byte offsets.
#[derive(Debug)]
pub(crate) struct FlowMapping {
    /// Byte of the opening `{`.
    open: usize,
    entries: Vec<FlowEntry>,
    /// Bytes where comments start, between the braces.
    comments: Vec<usize>,
}

/// One `key: value` of a flow mapping.
#[derive(Debug)]
struct FlowEntry {
    /// First byte of the key.
    start: usize,
    /// The `:` between the key and its value, when written.
    colon: Option<usize>,
    /// First byte after the last byte of the value (of the key, without one).
    end: usize,
    /// The `,` after the entry.
    separator: Option<usize>,
    /// The key as YAML reads it, when it is a string.
    key: Option<String>,
}

/// An entry while its bytes are being read.
#[derive(Debug)]
struct EntryBuilder {
    start: usize,
    colon: Option<usize>,
    end: usize,
}

impl EntryBuilder {
    fn finish(self, yaml: &str, separator: Option<usize>) -> FlowEntry {
        let key_text = yaml[self.start..self.colon.unwrap_or(self.end)].trim_end();
        // `? key` is an explicit key: never one Mine writes, so never matched.
        let key = (!key_text.starts_with('?'))
            .then(|| serde_yaml::from_str::<serde_yaml::Value>(key_text).ok())
            .flatten()
            .and_then(|value| value.as_str().map(str::to_string));
        FlowEntry {
            start: self.start,
            colon: self.colon,
            end: self.end,
            separator,
            key,
        }
    }
}

impl FlowMapping {
    /// Take apart the flow mapping that opens at `open`. `None` when the text
    /// is not one well-formed flow mapping followed only by blank space and
    /// comments, or holds an empty entry (`{a: 1,, b: 2}`).
    fn scan(yaml: &str, open: usize) -> Option<Self> {
        let bytes = yaml.as_bytes();
        let mut mapping = Self {
            open,
            entries: Vec::new(),
            comments: Vec::new(),
        };
        let mut depth = 1_usize;
        let mut previous = b'{';
        let mut after_space = false;
        let mut entry: Option<EntryBuilder> = None;
        let mut index = open + 1;
        let close = loop {
            let &byte = bytes.get(index)?;
            let mut next = index + 1;
            match byte {
                b' ' | b'\t' | b'\r' | b'\n' => {
                    after_space = true;
                    index = next;
                    continue;
                }
                b'#' if after_space => {
                    mapping.comments.push(index);
                    index = line_end(yaml, index);
                    continue;
                }
                b'"' | b'\'' if opens_flow_quote(previous) => {
                    next = quoted_scalar_end(bytes, index)?;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        if byte != b'}' {
                            return None;
                        }
                        if let Some(open_entry) = entry.take() {
                            mapping.entries.push(open_entry.finish(yaml, None));
                        }
                        break index;
                    }
                }
                b',' if depth == 1 => {
                    mapping.entries.push(entry.take()?.finish(yaml, Some(index)));
                    previous = byte;
                    after_space = false;
                    index = next;
                    continue;
                }
                b':' if depth == 1 => {
                    if let Some(open_entry) = entry.as_mut() {
                        if open_entry.colon.is_none()
                            && separates_flow_value(previous, bytes.get(next).copied())
                        {
                            open_entry.colon = Some(index);
                        }
                    }
                }
                _ => {}
            }
            entry
                .get_or_insert(EntryBuilder {
                    start: index,
                    colon: None,
                    end: index,
                })
                .end = next;
            previous = bytes[next - 1];
            after_space = false;
            index = next;
        };
        let mut rest = close + 1;
        while let Some(&byte) = bytes.get(rest) {
            match byte {
                b' ' | b'\t' | b'\r' | b'\n' => rest += 1,
                b'#' if matches!(bytes[rest - 1], b' ' | b'\t' | b'\r' | b'\n') => {
                    rest = line_end(yaml, rest);
                }
                _ => return None,
            }
        }
        Some(mapping)
    }

    /// Whether the mapping holds `key`.
    pub(crate) fn has_key(&self, key: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.key.as_deref() == Some(key))
    }

    /// The one entry of `key`. `Err` when the key is written twice.
    fn entry_of(&self, key: &str) -> Result<Option<usize>, ()> {
        let mut found = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.key.as_deref() == Some(key))
            .map(|(index, _)| index);
        let first = found.next();
        match found.next() {
            Some(_) => Err(()),
            None => Ok(first),
        }
    }

    /// Set `key` to `value`, a flow node: its value is replaced in place, or
    /// the entry is added after the last one. Every other byte stays. `None`
    /// when the replaced value holds a comment or the key is written twice.
    pub(crate) fn set_key(&self, yaml: &str, key: &str, value: &str) -> Option<String> {
        let (start, end, insert) = match self.entry_of(key).ok()? {
            Some(index) => {
                let entry = &self.entries[index];
                match entry.colon {
                    Some(colon) => (colon + 1, entry.end, format!(" {value}")),
                    None => (entry.end, entry.end, format!(": {value}")),
                }
            }
            None => match self.entries.last() {
                // A trailing comma already separates the new entry.
                Some(FlowEntry {
                    separator: Some(separator),
                    ..
                }) => (separator + 1, separator + 1, format!(" {key}: {value}")),
                Some(last) => (last.end, last.end, format!(", {key}: {value}")),
                None => (self.open + 1, self.open + 1, format!("{key}: {value}")),
            },
        };
        self.splice(yaml, start, end, &insert)
    }

    /// Remove `key` with the comma that separates it, and the line it stood
    /// on when nothing else is there. `None` when the removed text holds a
    /// comment or the key is written twice.
    pub(crate) fn remove_key(&self, yaml: &str, key: &str) -> Option<String> {
        let Some(index) = self.entry_of(key).ok()? else {
            return Some(yaml.to_string());
        };
        let entry = &self.entries[index];
        let (start, end) = match (entry.separator, index.checked_sub(1)) {
            (Some(separator), _) => widen_removed_entry(yaml, entry.start, separator + 1),
            (None, Some(previous)) => (self.entries[previous].separator?, entry.end),
            (None, None) => (entry.start, entry.end),
        };
        self.splice(yaml, start, end, "")
    }

    fn splice(&self, yaml: &str, start: usize, end: usize, insert: &str) -> Option<String> {
        if self.comments.iter().any(|comment| (start..end).contains(comment)) {
            return None;
        }
        let mut out = String::with_capacity(yaml.len() + insert.len());
        out.push_str(&yaml[..start]);
        out.push_str(insert);
        out.push_str(&yaml[end..]);
        Some(out)
    }
}

/// The text a removed entry takes with it, given the entry and its comma:
/// the blank space after the comma too, unless a comment follows it (the
/// comment keeps the space it needs); and the whole line when the entry is
/// the only thing on it.
fn widen_removed_entry(yaml: &str, start: usize, end: usize) -> (usize, usize) {
    let bytes = yaml.as_bytes();
    let mut after = end;
    while matches!(bytes.get(after), Some(b' ' | b'\t')) {
        after += 1;
    }
    let line_start = yaml[..start].rfind('\n').map_or(0, |at| at + 1);
    let alone_on_line = yaml[line_start..start].trim_matches([' ', '\t']).is_empty();
    match bytes.get(after) {
        Some(b'#') => (start, end),
        Some(b'\n') if alone_on_line => (line_start, after + 1),
        Some(b'\r') if alone_on_line && bytes.get(after + 1) == Some(&b'\n') => {
            (line_start, after + 2)
        }
        _ => (start, after),
    }
}

/// A quote opens a quoted scalar in flow context only where a node starts:
/// after `{`, `[`, `,`, `:` or `?`. Elsewhere it is text of a plain scalar.
fn opens_flow_quote(previous: u8) -> bool {
    matches!(previous, b'{' | b'[' | b',' | b':' | b'?')
}

/// A `:` separates a key from its value when blank space or a flow indicator
/// follows it, or right after a quoted key or a flow collection (JSON-like
/// `"key":value`). Otherwise it is text of a plain scalar (`a:b`).
fn separates_flow_value(previous: u8, next: Option<u8>) -> bool {
    matches!(previous, b'"' | b'\'' | b']' | b'}')
        || matches!(
            next,
            None | Some(b' ' | b'\t' | b'\r' | b'\n' | b',' | b'[' | b']' | b'{' | b'}')
        )
}

/// First byte after the quoted scalar that opens at `start`.
fn quoted_scalar_end(bytes: &[u8], start: usize) -> Option<usize> {
    let quote = bytes[start];
    let mut index = start + 1;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'\\' && quote == b'"' {
            index += 2;
        } else if byte == quote {
            // `''` inside a single-quoted scalar is an escaped quote.
            if quote == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                index += 2;
            } else {
                return Some(index + 1);
            }
        } else {
            index += 1;
        }
    }
    None
}

/// What the fenced properties of a note hold, as YAML reads them.
enum Properties {
    /// A mapping of keys. A note without frontmatter, or with an empty one,
    /// has an empty mapping.
    Mapping(serde_yaml::Mapping),
    /// Fences around text that is not a mapping of properties.
    Unreadable,
}

fn read_properties(note: &str) -> Properties {
    let FrontmatterBounds::Valid {
        yaml_start,
        yaml_end,
        ..
    } = frontmatter_bounds(note)
    else {
        return Properties::Mapping(serde_yaml::Mapping::new());
    };
    let yaml = &note[yaml_start..yaml_end];
    if yaml.trim().is_empty() {
        return Properties::Mapping(serde_yaml::Mapping::new());
    }
    match serde_yaml::from_str::<serde_yaml::Value>(yaml) {
        Ok(serde_yaml::Value::Mapping(mapping)) => Properties::Mapping(mapping),
        Ok(serde_yaml::Value::Null) => Properties::Mapping(serde_yaml::Mapping::new()),
        _ => Properties::Unreadable,
    }
}

/// The text after the frontmatter, or the whole note without one.
pub(crate) fn body_of(note: &str) -> &str {
    match frontmatter_bounds(note) {
        FrontmatterBounds::None => note,
        FrontmatterBounds::Valid { body_start, .. } => &note[body_start..],
    }
}

/// Every property of `source` outside `own_keys`, the keys the operation
/// writes, must read the same in `patched`, and `patched` must add none: the
/// user's own properties are not the operation's to change (Ф1). Properties
/// `source` holds as unreadable text are not compared; the patch leaves that
/// text as it is.
pub(crate) fn verify_other_properties(
    source: &str,
    patched: &str,
    own_keys: &[&str],
) -> Result<(), SourcePatchError> {
    let Properties::Mapping(before) = read_properties(source) else {
        return Ok(());
    };
    let Properties::Mapping(after) = read_properties(patched) else {
        return Err(SourcePatchError::RoundTrip {
            field: "frontmatter",
        });
    };
    let is_other = |key: &serde_yaml::Value| !key.as_str().is_some_and(|key| own_keys.contains(&key));
    let kept = before.iter().filter(|(key, _)| is_other(key)).count();
    let found = after.iter().filter(|(key, _)| is_other(key)).count();
    if kept != found
        || before
            .iter()
            .filter(|(key, _)| is_other(key))
            .any(|(key, value)| after.get(key) != Some(value))
    {
        return Err(SourcePatchError::RoundTrip {
            field: OTHER_PROPERTIES,
        });
    }
    Ok(())
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
    fn flow_properties_take_a_membership_change_inside_the_braces() {
        let source = "---\n{aliases: [A], saved_at: 2026-01-01}\n---\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.tags = vec!["New".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\n{aliases: [A], saved_at: 2026-01-01, Mine Collections: [\"[[New]]\"]}\n---\nBody"
        );
    }

    #[test]
    fn flow_properties_refuse_a_field_the_line_writer_cannot_place() {
        let source = "---\n{aliases: [A], saved_at: 2026-01-01}\n---\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.thumbnail = Some("a.jpg".to_string());
        assert!(matches!(
            apply_block_changes(source, &before, &after),
            Err(SourcePatchError::RoundTrip { .. })
        ));
    }

    #[test]
    fn user_properties_must_read_the_same_after_a_patch() {
        let source = "---\naliases: [A]\nsaved_at: 2026-01-01\n---\nBody";
        assert_eq!(
            verify_other_properties(source, "---\naliases: [B]\nsaved_at: 2026-01-01\n---\nBody", &MINE_FRONTMATTER_KEYS),
            Err(SourcePatchError::RoundTrip { field: OTHER_PROPERTIES })
        );
        assert_eq!(
            verify_other_properties(source, "---\naliases: [A]\nsaved_at: 2026-02-02\n---\nBody", &MINE_FRONTMATTER_KEYS),
            Ok(())
        );
        assert_eq!(
            verify_other_properties(source, "---\naliases: [A]\nrating: 5\n---\nBody", &MINE_FRONTMATTER_KEYS),
            Err(SourcePatchError::RoundTrip { field: OTHER_PROPERTIES })
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
    fn trailing_comment_of_the_key_line_survives_a_value_change() {
        let source = "---\ntype: channel\nposition: 0   # pinned first\nsaved_at: 2026-01-01\n---\n";
        let before = read("Collection", source);
        let mut after = before.clone();
        after.frontmatter.position = Some(1);
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\ntype: channel\nposition: 1   # pinned first\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn comment_lines_inside_a_list_value_survive_its_replacement() {
        let source = "---\nMine Related Notes:\n  - \"[[Old]]\"\n  # keep: context for the next one\n  - \"[[Other]]\" # the main one\nsaved_at: 2026-01-01\n---\nBody";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.related_notes = vec!["New".to_string(), "Other".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nMine Related Notes:\n  # keep: context for the next one\n  - \"[[New]]\"\n  - \"[[Other]]\" # the main one\nsaved_at: 2026-01-01\n---\nBody"
        );
    }

    #[test]
    fn comment_of_a_removed_list_item_stays_as_a_comment_line() {
        let source = "---\nMine Related Notes: # sources\n  - \"[[Old]]\" # first draft\n  - \"[[Other]]\"\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.related_notes = vec!["Other".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nMine Related Notes: # sources\n  # first draft\n  - \"[[Other]]\"\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn column_zero_comment_between_sequence_items_stays_inside_the_value() {
        let source = "---\nMine Related Notes:\n- \"[[Old]]\"\n# note\n- \"[[Other]]\"\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.related_notes = vec!["New".to_string(), "Other".to_string()];
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nMine Related Notes:\n# note\n  - \"[[New]]\"\n  - \"[[Other]]\"\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn comment_after_the_value_stays_where_it_was() {
        let source = "---\nthumbnail: a.jpg\n  # about the next key\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.thumbnail = Some("b.jpg".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\nthumbnail: b.jpg\n  # about the next key\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn hash_inside_quotes_or_a_word_is_not_a_comment() {
        let source = "---\ntitle: \"Issue # 5\"\ndescription: 'it''s # not'\nurl: https://example.com/#top\nauthor: it's # a comment\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.title = Some("Issue 6".to_string());
        after.frontmatter.description = Some("done".to_string());
        after.frontmatter.url = Some("https://example.com/".to_string());
        after.frontmatter.author = Some("me".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\ntitle: Issue 6\ndescription: done\nurl: https://example.com/\nauthor: me # a comment\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn hash_lines_inside_a_multi_line_quoted_value_are_text() {
        let source = "---\ndescription: \"first\n  # not a comment\n  last\" # real\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.description = Some("short".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\ndescription: short\n  # real\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn hash_lines_inside_a_block_scalar_are_text() {
        let source = "---\ndescription: | # header\n  # heading of the text\n  line\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.description = Some("short".to_string());
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\ndescription: short # header\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn comments_of_a_removed_field_are_kept() {
        let source = "---\nthumbnail: a.jpg # cover\nsaved_at: 2026-01-01\n---\n";
        let before = read("Note", source);
        let mut after = before.clone();
        after.frontmatter.thumbnail = None;
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\n# cover\nsaved_at: 2026-01-01\n---\n"
        );
    }

    #[test]
    fn crlf_comment_keeps_its_line_endings() {
        let source = "---\r\nposition: 0 # c\r\nsaved_at: 2026-01-01\r\n---\r\n";
        let before = read("Collection", source);
        let mut after = before.clone();
        after.frontmatter.position = Some(2);
        assert_eq!(
            apply_block_changes(source, &before, &after).unwrap(),
            "---\r\nposition: 2 # c\r\nsaved_at: 2026-01-01\r\n---\r\n"
        );
    }

    #[test]
    fn horizontal_rules_are_not_properties() {
        let source = "---\nIntro paragraph.\n---\nRest";
        let block = read("Note", source);
        assert_eq!(block.body, source);
    }
}
