//! Where text selected in a rendered note lies in the note's Markdown, and
//! which bytes of the note delete it (SPEC_TEXT_SELECTION_EXTRACTION.md,
//! «Безопасность выделения»).
//!
//! Detail shows a body through a Markdown renderer, so the text a reader
//! selects is rendered text: `x.com` of `[x.com](<https://x.com/…>)`, nothing
//! of `![[photo.jpg]]` or of a `---` rule. Looked up in the source as written,
//! a selection that crosses such syntax is found nowhere (09.10.2026: the
//! `Source:` line card merge writes is a Markdown link, and selecting it
//! together with the `Author:` line under it could not be deleted).
//!
//! Here the body is read by a standard Markdown parser (`pulldown_cmark`) with
//! the extensions the renderer uses, every rendered character keeps the
//! source bytes it comes from, and the selection is looked up in that
//! rendered text.

use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Why a selection has no safe place in the note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionMappingError {
    /// The selected text is not the rendered text of the note where the
    /// selection starts, or it starts or ends inside one rendered character
    /// that several source bytes spell (`&amp;`).
    NotFound,
    /// The selected text occurs more than once where the selection starts.
    Ambiguous,
    /// Deleting the selection would cut a code block, a table or an HTML
    /// block apart; what remains of it would render as something else.
    CutsBlock,
}

/// A body as the renderer shows it, character by character, with the source
/// bytes behind every character and the syntax around them.
#[derive(Debug)]
pub struct RenderedBody {
    glyphs: Vec<Glyph>,
    /// The rendered text with every run of whitespace written as one space,
    /// the way a selection is compared with it.
    text: String,
    /// For every character of `text`: its byte offset there and its glyph.
    chars: Vec<NormalizedChar>,
    inline: Vec<InlineConstruct>,
    atomic: Vec<AtomicBlock>,
    images: Vec<Range<usize>>,
}

#[derive(Debug, Clone)]
struct Glyph {
    ch: char,
    source: Range<usize>,
    /// The source does not spell the character (`&amp;` for `&`, `\*` for
    /// `*`): the character stands for the whole range and can be selected
    /// only together with the characters of the same range.
    opaque: bool,
}

#[derive(Debug, Clone, Copy)]
struct NormalizedChar {
    byte: usize,
    glyph: usize,
}

/// A link, an image, an emphasis, a strikethrough or a code span.
#[derive(Debug, Clone)]
struct InlineConstruct {
    whole: Range<usize>,
    /// Source between the opening and the closing syntax.
    inner: Option<Range<usize>>,
    /// Source from the first to the last visible character inside.
    visible: Option<Range<usize>>,
}

/// A code block, an HTML block or a table: blocks whose syntax spans lines,
/// so a deletion may stay inside one of their `editable` parts or take them
/// whole, nothing in between.
#[derive(Debug, Clone)]
struct AtomicBlock {
    whole: Range<usize>,
    editable: Vec<Range<usize>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Inline,
    Image,
    Atomic,
    Cell,
    Block,
}

#[derive(Debug)]
struct Frame {
    kind: FrameKind,
    whole: Range<usize>,
    inner: Option<Range<usize>>,
    visible: Option<Range<usize>>,
    parts: Vec<Range<usize>>,
}

impl RenderedBody {
    /// Read `body` the way Detail renders it: GitHub tables, strikethrough
    /// and footnotes, Obsidian wikilinks, task lists.
    #[must_use]
    pub fn parse(body: &str) -> Self {
        let options = Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_WIKILINKS;
        let mut reader = Reader {
            body,
            glyphs: Vec::new(),
            frames: Vec::new(),
            inline: Vec::new(),
            atomic: Vec::new(),
            images: Vec::new(),
        };
        for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
            reader.read(event, range);
        }
        let (text, chars) = normalize_glyphs(&reader.glyphs);
        Self {
            glyphs: reader.glyphs,
            text,
            chars,
            inline: reader.inline,
            atomic: reader.atomic,
            images: reader.images,
        }
    }

    /// Source bytes of the rendered text `selected_text` covers, from its
    /// first to its last character.
    ///
    /// With `first_block`, the source range of the first block the selection
    /// touches, the selection starts inside that block, or, when the block is
    /// an image without text, at the first text after it. Without it, the
    /// selected text must occur once in the whole body.
    ///
    /// # Errors
    ///
    /// [`SelectionMappingError::NotFound`] when the text is not there,
    /// [`SelectionMappingError::Ambiguous`] when it is there more than once.
    pub fn locate(
        &self,
        first_block: Option<Range<usize>>,
        selected_text: &str,
    ) -> Result<Range<usize>, SelectionMappingError> {
        let needle = normalize_text(selected_text);
        if needle.is_empty() {
            return Err(SelectionMappingError::NotFound);
        }
        let start = match first_block {
            None => self.single_match(&needle, 0..self.chars.len())?,
            Some(block) => self.match_in_block(&needle, &block)?,
        };
        let end = start + needle.chars().count() - 1;
        let first = self.chars[start].glyph;
        let last = self.chars[end].glyph;
        if self.splits_opaque(first, last) {
            return Err(SelectionMappingError::NotFound);
        }
        Ok(self.glyphs[first].source.start..self.glyphs[last].source.end)
    }

    /// Whether a selection starts inside `block`, possibly running on past
    /// it into text this reading does not render the same way. Anchoring a
    /// selection needs only its first block.
    #[must_use]
    pub fn starts_in_block(&self, block: Range<usize>, selected_text: &str) -> bool {
        match self.locate(Some(block.clone()), selected_text) {
            Ok(_) | Err(SelectionMappingError::Ambiguous) => return true,
            Err(_) => {}
        }
        let needle = normalize_text(selected_text);
        let in_block: Vec<usize> = (0..self.chars.len())
            .filter(|&index| self.char_in_block(index, &block))
            .collect();
        let Some(&last) = in_block.last() else {
            return false;
        };
        let block_end = self.char_end_byte(last);
        in_block.iter().any(|&index| {
            let tail = &self.text[self.chars[index].byte..block_end];
            needle
                .strip_prefix(tail)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
        })
    }

    /// Source ranges, ascending and disjoint, whose removal deletes the
    /// rendered text of `selection` (a range [`Self::locate`] returned).
    ///
    /// Everything between the first and the last selected character goes,
    /// images and rules included. A link, an emphasis or a code span whose
    /// visible text is selected entirely goes with its syntax; one whose
    /// text is selected in part keeps its syntax around the rest. Paragraphs,
    /// headings, list items and quotes the selection runs across merge, as
    /// in a text editor.
    ///
    /// # Errors
    ///
    /// [`SelectionMappingError::CutsBlock`] when the selection runs into a
    /// code block, an HTML block or a table without taking it whole and
    /// without staying inside one code block or one table cell.
    pub fn deletion_ranges(
        &self,
        selection: Range<usize>,
    ) -> Result<Vec<Range<usize>>, SelectionMappingError> {
        let span = self.grow_over_selected_constructs(selection);
        for block in &self.atomic {
            let untouched = !overlaps(&block.whole, &span);
            let whole = contains(&span, &block.whole);
            let inside = block.editable.iter().any(|part| contains(part, &span));
            if !(untouched || whole || inside) {
                return Err(SelectionMappingError::CutsBlock);
            }
        }
        let mut kept: Vec<Range<usize>> = Vec::new();
        for construct in &self.inline {
            if !overlaps(&construct.whole, &span) || contains(&span, &construct.whole) {
                continue;
            }
            match &construct.inner {
                Some(inner) if contains(inner, &span) => {}
                Some(inner) => {
                    kept.push(construct.whole.start..inner.start);
                    kept.push(inner.end..construct.whole.end);
                }
                None => kept.push(construct.whole.clone()),
            }
        }
        Ok(subtract(span, kept))
    }

    /// A construct whose visible text lies inside the span is selected
    /// entirely: the span takes its syntax too. Repeated, since a link taken
    /// whole may complete the emphasis around it.
    fn grow_over_selected_constructs(&self, mut span: Range<usize>) -> Range<usize> {
        loop {
            let mut grown = false;
            for construct in &self.inline {
                let Some(visible) = &construct.visible else {
                    continue;
                };
                if contains(&span, visible) && !contains(&span, &construct.whole) {
                    span = span.start.min(construct.whole.start)..span.end.max(construct.whole.end);
                    grown = true;
                }
            }
            if !grown {
                return span;
            }
        }
    }

    fn match_in_block(
        &self,
        needle: &str,
        block: &Range<usize>,
    ) -> Result<usize, SelectionMappingError> {
        let in_block = |index: usize| self.char_in_block(index, block);
        if let Some(first) = (0..self.chars.len()).find(|&index| in_block(index)) {
            let last = (first..self.chars.len())
                .rfind(|&index| in_block(index))
                .unwrap_or(first);
            return self.single_match(needle, first..last + 1);
        }
        // An image paragraph has no text of its own: a selection that starts
        // on it starts at the text after it.
        if !self.images.iter().any(|image| contains(block, image)) {
            return Err(SelectionMappingError::NotFound);
        }
        let next = (0..self.chars.len())
            .find(|&index| {
                let glyph = &self.glyphs[self.chars[index].glyph];
                !glyph.ch.is_whitespace() && glyph.source.start >= block.end
            })
            .ok_or(SelectionMappingError::NotFound)?;
        if self.text[self.chars[next].byte..].starts_with(needle) {
            Ok(next)
        } else {
            Err(SelectionMappingError::NotFound)
        }
    }

    /// The one match of `needle` that starts on a character of `starts`;
    /// matches may overlap.
    fn single_match(
        &self,
        needle: &str,
        starts: Range<usize>,
    ) -> Result<usize, SelectionMappingError> {
        let mut found = None;
        let mut index = starts.start;
        while index < starts.end {
            let byte = self.chars[index].byte;
            let Some(offset) = self.text[byte..].find(needle) else {
                break;
            };
            let start = self.char_at_byte(byte + offset);
            if start >= starts.end {
                break;
            }
            if found.is_some() {
                return Err(SelectionMappingError::Ambiguous);
            }
            found = Some(start);
            index = start + 1;
        }
        found.ok_or(SelectionMappingError::NotFound)
    }

    fn char_in_block(&self, index: usize, block: &Range<usize>) -> bool {
        let glyph = &self.glyphs[self.chars[index].glyph];
        !glyph.ch.is_whitespace() && block.contains(&glyph.source.start)
    }

    fn char_at_byte(&self, byte: usize) -> usize {
        self.chars.partition_point(|normalized| normalized.byte < byte)
    }

    fn char_end_byte(&self, index: usize) -> usize {
        self.chars
            .get(index + 1)
            .map_or(self.text.len(), |next| next.byte)
    }

    /// The selection starts or ends among the characters of one source
    /// range that spells none of them.
    fn splits_opaque(&self, first: usize, last: usize) -> bool {
        let shares = |a: usize, b: usize| {
            self.glyphs[a].opaque && self.glyphs[b].opaque && self.glyphs[a].source == self.glyphs[b].source
        };
        (first > 0 && shares(first - 1, first))
            || (last + 1 < self.glyphs.len() && shares(last, last + 1))
    }
}

struct Reader<'a> {
    body: &'a str,
    glyphs: Vec<Glyph>,
    frames: Vec<Frame>,
    inline: Vec<InlineConstruct>,
    atomic: Vec<AtomicBlock>,
    images: Vec<Range<usize>>,
}

impl Reader<'_> {
    fn read(&mut self, event: Event<'_>, range: Range<usize>) {
        match event {
            Event::Start(tag) => {
                self.touch(&range);
                let kind = frame_kind(&tag);
                if kind == FrameKind::Block || kind == FrameKind::Atomic || kind == FrameKind::Cell {
                    self.push_separator(range.start);
                }
                self.frames.push(Frame {
                    kind,
                    whole: range,
                    inner: None,
                    visible: None,
                    parts: Vec::new(),
                });
            }
            Event::End(tag) => {
                let end = range.end;
                if let Some(frame) = self.frames.pop() {
                    self.close(frame);
                }
                self.touch(&range);
                if !is_inline_end(tag) {
                    self.push_separator(end);
                }
            }
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => {
                self.touch(&range);
                if !self.in_image() {
                    self.push_text(&text, range);
                }
            }
            Event::Code(text) => self.read_code(&text, range),
            Event::SoftBreak | Event::HardBreak => {
                self.touch(&range);
                if !self.in_image() {
                    self.push_glyph('\n', range, false);
                }
            }
            Event::Rule => {
                self.touch(&range);
                self.push_separator(range.start);
            }
            Event::TaskListMarker(_)
            | Event::FootnoteReference(_)
            | Event::InlineMath(_)
            | Event::DisplayMath(_) => self.touch(&range),
        }
    }

    /// An inline code span: a construct of its own whose inner part is the
    /// code text, when the source spells it unchanged.
    fn read_code(&mut self, text: &str, range: Range<usize>) {
        self.touch(&range);
        let inner = self.body[range.clone()]
            .find(text)
            .filter(|_| !text.is_empty())
            .map(|offset| range.start + offset..range.start + offset + text.len());
        let first_glyph = self.glyphs.len();
        if !self.in_image() {
            match &inner {
                Some(inner) => self.push_text(text, inner.clone()),
                None => {
                    for ch in text.chars() {
                        self.push_glyph(ch, range.clone(), true);
                    }
                }
            }
        }
        self.inline.push(InlineConstruct {
            whole: range,
            inner,
            visible: visible_span(&self.glyphs[first_glyph..]),
        });
    }

    fn close(&mut self, frame: Frame) {
        match frame.kind {
            FrameKind::Inline => self.inline.push(InlineConstruct {
                whole: frame.whole,
                inner: frame.inner,
                visible: frame.visible,
            }),
            FrameKind::Image => {
                self.images.push(frame.whole.clone());
                self.inline.push(InlineConstruct {
                    whole: frame.whole,
                    inner: frame.inner,
                    visible: None,
                });
            }
            FrameKind::Atomic => {
                let editable = if frame.parts.is_empty() {
                    frame.inner.into_iter().collect()
                } else {
                    frame.parts
                };
                self.atomic.push(AtomicBlock {
                    whole: frame.whole,
                    editable,
                });
            }
            FrameKind::Cell => {
                if let (Some(inner), Some(table)) = (
                    frame.inner,
                    self.frames
                        .iter_mut()
                        .rev()
                        .find(|open| open.kind == FrameKind::Atomic),
                ) {
                    table.parts.push(inner);
                }
            }
            FrameKind::Block => {}
        }
    }

    /// Every open construct contains the event.
    fn touch(&mut self, range: &Range<usize>) {
        for frame in &mut self.frames {
            frame.inner = Some(cover(frame.inner.as_ref(), range));
        }
    }

    fn in_image(&self) -> bool {
        self.frames.iter().any(|frame| frame.kind == FrameKind::Image)
    }

    fn push_text(&mut self, text: &str, range: Range<usize>) {
        if self.body.get(range.clone()) == Some(text) {
            for (offset, ch) in text.char_indices() {
                let start = range.start + offset;
                self.push_glyph(ch, start..start + ch.len_utf8(), false);
            }
        } else {
            for ch in text.chars() {
                self.push_glyph(ch, range.clone(), true);
            }
        }
    }

    /// Blocks are apart in the rendered text: their boundary reads as
    /// whitespace, which takes no source bytes of its own.
    fn push_separator(&mut self, at: usize) {
        self.push_glyph('\n', at..at, false);
    }

    fn push_glyph(&mut self, ch: char, source: Range<usize>, opaque: bool) {
        if !ch.is_whitespace() {
            for frame in &mut self.frames {
                frame.visible = Some(cover(frame.visible.as_ref(), &source));
            }
        }
        self.glyphs.push(Glyph { ch, source, opaque });
    }
}

fn frame_kind(tag: &Tag<'_>) -> FrameKind {
    match tag {
        Tag::Emphasis
        | Tag::Strong
        | Tag::Strikethrough
        | Tag::Superscript
        | Tag::Subscript
        | Tag::Link { .. } => FrameKind::Inline,
        Tag::Image { .. } => FrameKind::Image,
        Tag::CodeBlock(_) | Tag::HtmlBlock | Tag::Table(_) => FrameKind::Atomic,
        Tag::TableCell => FrameKind::Cell,
        Tag::Paragraph
        | Tag::Heading { .. }
        | Tag::BlockQuote(_)
        | Tag::List(_)
        | Tag::Item
        | Tag::FootnoteDefinition(_)
        | Tag::DefinitionList
        | Tag::DefinitionListTitle
        | Tag::DefinitionListDefinition
        | Tag::TableHead
        | Tag::TableRow
        | Tag::MetadataBlock(_) => FrameKind::Block,
    }
}

fn is_inline_end(tag: TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

fn visible_span(glyphs: &[Glyph]) -> Option<Range<usize>> {
    glyphs
        .iter()
        .filter(|glyph| !glyph.ch.is_whitespace())
        .fold(None, |span, glyph| Some(cover(span.as_ref(), &glyph.source)))
}

fn cover(span: Option<&Range<usize>>, range: &Range<usize>) -> Range<usize> {
    span.map_or_else(
        || range.clone(),
        |span| span.start.min(range.start)..span.end.max(range.end),
    )
}

fn overlaps(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}

fn contains(outer: &Range<usize>, inner: &Range<usize>) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// `span` without the `kept` ranges, as ascending non-empty pieces.
fn subtract(span: Range<usize>, mut kept: Vec<Range<usize>>) -> Vec<Range<usize>> {
    kept.sort_by_key(|range| range.start);
    let mut pieces = Vec::new();
    let mut cursor = span.start;
    for range in kept {
        let start = range.start.max(span.start);
        let end = range.end.min(span.end);
        if start >= end {
            continue;
        }
        if cursor < start {
            pieces.push(cursor..start);
        }
        cursor = cursor.max(end);
    }
    if cursor < span.end {
        pieces.push(cursor..span.end);
    }
    pieces
}

/// The rendered text with every whitespace run as one space and no
/// whitespace at either end, the way a selection is compared with it.
fn normalize_glyphs(glyphs: &[Glyph]) -> (String, Vec<NormalizedChar>) {
    let mut text = String::new();
    let mut chars = Vec::new();
    let mut pending_space: Option<usize> = None;
    for (index, glyph) in glyphs.iter().enumerate() {
        if glyph.ch.is_whitespace() {
            if !text.is_empty() && pending_space.is_none() {
                pending_space = Some(index);
            }
            continue;
        }
        if let Some(space) = pending_space.take() {
            chars.push(NormalizedChar {
                byte: text.len(),
                glyph: space,
            });
            text.push(' ');
        }
        chars.push(NormalizedChar {
            byte: text.len(),
            glyph: index,
        });
        text.push(glyph.ch);
    }
    (text, chars)
}

/// A selection's text compared with the rendered text: whitespace runs as
/// one space, none at either end.
fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Delete what `selected` covers, starting in the block `block` of `body`.
    fn delete(body: &str, block: &str, selected: &str) -> Result<String, SelectionMappingError> {
        let start = body.find(block).expect("block in body");
        let rendered = RenderedBody::parse(body);
        let selection = rendered.locate(Some(start..start + block.len()), selected)?;
        let mut out = body.to_string();
        for range in rendered.deletion_ranges(selection)?.into_iter().rev() {
            out.replace_range(range, "");
        }
        Ok(out)
    }

    #[test]
    fn selection_across_a_link_and_the_next_paragraph_deletes_both_lines() {
        let body = "![[a.jpg]]\n\nSource: [x.com](<https://x.com/a>)\n\nAuthor: @a\n\n---";
        assert_eq!(
            delete(body, "Source:", "Source: x.com\n\nAuthor: @a").unwrap(),
            "![[a.jpg]]\n\n\n\n---"
        );
    }

    #[test]
    fn image_and_rule_inside_the_selection_go_with_it() {
        let body = "One\n\n---\n\n![[b.jpg]]\n\nTwo three";
        assert_eq!(delete(body, "One", "One\n\nTwo").unwrap(), " three");
    }

    #[test]
    fn a_selection_starting_on_an_image_paragraph_starts_at_the_text_after_it() {
        let body = "![[a.jpg]]\n\nCaption text\n\nMore";
        assert_eq!(delete(body, "![[a.jpg]]", "Caption text").unwrap(), "![[a.jpg]]\n\n\n\nMore");
    }

    #[test]
    fn a_link_selected_whole_goes_with_its_syntax() {
        let body = "Текст **жирный** и [ссылка](https://example.org)";
        assert_eq!(delete(body, body, "ссылка").unwrap(), "Текст **жирный** и ");
        assert_eq!(delete(body, body, "жирный и ссылка").unwrap(), "Текст ");
    }

    #[test]
    fn a_link_selected_in_part_keeps_its_syntax_around_the_rest() {
        let body = "See [example page](https://example.org) now";
        assert_eq!(delete(body, body, "exam").unwrap(), "See [ple page](https://example.org) now");
        assert_eq!(delete(body, body, "See exam").unwrap(), "[ple page](https://example.org) now");
        assert_eq!(delete(body, body, "page now").unwrap(), "See [example ](https://example.org)");
    }

    #[test]
    fn wikilink_alias_is_the_text_and_the_target_is_syntax() {
        let body = "Read [[Long Note|this]] first";
        assert_eq!(delete(body, body, "this first").unwrap(), "Read ");
        assert_eq!(delete(body, body, "Read th").unwrap(), "[[Long Note|is]] first");
    }

    #[test]
    fn code_span_text_maps_inside_its_backticks() {
        let body = "Run `cargo test` now";
        assert_eq!(delete(body, body, "test").unwrap(), "Run `cargo ` now");
        assert_eq!(delete(body, body, "cargo test now").unwrap(), "Run ");
    }

    #[test]
    fn soft_breaks_and_paragraph_breaks_match_any_whitespace() {
        let body = "Alpha beta\nGamma delta.\n\nSecond paragraph.";
        let first = "Alpha beta\nGamma delta.";
        assert_eq!(delete(body, first, "beta Gamma").unwrap(), "Alpha  delta.\n\nSecond paragraph.");
        assert_eq!(
            delete(body, first, "delta.\n\nSecond").unwrap(),
            "Alpha beta\nGamma  paragraph."
        );
    }

    #[test]
    fn the_supplied_block_decides_between_equal_paragraphs() {
        let body = "Repeat\n\nRepeat";
        assert_eq!(delete(body, "Repeat", "Repeat").unwrap(), "\n\nRepeat");
        let second = body.rfind("Repeat").unwrap();
        let rendered = RenderedBody::parse(body);
        assert_eq!(
            rendered.locate(Some(second..body.len()), "Repeat").unwrap(),
            second..body.len()
        );
        assert_eq!(rendered.locate(None, "Repeat"), Err(SelectionMappingError::Ambiguous));
    }

    #[test]
    fn a_repeat_inside_the_first_block_is_ambiguous() {
        let body = "word and word";
        let rendered = RenderedBody::parse(body);
        assert_eq!(
            rendered.locate(Some(0..body.len()), "word"),
            Err(SelectionMappingError::Ambiguous)
        );
    }

    #[test]
    fn text_from_another_block_or_from_syntax_is_not_found() {
        let body = "First\n\nSecond [x.com](<https://x.com/WoolRool>)";
        let rendered = RenderedBody::parse(body);
        assert_eq!(rendered.locate(Some(0..5), "Second"), Err(SelectionMappingError::NotFound));
        assert_eq!(rendered.locate(None, "WoolRool"), Err(SelectionMappingError::NotFound));
        // A range inside an image's syntax is not an image paragraph.
        let media = "![[a.jpg]]\n\nText";
        assert_eq!(
            RenderedBody::parse(media).locate(Some(1..4), "Text"),
            Err(SelectionMappingError::NotFound)
        );
    }

    #[test]
    fn an_entity_is_selected_whole_or_not_at_all() {
        let body = "Tom &amp; Jerry";
        assert_eq!(delete(body, body, "& Jerry").unwrap(), "Tom ");
        assert_eq!(delete(body, body, "Tom &").unwrap(), " Jerry");
        // A code span over two lines renders its line break as a space the
        // source does not spell: its text goes whole or not at all.
        let code = "Run `a\nb` now";
        assert_eq!(delete(code, code, "a"), Err(SelectionMappingError::NotFound));
        assert_eq!(delete(code, code, "a b").unwrap(), "Run  now");
    }

    #[test]
    fn deletion_stays_inside_a_code_block_or_takes_it_whole() {
        let body = "Intro\n\n```\nlet a = 1;\n```\n\nOutro";
        assert_eq!(delete(body, "let a", "a = 1").unwrap(), "Intro\n\n```\nlet ;\n```\n\nOutro");
        assert_eq!(delete(body, "Intro", "Intro let a = 1; Outro").unwrap(), "");
        assert_eq!(
            delete(body, "Intro", "Intro let a"),
            Err(SelectionMappingError::CutsBlock)
        );
    }

    #[test]
    fn deletion_stays_inside_a_table_cell_or_takes_the_table_whole() {
        let body = "| a | b |\n|---|---|\n| one | two |";
        let row = "| one | two |";
        assert_eq!(delete(body, row, "on").unwrap(), "| a | b |\n|---|---|\n| e | two |");
        assert_eq!(delete(body, row, "one two"), Err(SelectionMappingError::CutsBlock));
    }

    #[test]
    fn list_items_the_selection_runs_across_merge() {
        let body = "- first item\n- second item";
        assert_eq!(delete(body, "- first item", "item second").unwrap(), "- first  item");
    }

    #[test]
    fn a_selection_running_past_its_first_block_into_unread_text_still_starts_there() {
        let body = "Text with [link](https://example.org) end\n\nNext";
        let rendered = RenderedBody::parse(body);
        let block = 0..body.find("\n\n").unwrap();
        assert!(rendered.starts_in_block(block.clone(), "link end\n\nNext 1 ↩"));
        assert!(!rendered.starts_in_block(block, "Next"));
    }
}
