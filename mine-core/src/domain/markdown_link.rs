//! Where a Markdown inline link or image begins and ends, and where its
//! destination is: one reading of `[text](destination "title")` and
//! `![alt](destination "title")` for every caller that reads, rewrites or
//! removes a destination (`SPEC_AUDIT_FIXES.md`, В1.1).
//!
//! The reading follows `CommonMark`: a destination may stand in angle brackets,
//! may hold balanced parentheses and backslash escapes, and may be followed by
//! a title in quotes, apostrophes or parentheses. One leniency is kept on
//! purpose: a destination without angle brackets may hold spaces, the way
//! Mine names its media (`Foo (image 1).jpg`) and the way older notes wrote
//! them. Such a destination still ends before a title that closes the link,
//! so `![](a b.jpg "t")` names `a b.jpg`.

use std::borrow::Cow;
use std::ops::Range;

/// One inline Markdown link or image, located by byte offsets into the text
/// it was read from. Every offset lies on an ASCII delimiter, so each range
/// slices the text at character boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineLink {
    /// Offset of the `!` of an image or of the `[` of a link.
    pub start: usize,
    /// Offset just past the closing `)`.
    pub end: usize,
    /// Whether this is an image, `![alt](…)`.
    pub image: bool,
    /// The link text or the alt text, between the brackets.
    pub text: Range<usize>,
    /// The destination as written, without its angle brackets.
    pub destination: Range<usize>,
    /// Whether the destination is written in angle brackets.
    pub angle_brackets: bool,
}

/// Read the inline link or image that begins at `start`, the offset of its
/// `!` or `[`. `None` when the text there is no link: an unclosed bracket, a
/// wikilink (`[[…]]`), a destination that runs across a line.
#[must_use]
pub fn inline_link_at(text: &str, start: usize) -> Option<InlineLink> {
    let bytes = text.as_bytes();
    let (image, open) = match bytes.get(start)? {
        b'!' if bytes.get(start + 1) == Some(&b'[') => (true, start + 1),
        b'[' => (false, start),
        _ => return None,
    };
    if bytes.get(open + 1) == Some(&b'[') {
        return None;
    }
    let text_start = open + 1;
    let text_end = link_text_end(bytes, text_start)?;
    if bytes.get(text_end + 1) != Some(&b'(') {
        return None;
    }
    let mut index = skip_whitespace(bytes, text_end + 2)?;
    let (destination, angle_brackets) = if bytes.get(index) == Some(&b'<') {
        let destination_start = index + 1;
        let destination_end = angle_destination_end(bytes, destination_start)?;
        index = destination_end + 1;
        (destination_start..destination_end, true)
    } else {
        let destination_end = bare_destination_end(bytes, index)?;
        let destination = index..destination_end;
        index = destination_end;
        (destination, false)
    };
    let end = closing_paren_after(bytes, index)?;
    Some(InlineLink {
        start: if image { start } else { open },
        end,
        image,
        text: text_start..text_end,
        destination,
        angle_brackets,
    })
}

/// Every inline link and image outside code, in document order of their
/// starts (`SPEC_AUDIT_FIXES.md`, Г1.6, Г1.7). Code is what `CommonMark` and
/// Obsidian read as code: fenced and indented code blocks and code spans
/// (`code_block_ranges`). An image inside a link's text is found as well
/// (`[![x](a.jpg)](https://…)`): it is a reference of its own. Wikilinks are
/// not Markdown links and are passed over, and so is a `[` or `!` escaped
/// with a backslash. This is what a rewrite may touch.
#[must_use]
pub fn inline_links_outside_code(text: &str) -> Vec<InlineLink> {
    scan_outside_code(text).links
}

/// One wikilink, `[[target#heading|alias]]` or the embed `![[…]]`, located by
/// byte offsets into the text it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wikilink {
    /// Offset of the `!` of an embed or of the first `[`.
    pub start: usize,
    /// Offset just past the closing `]]`.
    pub end: usize,
    /// Whether this is an embed, `![[…]]`.
    pub embed: bool,
    /// What stands between the brackets: the target, its heading and its
    /// alias, as written.
    pub inner: Range<usize>,
}

/// Every wikilink outside code, in document order (`SPEC_AUDIT_FIXES.md`,
/// Г1.7): Obsidian reads no link in a code block or a code span, so a rename
/// rewrites none there. A wikilink ends at the first `]]` on its line; one
/// with no `]]` on its line is no link.
#[must_use]
pub fn wikilinks_outside_code(text: &str) -> Vec<Wikilink> {
    scan_outside_code(text).wikilinks
}

/// The destinations of the link reference definitions of `text`
/// (`[label]: destination "title"`), without angle brackets, in document
/// order; `![a][label]` and `[a][label]` link through them. A definition is
/// read wherever one may stand: after indentation, block quote markers and
/// list markers, with its destination on the same line or the next one.
/// Footnotes (`[^1]: …`) are no definitions. Code is not told apart here:
/// the one caller asks what a note may refer to and errs towards more.
#[must_use]
pub fn reference_definition_destinations(text: &str) -> Vec<Range<usize>> {
    let bytes = text.as_bytes();
    let mut destinations = Vec::new();
    let mut line_start = 0;
    while line_start < text.len() {
        let next_line = line_end(text, line_start);
        let open = line_start + definition_start(&bytes[line_start..next_line]);
        if bytes.get(open) == Some(&b'[') && !matches!(bytes.get(open + 1), Some(b'[' | b'^')) {
            if let Some(destination) = definition_destination(text, open) {
                destinations.push(destination);
            }
        }
        line_start = next_line;
    }
    destinations
}

/// The path a local destination names, read once (`SPEC_AUDIT_FIXES.md`,
/// Г1.2): backslash escapes resolved, a `#fragment` or `?query` cut where `#`
/// or `?` is written, and the rest percent-decoded exactly once. So
/// `photo%23tag.jpg` names `photo#tag.jpg` and `a%2520b.jpg` names
/// `a%20b.jpg`: a decoded path is never decoded or cut again. `None` for a
/// destination outside the space.
#[must_use]
pub fn local_destination_path(written: &str) -> Option<String> {
    let unescaped = unescape_destination(written.trim());
    if is_external_destination(&unescaped) {
        return None;
    }
    let path = &unescaped[..unescaped.find(['#', '?']).unwrap_or(unescaped.len())];
    Some(percent_encoding::percent_decode_str(path).decode_utf8_lossy().into_owned())
}

/// The path a destination names, as written without angle brackets: its
/// backslash escapes resolved (`a\(1\).jpg` names `a(1).jpg`). Percent
/// encoding is left to the caller, which knows whether the destination is
/// local.
#[must_use]
pub fn unescape_destination(raw: &str) -> Cow<'_, str> {
    if !raw.contains('\\') {
        return Cow::Borrowed(raw);
    }
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(&next) = chars.peek() {
                if next.is_ascii_punctuation() {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(ch);
    }
    Cow::Owned(out)
}

/// Whether a destination names something outside the space: a URL with a
/// scheme, a protocol-relative URL, or only a fragment of the note itself.
#[must_use]
pub fn is_external_destination(destination: &str) -> bool {
    let trimmed = destination.trim();
    trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("//")
        || trimmed.contains("://")
        || trimmed
            .split_once(':')
            .is_some_and(|(scheme, _)| is_url_scheme(scheme))
}

/// `mailto`, `data`, `obsidian` and the like: a scheme is letters first,
/// then letters, digits, `+`, `-` or `.`. A drive letter is no scheme here:
/// the space holds no Windows paths.
fn is_url_scheme(candidate: &str) -> bool {
    candidate.len() > 1
        && candidate.starts_with(|ch: char| ch.is_ascii_alphabetic())
        && candidate
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

/// Upper-case hexadecimal digits of a percent-encoded byte.
const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";

/// Characters a fully percent-encoded destination keeps as they are: the
/// unreserved set of RFC 3986 and the path separator.
const FULLY_ENCODED_KEEPS: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~')
    .remove(b'/');

/// Write `path`, a decoded file path, as a destination in the style of
/// `written`, the destination it replaces.
///
/// A destination that encodes its non-ASCII letters (as many Markdown editors
/// write them) is encoded fully again. Otherwise only what would break the
/// link or change its meaning is encoded: `%` always, as a reader decodes it;
/// `#` and `?`, which would start a fragment or a query; `<` and `>`; and,
/// outside angle brackets, spaces and parentheses, which `CommonMark` does not
/// allow there.
#[must_use]
pub fn encode_destination_like(written: &str, angle_brackets: bool, path: &str) -> String {
    let decoded = percent_encoding::percent_decode_str(written).decode_utf8_lossy();
    if written.is_ascii() && !decoded.is_ascii() {
        return percent_encoding::utf8_percent_encode(path, FULLY_ENCODED_KEEPS).to_string();
    }
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        let encode = match ch {
            '%' | '#' | '?' | '<' | '>' | '\\' => true,
            ' ' | '(' | ')' => !angle_brackets,
            _ => ch.is_control(),
        };
        if encode {
            let mut buffer = [0u8; 4];
            for byte in ch.encode_utf8(&mut buffer).bytes() {
                out.push('%');
                out.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
                out.push(char::from(HEX_DIGITS[usize::from(byte & 0x0F)]));
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// The offset past the line ending of the line holding `index`, or the end
/// of the text.
fn line_end(text: &str, index: usize) -> usize {
    text[index..]
        .find('\n')
        .map_or(text.len(), |offset| index + offset + 1)
}

/// Inline links and wikilinks found outside code.
#[derive(Default)]
struct OutsideCode {
    links: Vec<InlineLink>,
    wikilinks: Vec<Wikilink>,
}

fn scan_outside_code(text: &str) -> OutsideCode {
    let blocks = code_block_ranges(text);
    let mut found = OutsideCode::default();
    scan_inline(text, 0..text.len(), &blocks, &mut found);
    found
}

/// Walk `range` of `text` the way an inline parser does, skipping the code
/// blocks in `blocks` and code spans, and collect links and wikilinks. A
/// link's text is walked in turn: an image may stand inside it.
fn scan_inline(text: &str, range: Range<usize>, blocks: &[Range<usize>], found: &mut OutsideCode) {
    let bytes = text.as_bytes();
    let mut index = range.start;
    // The first code block that ends after `index`; `index` only grows.
    let mut block = blocks.partition_point(|block| block.end <= index);
    // Where a code span opened in the current paragraph may close at the
    // latest: the paragraph's end, the next code block, the walked range.
    let mut span_limit = index;
    while index < range.end {
        while blocks.get(block).is_some_and(|code| code.end <= index) {
            block += 1;
        }
        if let Some(code) = blocks.get(block).filter(|code| code.start <= index) {
            index = code.end;
            continue;
        }
        match bytes[index] {
            b'\\' => index += 2,
            b'`' => {
                if index >= span_limit {
                    let next_block = blocks.get(block).map_or(text.len(), |code| code.start);
                    span_limit = paragraph_end(text, index).min(next_block).min(range.end);
                }
                let width = run_length(bytes, index, b'`');
                index = closing_backticks(bytes, index + width, width, span_limit)
                    .map_or(index + width, |close| close + width);
            }
            b'!' if bytes[index + 1..].starts_with(b"[[") => {
                match wikilink_at(text, index, range.end) {
                    Some(wikilink) => {
                        index = wikilink.end;
                        found.wikilinks.push(wikilink);
                    }
                    None => index += 3,
                }
            }
            b'[' if bytes.get(index + 1) == Some(&b'[') => match wikilink_at(text, index, range.end) {
                Some(wikilink) => {
                    index = wikilink.end;
                    found.wikilinks.push(wikilink);
                }
                None => index += 2,
            },
            b'!' | b'[' => match inline_link_at(text, index).filter(|link| link.end <= range.end) {
                Some(link) => {
                    index = link.end;
                    let link_text = (!link.image).then(|| link.text.clone());
                    found.links.push(link);
                    if let Some(link_text) = link_text {
                        scan_inline(text, link_text, blocks, found);
                    }
                }
                None => index += 1,
            },
            _ => index += 1,
        }
    }
}

/// The wikilink whose `!` or first `[` is at `start`, closed by the first
/// `]]` on its line before `limit`.
fn wikilink_at(text: &str, start: usize, limit: usize) -> Option<Wikilink> {
    let embed = text.as_bytes()[start] == b'!';
    let inner_start = start + if embed { 3 } else { 2 };
    let search_end = line_end(text, inner_start.min(text.len())).min(limit);
    let close = inner_start + text.get(inner_start..search_end)?.find("]]")?;
    Some(Wikilink {
        start,
        end: close + 2,
        embed,
        inner: inner_start..close,
    })
}

/// Columns a tab advances indentation to: the next multiple of four, as
/// `CommonMark` counts it.
const TAB_STOP: usize = 4;

/// Indentation beyond its container's that makes a line code, not text.
const CODE_INDENT: usize = 4;

/// The digits an ordered list marker may have at most.
const MAX_ORDERED_MARKER_DIGITS: usize = 9;

/// A fenced code block not closed yet.
struct OpenFence {
    start: usize,
    marker: u8,
    width: usize,
    /// The content column of the list item the fence opened in.
    base: usize,
    quote_depth: usize,
}

/// The code blocks of `text`, fenced and indented, each from the start of
/// its first line to past its last line, in document order (`CommonMark`
/// 4.4, 4.5; `SPEC_AUDIT_FIXES.md`, Г1.7).
///
/// Block quotes and list items are followed far enough to tell code from
/// text: indentation counts from the content column of the list item a line
/// belongs to, so a line indented inside a list item is the item's text, and
/// an indented line that continues a paragraph is text too, since an
/// indented code block cannot interrupt a paragraph. Where the reading is
/// unsure, a line is text: a rewrite then still reaches its links.
fn code_block_ranges(text: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut fence: Option<OpenFence> = None;
    let mut indented: Option<Range<usize>> = None;
    // Content columns of the open list items, innermost last.
    let mut lists: Vec<usize> = Vec::new();
    let mut quote_depth = 0;
    // Whether the previous line was paragraph text a line may continue.
    let mut paragraph = false;
    let mut line_start = 0;
    while line_start < text.len() {
        let next_line = line_end(text, line_start);
        let line = text[line_start..next_line].trim_end_matches(['\n', '\r']);
        let (depth, quoted) = block_quote_content(line);
        let (indent, content) = indentation(quoted);
        let blank = content.trim().is_empty();

        if let Some(open) = fence.take() {
            let container_ended = depth < open.quote_depth || (!blank && indent < open.base);
            if !container_ended {
                let closes = indent < open.base + CODE_INDENT
                    && fence_marker(content).is_some_and(|(marker, width, tail)| {
                        marker == open.marker && width >= open.width && tail.trim().is_empty()
                    });
                if closes {
                    ranges.push(open.start..next_line);
                    paragraph = false;
                } else {
                    fence = Some(open);
                }
                line_start = next_line;
                continue;
            }
            ranges.push(open.start..line_start);
        }

        if depth != quote_depth {
            if paragraph && !blank && depth < quote_depth && !starts_block(content) {
                // A lazy continuation line of the quoted paragraph.
                line_start = next_line;
                continue;
            }
            ranges.extend(indented.take());
            lists.clear();
            quote_depth = depth;
            paragraph = false;
        }
        if blank {
            // An indented code block runs on across blank lines.
            paragraph = false;
            line_start = next_line;
            continue;
        }
        if paragraph {
            let base = lists.last().copied().unwrap_or(0);
            if indent >= base + CODE_INDENT || !starts_block(content) {
                if is_setext_underline(content) {
                    paragraph = false;
                }
                line_start = next_line;
                continue;
            }
        }
        while lists.last().is_some_and(|column| *column > indent) {
            lists.pop();
        }
        let base = lists.last().copied().unwrap_or(0);
        if indent >= base + CODE_INDENT {
            match &mut indented {
                Some(run) => run.end = next_line,
                None => indented = Some(line_start..next_line),
            }
            line_start = next_line;
            continue;
        }
        ranges.extend(indented.take());
        if let Some((marker, width, _)) = fence_marker(content) {
            fence = Some(OpenFence {
                start: line_start,
                marker,
                width,
                base,
                quote_depth: depth,
            });
            paragraph = false;
        } else if is_thematic_break(content) || is_atx_heading(content) {
            paragraph = false;
        } else if let Some((column, has_text)) = list_item_content_column(content, indent) {
            lists.push(column);
            paragraph = has_text;
        } else {
            paragraph = true;
        }
        line_start = next_line;
    }
    if let Some(open) = fence {
        ranges.push(open.start..text.len());
    }
    ranges.extend(indented);
    ranges
}

/// How many block quote markers open `line`, and what follows them: each
/// `>` after at most three spaces, with one space after it.
fn block_quote_content(line: &str) -> (usize, &str) {
    let bytes = line.as_bytes();
    let mut depth = 0;
    let mut offset = 0;
    loop {
        let spaces = bytes[offset..].iter().take_while(|byte| **byte == b' ').count();
        if spaces >= CODE_INDENT || bytes.get(offset + spaces) != Some(&b'>') {
            return (depth, &line[offset..]);
        }
        offset += spaces + 1;
        depth += 1;
        if matches!(bytes.get(offset), Some(b' ' | b'\t')) {
            offset += 1;
        }
    }
}

/// The indentation of `line` in columns, and the line after it.
fn indentation(line: &str) -> (usize, &str) {
    let mut columns = 0;
    for (offset, byte) in line.bytes().enumerate() {
        match byte {
            b' ' => columns += 1,
            b'\t' => columns += TAB_STOP - columns % TAB_STOP,
            _ => return (columns, &line[offset..]),
        }
    }
    (columns, "")
}

/// Whether `content`, a line without its indentation, opens a block that
/// ends a paragraph: a fence, a thematic break, a heading or a list item.
fn starts_block(content: &str) -> bool {
    fence_marker(content).is_some()
        || is_thematic_break(content)
        || is_atx_heading(content)
        || list_item_content_column(content, 0).is_some_and(|(_, has_text)| has_text)
}

/// Three or more `-`, `*` or `_` alone on a line, spaces between allowed.
fn is_thematic_break(content: &str) -> bool {
    let mut marks = content.bytes().filter(|byte| !matches!(byte, b' ' | b'\t'));
    let Some(first) = marks.next() else {
        return false;
    };
    matches!(first, b'-' | b'*' | b'_') && marks.clone().all(|byte| byte == first) && marks.count() >= 2
}

/// A setext heading underline: `=` or `-` alone on a line.
fn is_setext_underline(content: &str) -> bool {
    let trimmed = content.trim_end();
    !trimmed.is_empty() && (trimmed.bytes().all(|byte| byte == b'=') || trimmed.bytes().all(|byte| byte == b'-'))
}

/// `#` to `######` followed by a space or the end of the line.
fn is_atx_heading(content: &str) -> bool {
    let hashes = content.bytes().take_while(|byte| *byte == b'#').count();
    (1..=6).contains(&hashes) && content[hashes..].chars().next().is_none_or(|ch| ch == ' ' || ch == '\t')
}

/// The content column of the list item `content` opens, `content` being a
/// line indented by `indent` columns, and whether the item has text on this
/// line. A bullet (`-`, `+`, `*`) or an ordered marker (`1.`, `1)`) must be
/// followed by a space or the end of the line.
fn list_item_content_column(content: &str, indent: usize) -> Option<(usize, bool)> {
    let bytes = content.as_bytes();
    let marker_width = match *bytes.first()? {
        b'-' | b'+' | b'*' => 1,
        b'0'..=b'9' => {
            let digits = bytes.iter().take_while(|byte| byte.is_ascii_digit()).count();
            if digits > MAX_ORDERED_MARKER_DIGITS || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            digits + 1
        }
        _ => return None,
    };
    let after = &content[marker_width..];
    if !after.is_empty() && !after.starts_with([' ', '\t']) {
        return None;
    }
    let (spaces, text) = indentation(after);
    let marker_end = indent + marker_width;
    if text.trim().is_empty() || spaces > CODE_INDENT {
        // No text yet, or text that is itself indented code: the content
        // column is one past the marker.
        return Some((marker_end + 1, !text.trim().is_empty()));
    }
    Some((marker_end + spaces, true))
}

/// Where a link reference definition may begin on a line: past
/// indentation, block quote markers and list markers.
fn definition_start(line: &[u8]) -> usize {
    let mut index = 0;
    loop {
        while matches!(line.get(index), Some(b' ' | b'\t')) {
            index += 1;
        }
        match line.get(index) {
            Some(b'>') => index += 1,
            Some(b'-' | b'+' | b'*') if matches!(line.get(index + 1), Some(b' ' | b'\t')) => index += 2,
            Some(b'0'..=b'9') => {
                let digits = line[index..].iter().take_while(|byte| byte.is_ascii_digit()).count();
                if digits <= MAX_ORDERED_MARKER_DIGITS
                    && matches!(line.get(index + digits), Some(b'.' | b')'))
                    && matches!(line.get(index + digits + 1), Some(b' ' | b'\t'))
                {
                    index += digits + 2;
                } else {
                    return index;
                }
            }
            _ => return index,
        }
    }
}

/// The destination of the definition whose label opens at `open`: after the
/// colon on the same line or, when nothing follows the colon, on the next
/// line.
fn definition_destination(text: &str, open: usize) -> Option<Range<usize>> {
    let bytes = text.as_bytes();
    let mut index = open + 1;
    loop {
        match *bytes.get(index)? {
            b'\\' => index += 2,
            b']' => break,
            b'[' | b'\n' => return None,
            _ => index += 1,
        }
    }
    if index == open + 1 || bytes.get(index + 1) != Some(&b':') {
        return None;
    }
    let mut start = index + 2;
    while matches!(bytes.get(start), Some(b' ' | b'\t' | b'\r')) {
        start += 1;
    }
    if bytes.get(start) == Some(&b'\n') {
        start += 1;
        while matches!(bytes.get(start), Some(b' ' | b'\t')) {
            start += 1;
        }
    }
    if start >= bytes.len() {
        return None;
    }
    if bytes.get(start) == Some(&b'<') {
        let end = angle_destination_end(bytes, start + 1)?;
        return Some(start + 1..end);
    }
    let end = start
        + bytes[start..]
            .iter()
            .take_while(|byte| !byte.is_ascii_whitespace() && !byte.is_ascii_control())
            .count();
    (end > start).then_some(start..end)
}

/// The offset of the `]` that closes link text starting at `index`: brackets
/// nest, backslash escapes are skipped, and a blank line ends the search.
fn link_text_end(bytes: &[u8], mut index: usize) -> Option<usize> {
    let mut depth = 1usize;
    loop {
        match *bytes.get(index)? {
            b'\\' => {
                index += 2;
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            b'\n' if blank_line_follows(bytes, index) => return None,
            _ => {}
        }
        index += 1;
    }
}

/// The offset of the `>` that closes a destination in angle brackets.
fn angle_destination_end(bytes: &[u8], mut index: usize) -> Option<usize> {
    loop {
        match *bytes.get(index)? {
            b'\\' => index += 2,
            b'>' => return Some(index),
            b'<' | b'\n' | b'\r' => return None,
            _ => index += 1,
        }
    }
}

/// The end of a destination without angle brackets: the `)` that closes the
/// link at depth zero, or the whitespace before a title that closes it.
/// Spaces inside are part of the destination (see the module comment); a line
/// ending is not.
fn bare_destination_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut index = start;
    loop {
        let byte = *bytes.get(index)?;
        match byte {
            b'\\' => {
                index += 2;
                continue;
            }
            b'(' => depth += 1,
            b')' if depth == 0 => return Some(index),
            b')' => depth -= 1,
            b' ' | b'\t' | b'\n' | b'\r' => {
                if depth == 0 && closes_after_whitespace(bytes, index) {
                    return Some(index);
                }
                if byte == b'\n' || byte == b'\r' {
                    return None;
                }
            }
            _ if byte.is_ascii_control() => return None,
            _ => {}
        }
        index += 1;
    }
}

/// Whether the link closes after the whitespace at `index`: optional
/// whitespace, an optional title, optional whitespace, then `)`.
fn closes_after_whitespace(bytes: &[u8], index: usize) -> bool {
    let Some(index) = skip_whitespace(bytes, index) else {
        return false;
    };
    if bytes.get(index) == Some(&b')') {
        return true;
    }
    title_end(bytes, index)
        .and_then(|after| skip_whitespace(bytes, after))
        .is_some_and(|after| bytes.get(after) == Some(&b')'))
}

/// The offset past the `)` that closes a link whose destination ended at
/// `index`: an optional title must be set apart by whitespace.
fn closing_paren_after(bytes: &[u8], index: usize) -> Option<usize> {
    let after_space = skip_whitespace(bytes, index)?;
    let index = if after_space > index {
        match title_end(bytes, after_space) {
            Some(after_title) => skip_whitespace(bytes, after_title)?,
            None => after_space,
        }
    } else {
        index
    };
    (bytes.get(index) == Some(&b')')).then_some(index + 1)
}

/// The offset past a link title at `index`: `"…"`, `'…'` or `(…)`, with
/// backslash escapes, no blank line, and no unescaped `(` inside `(…)`.
fn title_end(bytes: &[u8], index: usize) -> Option<usize> {
    let close = match *bytes.get(index)? {
        b'"' => b'"',
        b'\'' => b'\'',
        b'(' => b')',
        _ => return None,
    };
    let mut cursor = index + 1;
    loop {
        match *bytes.get(cursor)? {
            b'\\' => cursor += 2,
            byte if byte == close => return Some(cursor + 1),
            b'(' if close == b')' => return None,
            b'\n' if blank_line_follows(bytes, cursor) => return None,
            _ => cursor += 1,
        }
    }
}

/// Skip spaces and tabs with at most one line ending among them. `None` when
/// a blank line follows, which ends the paragraph and so the link.
fn skip_whitespace(bytes: &[u8], mut index: usize) -> Option<usize> {
    let mut line_endings = 0;
    while let Some(&byte) = bytes.get(index) {
        match byte {
            b' ' | b'\t' | b'\r' => index += 1,
            b'\n' => {
                line_endings += 1;
                if line_endings > 1 {
                    return None;
                }
                index += 1;
            }
            _ => break,
        }
    }
    Some(index)
}

/// Whether the line after the line ending at `newline` is blank.
fn blank_line_follows(bytes: &[u8], newline: usize) -> bool {
    bytes[newline + 1..]
        .iter()
        .take_while(|byte| **byte != b'\n')
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r'))
}

/// The end of the paragraph a line belongs to: the first blank line after it,
/// or the end of the text. Code spans do not close across it.
fn paragraph_end(text: &str, line_start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut index = line_start;
    while let Some(offset) = text[index..].find('\n') {
        let newline = index + offset;
        if blank_line_follows(bytes, newline) {
            return newline;
        }
        index = newline + 1;
    }
    bytes.len()
}

fn run_length(bytes: &[u8], index: usize, byte: u8) -> usize {
    bytes[index..].iter().take_while(|found| **found == byte).count()
}

/// The start of a run of exactly `width` backticks before `limit`.
fn closing_backticks(bytes: &[u8], mut index: usize, width: usize, limit: usize) -> Option<usize> {
    while index < limit {
        if bytes[index] == b'`' {
            let found = run_length(bytes, index, b'`');
            if found == width {
                return Some(index);
            }
            index += found;
        } else {
            index += 1;
        }
    }
    None
}

/// A code fence opening or closing a fenced block: up to three spaces, then
/// three or more backticks or tildes; returns the marker, its width and the
/// rest of the line.
fn fence_marker(line: &str) -> Option<(u8, usize, &str)> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = *rest.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let count = rest.bytes().take_while(|byte| *byte == marker).count();
    (count >= 3).then(|| (marker, count, &rest[count..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn destination(text: &str) -> Option<(&str, bool)> {
        let start = text.find(['!', '[']).unwrap();
        inline_link_at(text, start).map(|link| (&text[link.destination], link.angle_brackets))
    }

    #[test]
    fn a_title_in_any_form_is_not_part_of_the_destination() {
        assert_eq!(destination("![x](a.jpg \"t\")"), Some(("a.jpg", false)));
        assert_eq!(destination("![x](a.jpg 't')"), Some(("a.jpg", false)));
        assert_eq!(destination("![x](a.jpg (t))"), Some(("a.jpg", false)));
        assert_eq!(destination("[x](../Notes/Foo.md \"t\" )"), Some(("../Notes/Foo.md", false)));
        assert_eq!(destination("[x](a.md\n\"title\")"), Some(("a.md", false)));
    }

    #[test]
    fn angle_brackets_hold_spaces_and_parentheses() {
        assert_eq!(destination("![x](<p q.jpg>)"), Some(("p q.jpg", true)));
        assert_eq!(destination("![x](<a (b).jpg> \"t\")"), Some(("a (b).jpg", true)));
        assert_eq!(destination("![x](<>)"), Some(("", true)));
        assert_eq!(destination("![x](<a\nb>)"), None);
    }

    #[test]
    fn balanced_parentheses_and_spaces_stay_in_a_bare_destination() {
        assert_eq!(destination("![x](Foo (image 1).jpg)"), Some(("Foo (image 1).jpg", false)));
        assert_eq!(destination("![x](Foo (image 1).jpg \"t\")"), Some(("Foo (image 1).jpg", false)));
        assert_eq!(destination("![x](a b.jpg)"), Some(("a b.jpg", false)));
        assert_eq!(destination("![x](a\\(1\\).jpg)"), Some(("a\\(1\\).jpg", false)));
        assert_eq!(destination("![x](Foo (image 1.jpg)"), None);
    }

    #[test]
    fn link_text_nests_brackets_and_wikilinks_are_no_links() {
        let text = "[a [b] c](x.md)";
        let link = inline_link_at(text, 0).unwrap();
        assert_eq!(&text[link.text.clone()], "a [b] c");
        assert_eq!(link.end, text.len());
        assert!(inline_link_at("[[Foo]]", 0).is_none());
        assert!(inline_link_at("![[Foo.jpg]]", 0).is_none());
        assert!(inline_link_at("[a](b", 0).is_none());
        assert!(inline_link_at("[a]\n\n(b)", 0).is_none());
    }

    #[test]
    fn a_rewrite_sees_no_link_in_code_or_behind_an_escape() {
        let text = "[a](a.md) `[b](b.md)` \\[c](c.md)\n```\n[d](d.md)\n```\n![e](e.jpg \"t\") [[f]] ``code ` [g](g.md)``\n";
        let found: Vec<&str> = inline_links_outside_code(text)
            .into_iter()
            .map(|link| &text[link.destination])
            .collect();
        assert_eq!(found, ["a.md", "e.jpg"]);
    }

    /// Г1.6: the image inside a link's text is found after the link itself.
    #[test]
    fn an_image_inside_a_link_is_found_too() {
        let text = "[![x](a.jpg)](https://e.com) [`code` ![y](b.jpg)](c.md) ![![z](d.jpg)](e.jpg)";
        let found: Vec<&str> = inline_links_outside_code(text)
            .into_iter()
            .map(|link| &text[link.destination])
            .collect();
        assert_eq!(found, ["https://e.com", "a.jpg", "c.md", "b.jpg", "e.jpg"]);
    }

    /// Г1.7: indented code is code; indentation inside a list item or a
    /// paragraph's continuation is text; block quotes and fences inside list
    /// items are followed.
    #[test]
    fn indented_code_is_told_from_indented_text() {
        let text = "\
[a](a.md)

    [code](x.md)
    [code](x.md)

    [still code](x.md)
text
    [continues the paragraph](b.md)

- item
    [lazy](c.md)

  [second paragraph](d.md)

      [code in the item](x.md)

  ```
  [fenced in the item](x.md)
  ```
  [after the fence](e.md)

1. one
   - nested

     [nested text](f.md)

         [nested code](x.md)

> quote
>
>     [quoted code](x.md)
> [quoted text](g.md)

# Heading
    [code after a heading](x.md)
";
        let found: Vec<&str> = inline_links_outside_code(text)
            .into_iter()
            .map(|link| &text[link.destination])
            .collect();
        assert_eq!(found, ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"]);
    }

    #[test]
    fn wikilinks_outside_code_end_on_their_line() {
        let text = "[[A]] ![[b.jpg|alt]] `[[C]]` \\[[D]] [[unclosed\n]] [[E#h|e]]\n```\n[[F]]\n```\n";
        let found: Vec<(&str, bool)> = wikilinks_outside_code(text)
            .into_iter()
            .map(|link| (&text[link.inner], link.embed))
            .collect();
        assert_eq!(found, [("A", false), ("b.jpg|alt", true), ("E#h|e", false)]);
    }

    #[test]
    fn reference_definitions_are_read_wherever_they_stand() {
        let text = "![a][r]\n\n[r]: ../Media/a.jpg \"t\"\n  [s]:\n  <../Media/b c.jpg>\n> - [t]: c.pdf\n[^1]: footnote.pdf\n[[w]]: no.pdf\n[]: empty.pdf\n[u]:\n\n[v] no colon\n";
        let found: Vec<&str> = reference_definition_destinations(text)
            .into_iter()
            .map(|range| &text[range])
            .collect();
        assert_eq!(found, ["../Media/a.jpg", "../Media/b c.jpg", "c.pdf"]);
    }

    /// Г1.2: a destination is read once: a written `#` or `?` ends the path,
    /// an encoded one is part of it, and an encoded `%` stays `%`.
    #[test]
    fn a_local_destination_is_decoded_exactly_once() {
        assert_eq!(local_destination_path("photo%23tag.jpg").as_deref(), Some("photo#tag.jpg"));
        assert_eq!(local_destination_path("a%2520b.jpg").as_deref(), Some("a%20b.jpg"));
        assert_eq!(local_destination_path("../Media/a.jpg#crop").as_deref(), Some("../Media/a.jpg"));
        assert_eq!(local_destination_path("a.jpg?v=2").as_deref(), Some("a.jpg"));
        assert_eq!(local_destination_path("Q%3F.jpg").as_deref(), Some("Q?.jpg"));
        assert_eq!(local_destination_path("a\\(1\\).jpg").as_deref(), Some("a(1).jpg"));
        assert_eq!(local_destination_path("https://e.com/a%20b.jpg"), None);
        assert_eq!(local_destination_path("#part"), None);
    }

    #[test]
    fn a_link_after_a_multi_line_construct_is_still_found() {
        let text = "`code\nspan` [a](a.md)\n[b](b.md)";
        let found: Vec<&str> = inline_links_outside_code(text)
            .into_iter()
            .map(|link| &text[link.destination])
            .collect();
        assert_eq!(found, ["a.md", "b.md"]);
    }

    #[test]
    fn escapes_resolve_and_external_destinations_are_told_apart() {
        assert_eq!(unescape_destination("a\\(1\\).jpg"), "a(1).jpg");
        assert_eq!(unescape_destination("plain.jpg"), "plain.jpg");
        for external in ["https://e.com/a.jpg", "mailto:a@b.c", "#part", "//cdn/a.jpg", "obsidian://open"] {
            assert!(is_external_destination(external), "{external}");
        }
        for local in ["../Media/a.jpg", "Foo.md#part", "/Media/a.jpg", "a:b.jpg"] {
            assert!(!is_external_destination(local), "{local}");
        }
    }

    #[test]
    fn a_new_path_is_written_in_the_style_of_the_old_destination() {
        assert_eq!(encode_destination_like("../Media/a.jpg", false, "../Media/b c (1).jpg"), "../Media/b%20c%20%281%29.jpg");
        assert_eq!(encode_destination_like("../Media/a b.jpg", true, "../Media/b c (1).jpg"), "../Media/b c (1).jpg");
        assert_eq!(
            encode_destination_like("../Media/%D1%84.jpg", false, "../Media/снимок 2.jpg"),
            "../Media/%D1%81%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA%202.jpg"
        );
        assert_eq!(encode_destination_like("Фото.jpg", false, "Снимок #1?.jpg"), "Снимок%20%231%3F.jpg");
        assert_eq!(encode_destination_like("a.jpg", true, "50% <off>.jpg"), "50%25 %3Coff%3E.jpg");
    }
}
