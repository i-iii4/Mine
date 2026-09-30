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

/// Every inline link and image outside code, in document order: fenced code
/// blocks and code spans are code, and so are links written inside them.
/// Wikilinks are not Markdown links and are passed over, and so is a `[` or
/// `!` escaped with a backslash. This is what a rewrite may touch.
#[must_use]
pub fn inline_links_outside_code(text: &str) -> Vec<InlineLink> {
    let bytes = text.as_bytes();
    let mut links = Vec::new();
    let mut index = 0;
    let mut at_line_start = true;
    // The end of the paragraph `index` is in, found once per paragraph: a
    // code span never closes past it.
    let mut paragraph_limit = 0;
    while index < bytes.len() {
        if at_line_start {
            at_line_start = false;
            let line_end = line_end(text, index);
            if let Some((marker, width, _)) = fence_marker(text[index..line_end].trim_end_matches(['\n', '\r'])) {
                index = fenced_block_end(text, line_end, marker, width);
                at_line_start = true;
                continue;
            }
        }
        match bytes[index] {
            b'\n' => {
                index += 1;
                at_line_start = true;
            }
            b'\\' => {
                // A backslash before a line ending is a hard line break.
                at_line_start = bytes.get(index + 1) == Some(&b'\n');
                index += 2;
            }
            b'`' => {
                if index >= paragraph_limit {
                    paragraph_limit = paragraph_end(text, index);
                }
                let width = run_length(bytes, index, b'`');
                index = closing_backticks(bytes, index + width, width, paragraph_limit)
                    .map_or(index + width, |close| close + width);
            }
            b'[' if bytes.get(index + 1) == Some(&b'[') => {
                let line_end = line_end(text, index);
                index = text[index + 2..line_end]
                    .find("]]")
                    .map_or(index + 2, |offset| index + 2 + offset + 2);
            }
            b'!' | b'[' => match inline_link_at(text, index) {
                Some(link) => {
                    index = link.end;
                    links.push(link);
                }
                None => index += 1,
            },
            _ => index += 1,
        }
    }
    links
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

/// The offset past the line that closes a fenced block whose opening line
/// ended at `index`, or the end of the text for a block never closed.
fn fenced_block_end(text: &str, mut index: usize, marker: u8, width: usize) -> usize {
    while index < text.len() {
        let end = line_end(text, index);
        let closes = fence_marker(text[index..end].trim_end_matches(['\n', '\r'])).is_some_and(
            |(found, count, tail)| found == marker && count >= width && tail.trim().is_empty(),
        );
        if closes {
            return end;
        }
        index = end;
    }
    text.len()
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
