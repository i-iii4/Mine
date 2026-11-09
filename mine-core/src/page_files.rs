//! The one route of a file from a page into a space (SPEC_CLIPPER.md, «Один
//! путь файла со страницы», Б4, Б7, Б13): which files a clip takes from its
//! page, how a browser may ask for them, how they are named, how the body
//! embeds them, and how the clipper says that a file was not obtained.
//!
//! Every executor of a clip uses these rules, the helper directly and the
//! browser folder through the JSON bridge. Nothing here touches the network:
//! the helper refines [`PageFile::reachable`] by resolving the name.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::ops::Range;

use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::domain::block::IMAGE_MEDIA_EXTS;
use crate::domain::markdown_images::{build_inline_wikilink, replaceable_body_images};
use crate::links::LinkIndex;

/// How many requests for files a browser keeps open at once (Б11).
pub const MAX_PARALLEL_REQUESTS: u32 = 3;
/// How many of them may go to one host: more than that invites a `429` (Б11).
pub const MAX_REQUESTS_PER_HOST: u32 = 2;
/// `429 Too Many Requests`: the site limits this client (Б2).
pub const TOO_MANY_REQUESTS: u16 = 429;
/// The extension of a file when neither its address nor its server names one;
/// the bytes correct it once they are here (Б13).
pub const ASSUMED_EXTENSION: &str = "jpg";

// ─── Addresses ──────────────────────────────────────────────────────────────

/// Why an address may not be asked for on the person's behalf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum AddressRefusal {
    #[error("the address cannot be read")]
    Invalid,
    #[error("only http:// and https:// addresses are allowed")]
    Scheme,
    #[error("the address names this Mac or a private network")]
    Internal,
    #[error("the name has no known public suffix")]
    UnknownSuffix,
}

/// The rule of [`address_check`] that needs no list of names: the scheme,
/// `localhost` and an IP address written in the address itself.
pub fn address_literal_check(url: &str) -> Result<(), AddressRefusal> {
    let parsed = Url::parse(url).map_err(|_| AddressRefusal::Invalid)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AddressRefusal::Scheme);
    }
    let reaches_public = match parsed.host().ok_or(AddressRefusal::Invalid)? {
        Host::Ipv4(address) => is_public_ip(IpAddr::V4(address)),
        Host::Ipv6(address) => is_public_ip(IpAddr::V6(address)),
        Host::Domain(domain) => {
            let name = domain.trim_end_matches('.').to_ascii_lowercase();
            name != "localhost" && !name.ends_with(".localhost")
        }
    };
    if reaches_public {
        Ok(())
    } else {
        Err(AddressRefusal::Internal)
    }
}

/// Whether an address may be asked for, judged by the address alone (Б13): a
/// browser cannot see where a name resolves, so a name without a known public
/// suffix (`router`, `nas.local`, `host.internal`) counts as internal. A top
/// level domain newer than this build's list counts as internal until the next
/// build. The helper resolves the name instead.
pub fn address_check(url: &str) -> Result<(), AddressRefusal> {
    address_literal_check(url)?;
    let parsed = Url::parse(url).map_err(|_| AddressRefusal::Invalid)?;
    if let Some(Host::Domain(domain)) = parsed.host() {
        let name = domain.trim_end_matches('.').to_ascii_lowercase();
        if !psl::suffix(name.as_bytes()).is_some_and(|suffix| suffix.is_known()) {
            return Err(AddressRefusal::UnknownSuffix);
        }
    }
    Ok(())
}

/// Whether a fetch made on the person's behalf may reach `ip`: not this Mac,
/// not the person's network or their provider's, not a service or reserved
/// range (SPEC_AUDIT_FIXES.md, Ф10).
#[must_use]
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => is_public_v6(address),
    }
}

fn is_public_v4(addr: Ipv4Addr) -> bool {
    let [a, b, c, _] = addr.octets();
    let restricted = addr.is_private()
        || addr.is_loopback()
        || addr.is_link_local()
        || addr.is_broadcast()
        || addr.is_unspecified()
        || addr.is_multicast()
        // "This network".
        || a == 0
        // Shared address space of carrier-grade NAT.
        || (a == 100 && (64..=127).contains(&b))
        // IETF protocol assignments.
        || (a == 192 && b == 0 && c == 0)
        // Documentation.
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        // Benchmarking.
        || (a == 198 && (b == 18 || b == 19))
        // Reserved.
        || a >= 240;
    !restricted
}

fn is_public_v6(addr: Ipv6Addr) -> bool {
    // An IPv4 address written as IPv6 reaches that IPv4 address.
    if let Some(v4) = addr.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = addr.segments();
    let embedded = |high: u16, low: u16| {
        let [a, b] = high.to_be_bytes();
        let [c, d] = low.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    // IPv4-compatible addresses (deprecated) and `::`, `::1`.
    if s[..6] == [0; 6] {
        return false;
    }
    // NAT64 carries an IPv4 destination.
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded(s[6], s[7]));
    }
    // 6to4 carries an IPv4 relay.
    if s[0] == 0x2002 && !is_public_v4(embedded(s[1], s[2])) {
        return false;
    }
    let restricted = addr.is_loopback()
        || addr.is_unspecified()
        || addr.is_unique_local()
        || addr.is_unicast_link_local()
        || addr.is_multicast()
        // Site-local (deprecated).
        || (s[0] & 0xffc0) == 0xfec0
        // Documentation.
        || (s[0] == 0x2001 && s[1] == 0x0db8);
    !restricted
}

// ─── The plan ───────────────────────────────────────────────────────────────

/// A poster of a video the body shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct VideoPosterRef {
    pub video_url: String,
    pub poster_url: String,
}

/// The files of a clip as the Save request names them (Б7).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PageFilesRequest {
    /// The page of the clip, as the snapshot took it.
    pub document_url: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub video_posters: Option<Vec<VideoPosterRef>>,
}

/// One file a browser may ask for, and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PageFile {
    pub url: String,
    /// The video this poster stands for: it is asked for only when the browser
    /// did not get that video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_of: Option<String>,
    /// The `Referer` of a request from outside the page: the origin of the
    /// clip's page, which is what a browser sends another domain by default.
    pub referer: Option<String>,
    /// Whether the request carries the person's cookies: only to the site of
    /// the clip's page, because the page wrote the address (Б6).
    pub cookies: bool,
    /// Whether a browser may ask from outside the page (Б7, Б13).
    pub reachable: bool,
}

/// The answer to a request for the files of a clip (Б7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PageFilePlan {
    pub parallel: u32,
    pub per_domain: u32,
    pub files: Vec<PageFile>,
}

fn is_web_address(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Whether `file` and `page` are on one site, that is, under one registrable
/// domain by the public suffix list; addresses without a domain, on one host.
#[must_use]
pub fn same_site(file: &str, page: &str) -> bool {
    let (Ok(file), Ok(page)) = (Url::parse(file), Url::parse(page)) else {
        return false;
    };
    match (file.host(), page.host()) {
        (Some(Host::Domain(left)), Some(Host::Domain(right))) => {
            let left = left.trim_end_matches('.').to_ascii_lowercase();
            let right = right.trim_end_matches('.').to_ascii_lowercase();
            match (psl::domain_str(&left), psl::domain_str(&right)) {
                (Some(left), Some(right)) => left == right,
                _ => left == right,
            }
        }
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// The `Referer` of a request from outside the page: the origin of `page`
/// with its path, and nothing for a page without an origin.
fn origin_referer(page: &str) -> Option<String> {
    let origin = Url::parse(page).ok()?.origin();
    origin.is_tuple().then(|| format!("{}/", origin.ascii_serialization()))
}

/// What a browser may ask for, and how, for the files of a clip (Б7): the same
/// reading of the body as at the writing of the card, with no limit on the
/// number of media and no probe of the network. One address is listed once.
/// The card's file comes first, because a picture card cannot be saved without
/// it; a poster is listed only for a video the body shows, because only such a
/// video can leave the card without a preview.
#[must_use]
pub fn page_file_plan(request: &PageFilesRequest) -> PageFilePlan {
    let referer = origin_referer(&request.document_url);
    let file = |url: &str, poster_of: Option<&str>| PageFile {
        url: url.to_string(),
        poster_of: poster_of.map(str::to_string),
        referer: referer.clone(),
        cookies: same_site(url, &request.document_url),
        reachable: address_check(url).is_ok(),
    };
    let mut listed: HashSet<String> = HashSet::new();
    let mut files = Vec::new();
    if let Some(url) = request.image_url.as_deref().filter(|url| is_web_address(url)) {
        listed.insert(url.to_string());
        files.push(file(url, None));
    }
    let body = request.body.as_deref().unwrap_or_default();
    let mut shown: HashSet<String> = HashSet::new();
    for image in replaceable_body_images(body) {
        if !is_web_address(&image.url) {
            continue;
        }
        if listed.insert(image.url.clone()) {
            files.push(file(&image.url, None));
        }
        shown.insert(image.url);
    }
    for poster in request.video_posters.iter().flatten() {
        if shown.contains(&poster.video_url)
            && is_web_address(&poster.poster_url)
            && listed.insert(poster.poster_url.clone())
        {
            files.push(file(&poster.poster_url, Some(&poster.video_url)));
        }
    }
    PageFilePlan {
        parallel: MAX_PARALLEL_REQUESTS,
        per_domain: MAX_REQUESTS_PER_HOST,
        files,
    }
}

// ─── Kinds and names ────────────────────────────────────────────────────────

/// The kind of a medium the body embeds, as its file is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum InlineMediaKind {
    Image,
    Video,
    File,
}

impl InlineMediaKind {
    /// The word of this kind in a file name and in the Save answer.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            InlineMediaKind::Image => "image",
            InlineMediaKind::Video => "video",
            InlineMediaKind::File => "file",
        }
    }
}

/// The extension an address states outright, or `None` when it states none.
///
/// API-style addresses such as `.../xrpc/com.atproto.sync.getBlob` are the case
/// that matters: their last dotted segment is a method name, not a file type.
///
/// Only letters and digits make an extension: a file cannot be named with
/// anything else (`select_unique_file_stem`), and before 13.10.2026 one address
/// such as `photo.j-pg` left every picture of an article remote and a poster at
/// such an address failed the whole save (SPEC_DEEP_AUDIT.md, Е4.1). Such an
/// address states no type; the server and the bytes say it.
#[must_use]
pub fn ext_from_url_opt(url: &str) -> Option<&str> {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);
    let (_, ext) = path.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || !ext.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext)
}

/// Classify an extension as image, video or other.
#[must_use]
pub fn inline_media_kind_from_ext(ext: &str) -> InlineMediaKind {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif" | "heic" | "heif" | "bmp" | "svg"
        | "tiff" | "tif" => InlineMediaKind::Image,
        "mp4" | "webm" | "m4v" | "mov" | "mkv" | "avi" => InlineMediaKind::Video,
        _ => InlineMediaKind::File,
    }
}

/// The local file name of a medium of the body:
/// `<slug> (<kind> <1-based idx>).<ext>`, as `Hello World (image 1).jpg` or
/// `Story (video 2).mp4`. The index counts per kind, so an article mixing 3
/// images and 2 videos has `(image 1/2/3)` and `(video 1/2)`.
#[must_use]
pub fn build_inline_media_name(slug: &str, kind: InlineMediaKind, idx: u32, ext: &str) -> String {
    let label = kind.label();
    if ext.is_empty() {
        format!("{slug} ({label} {idx})")
    } else {
        format!("{slug} ({label} {idx}).{ext}")
    }
}

/// One place of the body that shows a medium.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct InlinePlace {
    /// Source bytes of the whole `![caption](url)`.
    pub start: u32,
    pub end: u32,
    /// The caption as written, line breaks as spaces.
    pub caption: String,
}

impl InlinePlace {
    /// The source bytes of this place.
    #[must_use]
    pub fn range(&self) -> Range<usize> {
        self.start as usize..self.end as usize
    }
}

/// One address the body shows, with every place that shows it: a repeated
/// address stands for one file and costs one request (Б8, Б9, Ф5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct InlineMedia {
    pub url: String,
    pub kind: InlineMediaKind,
    pub extension: String,
    /// The name its file takes before the bytes are seen.
    pub file_name: String,
    pub places: Vec<InlinePlace>,
}

/// The media of a body that can become local files, in source order, each
/// address once. `type_of` names the extension of an address that states none;
/// it is asked once per address, and silence means [`ASSUMED_EXTENSION`].
pub fn inline_media(
    body: &str,
    slug: &str,
    mut type_of: impl FnMut(&str) -> Option<String>,
) -> Vec<InlineMedia> {
    let mut media: Vec<InlineMedia> = Vec::new();
    let mut by_url: HashMap<String, usize> = HashMap::new();
    let (mut images, mut videos, mut others) = (0_u32, 0_u32, 0_u32);
    for image in replaceable_body_images(body) {
        if !is_web_address(&image.url) {
            continue;
        }
        let place = InlinePlace {
            start: u32::try_from(image.range.start).unwrap_or(u32::MAX),
            end: u32::try_from(image.range.end).unwrap_or(u32::MAX),
            caption: image.caption,
        };
        if let Some(&known) = by_url.get(&image.url) {
            media[known].places.push(place);
            continue;
        }
        // An address that names its type is trusted; one that does not is asked
        // about, so an API endpoint serving a video is not filed as a JPEG.
        let extension = ext_from_url_opt(&image.url)
            .map(str::to_string)
            .or_else(|| type_of(&image.url))
            .unwrap_or_else(|| ASSUMED_EXTENSION.to_string());
        let kind = inline_media_kind_from_ext(&extension);
        let count = match kind {
            InlineMediaKind::Image => &mut images,
            InlineMediaKind::Video => &mut videos,
            InlineMediaKind::File => &mut others,
        };
        *count += 1;
        let file_name = build_inline_media_name(slug, kind, *count, &extension);
        by_url.insert(image.url.clone(), media.len());
        media.push(InlineMedia { url: image.url, kind, extension, file_name, places: vec![place] });
    }
    media
}

/// Which place of the text a stored file took (Ф5). The executor compares the
/// bytes and says which file each place shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct BodyPlacement {
    pub start: u32,
    pub end: u32,
    pub caption: String,
    /// The file's path, relative to the root of the space.
    pub file: String,
}

/// The body with each placed medium embedded as a local file; every other byte
/// stays as written. Placements apply from the end of the text, so that earlier
/// offsets stay valid; a placement that does not fit the text is left out.
#[must_use]
pub fn rewrite_body(body: &str, placements: &[BodyPlacement], links: &LinkIndex) -> String {
    let mut ordered: Vec<&BodyPlacement> = placements.iter().collect();
    ordered.sort_by_key(|placement| std::cmp::Reverse(placement.start));
    let mut result = body.to_string();
    for placement in ordered {
        let (start, end) = (placement.start as usize, placement.end as usize);
        if end > result.len()
            || start > end
            || !result.is_char_boundary(start)
            || !result.is_char_boundary(end)
        {
            continue;
        }
        let target = links
            .shortest_link(&placement.file, false)
            .unwrap_or_else(|| placement.file.clone());
        result.replace_range(start..end, &build_inline_wikilink(&target, placement.caption.trim()));
    }
    result
}

/// What the file at a card's `image_url` becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CardFileRole {
    File,
    Thumbnail,
}

/// A picture of a video card is its preview, written as `thumbnail`; any other
/// file of a card is its `file` (Б9).
#[must_use]
pub fn card_file_role(block_type: &str, extension: &str) -> CardFileRole {
    if block_type == "video" && IMAGE_MEDIA_EXTS.contains(&extension.to_lowercase().as_str()) {
        CardFileRole::Thumbnail
    } else {
        CardFileRole::File
    }
}

// ─── What the clipper says ──────────────────────────────────────────────────

/// Why a file was not obtained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MediaFailure {
    /// The server answered with an error status.
    Refused {
        status: u16,
        /// How long the server asks to wait, from its `Retry-After`.
        #[serde(default)]
        retry_after_seconds: Option<u32>,
    },
    /// No answer from the server, or an answer that is not the file.
    NoAnswer { cause: String },
    /// What a browser knows of a file it did not get (Б13).
    Browser { failure: FileFailure },
    /// The address was not asked for because of what it names (Б13).
    Address { refusal: AddressRefusal },
}

/// Why a browser has no file for an address and no answer of the server to say
/// so, each in the clipper's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum FileFailure {
    #[error("no answer")]
    NoAnswer,
    #[error("the answer is a web page")]
    NotAFile,
    #[error("the file is larger than 500 MiB")]
    TooLarge,
    /// The bytes came, and the browser's storage refused them.
    #[error("the browser could not keep the file")]
    NotStored,
    /// The collection ended before this file: its worker stopped.
    #[error("the browser did not ask for the file")]
    NotAsked,
}

/// The host of `url` as a person names the site; the address itself when it has
/// none.
#[must_use]
pub fn site_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// A wait as the clipper says it: seconds under a minute, else whole minutes
/// rounded up, hours from sixty minutes on.
#[must_use]
pub fn wait_text(seconds: u64) -> String {
    const SECONDS_PER_MINUTE: u64 = 60;
    const MINUTES_PER_HOUR: u64 = 60;
    if seconds < SECONDS_PER_MINUTE {
        return format!("{seconds} s");
    }
    let minutes = seconds.div_ceil(SECONDS_PER_MINUTE);
    if minutes < MINUTES_PER_HOUR {
        return format!("{minutes} min");
    }
    let (hours, rest) = (minutes / MINUTES_PER_HOUR, minutes % MINUTES_PER_HOUR);
    if rest == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {rest} min")
    }
}

/// Why a file of `site` was not obtained, in the clipper's words (Б3): the site,
/// the HTTP code and, for a `429`, when the site allows the next request. A
/// failure without an HTTP answer names the site and its cause.
#[must_use]
pub fn media_failure_reason(site: &str, failure: &MediaFailure) -> String {
    match failure {
        MediaFailure::NoAnswer { cause } => format!("{site} did not give the file: {cause}."),
        MediaFailure::Browser { failure } => format!("{site} did not give the file: {failure}."),
        MediaFailure::Address { refusal } => format!("{site} did not give the file: {refusal}."),
        MediaFailure::Refused { status, retry_after_seconds } if *status == TOO_MANY_REQUESTS => {
            let when = retry_after_seconds.map_or_else(
                || "later".to_string(),
                |seconds| format!("in {}", wait_text(u64::from(seconds))),
            );
            format!("{site} is not giving the file right now (HTTP {status}). Try again {when}.")
        }
        MediaFailure::Refused { status, .. } => format!("{site} did not give the file (HTTP {status})."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(body: &str, image_url: Option<&str>, posters: &[(&str, &str)]) -> PageFilePlan {
        page_file_plan(&PageFilesRequest {
            document_url: "https://shop.example.com/p/1?x=1#top".into(),
            body: Some(body.into()),
            image_url: image_url.map(str::to_string),
            video_posters: Some(
                posters
                    .iter()
                    .map(|(video, poster)| VideoPosterRef {
                        video_url: (*video).into(),
                        poster_url: (*poster).into(),
                    })
                    .collect(),
            ),
        })
    }

    #[test]
    fn the_plan_lists_every_address_once_with_the_limits_of_the_browser() {
        let answer = plan(
            "![a](https://cdn.example.net/a.jpg)\n\n![again](https://cdn.example.net/a.jpg)\n\n\
             ![b](https://shop.example.com/b.png)\n\n![local](Media/c.png)\n\n\
             ```\n![code](https://cdn.example.net/code.jpg)\n```\n",
            Some("https://cdn.example.net/og.jpg"),
            &[],
        );
        assert_eq!((answer.parallel, answer.per_domain), (3, 2));
        let urls: Vec<_> = answer.files.iter().map(|file| file.url.as_str()).collect();
        assert_eq!(
            urls,
            ["https://cdn.example.net/og.jpg", "https://cdn.example.net/a.jpg", "https://shop.example.com/b.png"]
        );
    }

    #[test]
    fn the_referer_is_the_origin_of_the_page_and_cookies_stay_on_its_site() {
        let answer = plan(
            "![a](https://cdn.example.net/a.jpg)\n\n![b](https://files.example.com/b.png)\n\n\
             ![c](https://user.github.io/c.png)\n",
            None,
            &[],
        );
        for file in &answer.files {
            assert_eq!(file.referer.as_deref(), Some("https://shop.example.com/"));
        }
        let cookies: Vec<_> = answer.files.iter().map(|file| file.cookies).collect();
        assert_eq!(cookies, [false, true, false]);
        // Two sites under one public suffix are two sites.
        assert!(!same_site("https://a.github.io/x", "https://b.github.io/y"));
        assert!(same_site("https://app.example.co.uk/x", "https://files.example.co.uk/y"));
        assert!(!same_site("https://example.co.uk/x", "https://other.co.uk/y"));
        // Addresses without a domain are one site only on one host.
        assert!(same_site("http://192.0.2.1:1/x", "http://192.0.2.1:2/y"));
        assert!(!same_site("http://192.0.2.1/x", "http://192.0.2.2/y"));
    }

    #[test]
    fn a_page_without_an_origin_gives_no_referer() {
        let answer = page_file_plan(&PageFilesRequest {
            document_url: "file:///Users/me/page.html".into(),
            body: Some("![a](https://cdn.example.net/a.jpg)".into()),
            ..PageFilesRequest::default()
        });
        assert_eq!(answer.files[0].referer, None);
        assert!(!answer.files[0].cookies);
    }

    #[test]
    fn a_poster_is_listed_only_for_a_video_the_body_shows() {
        let answer = plan(
            "![v](https://cdn.example.net/v.mp4)\n",
            None,
            &[
                ("https://cdn.example.net/v.mp4", "https://cdn.example.net/p.jpg"),
                ("https://cdn.example.net/other.mp4", "https://cdn.example.net/q.jpg"),
            ],
        );
        let urls: Vec<_> = answer.files.iter().map(|file| (file.url.as_str(), file.poster_of.as_deref())).collect();
        assert_eq!(
            urls,
            [
                ("https://cdn.example.net/v.mp4", None),
                ("https://cdn.example.net/p.jpg", Some("https://cdn.example.net/v.mp4")),
            ]
        );
    }

    #[test]
    fn data_and_blob_addresses_are_not_files_of_the_route() {
        let answer = plan("![a](data:image/png;base64,AAAA)\n\n![b](blob:https://x/y)\n", Some("data:image/png;base64,AAAA"), &[]);
        assert!(answer.files.is_empty());
    }

    #[test]
    fn a_file_on_an_internal_address_is_not_reachable() {
        let answer = plan(
            "![a](http://10.0.0.5/a.jpg)\n\n![b](http://localhost/b.jpg)\n\n![c](http://nas.local/c.jpg)\n\n\
             ![d](https://cdn.example.net/d.jpg)\n",
            None,
            &[],
        );
        let reachable: Vec<_> = answer.files.iter().map(|file| file.reachable).collect();
        assert_eq!(reachable, [false, false, false, true]);
    }

    #[test]
    fn the_address_alone_decides_what_a_browser_may_ask_for() {
        for (url, refusal) in [
            ("ftp://example.com/a", AddressRefusal::Scheme),
            ("not an address", AddressRefusal::Invalid),
            ("http://localhost/a", AddressRefusal::Internal),
            ("http://photos.localhost/a", AddressRefusal::Internal),
            ("http://127.0.0.1/a", AddressRefusal::Internal),
            ("http://[::1]/a", AddressRefusal::Internal),
            ("http://169.254.169.254/latest/meta-data/", AddressRefusal::Internal),
            ("http://router/a", AddressRefusal::UnknownSuffix),
            ("http://nas.local/a", AddressRefusal::UnknownSuffix),
            ("http://host.internal/a", AddressRefusal::UnknownSuffix),
        ] {
            assert_eq!(address_check(url), Err(refusal), "{url}");
        }
        for url in ["https://example.com/a", "http://93.184.216.34/a", "https://пример.рф/a", "https://a.b.co.uk/x"] {
            assert_eq!(address_check(url), Ok(()), "{url}");
        }
    }

    #[test]
    fn service_and_translated_addresses_are_not_public() {
        for blocked in [
            "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::127.0.0.1", "100.64.0.1", "100.127.255.254",
            "224.0.0.1", "239.255.255.250", "0.1.2.3", "240.0.0.1", "192.0.0.8", "198.18.0.1",
            "64:ff9b::7f00:1", "2002:7f00:1::", "fec0::1", "ff02::1", "2001:db8::1",
        ] {
            assert!(!is_public_ip(blocked.parse().unwrap()), "{blocked} must be blocked");
        }
        for allowed in ["93.184.216.34", "100.128.0.1", "2606:2800:220:1::", "64:ff9b::5db8:d822", "::ffff:93.184.216.34"] {
            assert!(is_public_ip(allowed.parse().unwrap()), "{allowed} must be allowed");
        }
    }

    #[test]
    fn a_repeated_address_is_one_medium_with_two_places() {
        let body = "![first](https://h.example/a.jpg)\n\n![v](https://h.example/v.mp4)\n\n\
                    ![second](https://h.example/a.jpg)\n\n![b](https://h.example/b.png)";
        let mut asked = Vec::new();
        let media = inline_media(body, "Post", |url| {
            asked.push(url.to_string());
            None
        });
        assert!(asked.is_empty(), "an address that states its type was asked about");
        let names: Vec<_> = media.iter().map(|medium| medium.file_name.as_str()).collect();
        assert_eq!(names, ["Post (image 1).jpg", "Post (video 1).mp4", "Post (image 2).png"]);
        let captions: Vec<_> = media[0].places.iter().map(|place| place.caption.as_str()).collect();
        assert_eq!(captions, ["first", "second"]);
    }

    #[test]
    fn an_address_without_a_type_is_asked_about_once() {
        let body = "![a](https://h.example/xrpc/getBlob?cid=1)\n\n![b](https://h.example/xrpc/getBlob?cid=1)";
        let mut asked = 0;
        let media = inline_media(body, "Post", |_| {
            asked += 1;
            Some("mp4".to_string())
        });
        assert_eq!(asked, 1);
        assert_eq!(media[0].file_name, "Post (video 1).mp4");
        let silent = inline_media(body, "Post", |_| None);
        assert_eq!(silent[0].file_name, "Post (image 1).jpg");
    }

    #[test]
    fn a_body_of_any_length_has_no_limit_on_its_media() {
        let body: String = (0..100).map(|index| format!("![p](https://h.example/{index}.jpg)\n\n")).collect();
        assert_eq!(inline_media(&body, "Long", |_| None).len(), 100);
        assert_eq!(plan(&body, None, &[]).files.len(), 100);
    }

    #[test]
    fn the_body_is_rewritten_only_at_its_placements() {
        let body = "до ![a](https://h.example/a.jpg) между ![b](https://h.example/b.jpg) после";
        let media = inline_media(body, "S", |_| None);
        let placements: Vec<_> = media
            .iter()
            .map(|medium| BodyPlacement {
                start: medium.places[0].start,
                end: medium.places[0].end,
                caption: medium.places[0].caption.clone(),
                file: format!("Media/{}", medium.file_name),
            })
            .collect();
        let links = LinkIndex::new(placements.iter().map(|placement| placement.file.as_str()));
        assert_eq!(
            rewrite_body(body, &placements, &links),
            "до ![[S (image 1).jpg|a]] между ![[S (image 2).jpg|b]] после"
        );
        // A placement that does not fit the text changes nothing.
        let wild = [BodyPlacement { start: 1, end: 9000, caption: String::new(), file: "x.jpg".into() }];
        assert_eq!(rewrite_body(body, &wild, &links), body);
        let inside_a_letter = [BodyPlacement { start: 1, end: 2, caption: String::new(), file: "x.jpg".into() }];
        assert_eq!(rewrite_body(body, &inside_a_letter, &links), body);
    }

    #[test]
    fn a_picture_of_a_video_card_is_its_thumbnail() {
        assert_eq!(card_file_role("video", "jpg"), CardFileRole::Thumbnail);
        assert_eq!(card_file_role("video", "mp4"), CardFileRole::File);
        assert_eq!(card_file_role("link", "jpg"), CardFileRole::File);
        assert_eq!(card_file_role("image", "png"), CardFileRole::File);
    }

    #[test]
    fn a_wait_is_said_in_seconds_minutes_or_hours() {
        assert_eq!(wait_text(45), "45 s");
        assert_eq!(wait_text(600), "10 min");
        assert_eq!(wait_text(601), "11 min");
        assert_eq!(wait_text(3600), "1 h");
        assert_eq!(wait_text(5400), "1 h 30 min");
    }

    #[test]
    fn a_failure_names_the_site_the_code_and_when_to_retry() {
        let refused = |status, retry_after_seconds| MediaFailure::Refused { status, retry_after_seconds };
        assert_eq!(
            media_failure_reason("cdn.example", &refused(429, Some(600))),
            "cdn.example is not giving the file right now (HTTP 429). Try again in 10 min."
        );
        assert_eq!(
            media_failure_reason("cdn.example", &refused(429, None)),
            "cdn.example is not giving the file right now (HTTP 429). Try again later."
        );
        assert_eq!(media_failure_reason("cdn.example", &refused(404, None)), "cdn.example did not give the file (HTTP 404).");
        assert_eq!(
            media_failure_reason("cdn.example", &MediaFailure::NoAnswer { cause: "connection reset by peer".into() }),
            "cdn.example did not give the file: connection reset by peer."
        );
        assert_eq!(
            media_failure_reason("cdn.example", &MediaFailure::Browser { failure: FileFailure::TooLarge }),
            "cdn.example did not give the file: the file is larger than 500 MiB."
        );
        assert_eq!(
            media_failure_reason("nas.local", &MediaFailure::Address { refusal: AddressRefusal::UnknownSuffix }),
            "nas.local did not give the file: the name has no known public suffix."
        );
    }
}
