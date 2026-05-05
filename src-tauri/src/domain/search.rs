// Search: query parsing for FTS5 and filtering.
//
// Parses user input like "type:image tag:design sunset tokyo"
// into a structured SearchQuery with typed filters and free text.
//
// Contract: SPEC_DOMAIN.md#domain/search

use super::block::CardKind;

// ─── Types ──────────────────────────────────────────────────────────────────

/// A parsed search query with optional filters and free text.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchQuery {
    /// Free text for FTS5 full-text search.
    pub text: String,
    /// Structured filters extracted from the query.
    pub filters: Vec<SearchFilter>,
}

/// A typed search filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchFilter {
    /// Filter by derived card kind: `type:media`.
    Type(CardKind),
    /// Filter by tag: `tag:design`.
    Tag(String),
}

impl SearchQuery {
    /// Returns true if the query has no text and no filters.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.filters.is_empty()
    }

    /// Returns true if the query has at least one filter.
    pub fn has_filters(&self) -> bool {
        !self.filters.is_empty()
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Parse a search string into a structured query.
///
/// Recognized filters:
/// - `type:media` (or article, channel; legacy image/link/video/file aliases map to media)
/// - `tag:design`
///
/// Unknown filter prefixes (e.g. `foo:bar`) are treated as plain text.
/// Unknown type values (e.g. `type:unknown`) are treated as plain text.
pub fn parse_search_query(input: &str) -> SearchQuery {
    let mut filters = Vec::new();
    let mut text_parts = Vec::new();

    for token in input.split_whitespace() {
        if let Some(parsed) = try_parse_filter(token) {
            filters.push(parsed);
        } else {
            text_parts.push(token);
        }
    }

    SearchQuery {
        text: text_parts.join(" "),
        filters,
    }
}

// ─── Private helpers ────────────────────────────────────────────────────────

/// Try to parse a single token as a filter.
/// Returns None if the token is not a recognized filter.
fn try_parse_filter(token: &str) -> Option<SearchFilter> {
    let (prefix, value) = token.split_once(':')?;

    match prefix {
        "type" => {
            let card_kind = parse_card_kind_filter(value)?;
            Some(SearchFilter::Type(card_kind))
        }
        "tag" => {
            if value.is_empty() {
                None
            } else {
                Some(SearchFilter::Tag(value.to_string()))
            }
        }
        _ => None, // Unknown prefix: treat as text
    }
}

fn parse_card_kind_filter(value: &str) -> Option<CardKind> {
    match value {
        "article" => Some(CardKind::Article),
        "media" | "image" | "link" | "video" | "file" => Some(CardKind::Media),
        "channel" => Some(CardKind::Channel),
        _ => None,
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query() {
        // S1
        let q = parse_search_query("");
        assert!(q.is_empty());
        assert_eq!(q.text, "");
        assert!(q.filters.is_empty());
    }

    #[test]
    fn text_only() {
        // S2
        let q = parse_search_query("sunset tokyo");
        assert_eq!(q.text, "sunset tokyo");
        assert!(q.filters.is_empty());
    }

    #[test]
    fn type_filter_only() {
        // S3
        let q = parse_search_query("type:image");
        assert_eq!(q.text, "");
        assert_eq!(q.filters, vec![SearchFilter::Type(CardKind::Media)]);
    }

    #[test]
    fn type_filter_with_text() {
        // S4
        let q = parse_search_query("type:image sunset");
        assert_eq!(q.text, "sunset");
        assert_eq!(q.filters, vec![SearchFilter::Type(CardKind::Media)]);
    }

    #[test]
    fn multiple_tag_filters() {
        // S5
        let q = parse_search_query("tag:design tag:web");
        assert_eq!(q.text, "");
        assert_eq!(
            q.filters,
            vec![
                SearchFilter::Tag("design".to_string()),
                SearchFilter::Tag("web".to_string()),
            ]
        );
    }

    #[test]
    fn mixed_filters_and_text() {
        // S6
        let q = parse_search_query("type:image tag:design sunset tokyo");
        assert_eq!(q.text, "sunset tokyo");
        assert_eq!(
            q.filters,
            vec![
                SearchFilter::Type(CardKind::Media),
                SearchFilter::Tag("design".to_string()),
            ]
        );
    }

    #[test]
    fn unknown_type_treated_as_text() {
        // S7
        let q = parse_search_query("type:unknown");
        assert_eq!(q.text, "type:unknown");
        assert!(q.filters.is_empty());
    }

    #[test]
    fn unknown_prefix_treated_as_text() {
        // S8
        let q = parse_search_query("foo:bar");
        assert_eq!(q.text, "foo:bar");
        assert!(q.filters.is_empty());
    }

    #[test]
    fn whitespace_normalized() {
        // S9
        let q = parse_search_query("  type:image  sunset  ");
        assert_eq!(q.text, "sunset");
        assert_eq!(q.filters, vec![SearchFilter::Type(CardKind::Media)]);
    }

    #[test]
    fn all_card_kind_filters_and_legacy_media_aliases() {
        for (input, expected) in [
            ("type:media", CardKind::Media),
            ("type:image", CardKind::Media),
            ("type:link", CardKind::Media),
            ("type:video", CardKind::Media),
            ("type:file", CardKind::Media),
            ("type:article", CardKind::Article),
            ("type:channel", CardKind::Channel),
        ] {
            let q = parse_search_query(input);
            assert_eq!(q.filters, vec![SearchFilter::Type(expected)]);
        }
    }

    #[test]
    fn empty_tag_value_treated_as_text() {
        let q = parse_search_query("tag:");
        assert_eq!(q.text, "tag:");
        assert!(q.filters.is_empty());
    }

    #[test]
    fn is_empty_and_has_filters() {
        let empty = parse_search_query("");
        assert!(empty.is_empty());
        assert!(!empty.has_filters());

        let with_text = parse_search_query("hello");
        assert!(!with_text.is_empty());
        assert!(!with_text.has_filters());

        let with_filter = parse_search_query("type:image");
        assert!(!with_filter.is_empty());
        assert!(with_filter.has_filters());
    }

    #[test]
    fn filter_order_preserved() {
        let q = parse_search_query("tag:b type:image tag:a");
        assert_eq!(
            q.filters,
            vec![
                SearchFilter::Tag("b".to_string()),
                SearchFilter::Type(CardKind::Media),
                SearchFilter::Tag("a".to_string()),
            ]
        );
    }

    #[test]
    fn url_in_text_not_parsed_as_filter() {
        let q = parse_search_query("https://example.com");
        assert_eq!(q.text, "https://example.com");
        assert!(q.filters.is_empty());
    }
}
