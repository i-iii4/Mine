//! What the editor's `[[` menu offers (SPEC_EDITING.md, Л10.2): the space's
//! notes by a fuzzy query, then the headings or the block ids of the note a
//! link names.
//!
//! Every row carries the text the editor writes between `[[` and `]]`. Its
//! note part is the shortest form that the core `LinkIndex`, the one
//! `block_queries::resolve_note_link` opens links with, resolves to the chosen
//! note: the bare name when it names that note, else a path. A row whose text
//! would open another note, or would read back as another wikilink, is left
//! out rather than offered: an inserted link always opens what was chosen.
//!
//! Headings and block ids come from the indexed body of that note, found the
//! way the reading mode finds the place a link names
//! (`src/lib/reading/anchors.ts`): a heading is one of the document's own,
//! named by the path of `#` parts Obsidian's walk (`matchHeading`) reaches it
//! by; a block id is a `^id` that ends its line.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

use anyhow::Result;
use mine_core::domain::markdown_link::wikilinks_outside_code;
use mine_core::links::{split_link_fragment, LinkIndex, LinkResolution, LinkSyntax};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// The most rows one answer of the menu holds.
pub const NOTE_LINK_SUGGESTION_LIMIT: usize = 50;

/// The most characters of a block's text the second line of its row shows.
const BLOCK_DETAIL_MAX_CHARS: usize = 80;

/// What every matched character of a subsequence match is worth.
const SUBSEQUENCE_CHAR_SCORE: u32 = 1;
/// What a matched character adds when it follows the one matched before it.
const SUBSEQUENCE_ADJACENT_BONUS: u32 = 5;
/// What a matched character adds when it starts a word.
const SUBSEQUENCE_WORD_START_BONUS: u32 = 3;

/// The extension of a note's file, which a link leaves out.
const NOTE_EXTENSION: &str = ".md";

/// What the `[[` menu asks for (Л10.2).
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteLinkQuery {
    /// Notes whose name or path matches `text` fuzzily; an empty `text` lists notes by name.
    Notes { text: String },
    /// Headings of the note that the link target `note` resolves to from the source note.
    Headings { note: String, text: String },
    /// Block ids `^id` of the note that `note` resolves to.
    Blocks { note: String, text: String },
}

/// One row of the `[[` menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct NoteLinkSuggestion {
    /// The row's text: the note's name (file name without `.md`), the heading's text, or the block id without `^`.
    pub label: String,
    /// The second line: the note's folder (`""` at the space root); `H1`..`H6` for a heading; the start of the block's text for a block.
    pub detail: String,
    /// What goes between `[[` and `]]`: `Name`, `Folder/Name`, `Name#Heading`, `Name#Parent#Heading`, `Name#^id`.
    pub target: String,
    /// The slug of the note the link resolves to.
    pub slug: String,
    /// The parts of `label` that matched the query, in UTF-16 code units (JavaScript string offsets), ascending, not overlapping.
    pub matches: Vec<LabelMatch>,
}

/// A part of a row's label that matched the query: `[start, end)` in UTF-16
/// code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub struct LabelMatch {
    /// Offset of the first matched code unit.
    pub start: u32,
    /// Offset just past the last matched code unit.
    pub end: u32,
}

/// The rows of the `[[` menu for `query`, typed in the note `source_slug`: at
/// most [`NOTE_LINK_SUGGESTION_LIMIT`], best first, each one's `target`
/// resolving from that note to the note in its `slug` (Л10.2).
///
/// # Errors
///
/// Fails when the index cannot be read.
pub fn suggest_note_links(
    conn: &Connection,
    source_slug: &str,
    query: &NoteLinkQuery,
) -> Result<Vec<NoteLinkSuggestion>> {
    let notes = SpaceNotes::load(conn)?;
    match query {
        NoteLinkQuery::Notes { text } => Ok(notes.suggest_notes(source_slug, text)),
        NoteLinkQuery::Headings { note, text } => {
            let Some(chosen) = notes.chosen_note(conn, source_slug, note)? else {
                return Ok(Vec::new());
            };
            Ok(chosen.headings(&notes, source_slug, text))
        }
        NoteLinkQuery::Blocks { note, text } => {
            let Some(chosen) = notes.chosen_note(conn, source_slug, note)? else {
                return Ok(Vec::new());
            };
            Ok(chosen.blocks(&notes, source_slug, text))
        }
    }
}

/// Every note of the space as the link index knows it: cards and collection
/// pages, since a page's name makes a card's short name ambiguous all the same.
struct SpaceNotes {
    index: LinkIndex,
    /// Slug of every note, and whether it is a card (the menu offers only cards).
    cards: HashMap<String, bool>,
}

impl SpaceNotes {
    fn load(conn: &Connection) -> Result<Self> {
        let mut stmt = conn.prepare("SELECT slug, card_kind != 'channel' FROM blocks")?;
        let cards = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)))?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        let index = LinkIndex::new(cards.keys().map(|slug| format!("{slug}{NOTE_EXTENSION}")));
        Ok(Self { index, cards })
    }

    /// The shortest link text naming the note `slug` (emission invariant).
    fn note_link(&self, slug: &str) -> Option<String> {
        self.index.shortest_link(&format!("{slug}{NOTE_EXTENSION}"), true)
    }

    /// Whether `[[target]]`, written into the note `source_slug`, reads back
    /// as this one wikilink, carries `fragment` after its note part, and opens
    /// the note `slug`.
    fn emits(&self, source_slug: &str, target: &str, fragment: Option<&str>, slug: &str) -> bool {
        let written = format!("[[{target}]]");
        let links = wikilinks_outside_code(&written);
        let [link] = links.as_slice() else {
            return false;
        };
        if link.embed || link.start != 0 || link.end != written.len() {
            return false;
        }
        if written.get(link.inner.clone()) != Some(target) {
            return false;
        }
        let (file, written_fragment) = split_link_fragment(target);
        if written_fragment != fragment {
            return false;
        }
        matches!(
            self.index.resolve(&format!("{source_slug}{NOTE_EXTENSION}"), file, LinkSyntax::Obsidian),
            LinkResolution::Resolved(path) if path.strip_suffix(NOTE_EXTENSION) == Some(slug)
        )
    }

    /// The card the link target `note` opens from `source_slug`, with its
    /// body and its link text; `None` when it opens nothing, a collection
    /// page, or a card no link text names.
    fn chosen_note(&self, conn: &Connection, source_slug: &str, note: &str) -> Result<Option<ChosenNote>> {
        let LinkResolution::Resolved(path) =
            self.index.resolve(&format!("{source_slug}{NOTE_EXTENSION}"), note, LinkSyntax::Obsidian)
        else {
            return Ok(None);
        };
        let Some(slug) = path.strip_suffix(NOTE_EXTENSION) else {
            return Ok(None);
        };
        if self.cards.get(slug) != Some(&true) {
            return Ok(None);
        }
        let Some(link) = self.note_link(slug) else {
            return Ok(None);
        };
        let body: Option<Option<String>> = conn
            .query_row("SELECT body FROM blocks WHERE slug = ?1", [slug], |row| row.get(0))
            .optional()?;
        Ok(body.map(|body| ChosenNote {
            slug: slug.to_string(),
            link,
            body: body.unwrap_or_default(),
        }))
    }

    /// Notes mode: cards whose name (or, for a query with `/`, whose path)
    /// matches `text`, best first; every card by name for an empty `text`.
    fn suggest_notes(&self, source_slug: &str, text: &str) -> Vec<NoteLinkSuggestion> {
        let query = Query::new(text);
        let mut candidates: Vec<NoteCandidate<'_>> = self
            .cards
            .iter()
            .filter(|(_, is_card)| **is_card)
            .filter_map(|(slug, _)| NoteCandidate::new(slug, &query))
            .collect();
        candidates.sort_by_cached_key(NoteCandidate::order_key);
        candidates
            .into_iter()
            .filter_map(|candidate| {
                let target = self.note_link(candidate.slug)?;
                self.emits(source_slug, &target, None, candidate.slug).then(|| NoteLinkSuggestion {
                    label: candidate.name.to_string(),
                    detail: candidate.folder.to_string(),
                    target,
                    slug: candidate.slug.to_string(),
                    matches: label_matches(candidate.name, &candidate.name_ranges()),
                })
            })
            .take(NOTE_LINK_SUGGESTION_LIMIT)
            .collect()
    }
}

/// A card offered in notes mode, and how it matched the query.
struct NoteCandidate<'a> {
    slug: &'a str,
    name: &'a str,
    folder: &'a str,
    /// How the query matched: the name, or the whole slug for a query with `/`;
    /// `None` for an empty query.
    matched: Option<TextMatch>,
    /// Whether `matched` is of the whole slug.
    by_path: bool,
}

impl<'a> NoteCandidate<'a> {
    fn new(slug: &'a str, query: &Query) -> Option<Self> {
        let (folder, name) = slug.rsplit_once('/').unwrap_or(("", slug));
        let by_path = query.text.contains('/');
        let matched = if query.is_empty() {
            None
        } else {
            Some(query.match_text(if by_path { slug } else { name })?)
        };
        Some(Self { slug, name, folder, matched, by_path })
    }

    /// Best match first, then the shorter name, then the name, then the slug.
    fn order_key(&self) -> (Option<MatchRank>, usize, String, &'a str, &'a str) {
        (
            self.matched.as_ref().map(TextMatch::rank),
            self.name.chars().count(),
            self.name.to_lowercase(),
            self.name,
            self.slug,
        )
    }

    /// The matched characters of the name: a match of the slug keeps the
    /// part that falls inside the name.
    fn name_ranges(&self) -> Vec<Range<usize>> {
        let Some(matched) = &self.matched else {
            return Vec::new();
        };
        if !self.by_path {
            return matched.ranges.clone();
        }
        let name_start = self.slug.chars().count() - self.name.chars().count();
        matched
            .ranges
            .iter()
            .filter(|range| range.end > name_start)
            .map(|range| range.start.max(name_start) - name_start..range.end - name_start)
            .collect()
    }
}

/// The card a heading or block query names.
struct ChosenNote {
    slug: String,
    /// The shortest link text naming it, the note part of every row.
    link: String,
    body: String,
}

impl ChosenNote {
    /// Headings mode: the note's own headings matching `text`, in document
    /// order for an empty `text`.
    fn headings(&self, notes: &SpaceNotes, source_slug: &str, text: &str) -> Vec<NoteLinkSuggestion> {
        let headings = source_headings(&self.body);
        let rows = headings.iter().enumerate().filter_map(|(index, heading)| {
            let fragment = heading_fragment(&headings, index, |fragment| {
                notes.emits(source_slug, &format!("{}#{fragment}", self.link), Some(fragment), &self.slug)
            })?;
            Some(Row {
                label: heading.text.clone(),
                detail: format!("H{}", heading.level),
                target: format!("{}#{fragment}", self.link),
            })
        });
        self.ranked(rows.collect(), text)
    }

    /// Blocks mode: the note's block ids matching `text`, in document order
    /// for an empty `text`.
    fn blocks(&self, notes: &SpaceNotes, source_slug: &str, text: &str) -> Vec<NoteLinkSuggestion> {
        let rows = block_ids(&self.body).into_iter().filter_map(|block| {
            let fragment = format!("^{}", block.id);
            let target = format!("{}#{fragment}", self.link);
            notes.emits(source_slug, &target, Some(&fragment), &self.slug).then_some(Row {
                label: block.id,
                detail: block.detail,
                target,
            })
        });
        self.ranked(rows.collect(), text)
    }

    /// `rows` matching `text`, best first and then in document order; all of
    /// them in document order for an empty `text`.
    fn ranked(&self, rows: Vec<Row>, text: &str) -> Vec<NoteLinkSuggestion> {
        let query = Query::new(text);
        let mut matched: Vec<RankedRow> = rows
            .into_iter()
            .enumerate()
            .filter_map(|(position, row)| {
                let matched = if query.is_empty() {
                    None
                } else {
                    Some(query.match_text(&row.label)?)
                };
                Some(RankedRow { matched, position, row })
            })
            .collect();
        matched.sort_by_cached_key(RankedRow::order_key);
        matched
            .into_iter()
            .take(NOTE_LINK_SUGGESTION_LIMIT)
            .map(|RankedRow { matched, row, .. }| NoteLinkSuggestion {
                matches: matched
                    .map(|matched| label_matches(&row.label, &matched.ranges))
                    .unwrap_or_default(),
                label: row.label,
                detail: row.detail,
                target: row.target,
                slug: self.slug.clone(),
            })
            .collect()
    }
}

/// A heading or block row before the query ranks it.
struct Row {
    label: String,
    detail: String,
    target: String,
}

/// A heading or block row, how the query matched it, and where it stands in
/// the note.
struct RankedRow {
    matched: Option<TextMatch>,
    position: usize,
    row: Row,
}

impl RankedRow {
    /// Best match first, then the shorter label, then the label, then
    /// document order; document order alone without a query.
    fn order_key(&self) -> (Option<MatchRank>, Option<(usize, String)>, usize) {
        (
            self.matched.as_ref().map(TextMatch::rank),
            self.matched
                .is_some()
                .then(|| (self.row.label.chars().count(), self.row.label.to_lowercase())),
            self.position,
        )
    }
}

/// How a query matched a text, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchTier {
    /// The whole text, letter case aside.
    Exact,
    /// The text starts with the query.
    Prefix,
    /// The query stands in the text at the start of a word.
    WordStart,
    /// The query stands in the text elsewhere.
    Substring,
    /// The query's characters stand in the text in order, apart.
    Subsequence,
}

/// The order of two matches: the tier, then within a subsequence the score.
type MatchRank = (MatchTier, Reverse<u32>);

/// How a query matched one text.
#[derive(Debug, Clone)]
struct TextMatch {
    tier: MatchTier,
    /// Contiguity and word starts of a subsequence match; 0 for the others.
    score: u32,
    /// Matched characters of the text, as character indices, ascending and
    /// not touching.
    ranges: Vec<Range<usize>>,
}

impl TextMatch {
    fn rank(&self) -> MatchRank {
        (self.tier, Reverse(self.score))
    }
}

/// A query as the matcher reads it: lowercased and trimmed for the
/// contiguous tiers, and without whitespace for the subsequence tier, so
/// `прим зам` finds `Пример заметки`.
struct Query {
    text: String,
    folded: Vec<char>,
    letters: Vec<char>,
}

impl Query {
    fn new(text: &str) -> Self {
        let text = text.trim().to_string();
        let folded: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
        let letters = folded.iter().copied().filter(|ch| !ch.is_whitespace()).collect();
        Self { text, folded, letters }
    }

    fn is_empty(&self) -> bool {
        self.folded.is_empty()
    }

    /// How this query matches `text`, case-insensitively; `None` when it
    /// does not.
    fn match_text(&self, text: &str) -> Option<TextMatch> {
        let folded = FoldedText::new(text);
        if folded.chars == self.folded {
            return Some(TextMatch {
                tier: MatchTier::Exact,
                score: 0,
                ranges: merged_ranges(folded.origin.iter().copied()),
            });
        }
        let width = self.folded.len();
        let starts: Vec<usize> = (0..=folded.chars.len().saturating_sub(width))
            .filter(|start| folded.chars.get(*start..start + width) == Some(self.folded.as_slice()))
            .collect();
        let contiguous = |tier, start: usize| TextMatch {
            tier,
            score: 0,
            ranges: merged_ranges(folded.origin[start..start + width].iter().copied()),
        };
        if starts.first() == Some(&0) {
            return Some(contiguous(MatchTier::Prefix, 0));
        }
        if let Some(start) = starts.iter().copied().find(|start| folded.word_start[*start]) {
            return Some(contiguous(MatchTier::WordStart, start));
        }
        if let Some(start) = starts.first().copied() {
            return Some(contiguous(MatchTier::Substring, start));
        }
        let (score, positions) = best_subsequence(&folded, &self.letters)?;
        Some(TextMatch {
            tier: MatchTier::Subsequence,
            score,
            ranges: merged_ranges(positions.into_iter().map(|position| folded.origin[position])),
        })
    }
}

/// A text lowercased character by character, each lowercase character with
/// the index of the character it comes from (`İ` lowercases to two).
struct FoldedText {
    chars: Vec<char>,
    origin: Vec<usize>,
    /// Whether the character starts a word: the first letter or digit of the
    /// text, after a character that is neither, or an uppercase letter after
    /// a lowercase one.
    word_start: Vec<bool>,
}

impl FoldedText {
    fn new(text: &str) -> Self {
        let source: Vec<char> = text.chars().collect();
        let mut folded = Self { chars: Vec::new(), origin: Vec::new(), word_start: Vec::new() };
        for (index, ch) in source.iter().enumerate() {
            let previous = index.checked_sub(1).map(|before| source[before]);
            let starts_word = ch.is_alphanumeric()
                && previous.is_none_or(|before| {
                    !before.is_alphanumeric() || (before.is_lowercase() && ch.is_uppercase())
                });
            for (part, lower) in ch.to_lowercase().enumerate() {
                folded.chars.push(lower);
                folded.origin.push(index);
                folded.word_start.push(starts_word && part == 0);
            }
        }
        folded
    }
}

/// The best placement of `letters` in `text` in order: the highest score,
/// where every matched character scores, more when it follows the previous
/// match or starts a word; the earliest placement among equals. Returns the
/// score and the matched positions of `text.chars`.
fn best_subsequence(text: &FoldedText, letters: &[char]) -> Option<(u32, Vec<usize>)> {
    let length = text.chars.len();
    if letters.is_empty() || !is_subsequence(&text.chars, letters) {
        return None;
    }
    let char_score = |position: usize| {
        SUBSEQUENCE_CHAR_SCORE
            + if text.word_start[position] { SUBSEQUENCE_WORD_START_BONUS } else { 0 }
    };
    // best[row][position]: the best score of placing letters[..=row] with
    // letters[row] at `position`; from[row][position]: where letters[row - 1] went.
    let mut best: Vec<Vec<Option<u32>>> = Vec::with_capacity(letters.len());
    let mut from: Vec<Vec<usize>> = Vec::with_capacity(letters.len());
    best.push(
        (0..length)
            .map(|position| (text.chars[position] == letters[0]).then(|| char_score(position)))
            .collect(),
    );
    from.push(vec![0; length]);
    for (row, letter) in letters.iter().enumerate().skip(1) {
        let previous = &best[row - 1];
        let mut scores = vec![None; length];
        let mut sources = vec![0; length];
        // The best placement of the previous letter at least two before `position`.
        let mut apart: Option<(u32, usize)> = None;
        for position in 0..length {
            if let Some(before) = position.checked_sub(2) {
                if let Some(score) = previous[before] {
                    if apart.is_none_or(|(best_apart, _)| score > best_apart) {
                        apart = Some((score, before));
                    }
                }
            }
            if text.chars[position] != *letter {
                continue;
            }
            let adjacent = position
                .checked_sub(1)
                .and_then(|before| previous[before].map(|score| (score + SUBSEQUENCE_ADJACENT_BONUS, before)));
            let chosen = match (adjacent, apart) {
                (Some(next), Some(away)) => Some(if next.0 >= away.0 { next } else { away }),
                (next, away) => next.or(away),
            };
            if let Some((score, source)) = chosen {
                scores[position] = Some(score + char_score(position));
                sources[position] = source;
            }
        }
        best.push(scores);
        from.push(sources);
    }
    let last = best.len() - 1;
    let (mut position, score) = best[last]
        .iter()
        .enumerate()
        .filter_map(|(position, score)| score.map(|score| (position, score)))
        .fold(None, |found: Option<(usize, u32)>, (position, score)| match found {
            Some((_, best_score)) if best_score >= score => found,
            _ => Some((position, score)),
        })?;
    let mut positions = vec![position; letters.len()];
    for row in (1..letters.len()).rev() {
        position = from[row][position];
        positions[row - 1] = position;
    }
    Some((score, positions))
}

fn is_subsequence(text: &[char], letters: &[char]) -> bool {
    let mut rest = text.iter();
    letters.iter().all(|letter| rest.any(|ch| ch == letter))
}

/// Character indices, ascending, as ranges with touching ones joined.
fn merged_ranges(indices: impl IntoIterator<Item = usize>) -> Vec<Range<usize>> {
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for index in indices {
        match ranges.last_mut() {
            Some(last) if index <= last.end => last.end = last.end.max(index + 1),
            _ => ranges.push(index..index + 1),
        }
    }
    ranges
}

/// Character ranges of `label` in UTF-16 code units, the offsets the
/// frontend's strings count.
fn label_matches(label: &str, ranges: &[Range<usize>]) -> Vec<LabelMatch> {
    let mut offsets = Vec::with_capacity(label.len() + 1);
    let mut units = 0usize;
    offsets.push(units);
    for ch in label.chars() {
        units += ch.len_utf16();
        offsets.push(units);
    }
    // A label is a file name or a line of a note, far below `u32::MAX` units.
    let unit = |index: usize| u32::try_from(offsets[index.min(offsets.len() - 1)]).unwrap_or(u32::MAX);
    ranges
        .iter()
        .filter(|range| range.start < range.end)
        .map(|range| LabelMatch { start: unit(range.start), end: unit(range.end) })
        .collect()
}

/// One of a note's own headings, as the reading mode's `sourceHeadings`
/// keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceHeading {
    level: u8,
    /// From the first to the last of its content as written, trimmed.
    text: String,
    /// The text as the walk compares it ([`heading_key`]).
    key: String,
}

/// The headings of the document's top level in `body`: not those inside a
/// quote, a callout, a list or a footnote definition, nor lines of a `$$`
/// formula the reading mode draws as math.
fn source_headings(body: &str) -> Vec<SourceHeading> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH;
    // `pulldown_cmark` reads `$$` only inside a paragraph; the reading mode
    // reads a `$$` block as a formula, with no heading in it. Its lines turn
    // blank, keeping every offset.
    let parsed = blank_math_blocks(body);
    let mut depth = 0usize;
    let mut headings = Vec::new();
    for (event, range) in Parser::new_ext(&parsed, options).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) if depth == 0 => {
                let text = body
                    .get(range.clone())
                    .map(|source| heading_content(source).trim().to_string())
                    .unwrap_or_default();
                headings.push(SourceHeading {
                    // `HeadingLevel` is `H1 = 1` through `H6 = 6`.
                    level: level as u8,
                    key: heading_key(&text),
                    text,
                });
            }
            Event::Start(
                Tag::BlockQuote(_) | Tag::List(_) | Tag::Item | Tag::FootnoteDefinition(_),
            ) => depth += 1,
            Event::End(TagEnd::BlockQuote(_) | TagEnd::List(_) | TagEnd::Item | TagEnd::FootnoteDefinition) => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    headings
}

/// The content of the heading whose source is `source`, from its first to
/// its last character: an ATX heading without its `#` marks and closing
/// sequence, a Setext heading without its underline.
fn heading_content(source: &str) -> &str {
    let lines = source.trim_end_matches(['\r', '\n']);
    if let Some((content, _underline)) = lines.rsplit_once('\n') {
        return content.trim();
    }
    let line = lines.trim_start_matches([' ', '\t']);
    let content = line.trim_start_matches('#').trim_matches([' ', '\t']);
    if content.chars().all(|ch| ch == '#') {
        return "";
    }
    let without_closing = content.trim_end_matches('#');
    if without_closing.len() < content.len() && without_closing.ends_with([' ', '\t']) {
        return without_closing.trim_end_matches([' ', '\t']);
    }
    content
}

/// The characters Obsidian replaces by a space before it compares headings
/// (`stripHeading`, `HEADING_SPECIAL_CHARACTERS` of anchors.ts).
fn is_heading_special(ch: char) -> bool {
    matches!(
        ch,
        '!' | '"' | '#' | '$' | '%' | '&' | '(' | ')' | '*' | '+' | ',' | '.' | ':' | ';' | '<'
            | '=' | '>' | '?' | '@' | '^' | '`' | '{' | '|' | '}' | '~' | '/' | '[' | ']'
            | '\\' | '\r' | '\n'
    )
}

/// The characters a heading part of a link cannot hold: they would end the
/// part, the link or its target, or make the part a block id.
fn is_link_breaking(ch: char) -> bool {
    matches!(ch, '#' | '|' | '^' | '[' | ']' | '\r' | '\n')
}

/// Whitespace as JavaScript's `\s` reads it, which anchors.ts collapses.
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `text` with every character `replaced` picks written as a space, runs of
/// whitespace as one space, and no space at the ends.
fn spaced(text: &str, replaced: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if replaced(ch) || is_js_whitespace(ch) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

/// A heading as Obsidian compares it (`stripHeading` of anchors.ts).
fn strip_heading(text: &str) -> String {
    spaced(text, is_heading_special)
}

/// What two headings are compared by: their stripped text, letter case aside
/// (`sameHeading` of anchors.ts).
fn heading_key(text: &str) -> String {
    strip_heading(text).to_lowercase()
}

/// A heading written as one `#` part of a link: readable, as the heading
/// reads, with only what would break the link taken out.
fn heading_link_part(text: &str) -> String {
    spaced(text, is_link_breaking)
}

/// Which of `headings` the parts of `Note#A#B` name, by Obsidian's walk
/// (`matchHeading` of anchors.ts): headings in order, each part matching a
/// heading deeper than the one the part before matched.
fn match_heading(headings: &[SourceHeading], path: &[&str]) -> Option<usize> {
    if path.is_empty() {
        return None;
    }
    let keys: Vec<String> = path.iter().map(|part| heading_key(part)).collect();
    let mut part = 0;
    let mut level = 0;
    for (index, heading) in headings.iter().enumerate() {
        if heading.level <= level || heading.key != keys[part] {
            continue;
        }
        part += 1;
        level = heading.level;
        if part == path.len() {
            return Some(index);
        }
    }
    None
}

/// The heading a link fragment names on the frontend: its `#` parts without
/// empty ones (`parseArticleAnchor`), walked by [`match_heading`]; `None`
/// when the fragment names a block or nothing.
fn fragment_heading(headings: &[SourceHeading], fragment: &str) -> Option<usize> {
    let parts: Vec<&str> = fragment.split('#').filter(|part| !part.is_empty()).collect();
    if let [only] = parts.as_slice() {
        if only.starts_with('^') || only.starts_with("[^") {
            return None;
        }
    }
    match_heading(headings, &parts)
}

/// The fragment after `#` that names heading `index`: its own part, then its
/// ancestors' parts put before it one at a time (the nearest heading before
/// it of a lower level, and so on) until the walk reaches it and `accepts`
/// the fragment. Parts are tried readable first, then as Obsidian strips
/// them. `None` when nothing reaches it: an exact twin under the same parent.
fn heading_fragment(
    headings: &[SourceHeading],
    index: usize,
    accepts: impl Fn(&str) -> bool,
) -> Option<String> {
    let forms: [fn(&str) -> String; 2] = [heading_link_part, strip_heading];
    for form in forms {
        let own = form(&headings[index].text);
        if own.is_empty() {
            continue;
        }
        let mut parts = vec![own];
        let mut current = index;
        loop {
            let fragment = parts.join("#");
            if fragment_heading(headings, &fragment) == Some(index) && accepts(&fragment) {
                return Some(fragment);
            }
            let Some(parent) = parent_heading(headings, current) else {
                break;
            };
            current = parent;
            let part = form(&headings[parent].text);
            if !part.is_empty() {
                parts.insert(0, part);
            }
        }
    }
    None
}

/// The nearest heading before `index` of a lower level.
fn parent_heading(headings: &[SourceHeading], index: usize) -> Option<usize> {
    let level = headings[index].level;
    headings[..index].iter().rposition(|heading| heading.level < level)
}

/// A block id of a note and the text it names.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockId {
    id: String,
    /// The start of the block's text: its line before the id, or for an id
    /// alone on its line the nearest line above with text.
    detail: String,
}

/// The block ids `^id` of `body` in document order: ids that end a line
/// after whitespace or stand alone on it, outside fenced code and `$$`
/// formulas. A link matches an id in any letter case, so of `^a` and `^A`
/// only the first, the one a link reaches, is listed.
fn block_ids(body: &str) -> Vec<BlockId> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    let mut last_text: Option<&str> = None;
    for line in body_lines(body) {
        let text = line.text.trim();
        if line.kind == LineKind::Text {
            if let Some((before, id)) = line_block_id(text) {
                let detail = if before.is_empty() { last_text.unwrap_or("") } else { before };
                if seen.insert(id.to_ascii_lowercase()) {
                    ids.push(BlockId {
                        id: id.to_string(),
                        detail: detail.chars().take(BLOCK_DETAIL_MAX_CHARS).collect(),
                    });
                }
            }
        }
        if !text.is_empty() {
            last_text = Some(text);
        }
    }
    ids
}

/// The id `^id` that ends `line` (trimmed) after whitespace or makes up all
/// of it, and the text before it, trimmed.
fn line_block_id(line: &str) -> Option<(&str, &str)> {
    let caret = line.rfind('^')?;
    let id = &line[caret + 1..];
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        return None;
    }
    let before = &line[..caret];
    (before.is_empty() || before.ends_with(char::is_whitespace)).then(|| (before.trim(), id))
}

/// What a line of a body is to the reading mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineKind {
    Text,
    /// A line of a fenced code block, its fences included.
    Code,
    /// A line of a `$$` formula, its fences included.
    Math,
}

/// One line of a body.
struct BodyLine<'a> {
    /// The line without its line break.
    text: &'a str,
    kind: LineKind,
    /// Byte range of the line, its line break included.
    range: Range<usize>,
}

/// The lines of `body`, with which of them are code or formula: a fence of
/// three or more backticks or tildes, or of two or more `$`, indented by at
/// most three spaces, runs to a fence of the same character at least as long
/// with nothing after it, or to the end of the body. A backtick or `$` fence
/// has no such character after it.
fn body_lines(body: &str) -> Vec<BodyLine<'_>> {
    let mut lines = Vec::new();
    let mut open: Option<(u8, usize)> = None;
    let mut offset = 0;
    for raw in body.split_inclusive('\n') {
        let text = raw.trim_end_matches(['\r', '\n']);
        let range = offset..offset + raw.len();
        offset += raw.len();
        let fenced = |marker: u8| if marker == b'$' { LineKind::Math } else { LineKind::Code };
        let kind = if let Some((marker, width)) = open {
            if fence(text).is_some_and(|(found, count, rest)| {
                found == marker && count >= width && rest.trim().is_empty()
            }) {
                open = None;
            }
            fenced(marker)
        } else {
            match fence(text) {
                Some((marker, count, rest))
                    if (marker == b'$' && count >= 2 && !rest.contains('$'))
                        || (marker == b'`' && count >= 3 && !rest.contains('`'))
                        || (marker == b'~' && count >= 3) =>
                {
                    open = Some((marker, count));
                    fenced(marker)
                }
                _ => LineKind::Text,
            }
        };
        lines.push(BodyLine { text, kind, range });
    }
    lines
}

/// The fence `line` may open or close: its character, how many of it, and
/// what follows.
fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = *rest.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~' | b'$') {
        return None;
    }
    let count = rest.bytes().take_while(|byte| *byte == marker).count();
    Some((marker, count, &rest[count..]))
}

/// `body` with every line of a `$$` formula blank: each of its bytes but the
/// line break a space, so every offset stays where it was.
fn blank_math_blocks(body: &str) -> String {
    body_lines(body)
        .into_iter()
        .map(|line| {
            let raw = &body[line.range];
            if line.kind == LineKind::Math {
                let line_break = &raw[line.text.len()..];
                format!("{}{line_break}", " ".repeat(line.text.len()))
            } else {
                raw.to_string()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{Block, BlockType, DateTime, Frontmatter};
    use crate::storage::{block_queries, db, index};

    fn note(slug: &str, body: &str, block_type: BlockType) -> Block {
        Block {
            slug: slug.to_string(),
            frontmatter: Frontmatter {
                block_type,
                title: None,
                description: None,
                url: None,
                file: None,
                thumbnail: None,
                tags: Vec::new(),
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-01-01T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: None,
                position: None,
                color: None,
                icon: None,
            },
            body: body.to_string(),
        }
    }

    /// An index of cards `(slug, body)` and collection pages.
    fn space(cards: &[(&str, &str)], pages: &[&str]) -> Connection {
        let conn = db::open_memory().unwrap();
        for (slug, body) in cards {
            index::upsert_block(&conn, &note(slug, body, BlockType::Article), None).unwrap();
        }
        for slug in pages {
            index::upsert_block(&conn, &note(slug, "", BlockType::Channel), None).unwrap();
        }
        conn
    }

    fn suggest(conn: &Connection, query: &NoteLinkQuery) -> Vec<NoteLinkSuggestion> {
        suggest_note_links(conn, "Cards/Source", query).unwrap()
    }

    fn notes(text: &str) -> NoteLinkQuery {
        NoteLinkQuery::Notes { text: text.to_string() }
    }

    fn headings(note: &str, text: &str) -> NoteLinkQuery {
        NoteLinkQuery::Headings { note: note.to_string(), text: text.to_string() }
    }

    fn blocks(note: &str, text: &str) -> NoteLinkQuery {
        NoteLinkQuery::Blocks { note: note.to_string(), text: text.to_string() }
    }

    fn slugs(rows: &[NoteLinkSuggestion]) -> Vec<&str> {
        rows.iter().map(|row| row.slug.as_str()).collect()
    }

    fn labels(rows: &[NoteLinkSuggestion]) -> Vec<&str> {
        rows.iter().map(|row| row.label.as_str()).collect()
    }

    fn targets(rows: &[NoteLinkSuggestion]) -> Vec<&str> {
        rows.iter().map(|row| row.target.as_str()).collect()
    }

    fn matched(rows: &[NoteLinkSuggestion], index: usize) -> Vec<(u32, u32)> {
        rows[index].matches.iter().map(|range| (range.start, range.end)).collect()
    }

    /// The emission invariant, from the outside: the target read as a link
    /// (`split_link_fragment`) and resolved by a `LinkIndex` of every note
    /// opens the row's note, and navigation (`resolve_note_link`) agrees.
    fn assert_round_trip(conn: &Connection, row: &NoteLinkSuggestion) {
        let paths: Vec<String> = conn
            .prepare("SELECT slug FROM blocks")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|slug| format!("{}.md", slug.unwrap()))
            .collect();
        let (file, _) = split_link_fragment(&row.target);
        assert_eq!(
            LinkIndex::new(paths).resolve("Cards/Source.md", file, LinkSyntax::Obsidian),
            LinkResolution::Resolved(format!("{}.md", row.slug)),
            "{row:?}"
        );
        assert_eq!(
            block_queries::resolve_note_link(conn, "Cards/Source", &row.target).unwrap().as_deref(),
            Some(row.slug.as_str()),
            "{row:?}"
        );
    }

    #[test]
    fn notes_are_found_by_name_with_their_folder_and_matched_part() {
        let conn = space(&[("Cards/Source", ""), ("Notes/Пример заметки", ""), ("Other", "")], &[]);

        let rows = suggest(&conn, &notes("Пример"));

        assert_eq!(slugs(&rows), vec!["Notes/Пример заметки"]);
        assert_eq!(rows[0].label, "Пример заметки");
        assert_eq!(rows[0].detail, "Notes");
        assert_eq!(rows[0].target, "Пример заметки");
        assert_eq!(matched(&rows, 0), vec![(0, 6)]);
    }

    #[test]
    fn a_query_with_a_slash_matches_the_path() {
        let conn = space(
            &[("Cards/Source", ""), ("Notes/Пример заметки", ""), ("Archive/Пример заметки", "")],
            &[],
        );

        let rows = suggest(&conn, &notes("archive/пр"));

        assert_eq!(slugs(&rows), vec!["Archive/Пример заметки"]);
        assert_eq!(rows[0].target, "Archive/Пример заметки");
        assert_eq!(rows[0].detail, "Archive");
        // The matched part of the path that falls in the name.
        assert_eq!(matched(&rows, 0), vec![(0, 2)]);
    }

    #[test]
    fn a_fuzzy_query_finds_a_note_by_word_starts_and_spaced_parts() {
        let conn = space(&[("Cards/Source", ""), ("Notes/Пример заметки", ""), ("Подзаголовок", "")], &[]);

        let initials = suggest(&conn, &notes("пз"));
        let spaced = suggest(&conn, &notes("прим зам"));

        assert_eq!(slugs(&initials), vec!["Notes/Пример заметки", "Подзаголовок"]);
        assert_eq!(matched(&initials, 0), vec![(0, 1), (7, 8)]);
        assert_eq!(slugs(&spaced), vec!["Notes/Пример заметки"]);
        assert_eq!(matched(&spaced, 0), vec![(0, 4), (7, 10)]);
    }

    #[test]
    fn matched_parts_count_utf16_code_units() {
        let conn = space(&[("Cards/Source", ""), ("🙂 Smile", "")], &[]);

        let rows = suggest(&conn, &notes("smile"));

        // The emoji is two code units, the space one.
        assert_eq!(matched(&rows, 0), vec![(3, 8)]);
    }

    #[test]
    fn notes_rank_exact_prefix_word_start_substring_then_subsequence() {
        let conn = space(
            &[
                ("Cards/Source", ""),
                ("Pelican", ""),
                ("Explanation", ""),
                ("Big plan", ""),
                ("Planet", ""),
                ("Plan", ""),
                ("Unrelated", ""),
            ],
            &[],
        );

        let rows = suggest(&conn, &notes("plan"));

        assert_eq!(labels(&rows), vec!["Plan", "Planet", "Big plan", "Explanation", "Pelican"]);
    }

    #[test]
    fn an_empty_query_lists_every_card_by_name() {
        let conn = space(&[("b", ""), ("c/a", ""), ("A", ""), ("Cards/Source", "")], &[]);

        let rows = suggest(&conn, &notes("  "));

        assert_eq!(slugs(&rows), vec!["A", "c/a", "b", "Cards/Source"]);
        assert!(rows.iter().all(|row| row.matches.is_empty()));
    }

    #[test]
    fn collection_pages_are_never_offered_but_make_a_name_ambiguous() {
        let conn = space(
            &[("Cards/Source", ""), ("Cards/Design", ""), ("Cards/Design notes", "")],
            &["Collections/Design"],
        );

        let rows = suggest(&conn, &notes("design"));
        let all = suggest(&conn, &notes(""));

        assert_eq!(slugs(&rows), vec!["Cards/Design", "Cards/Design notes"]);
        assert_eq!(targets(&rows), vec!["Cards/Design", "Design notes"]);
        assert!(!slugs(&all).contains(&"Collections/Design"));
        for row in &rows {
            assert_round_trip(&conn, row);
        }
    }

    #[test]
    fn at_most_the_limit_of_rows_is_returned() {
        let names: Vec<String> = (0..60).map(|number| format!("Note {number:02}")).collect();
        let cards: Vec<(&str, &str)> = names.iter().map(|name| (name.as_str(), "")).collect();
        let conn = space(&cards, &[]);

        assert_eq!(suggest(&conn, &notes("")).len(), NOTE_LINK_SUGGESTION_LIMIT);
        assert_eq!(suggest(&conn, &notes("note")).len(), NOTE_LINK_SUGGESTION_LIMIT);
    }

    #[test]
    fn every_emitted_note_target_resolves_to_the_chosen_note() {
        let conn = space(
            &[
                ("Cards/Source", ""),
                ("Cards/Unique", ""),
                ("A/Twin", ""),
                ("B/Twin", ""),
                ("Folder/Deep", ""),
                ("Same", ""),
                ("Folder/Same", ""),
            ],
            &[],
        );

        let rows = suggest(&conn, &notes(""));

        let by_slug: HashMap<&str, &str> =
            rows.iter().map(|row| (row.slug.as_str(), row.target.as_str())).collect();
        // A unique name is bare; twins in two folders carry their folder; a
        // root note keeps the bare name and its folder namesake its path.
        assert_eq!(by_slug["Cards/Unique"], "Unique");
        assert_eq!(by_slug["A/Twin"], "A/Twin");
        assert_eq!(by_slug["B/Twin"], "B/Twin");
        assert_eq!(by_slug["Folder/Deep"], "Deep");
        assert_eq!(by_slug["Same"], "Same");
        assert_eq!(by_slug["Folder/Same"], "Folder/Same");
        for row in &rows {
            assert_round_trip(&conn, row);
        }
    }

    #[test]
    fn a_note_whose_link_would_read_as_another_is_left_out() {
        let conn = space(&[("Cards/Source", ""), ("Book [2020]", ""), ("C# notes", ""), ("C", "")], &[]);

        let rows = suggest(&conn, &notes(""));

        // `[[Book [2020]]]` ends at the first `]]`; `C# notes` opens `C`.
        assert_eq!(slugs(&rows), vec!["C", "Cards/Source"]);
    }

    const HEADINGS_BODY: &str = "# Title **bold** [[Link]]\n\n\
> # Quoted\n\n\
- # Listed\n\n\
> [!note] Callout\n> ## In callout\n\n\
[^1]: # Footnote\n\n\
Setext *heading*\n----------------\n\n\
```\n# not a heading\n```\n\n\
$$\n# not a heading either\n$$\n\n\
## Closing ##\n";

    #[test]
    fn headings_are_the_top_level_ones_with_their_text_as_written() {
        let conn = space(&[("Cards/Source", ""), ("Notes/Guide", HEADINGS_BODY)], &[]);

        let rows = suggest(&conn, &headings("Guide", ""));

        assert_eq!(labels(&rows), vec!["Title **bold** [[Link]]", "Setext *heading*", "Closing"]);
        let details: Vec<&str> = rows.iter().map(|row| row.detail.as_str()).collect();
        assert_eq!(details, vec!["H1", "H2", "H2"]);
        assert_eq!(
            targets(&rows),
            vec!["Guide#Title **bold** Link", "Guide#Setext *heading*", "Guide#Closing"]
        );
        let found = source_headings(HEADINGS_BODY);
        for (index, row) in rows.iter().enumerate() {
            assert_eq!(row.slug, "Notes/Guide");
            assert_round_trip(&conn, row);
            let (_, fragment) = split_link_fragment(&row.target);
            assert_eq!(fragment_heading(&found, fragment.unwrap()), Some(index));
        }
    }

    #[test]
    fn heading_parts_leave_out_what_would_break_the_link() {
        let body = "# What? A|B #1 [x] ^y\n\n## Read README.md\n";
        let conn = space(&[("Cards/Source", ""), ("Guide", body)], &[]);

        let rows = suggest(&conn, &headings("Guide", ""));

        assert_eq!(labels(&rows), vec!["What? A|B #1 [x] ^y", "Read README.md"]);
        // `Guide#Read README.md` would name a file `.md`: Obsidian's own
        // stripped form names the heading instead.
        assert_eq!(targets(&rows), vec!["Guide#What? A B 1 x y", "Guide#Read README md"]);
        let found = source_headings(body);
        for (index, row) in rows.iter().enumerate() {
            assert_round_trip(&conn, row);
            let (_, fragment) = split_link_fragment(&row.target);
            assert_eq!(fragment_heading(&found, fragment.unwrap()), Some(index));
        }
    }

    #[test]
    fn a_duplicate_heading_gets_the_path_that_reaches_it_or_is_left_out() {
        let body = "# A\n## Setup\n# B\n## Setup\n## SETUP\n";
        let conn = space(&[("Cards/Source", ""), ("Guide", body)], &[]);

        let rows = suggest(&conn, &headings("Guide", ""));
        let filtered = suggest(&conn, &headings("Guide", "setup"));

        // The last `SETUP` is the twin of the `Setup` before it under `B`:
        // Obsidian's walk, letter case aside, never reaches it.
        assert_eq!(targets(&rows), vec!["Guide#A", "Guide#Setup", "Guide#B", "Guide#B#Setup"]);
        let found = source_headings(body);
        let reached: Vec<Option<usize>> = rows
            .iter()
            .map(|row| fragment_heading(&found, split_link_fragment(&row.target).1.unwrap()))
            .collect();
        assert_eq!(reached, vec![Some(0), Some(1), Some(2), Some(3)]);
        assert_eq!(targets(&filtered), vec!["Guide#Setup", "Guide#B#Setup"]);
        assert_eq!(matched(&filtered, 0), vec![(0, 5)]);
    }

    #[test]
    fn the_heading_walk_matches_obsidian() {
        let found = source_headings("# Intro\n## Hello, World!\n### Deep\n# Other\n### Deep\n");

        assert_eq!(strip_heading("Hello, World!"), "Hello World");
        assert_eq!(match_heading(&found, &["hello world"]), Some(1));
        assert_eq!(match_heading(&found, &["Deep"]), Some(2));
        assert_eq!(match_heading(&found, &["Other", "Deep"]), Some(4));
        assert_eq!(match_heading(&found, &["Deep", "Intro"]), None);
        assert_eq!(fragment_heading(&found, "^Deep"), None);
    }

    #[test]
    fn block_ids_end_their_line_or_stand_alone_outside_code_and_formulas() {
        let long = "x".repeat(100);
        let body = format!(
            "First paragraph text. ^first-id\n\n\
- item one ^item-1\n\n\
| a | b |\n|---|---|\n| 1 | 2 |\n\n^table-id\n\n\
```\ncode ^not-code\n```\n\n\
$$\nx ^not-math\n$$\n\n\
word^glued\n\n\
Footnote ref[^1] text\n\n\
{long} ^long\n\n\
Again ^FIRST-ID\n"
        );
        let conn = space(&[("Cards/Source", ""), ("Guide", &body)], &[]);

        let rows = suggest(&conn, &blocks("Guide", ""));

        assert_eq!(labels(&rows), vec!["first-id", "item-1", "table-id", "long"]);
        let details: Vec<&str> = rows.iter().map(|row| row.detail.as_str()).collect();
        assert_eq!(details, vec!["First paragraph text.", "- item one", "| 1 | 2 |", &long[..80]]);
        assert_eq!(rows[0].target, "Guide#^first-id");
        for row in &rows {
            assert_round_trip(&conn, row);
        }
        let filtered = suggest(&conn, &blocks("Guide", "item"));
        assert_eq!(labels(&filtered), vec!["item-1"]);
        assert_eq!(matched(&filtered, 0), vec![(0, 4)]);
    }

    #[test]
    fn headings_and_blocks_of_no_card_are_empty() {
        let conn = space(
            &[("Cards/Source", ""), ("A/Twin", "# Heading ^id"), ("B/Twin", "# Heading ^id")],
            &["Collections/Design"],
        );

        for note in ["Missing", "Design", "Twin", ""] {
            assert!(suggest(&conn, &headings(note, "")).is_empty(), "{note}");
            assert!(suggest(&conn, &blocks(note, "")).is_empty(), "{note}");
        }
        assert_eq!(suggest(&conn, &headings("A/Twin", "")).len(), 1);
    }
}
