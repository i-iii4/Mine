//! Byte-accurate local reference occurrences in Markdown source.
//!
//! Only supported syntax produces an occurrence. In particular, arbitrary YAML
//! prose and code are never treated as paths. The caller owns target resolution.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReferenceSyntax {
    Wikilink,
    MarkdownImage,
    MarkdownLink,
    FrontmatterMedia,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reference {
    /// Exact source bytes inside the delimiters, including an alias or URL suffix.
    pub(crate) raw: String,
    pub(crate) syntax: ReferenceSyntax,
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// Return nonoverlapping occurrences with byte offsets into the original text.
pub(crate) fn references_in(content: &str) -> Vec<Reference> {
    let mut result = Vec::new();
    let mut offset = 0;
    let mut frontmatter = false;
    let mut link_list = false;
    let mut fence: Option<(u8, usize)> = None;

    for line in content.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if offset == 0 && bare == "---" {
            frontmatter = true;
            offset += line.len();
            continue;
        }
        if frontmatter && (bare == "---" || bare == "...") {
            frontmatter = false;
            offset += line.len();
            continue;
        }
        if frontmatter {
            if !bare.starts_with(' ') {
                link_list = false;
                if let Some((key, value)) = bare.split_once(':') {
                    if matches!(key, "Mine Collections" | "Mine Related Notes") {
                        link_list = value.trim().is_empty();
                        scan_inline(value, offset + key.len() + 1, &mut result);
                        offset += line.len();
                        continue;
                    }
                }
            }
            if let Some(reference) = frontmatter_media(bare, offset) {
                result.push(reference);
            } else if link_list && bare.trim_start().starts_with("- ") {
                scan_inline(bare, offset, &mut result);
            }
            offset += line.len();
            continue;
        }
        if let Some((marker, count)) = fence {
            if fence_marker(bare).is_some_and(|(found, width, tail)| {
                found == marker && width >= count && tail.trim().is_empty()
            }) {
                fence = None;
            }
            offset += line.len();
            continue;
        }
        if let Some((marker, count, _)) = fence_marker(bare) {
            fence = Some((marker, count));
            offset += line.len();
            continue;
        }
        scan_inline(bare, offset, &mut result);
        offset += line.len();
    }
    result.sort_by_key(|reference| reference.start);
    result
}

/// Split the path from syntax retained verbatim during a target rewrite.
pub(crate) fn split_reference(reference: &Reference) -> (&str, &str) {
    let split_at = match reference.syntax {
        ReferenceSyntax::Wikilink | ReferenceSyntax::FrontmatterMedia => reference
            .raw
            .find(['|', '#'])
            .unwrap_or(reference.raw.len()),
        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink => reference
            .raw
            .find(['?', '#'])
            .unwrap_or(reference.raw.len()),
    };
    reference.raw.split_at(split_at)
}

/// Build a replacement for this occurrence while retaining its alias, anchor,
/// query and the Markdown URL's existing percent-encoding convention.
pub(crate) fn replacement_for(reference: &Reference, target: &str) -> String {
    let (old_target, suffix) = split_reference(reference);
    let encoded = if matches!(
        reference.syntax,
        ReferenceSyntax::MarkdownImage | ReferenceSyntax::MarkdownLink
    ) && old_target.contains('%')
    {
        encode_markdown_path(target)
    } else {
        target.to_owned()
    };
    format!("{encoded}{suffix}")
}

/// Replace a single verified occurrence without searching for similar text.
#[cfg(test)]
pub(crate) fn replace_target(content: &str, reference: &Reference, target: &str) -> Option<String> {
    (content.get(reference.start..reference.end) == Some(reference.raw.as_str())).then(|| {
        let mut revised = content.to_owned();
        revised.replace_range(
            reference.start..reference.end,
            &replacement_for(reference, target),
        );
        revised
    })
}

fn encode_markdown_path(path: &str) -> String {
    let mut encoded = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

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

fn frontmatter_media(line: &str, offset: usize) -> Option<Reference> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent != 0 {
        return None;
    }
    let colon = line.find(':')?;
    if !matches!(
        &line[..colon],
        "file" | "thumbnail" | "source_media" | "Mine Source Media"
    ) {
        return None;
    }
    let value_start = colon
        + 1
        + line[colon + 1..]
            .bytes()
            .take_while(|byte| *byte == b' ')
            .count();
    let value = &line[value_start..];
    if value.is_empty() || value.starts_with(['#', '[', '{', '|', '>']) && !value.starts_with("[[")
    {
        return None;
    }
    let (start, end) = if let Some(quote) = value
        .as_bytes()
        .first()
        .filter(|byte| **byte == b'"' || **byte == b'\'')
    {
        let close = value[1..].find(char::from(*quote))? + 1;
        if !value[close + 1..].trim().is_empty()
            && !value[close + 1..].trim_start().starts_with('#')
        {
            return None;
        }
        (value_start + 1, value_start + close)
    } else {
        let end = value.find(" #").unwrap_or(value.len());
        (value_start, value_start + value[..end].trim_end().len())
    };
    let raw = &line[start..end];
    let (start, end) = if raw.starts_with("![[") && raw.ends_with("]]") {
        (start + 3, end - 2)
    } else if raw.starts_with("[[") && raw.ends_with("]]") {
        (start + 2, end - 2)
    } else {
        (start, end)
    };
    let raw = &line[start..end];
    if raw.is_empty()
        || raw.contains(['\r', '\n'])
        || raw.starts_with("http:")
        || raw.starts_with("https:")
    {
        return None;
    }
    Some(Reference {
        raw: raw.into(),
        syntax: ReferenceSyntax::FrontmatterMedia,
        start: offset + start,
        end: offset + end,
    })
}

fn scan_inline(line: &str, offset: usize, result: &mut Vec<Reference>) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'`' && !escaped(bytes, index) {
            let width = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            if let Some(close) = closing_ticks(bytes, index + width, width) {
                index = close + width;
                continue;
            }
            index += width;
            continue;
        }
        if bytes[index..].starts_with(b"[[") && !escaped(bytes, index) {
            if let Some(close) = line[index + 2..].find("]]") {
                let start = index + 2;
                let end = start + close;
                if end > start {
                    result.push(Reference {
                        raw: line[start..end].into(),
                        syntax: ReferenceSyntax::Wikilink,
                        start: offset + start,
                        end: offset + end,
                    });
                }
                index = end + 2;
                continue;
            }
        }
        if bytes[index..].starts_with(b"![")
            && !escaped(bytes, index)
            && !bytes[index..].starts_with(b"![[")
        {
            if let Some((start, end, next)) = markdown_target(line, index, true) {
                result.push(Reference {
                    raw: line[start..end].into(),
                    syntax: ReferenceSyntax::MarkdownImage,
                    start: offset + start,
                    end: offset + end,
                });
                index = next;
                continue;
            }
        }
        if bytes[index] == b'[' && !escaped(bytes, index) && !bytes[index..].starts_with(b"[[") {
            if let Some((start, end, next)) = markdown_target(line, index, false) {
                result.push(Reference {
                    raw: line[start..end].into(),
                    syntax: ReferenceSyntax::MarkdownLink,
                    start: offset + start,
                    end: offset + end,
                });
                index = next;
                continue;
            }
        }
        index += 1;
    }
}

fn escaped(bytes: &[u8], index: usize) -> bool {
    let count = bytes[..index]
        .iter()
        .rev()
        .take_while(|byte| **byte == b'\\')
        .count();
    count % 2 == 1
}

fn closing_ticks(bytes: &[u8], mut index: usize, width: usize) -> Option<usize> {
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let found = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
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

fn markdown_target(line: &str, marker_start: usize, image: bool) -> Option<(usize, usize, usize)> {
    let bytes = line.as_bytes();
    let mut index = marker_start + if image { 2 } else { 1 };
    let mut brackets = 1;
    while index < bytes.len() {
        match bytes[index] {
            b'[' if !escaped(bytes, index) => brackets += 1,
            b']' if !escaped(bytes, index) => {
                brackets -= 1;
                if brackets == 0 {
                    break;
                }
            }
            _ => {}
        }
        index += 1;
    }
    if bytes.get(index + 1) != Some(&b'(') {
        return None;
    }
    index += 2;
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    let angle = bytes.get(index) == Some(&b'<');
    if angle {
        index += 1;
    }
    let start = index;
    let mut parens = 0;
    while index < bytes.len() {
        if !escaped(bytes, index) {
            match bytes[index] {
                b'>' if angle => break,
                b'(' if !angle => parens += 1,
                b')' if !angle && parens > 0 => parens -= 1,
                b')' if !angle => break,
                byte if !angle && byte.is_ascii_whitespace() => break,
                _ => {}
            }
        }
        index += 1;
    }
    let end = index;
    if end == start {
        return None;
    }
    if angle {
        if bytes.get(index) != Some(&b'>') {
            return None;
        }
        index += 1;
    }
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    if bytes.get(index) == Some(&b'"') || bytes.get(index) == Some(&b'\'') {
        let quote = bytes[index];
        index += 1;
        while index < bytes.len() && (bytes[index] != quote || escaped(bytes, index)) {
            index += 1;
        }
        if bytes.get(index) != Some(&quote) {
            return None;
        }
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
    }
    (bytes.get(index) == Some(&b')')).then_some((start, end, index + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_wikilink_alias_anchor_and_exact_utf8_span() {
        let text = "Привет ![[Папка/фото.jpg#кадр|подпись]]";
        let links = references_in(text);
        assert_eq!(links.len(), 1);
        assert_eq!(
            split_reference(&links[0]),
            ("Папка/фото.jpg", "#кадр|подпись")
        );
        assert_eq!(
            replace_target(text, &links[0], "Медиа/новое.jpg").as_deref(),
            Some("Привет ![[Медиа/новое.jpg#кадр|подпись]]")
        );
    }

    #[test]
    fn preserves_markdown_url_encoding_query_and_title() {
        let text = "![alt](<Media/old%20photo.jpg?size=2#crop> \"caption\")";
        let links = references_in(text);
        assert_eq!(links.len(), 1);
        assert_eq!(
            split_reference(&links[0]),
            ("Media/old%20photo.jpg", "?size=2#crop")
        );
        assert_eq!(
            replace_target(text, &links[0], "Media/new photo.jpg").as_deref(),
            Some("![alt](<Media/new%20photo.jpg?size=2#crop> \"caption\")")
        );
    }

    #[test]
    fn reads_only_supported_frontmatter_media_fields() {
        let text = "---\nfile: \"[[Media/photo.jpg|cover]]\"\nthumbnail: 'thumb.jpg'\nsource_media: clips/video.mp4 # source\ntitle: photo.jpg\nsummary: \"[[not-media]]\"\nMine Collections:\n  - \"[[collection]]\"\n---\n";
        let links = references_in(text);
        assert_eq!(
            links
                .iter()
                .filter(|r| r.syntax == ReferenceSyntax::FrontmatterMedia)
                .count(),
            3
        );
        assert_eq!(links[0].raw, "Media/photo.jpg|cover");
        assert_eq!(links[1].raw, "thumb.jpg");
        assert_eq!(links[2].raw, "clips/video.mp4");
        assert_eq!(split_reference(&links[0]), ("Media/photo.jpg", "|cover"));
        assert_eq!(links[3].raw, "collection");
    }

    #[test]
    fn skips_fences_inline_code_and_escaped_markers() {
        let text = "```md\n![[hidden.jpg]]\n```\n~~\n~~~\n![x](hidden.png)\n~~~\n`[[code]]` ``![x](code.png)`` \\[[escaped]] ![[shown]]";
        let links = references_in(text);
        assert_eq!(
            links.iter().map(|r| r.raw.as_str()).collect::<Vec<_>>(),
            ["shown"]
        );
    }

    #[test]
    fn does_not_guess_complex_yaml_values() {
        let text = "---\nfile: [one.jpg, two.jpg]\nthumbnail: https://example.com/a.jpg\nsource_media: |\n  photo.jpg\n---\n";
        assert!(references_in(text).is_empty());
    }

    #[test]
    fn reads_canonical_mine_frontmatter_links_and_media() {
        let text = "---\nMine Collections: [\"[[Design]]\", \"[[Архив|archive]]\"]\nMine Related Notes:\n  - \"[[Папка/Заметка#часть]]\"\nMine Source Media: 'Media/clip.mp4'\nsummary: \"[[unrelated]]\"\n---\n";
        let references = references_in(text);
        assert_eq!(
            references
                .iter()
                .map(|reference| reference.raw.as_str())
                .collect::<Vec<_>>(),
            [
                "Design",
                "Архив|archive",
                "Папка/Заметка#часть",
                "Media/clip.mp4"
            ]
        );
        assert_eq!(
            references
                .iter()
                .map(|reference| reference.syntax)
                .collect::<Vec<_>>(),
            [
                ReferenceSyntax::Wikilink,
                ReferenceSyntax::Wikilink,
                ReferenceSyntax::Wikilink,
                ReferenceSyntax::FrontmatterMedia
            ]
        );
        assert_eq!(replace_target(text, &references[2], "Другая/Заметка").as_deref(), Some("---\nMine Collections: [\"[[Design]]\", \"[[Архив|archive]]\"]\nMine Related Notes:\n  - \"[[Другая/Заметка#часть]]\"\nMine Source Media: 'Media/clip.mp4'\nsummary: \"[[unrelated]]\"\n---\n"));
    }

    #[test]
    fn reads_local_markdown_links_without_misreading_images_or_code() {
        let text = "[note](../Notes/old%20note.md#part) [video](<../Media/clip.mp4> \"play\") ![image](image.png) ` [hidden](hidden.md) ` [web](https://example.com)";
        let references = references_in(text);
        assert_eq!(
            references
                .iter()
                .map(|reference| reference.syntax)
                .collect::<Vec<_>>(),
            [
                ReferenceSyntax::MarkdownLink,
                ReferenceSyntax::MarkdownLink,
                ReferenceSyntax::MarkdownImage,
                ReferenceSyntax::MarkdownLink
            ]
        );
        assert_eq!(
            split_reference(&references[0]),
            ("../Notes/old%20note.md", "#part")
        );
        assert_eq!(replace_target(text, &references[0], "../Notes/new note.md").as_deref(), Some("[note](../Notes/new%20note.md#part) [video](<../Media/clip.mp4> \"play\") ![image](image.png) ` [hidden](hidden.md) ` [web](https://example.com)"));
    }
}
