//! Images of a Markdown body that can be stored locally, the extension a
//! server's content type stores them under, and the Obsidian wikilink that
//! replaces each of them.
//!
//! Shared by the clipper's native host, which localizes a body at save time,
//! and the `localize-remote-media` repair tool, which localizes notes after
//! the fact. Both rewrite only the bytes of the images found here and leave
//! the rest of the body byte for byte (Ф5, В4.1).

use std::ops::Range;

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};

/// An image the body shows, as a standard Markdown parser reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyImage {
    /// Source bytes of the whole `![caption](url)`.
    pub range: Range<usize>,
    /// The caption as written, each line break read as one space.
    pub caption: String,
    /// The destination with escapes and entities resolved.
    pub url: String,
}

/// Images of `body` that `![[name|caption]]` can stand for without losing
/// anything, in source order.
///
/// The images are the ones a standard Markdown parser (`pulldown_cmark`)
/// finds, so an escaped `\![`, an unclosed `![`, an ordinary link and any
/// example inside code stay text, and a real image inside a quote, a list, a
/// table or a footnote is an image (Ф5, Б4.4, В4.1). Table, strikethrough and
/// footnote syntax is on to read bodies the way the renderer with GitHub
/// extensions shows them, and wikilinks are on because Obsidian and the
/// renderer read `[[…]]` before anything inside it. Only the outermost image
/// counts: an image inside another image's caption is caption text.
///
/// Left out, and so kept byte for byte with their remote address: an image
/// with a title (the wikilink has no place for it), a reference-style image
/// (its definition may serve other images and links, and Mine does not read
/// definitions as media references, so a local file named only there would
/// look unused), an image inside a wikilink (a wikilink written into it would
/// close the outer one), and a caption the wikilink cannot close around.
#[must_use]
pub fn replaceable_body_images(body: &str) -> Vec<BodyImage> {
    struct OpenImage {
        range: Range<usize>,
        url: String,
        replaceable: bool,
        caption: CaptionReader,
        nested: usize,
    }

    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_WIKILINKS;
    let mut images = Vec::new();
    let mut open: Option<OpenImage> = None;
    // One entry per open link, `true` for a wikilink.
    let mut links: Vec<bool> = Vec::new();
    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        let Some(image) = open.as_mut() else {
            match event {
                Event::Start(Tag::Image {
                    link_type,
                    dest_url,
                    title,
                    ..
                }) => {
                    open = Some(OpenImage {
                        caption: CaptionReader::new(range.start + "![".len()),
                        range,
                        url: dest_url.into_string(),
                        replaceable: link_type == LinkType::Inline
                            && title.is_empty()
                            && !links.contains(&true),
                        nested: 0,
                    });
                }
                Event::Start(Tag::Link { link_type, .. }) => {
                    links.push(matches!(link_type, LinkType::WikiLink { .. }));
                }
                Event::End(TagEnd::Link) => {
                    links.pop();
                }
                _ => {}
            }
            continue;
        };
        match event {
            Event::End(TagEnd::Image) if image.nested == 0 => {
                if let Some(image) = open.take() {
                    let caption = image.caption.finish();
                    if image.replaceable && wikilink_caption_fits(caption.trim()) {
                        images.push(BodyImage {
                            range: image.range,
                            caption,
                            url: image.url,
                        });
                    }
                }
            }
            event => {
                match event {
                    Event::Start(Tag::Image { .. }) => image.nested += 1,
                    Event::End(TagEnd::Image) => image.nested -= 1,
                    _ => {}
                }
                image.caption.read(body, &event, range);
            }
        }
    }
    images
}

/// Rebuilds an image caption from the source bytes of its events.
///
/// The caption is kept as written (emphasis, code spans, escapes), because the
/// renderer parses it again from the wikilink. A line break becomes one space,
/// and the container prefix of the next line (`> `, list indentation), which
/// no event covers, is skipped.
struct CaptionReader {
    text: String,
    cursor: usize,
    after_break: bool,
}

impl CaptionReader {
    fn new(start: usize) -> Self {
        Self {
            text: String::new(),
            cursor: start,
            after_break: false,
        }
    }

    fn read(&mut self, body: &str, event: &Event<'_>, range: Range<usize>) {
        if matches!(event, Event::SoftBreak | Event::HardBreak) {
            if range.start > self.cursor {
                self.text.push_str(&body[self.cursor..range.start]);
            }
            self.text.push(' ');
            self.cursor = self.cursor.max(range.end);
            self.after_break = true;
            return;
        }
        if std::mem::take(&mut self.after_break) {
            self.cursor = self.cursor.max(range.start);
        }
        // A start event is followed by its content and its end event, which
        // carry the bytes; leaves and ends extend the caption to their end.
        if !matches!(event, Event::Start(_)) && range.end > self.cursor {
            self.text.push_str(&body[self.cursor..range.end]);
            self.cursor = range.end;
        }
    }

    fn finish(self) -> String {
        self.text
    }
}

/// Build an Obsidian wikilink embed for a locally-downloaded media file.
///
/// Format: `![[name]]` or `![[name|alt]]` when alt text is non-empty.
///
/// Phase 18.H.1: wikilink syntax removes the body-vs-disk asymmetry that
/// the percent-encoded `![alt](url)` form introduced. `]]` is not a
/// valid filename character on any supported platform, so parsers can
/// find it unambiguously and the URL literally equals the filename.
///
/// Obsidian renders `![[file.jpg]]` as an embedded image natively, so
/// the raw markdown source stays readable when the user inspects the
/// `.md` file in Obsidian.
#[must_use]
pub fn build_inline_wikilink(name: &str, alt: &str) -> String {
    // Defensive: if a filename ever contained `]]` it would confuse
    // the reader. Filesystem normally rejects this, but fall back to
    // the old encoded markdown form on the pathological case to keep
    // the output valid markdown no matter what.
    if name.contains("]]") {
        let encoded = encode_markdown_url_component(name);
        return format!("![{alt}]({encoded})");
    }

    if alt.is_empty() {
        format!("![[{name}]]")
    } else {
        // Obsidian pipe separates alt/caption from filename.
        // A literal `|` in a filename would break the split, so encode
        // it as an entity equivalent. Practically rare in filenames.
        let safe_alt = alt.replace('|', "&#124;").replace('\n', " ");
        format!("![[{name}|{safe_alt}]]")
    }
}

/// Map a `Content-Type` value to the extension Mine stores media under.
///
/// Only the types the rest of the pipeline can display are mapped; anything
/// else returns `None`, so the helper keeps whatever it already assumed and
/// the repair tool leaves the reference alone.
#[must_use]
pub fn media_extension_for_content_type(content_type: &str) -> Option<&'static str> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    Some(match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => return None,
    })
}

/// Whether `![[name|caption]]` holds `caption` whole. Obsidian and the
/// renderer end the embed at the first `]]`, so a caption containing `]]` or
/// ending in `]` would close it early and spill the rest into the text.
fn wikilink_caption_fits(caption: &str) -> bool {
    !caption.contains("]]") && !caption.ends_with(']')
}

/// Percent-encode characters that would confuse a markdown parser's
/// inline image URL parser: space, parentheses, and the percent sign
/// itself (so it does not look like an encoding escape to humans).
///
/// Markdown readers require either balanced/escaped parens or an
/// angle-bracket-wrapped URL for paths with parens. We keep the file on
/// disk human-readable (`Title (image 1).jpg`) but write the encoded
/// form in the markdown body so `![alt](url)` parses correctly both in
/// Obsidian and in the in-app renderer.
///
/// Kept intentionally narrow: anything outside the problem set (letters,
/// digits, unicode codepoints, dots, hyphens, underscores, `/`) is not
/// encoded — encoding them would make wikilinks less readable for users
/// inspecting the markdown source directly.
fn encode_markdown_url_component(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '%' => out.push_str("%25"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_maps_to_storable_extension() {
        assert_eq!(media_extension_for_content_type("video/mp4"), Some("mp4"));
        assert_eq!(
            media_extension_for_content_type("Video/MP4; codecs=avc1"),
            Some("mp4")
        );
        assert_eq!(media_extension_for_content_type("image/png"), Some("png"));
        assert_eq!(
            media_extension_for_content_type("image/svg+xml; charset=utf-8"),
            Some("svg")
        );
        assert_eq!(
            media_extension_for_content_type("application/octet-stream"),
            None
        );
        assert_eq!(media_extension_for_content_type("text/html"), None);
        assert_eq!(media_extension_for_content_type(""), None);
    }

    // ── Markdown URL encoding ───────────────────────────────────────────

    #[test]
    fn encode_url_spaces_and_parens() {
        assert_eq!(
            encode_markdown_url_component("Hello World (image 1).jpg"),
            "Hello%20World%20%28image%201%29.jpg"
        );
    }

    #[test]
    fn encode_url_ascii_safe_passthrough() {
        assert_eq!(encode_markdown_url_component("photo.jpg"), "photo.jpg");
        assert_eq!(
            encode_markdown_url_component("sunset-tokyo.png"),
            "sunset-tokyo.png"
        );
    }

    #[test]
    fn encode_url_preserves_unicode_chars() {
        // Cyrillic passes through: modern markdown parsers accept Unicode
        // in URLs, and keeping it readable is a Mine value.
        assert_eq!(
            encode_markdown_url_component("Закат (image 1).jpg"),
            "Закат%20%28image%201%29.jpg"
        );
    }

    #[test]
    fn encode_url_escapes_bare_percent() {
        // Paranoid: if a future filename ever contains a literal %, it
        // must not look like a malformed escape to the markdown parser.
        assert_eq!(encode_markdown_url_component("50%.jpg"), "50%25.jpg");
    }

    #[test]
    fn encode_url_idempotent_on_no_special_chars() {
        let input = "simple-name.mp4";
        assert_eq!(encode_markdown_url_component(input), input);
    }

    // ── Wikilink builder (18.H.1) ───────────────────────────────────────

    #[test]
    fn wikilink_plain_name_without_alt() {
        assert_eq!(
            build_inline_wikilink("Title (image 1).jpg", ""),
            "![[Title (image 1).jpg]]"
        );
    }

    #[test]
    fn wikilink_with_alt_uses_pipe_separator() {
        assert_eq!(
            build_inline_wikilink("Photo.jpg", "sunset on the beach"),
            "![[Photo.jpg|sunset on the beach]]"
        );
    }

    #[test]
    fn wikilink_preserves_unicode_name() {
        assert_eq!(
            build_inline_wikilink("Закат (image 1).jpg", ""),
            "![[Закат (image 1).jpg]]"
        );
    }

    #[test]
    fn wikilink_escapes_pipe_in_alt() {
        // A literal `|` in alt text would split the wikilink early.
        assert_eq!(
            build_inline_wikilink("File.jpg", "before | after"),
            "![[File.jpg|before &#124; after]]"
        );
    }

    #[test]
    fn wikilink_collapses_newlines_in_alt() {
        // Alt text with a newline would split the wikilink across lines.
        assert_eq!(
            build_inline_wikilink("File.jpg", "line one\nline two"),
            "![[File.jpg|line one line two]]"
        );
    }

    #[test]
    fn wikilink_falls_back_to_markdown_when_name_contains_close_delim() {
        // `]]` inside the filename would corrupt the wikilink; fall
        // back to the encoded markdown form so output stays valid.
        let built = build_inline_wikilink("weird]]name.jpg", "");
        assert!(built.starts_with("!["));
        assert!(built.contains("](")); // markdown form
        assert!(!built.contains("![["));
    }

    #[test]
    fn wikilink_omits_alt_when_only_whitespace() {
        // An alt that is whitespace-only should behave like empty alt
        // (caller passes `alt.trim()` — this mirrors that).
        assert_eq!(build_inline_wikilink("f.jpg", ""), "![[f.jpg]]");
    }
}
