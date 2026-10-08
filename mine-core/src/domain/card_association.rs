// Card associations: the rules that relate two cards by their own fields.
//
// Two cards share an author, a site or an address. Nothing here is written
// to a note: the index derives these keys from `author` and `url` and keeps
// them rebuildable. The functions are pure; `None` means the card carries no
// association by that rule.
//
// Contract: SPEC_CARD_ASSOCIATIONS.md

use unicode_normalization::UnicodeNormalization;
use url::Url;

use crate::domain::block::{Block, Frontmatter, IMAGE_MEDIA_EXTS, VIDEO_MEDIA_EXTS};
use crate::links::{note_name_key, obsidian_target_name_keys};

/// `source` of a card extracted from an inline image of another card.
pub const INLINE_MEDIA_EXTRACTION_SOURCE: &str = "inline-media-extraction";
/// `source` of a card extracted from selected text of another card.
pub const TEXT_SELECTION_EXTRACTION_SOURCE: &str = "text-selection-extraction";

/// Domains where different people publish: a host equal to one of them, or
/// ending in `.` plus one of them, has no site association. The list grows by
/// adding a domain here and a case to the test below.
pub const SHARED_PLATFORM_DOMAINS: &[&str] = &[
    // X
    "x.com",
    "twitter.com",
    "twimg.com",
    "t.co",
    // Instagram
    "instagram.com",
    "cdninstagram.com",
    // YouTube
    "youtube.com",
    "youtu.be",
    "ytimg.com",
    "youtube-nocookie.com",
    // cosmos.so
    "cosmos.so",
    // Are.na
    "are.na",
];

const WWW_PREFIX: &str = "www.";
const UTM_PARAMETER_PREFIX: &str = "utm_";

/// The author as written on the card: trimmed, `None` when empty.
#[must_use]
pub fn author_label(author: &str) -> Option<String> {
    let trimmed = author.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The comparison key of an author: the label in NFC, lowercased. The same
/// visible name typed with composed or decomposed letters is one author;
/// inner spaces, `@` and punctuation stay significant.
#[must_use]
pub fn author_key(author: &str) -> Option<String> {
    author_label(author).map(|label| label.nfc().collect::<String>().to_lowercase())
}

/// The comparison key of an address, or `None` for an address that cannot
/// carry the association: not `http(s)`, unparsable or without a host.
///
/// The address is read the WHATWG way, so host case, a default port and an
/// empty path against `/` do not tell two addresses apart. A leading `www.`,
/// the fragment and `utm_*` parameters are dropped; everything else, the
/// scheme included, stays significant.
#[must_use]
pub fn address_key(url: &str) -> Option<String> {
    let parsed = parse_web_url(url)?;
    let host = host_without_www(&parsed)?;
    let mut key = format!("{}://", parsed.scheme());
    if !parsed.username().is_empty() {
        key.push_str(parsed.username());
        if let Some(password) = parsed.password() {
            key.push(':');
            key.push_str(password);
        }
        key.push('@');
    }
    key.push_str(&host);
    if let Some(port) = parsed.port() {
        key.push(':');
        key.push_str(&port.to_string());
    }
    key.push_str(parsed.path());
    let kept: Vec<&str> = parsed
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|pair| !pair.is_empty() && !is_utm_parameter(pair))
        .collect();
    if !kept.is_empty() {
        key.push('?');
        key.push_str(&kept.join("&"));
    }
    Some(key)
}

/// The site of an address: its host without `www.`, or `None` on a shared
/// platform, for an address that leads straight to an image or video file,
/// and for an address `address_key` refuses.
#[must_use]
pub fn site_key(url: &str) -> Option<String> {
    let parsed = parse_web_url(url)?;
    let host = host_without_www(&parsed)?;
    if is_shared_platform_host(&host) || leads_to_media_file(&parsed) {
        return None;
    }
    Some(host)
}

/// Whether `host` (lowercase) belongs to a platform where different people
/// publish. Matches whole labels: `notx.com` is not `x.com`.
#[must_use]
pub fn is_shared_platform_host(host: &str) -> bool {
    SHARED_PLATFORM_DOMAINS.iter().any(|domain| {
        host == *domain
            || host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

/// The link to the card this one was extracted from: the first entry of
/// `Mine Related Notes` of an extracted card, `None` for any other card.
///
/// A card is extracted when its `source` names an extraction or it carries
/// `Mine Source Media`. Both extraction paths write exactly one link to the
/// source when they create the card; links added later follow it.
#[must_use]
pub fn extraction_source_target(frontmatter: &Frontmatter) -> Option<&str> {
    if !is_extracted_card(
        frontmatter.source.as_deref(),
        frontmatter.source_media.is_some(),
    ) {
        return None;
    }
    frontmatter.related_notes.first().map(String::as_str)
}

/// Whether a card was extracted from another: its `source` names an
/// extraction, or it carries `Mine Source Media`.
#[must_use]
pub fn is_extracted_card(source: Option<&str>, has_source_media: bool) -> bool {
    matches!(
        source,
        Some(INLINE_MEDIA_EXTRACTION_SOURCE | TEXT_SELECTION_EXTRACTION_SOURCE)
    ) || has_source_media
}

/// The name key the index keeps for finding the cards extracted from a note:
/// the first of `obsidian_target_name_keys` of the source link.
#[must_use]
pub fn extraction_source_name(target: &str) -> Option<String> {
    obsidian_target_name_keys(target).into_iter().next()
}

/// Everything the index keeps for associations, read from one card alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardAssociationKeys {
    /// `author_label` of the card's own `author`.
    pub own_author: Option<String>,
    pub site: Option<String>,
    pub address: Option<String>,
    /// `note_name_key` of the card's slug.
    pub note_name: Option<String>,
    /// The first name key of `extraction_source_target`, for finding the
    /// cards extracted from a note by its name.
    pub extraction_source_name: Option<String>,
}

/// The association keys of one card. A collection keeps only its name: the
/// source lookup must see the same notes as Related notes.
#[must_use]
pub fn card_association_keys(block: &Block) -> CardAssociationKeys {
    let note_name = note_name_key(&block.slug);
    if block.frontmatter.block_type == crate::domain::block::BlockType::Channel {
        return CardAssociationKeys {
            note_name,
            ..CardAssociationKeys::default()
        };
    }
    let url = block.frontmatter.url.as_deref();
    CardAssociationKeys {
        own_author: block.frontmatter.author.as_deref().and_then(author_label),
        site: url.and_then(site_key),
        address: url.and_then(address_key),
        note_name,
        extraction_source_name: extraction_source_target(&block.frontmatter)
            .and_then(extraction_source_name),
    }
}

fn parse_web_url(url: &str) -> Option<Url> {
    let parsed = Url::parse(url.trim()).ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(parsed)
}

fn host_without_www(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let host = match host.strip_prefix(WWW_PREFIX) {
        Some(rest) if !rest.is_empty() => rest,
        _ => host,
    };
    (!host.is_empty()).then(|| host.to_string())
}

fn is_utm_parameter(pair: &str) -> bool {
    let name = pair.split('=').next().unwrap_or(pair);
    name.len() >= UTM_PARAMETER_PREFIX.len()
        && name[..UTM_PARAMETER_PREFIX.len()].eq_ignore_ascii_case(UTM_PARAMETER_PREFIX)
}

fn leads_to_media_file(url: &Url) -> bool {
    let last_segment = url.path().rsplit('/').next().unwrap_or("");
    let Some((_, extension)) = last_segment.rsplit_once('.') else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    IMAGE_MEDIA_EXTS.contains(&extension.as_str()) || VIDEO_MEDIA_EXTS.contains(&extension.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{BlockType, DateTime};

    fn frontmatter() -> Frontmatter {
        Frontmatter {
            block_type: BlockType::Article,
            title: None,
            description: None,
            url: None,
            file: None,
            thumbnail: None,
            tags: Vec::new(),
            related_notes: Vec::new(),
            source_media: None,
            saved_at: DateTime::new("2026-10-07T12:00:00Z").unwrap(),
            source: None,
            width: None,
            height: None,
            author: None,
            position: None,
            color: None,
            icon: None,
        }
    }

    #[test]
    fn author_ignores_outer_spaces_and_case() {
        assert_eq!(author_label("  @Kotecinho  ").as_deref(), Some("@Kotecinho"));
        assert_eq!(author_key("  @Kotecinho  "), author_key("@kotecinho"));
        assert_eq!(author_key("Émile"), author_key("émile"));
    }

    #[test]
    fn author_written_with_composed_or_decomposed_letters_is_one_author() {
        assert_eq!(author_key("Cafe\u{301}"), author_key("Café"));
    }

    #[test]
    fn empty_author_is_no_author() {
        assert_eq!(author_label(""), None);
        assert_eq!(author_key("   "), None);
        assert_eq!(author_key("\u{3000}\t"), None);
    }

    #[test]
    fn inner_spaces_and_at_sign_stay_significant() {
        assert_ne!(author_key("Jane  Doe"), author_key("Jane Doe"));
        assert_ne!(author_key("@marco"), author_key("marco"));
    }

    #[test]
    fn address_drops_www_fragment_and_utm_parameters() {
        assert_eq!(
            address_key("https://www.door.link/#top"),
            address_key("https://door.link/")
        );
        assert_eq!(
            address_key("https://a.com/p?utm_source=x&id=7&UTM_Campaign=y&utm_medium=z&b=2"),
            Some("https://a.com/p?id=7&b=2".to_string())
        );
        assert_eq!(
            address_key("https://a.com/p?utm_source=x"),
            Some("https://a.com/p".to_string())
        );
    }

    #[test]
    fn address_keeps_other_hosts_and_order_of_parameters() {
        assert_ne!(address_key("https://www2.a.com/"), address_key("https://a.com/"));
        assert_ne!(address_key("https://m.a.com/"), address_key("https://a.com/"));
        assert_ne!(address_key("https://a.com/?b=1&a=2"), address_key("https://a.com/?a=2&b=1"));
    }

    #[test]
    fn address_is_read_the_whatwg_way() {
        assert_eq!(address_key("https://Door.LINK"), address_key("https://door.link/"));
        assert_eq!(address_key("https://a.com:443/x"), address_key("https://a.com/x"));
        assert_eq!(address_key("  https://a.com/x  "), address_key("https://a.com/x"));
    }

    #[test]
    fn scheme_and_trailing_slash_of_a_path_stay_significant() {
        assert_ne!(address_key("http://a.com/x"), address_key("https://a.com/x"));
        assert_ne!(address_key("https://a.com/about"), address_key("https://a.com/about/"));
    }

    #[test]
    fn only_web_addresses_carry_an_address() {
        assert_eq!(address_key("mailto:someone@example.com"), None);
        assert_eq!(address_key("file:///Users/me/a.jpg"), None);
        assert_eq!(address_key("not an address"), None);
        assert_eq!(address_key(""), None);
    }

    #[test]
    fn site_is_the_host_without_www() {
        assert_eq!(site_key("https://www.niklasrosen.se/work"), Some("niklasrosen.se".into()));
        assert_eq!(site_key("https://eng.basement.studio/x"), Some("eng.basement.studio".into()));
        assert_ne!(site_key("https://eng.basement.studio/"), site_key("https://basement.studio/"));
    }

    #[test]
    fn shared_platforms_and_their_subdomains_have_no_site() {
        for url in [
            "https://x.com/kotecinho/status/1",
            "https://mobile.twitter.com/a",
            "https://pbs.twimg.com/media/HPIW?format=jpg&name=large",
            "https://t.co/abc",
            "https://www.instagram.com/p/DWolCipAvoJ/",
            "https://scontent.cdninstagram.com/v/a",
            "https://youtu.be/9KDDhAOyv9k",
            "https://m.youtube.com/watch?v=9KDDhAOyv9k",
            "https://i.ytimg.com/vi/9KDDhAOyv9k/maxresdefault",
            "https://www.youtube-nocookie.com/embed/9KDDhAOyv9k",
            "https://cdn.cosmos.so/17edb3ba?format=webp",
            "https://www.cosmos.so/e/124532473",
            "https://www.are.na/block/2704914",
        ] {
            assert_eq!(site_key(url), None, "{url}");
        }
    }

    #[test]
    fn look_alike_hosts_remain_sites() {
        assert_eq!(site_key("https://notx.com/a"), Some("notx.com".into()));
        assert_eq!(
            site_key("https://cosmos.so.example.com/a"),
            Some("cosmos.so.example.com".into())
        );
    }

    #[test]
    fn addresses_of_image_and_video_files_have_no_site() {
        for url in [
            "https://a.com/photo.jpg",
            "https://a.com/photo.JPG",
            "https://a.com/photo.webp?w=200",
            "https://a.com/clip.mp4",
            "https://d2w9rnfcy7mm78.cloudfront.net/11589196/original_fa09.gif?1618434716?bc=0",
        ] {
            assert_eq!(site_key(url), None, "{url}");
            assert!(address_key(url).is_some(), "{url}");
        }
        assert_eq!(site_key("https://a.com/page.html"), Some("a.com".into()));
        assert_eq!(site_key("https://a.com/paper.pdf"), Some("a.com".into()));
    }

    #[test]
    fn extracted_cards_name_their_source() {
        let mut inline = frontmatter();
        inline.source = Some(INLINE_MEDIA_EXTRACTION_SOURCE.into());
        inline.related_notes = vec!["Source".into(), "Later".into()];
        assert_eq!(extraction_source_target(&inline), Some("Source"));

        let mut selection = frontmatter();
        selection.source = Some(TEXT_SELECTION_EXTRACTION_SOURCE.into());
        selection.related_notes = vec!["Source#^abc".into()];
        assert_eq!(extraction_source_target(&selection), Some("Source#^abc"));

        let mut media_card = frontmatter();
        media_card.source_media = Some("[[photo.jpg]]".into());
        media_card.related_notes = vec!["Cards/Source".into()];
        assert_eq!(extraction_source_target(&media_card), Some("Cards/Source"));
    }

    #[test]
    fn other_cards_and_extractions_without_links_have_no_source() {
        let mut no_links = frontmatter();
        no_links.source = Some(INLINE_MEDIA_EXTRACTION_SOURCE.into());
        assert_eq!(extraction_source_target(&no_links), None);

        for source in ["card-merge", "web-clipper"] {
            let mut card = frontmatter();
            card.source = Some(source.into());
            card.related_notes = vec!["Source".into()];
            assert_eq!(extraction_source_target(&card), None, "{source}");
        }
    }

    #[test]
    fn keys_of_a_card_and_of_a_collection() {
        let mut card_frontmatter = frontmatter();
        card_frontmatter.author = Some(" @poellll ".into());
        card_frontmatter.url = Some("https://www.mek.gallery/item?utm_source=x".into());
        card_frontmatter.source = Some(INLINE_MEDIA_EXTRACTION_SOURCE.into());
        card_frontmatter.related_notes = vec!["Cards/Source.md".into()];
        let card = Block {
            slug: "Cards/Piece".into(),
            frontmatter: card_frontmatter,
            body: String::new(),
        };
        assert_eq!(
            card_association_keys(&card),
            CardAssociationKeys {
                own_author: Some("@poellll".into()),
                site: Some("mek.gallery".into()),
                address: Some("https://mek.gallery/item".into()),
                note_name: Some("Piece".into()),
                extraction_source_name: Some("Source".into()),
            }
        );

        let mut collection_frontmatter = frontmatter();
        collection_frontmatter.block_type = BlockType::Channel;
        collection_frontmatter.url = Some("https://a.com/".into());
        let collection = Block {
            slug: "Collections/Ideas".into(),
            frontmatter: collection_frontmatter,
            body: String::new(),
        };
        assert_eq!(
            card_association_keys(&collection),
            CardAssociationKeys {
                note_name: Some("Ideas".into()),
                ..CardAssociationKeys::default()
            }
        );
    }
}
