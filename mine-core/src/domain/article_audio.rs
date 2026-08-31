// Shared article audio preparation: convert article-like markdown prose into a
// stable, speakable text contract that desktop and iOS can share.
//
// Pure logic: no filesystem, no Tauri, no platform speech APIs.

use sha2::{Digest, Sha256};
use thiserror::Error;
use whatlang::{detect, Lang};

use crate::domain::block::{
    derive_card_kind, derive_title_fields, strip_first_markdown_h1, Block, CardKind,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedArticleSpeech {
    pub speakable_text: String,
    pub text_hash: String,
    pub language_tag: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ArticleAudioPrepError {
    #[error("block '{slug}' is not an article")]
    NotArticle { slug: String },

    #[error("block '{slug}' is a social/media post, not an article")]
    UnsupportedArticleKind { slug: String },

    #[error("block '{slug}' has no speakable prose")]
    EmptySpeech { slug: String },
}

pub fn prepare_article_speech(
    block: &Block,
) -> Result<PreparedArticleSpeech, ArticleAudioPrepError> {
    if derive_card_kind(block) != CardKind::Article {
        return Err(ArticleAudioPrepError::NotArticle {
            slug: block.slug.clone(),
        });
    }
    if is_social_url(block.frontmatter.url.as_deref()) {
        return Err(ArticleAudioPrepError::UnsupportedArticleKind {
            slug: block.slug.clone(),
        });
    }

    let mut sections = Vec::new();
    let title_fields =
        derive_title_fields(&block.slug, block.frontmatter.title.as_deref(), &block.body);
    if let Some(title) = title_fields.display_title.as_deref() {
        let title = normalize_inline_markup(title);
        if !title.is_empty() {
            sections.push(title);
        }
    }
    if let Some(author) = block.frontmatter.author.as_deref() {
        let author = normalize_inline_markup(author);
        if !author.is_empty() {
            sections.push(author);
        }
    }

    let body = sanitize_body_for_speech(&strip_first_markdown_h1(&block.body));
    if !body.is_empty() {
        sections.push(body);
    }

    let speakable_text = sections.join("\n\n").trim().to_string();
    if speakable_text.is_empty() {
        return Err(ArticleAudioPrepError::EmptySpeech {
            slug: block.slug.clone(),
        });
    }

    let text_hash = hash_text(&speakable_text);
    let language_tag = detect_language_tag(&speakable_text);

    Ok(PreparedArticleSpeech {
        speakable_text,
        text_hash,
        language_tag,
    })
}

fn is_social_url(url: Option<&str>) -> bool {
    let Some(url) = url else {
        return false;
    };
    let lower = url.to_lowercase();
    ((lower.contains("twitter.com/") || lower.contains("x.com/")) && lower.contains("/status/"))
        || lower.contains("instagram.com/p/")
        || lower.contains("instagram.com/reel/")
        || lower.contains("instagram.com/stories/")
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn detect_language_tag(text: &str) -> Option<String> {
    let info = detect(text)?;
    let lang = match info.lang() {
        Lang::Eng => "en-US",
        Lang::Rus => "ru-RU",
        Lang::Ukr => "uk-UA",
        Lang::Spa => "es-ES",
        Lang::Por => "pt-BR",
        Lang::Fra => "fr-FR",
        Lang::Deu => "de-DE",
        Lang::Ita => "it-IT",
        _ => return None,
    };
    Some(lang.to_string())
}

fn sanitize_body_for_speech(body: &str) -> String {
    let mut paragraphs = Vec::new();
    let mut current = Vec::new();
    let mut in_fence = false;

    for raw_line in body.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        if is_table_line(trimmed) {
            continue;
        }

        let normalized = normalize_line_for_speech(trimmed);
        if normalized.is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
            continue;
        }

        current.push(normalized);
    }

    if !current.is_empty() {
        paragraphs.push(current.join(" "));
    }

    collapse_paragraphs(paragraphs)
}

fn is_table_line(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    if line.starts_with('|') && line.ends_with('|') {
        return true;
    }
    let pipe_count = line.chars().filter(|c| *c == '|').count();
    pipe_count >= 2
        && line
            .chars()
            .all(|c| c == '|' || c == '-' || c == ':' || c == ' ')
}

fn normalize_line_for_speech(line: &str) -> String {
    let line = strip_list_marker(strip_blockquote_prefix(line));
    let line = line.trim_start_matches('#').trim();
    if line.is_empty() {
        return String::new();
    }
    normalize_inline_markup(line)
}

fn strip_blockquote_prefix(mut line: &str) -> &str {
    while let Some(rest) = line.strip_prefix('>') {
        line = rest.trim_start();
    }
    line
}

fn strip_list_marker(line: &str) -> &str {
    if let Some(rest) = line.strip_prefix("- ") {
        return rest;
    }
    if let Some(rest) = line.strip_prefix("* ") {
        return rest;
    }
    if let Some(rest) = line.strip_prefix("+ ") {
        return rest;
    }

    let mut digits_len = 0;
    for ch in line.chars() {
        if ch.is_ascii_digit() {
            digits_len += ch.len_utf8();
            continue;
        }
        break;
    }
    if digits_len > 0 {
        let suffix = &line[digits_len..];
        if let Some(rest) = suffix.strip_prefix(". ") {
            return rest;
        }
        if let Some(rest) = suffix.strip_prefix(") ") {
            return rest;
        }
    }

    line
}

fn normalize_inline_markup(line: &str) -> String {
    let line = remove_markdown_images(line);
    let line = replace_markdown_links(&line);
    let line = remove_bare_urls(&line);
    let line = remove_inline_code(&line);
    collapse_inline_whitespace(strip_formatting_marks(&line))
}

fn remove_markdown_images(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        if rest.starts_with("![") {
            if let Some(end) = find_markdown_link_end(rest) {
                i += end;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or_default();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn replace_markdown_links(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        if rest.starts_with('[') {
            if let Some((label, consumed)) = parse_markdown_link(rest) {
                out.push_str(label.trim());
                i += consumed;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or_default();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn parse_markdown_link(input: &str) -> Option<(&str, usize)> {
    let bytes = input.as_bytes();
    let close_label = bytes.iter().position(|b| *b == b']')?;
    if bytes.get(close_label + 1) != Some(&b'(') {
        return None;
    }
    let tail = &input[close_label + 2..];
    let close_url = tail.find(')')?;
    let consumed = close_label + 2 + close_url + 1;
    Some((&input[1..close_label], consumed))
}

fn find_markdown_link_end(input: &str) -> Option<usize> {
    let bytes = input.as_bytes();
    let close_label = bytes.iter().position(|b| *b == b']')?;
    if bytes.get(close_label + 1) != Some(&b'(') {
        return None;
    }
    let tail = &input[close_label + 2..];
    let close_url = tail.find(')')?;
    Some(close_label + 2 + close_url + 1)
}

fn remove_bare_urls(input: &str) -> String {
    input
        .split_whitespace()
        .filter(|part| !part.starts_with("http://") && !part.starts_with("https://"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn remove_inline_code(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_code = false;
    for ch in input.chars() {
        if ch == '`' {
            in_code = !in_code;
            continue;
        }
        if !in_code {
            out.push(ch);
        }
    }
    out
}

fn strip_formatting_marks(input: &str) -> String {
    input
        .chars()
        .filter(|ch| !matches!(ch, '*' | '_' | '~'))
        .collect()
}

fn collapse_inline_whitespace(input: String) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collapse_paragraphs(paragraphs: Vec<String>) -> String {
    paragraphs
        .into_iter()
        .map(|p| collapse_inline_whitespace(p))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, DateTime, Frontmatter};

    fn article(body: &str) -> Block {
        Block {
            slug: "essay".to_string(),
            frontmatter: Frontmatter {
                block_type: BlockType::Article,
                title: Some("My **Title**".to_string()),
                description: None,
                url: Some("https://example.com/article".to_string()),
                file: None,
                thumbnail: None,
                tags: vec![],
                related_notes: Vec::new(),
                source_media: None,
                saved_at: DateTime::new("2026-04-19T00:00:00Z").unwrap(),
                source: None,
                width: None,
                height: None,
                author: Some("Jane _Doe_".to_string()),
                position: None,
                color: None,
                icon: None,
            },
            body: body.to_string(),
        }
    }

    #[test]
    fn prepares_article_speech_from_title_author_and_prose() {
        let prepared =
            prepare_article_speech(&article("Hello world.\n\nSecond paragraph.")).unwrap();
        assert_eq!(
            prepared.speakable_text,
            "My Title\n\nJane Doe\n\nHello world.\n\nSecond paragraph."
        );
        assert_eq!(prepared.text_hash.len(), 64);
    }

    #[test]
    fn strips_images_links_urls_code_and_tables() {
        let prepared = prepare_article_speech(&article(
            "# Intro\n\
             > Quote line\n\
             - Bullet item\n\
             ![hero](hero.png)\n\
             [Example](https://example.com)\n\
             https://openai.com\n\
             `inline code`\n\
             ```ts\nconst x = 1;\n```\n\
             | col | two |\n\
             | --- | --- |\n\
             Final paragraph.",
        ))
        .unwrap();
        assert_eq!(
            prepared.speakable_text,
            "Intro\n\nJane Doe\n\nQuote line Bullet item\n\nExample\n\nFinal paragraph."
        );
    }

    #[test]
    fn rejects_social_articles() {
        let mut block = article("Hello");
        block.frontmatter.url = Some("https://x.com/a/status/1".to_string());
        let err = prepare_article_speech(&block).unwrap_err();
        assert_eq!(
            err,
            ArticleAudioPrepError::UnsupportedArticleKind {
                slug: "essay".to_string(),
            }
        );
    }

    #[test]
    fn hash_changes_only_with_speech_relevant_content() {
        let base = prepare_article_speech(&article("Body text.\n![hero](a.png)")).unwrap();
        let same =
            prepare_article_speech(&article("Body text.\n![other](b.png)\nhttps://x.com")).unwrap();
        let changed = prepare_article_speech(&article("Body text changed.")).unwrap();
        assert_eq!(base.text_hash, same.text_hash);
        assert_ne!(base.text_hash, changed.text_hash);
    }

    #[test]
    fn detects_language_tag_for_russian_text() {
        let prepared =
            prepare_article_speech(&article("Это русскоязычный текст статьи без картинок."))
                .unwrap();
        assert_eq!(prepared.language_tag.as_deref(), Some("ru-RU"));
    }
}
