//! What a media file is, read from its first bytes.
//!
//! The one reader of image signatures in Mine. The asset protocol answers a
//! picture's MIME type with it, the preview pipeline decides with it what Rust
//! decodes and what a derived preview holds, and the save core names a
//! downloaded file by it. A file's name and a server's `Content-Type` say what
//! a file was meant to be; only its bytes say what it is: a server that
//! negotiates formats sends AVIF for a URL ending in `.png`.
//!
//! The executor reads the bytes; this module only interprets them.

/// How many leading bytes [`sniff_image_type`] needs to tell every type
/// apart, the compatible brands of an ISO image header included.
pub const IMAGE_HEAD_LEN: usize = 64;

/// The PNG file signature.
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// An image format recognised by its signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageType {
    Jpeg,
    Png,
    Gif,
    /// A still WebP: lossy, lossless, or extended without the animation flag.
    WebP,
    /// An extended WebP whose animation flag is set.
    AnimatedWebP,
    Avif,
    /// HEIC and the rest of the HEIF family.
    Heic,
}

impl ImageType {
    /// The MIME type this format is served as.
    #[must_use]
    pub fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::WebP | Self::AnimatedWebP => "image/webp",
            Self::Avif => "image/avif",
            Self::Heic => "image/heic",
        }
    }

    /// The extension a file of this format is stored under.
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::WebP | Self::AnimatedWebP => "webp",
            Self::Avif => "avif",
            Self::Heic => "heic",
        }
    }

    /// Whether `extension` already names this format, in any of its usual
    /// spellings and in any case.
    #[must_use]
    pub fn is_named_by(self, extension: &str) -> bool {
        let extension = extension.to_ascii_lowercase();
        match self {
            Self::Jpeg => matches!(extension.as_str(), "jpg" | "jpeg"),
            Self::Heic => matches!(extension.as_str(), "heic" | "heif"),
            _ => extension == self.extension(),
        }
    }
}

/// Recognise an image by the first bytes of its file.
///
/// `head` is the start of the file, ideally [`IMAGE_HEAD_LEN`] bytes or the
/// whole file when it is shorter. Anything that is not a known image
/// signature (video, text, a truncated header) is `None`.
#[must_use]
pub fn sniff_image_type(head: &[u8]) -> Option<ImageType> {
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageType::Jpeg);
    }
    if head.starts_with(&PNG_SIGNATURE) {
        return Some(ImageType::Png);
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some(ImageType::Gif);
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return webp_type(&head[12..]);
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return iso_image_type(head);
    }
    None
}

/// Still or animated, from the first chunk after the `WEBP` tag: four bytes of
/// fourcc, four of size, then the `VP8X` flags byte, where animation is bit
/// `0x02`. A first chunk that is missing, cut short or unknown is not a WebP
/// this module recognises.
fn webp_type(chunk: &[u8]) -> Option<ImageType> {
    match chunk.get(0..4)? {
        b"VP8 " | b"VP8L" => Some(ImageType::WebP),
        b"VP8X" if chunk.get(8)? & 0x02 != 0 => Some(ImageType::AnimatedWebP),
        b"VP8X" => Some(ImageType::WebP),
        _ => None,
    }
}

/// AVIF or HEIF, from the brands of an ISO `ftyp` box: the major brand at
/// bytes 8..12, the compatible brands from byte 16 to the end of the box.
///
/// AVIF is looked for first and anywhere: every AVIF also declares the HEIF
/// brand `mif1`, and many put it first, while no HEIF declares `avif`. A
/// video container (`isom`, `mp42`, `qt  `) names neither and is `None`.
fn iso_image_type(head: &[u8]) -> Option<ImageType> {
    let declared = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    let end = usize::try_from(declared).map_or(head.len(), |size| size.min(head.len()));
    let compatible = head.get(16..end).unwrap_or(&[]).chunks_exact(4);
    let mut heif = false;
    for brand in std::iter::once(&head[8..12]).chain(compatible) {
        match brand {
            b"avif" | b"avis" => return Some(ImageType::Avif),
            b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"hevm" | b"hevs"
            | b"mif1" | b"msf1" => heif = true,
            _ => {}
        }
    }
    heif.then_some(ImageType::Heic)
}

/// The extension Mine stores a medium of this `Content-Type` under.
///
/// Only the types the rest of the pipeline can display are mapped; anything
/// else is `None`.
#[must_use]
pub fn extension_for_content_type(content_type: &str) -> Option<&'static str> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
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

/// The extension a saved media file is named with: what its bytes are when
/// they are an image this module recognises, otherwise what the address, the
/// server or the uploader declared.
///
/// A declared extension that already names the recognised format is kept as
/// spelled (`.jpeg` stays `.jpeg`). `None` when the bytes say nothing and
/// nothing was declared.
#[must_use]
pub fn stored_media_extension(head: &[u8], declared: Option<&str>) -> Option<String> {
    let declared = declared.filter(|extension| !extension.is_empty());
    match sniff_image_type(head) {
        Some(found) => Some(match declared {
            Some(extension) if found.is_named_by(extension) => extension.to_string(),
            _ => found.extension().to_string(),
        }),
        None => declared.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AVIF: &[u8] = b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf";
    /// libheif and some encoders put the HEIF brand first and AVIF among the
    /// compatible ones.
    const AVIF_MIF1_FIRST: &[u8] = b"\x00\x00\x00\x20ftypmif1\x00\x00\x00\x00mif1avifmiafMA1B";
    const HEIC: &[u8] = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic";
    const MP4: &[u8] = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41";

    #[test]
    fn recognises_every_supported_signature() {
        assert_eq!(sniff_image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageType::Jpeg));
        assert_eq!(sniff_image_type(&PNG_SIGNATURE), Some(ImageType::Png));
        assert_eq!(sniff_image_type(b"GIF87a\x01\x00"), Some(ImageType::Gif));
        assert_eq!(sniff_image_type(b"GIF89a\x01\x00"), Some(ImageType::Gif));
        assert_eq!(
            sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00"),
            Some(ImageType::WebP)
        );
        assert_eq!(
            sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00"),
            Some(ImageType::WebP)
        );
        assert_eq!(sniff_image_type(AVIF), Some(ImageType::Avif));
        assert_eq!(sniff_image_type(HEIC), Some(ImageType::Heic));
    }

    #[test]
    fn tells_an_animated_webp_from_a_still_one() {
        assert_eq!(
            sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00"),
            Some(ImageType::AnimatedWebP)
        );
        assert_eq!(
            sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x08\x00\x00\x00"),
            Some(ImageType::WebP)
        );
    }

    #[test]
    fn finds_avif_among_compatible_brands() {
        assert_eq!(sniff_image_type(AVIF_MIF1_FIRST), Some(ImageType::Avif));
    }

    #[test]
    fn a_video_container_or_another_riff_is_not_an_image() {
        assert_eq!(sniff_image_type(MP4), None);
        assert_eq!(sniff_image_type(b"RIFF\x00\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff_image_type(b"RIFFxxxxWEBPVP8X"), None, "flags byte cut off");
        assert_eq!(sniff_image_type(b"RIFFxxxxWEBPJUNK\x00\x00\x00\x00"), None);
        assert_eq!(sniff_image_type(b"hello world, not an image"), None);
        assert_eq!(sniff_image_type(&[0x89, b'P', b'N']), None);
        assert_eq!(sniff_image_type(&[]), None);
    }

    #[test]
    fn mime_and_extension_follow_the_format() {
        assert_eq!(ImageType::Avif.mime(), "image/avif");
        assert_eq!(ImageType::AnimatedWebP.mime(), "image/webp");
        assert_eq!(ImageType::Jpeg.extension(), "jpg");
        assert!(ImageType::Jpeg.is_named_by("JPEG"));
        assert!(ImageType::Heic.is_named_by("heif"));
        assert!(!ImageType::Avif.is_named_by("png"));
    }

    #[test]
    fn content_type_maps_to_the_stored_extension() {
        assert_eq!(extension_for_content_type("Video/MP4; codecs=avc1"), Some("mp4"));
        assert_eq!(extension_for_content_type("image/svg+xml; charset=utf-8"), Some("svg"));
        assert_eq!(extension_for_content_type("application/octet-stream"), None);
        assert_eq!(extension_for_content_type(""), None);
    }

    /// The case that left a card empty: a URL ending in `.png` answered with
    /// AVIF. The file is named by what it is.
    #[test]
    fn a_media_file_is_named_by_its_bytes_not_its_address() {
        assert_eq!(stored_media_extension(AVIF, Some("png")).as_deref(), Some("avif"));
        assert_eq!(stored_media_extension(&PNG_SIGNATURE, Some("jpg")).as_deref(), Some("png"));
        assert_eq!(stored_media_extension(AVIF, None).as_deref(), Some("avif"));
    }

    #[test]
    fn a_declared_extension_stays_when_it_is_right_or_the_bytes_say_nothing() {
        assert_eq!(
            stored_media_extension(&[0xFF, 0xD8, 0xFF, 0xE0], Some("JPEG")).as_deref(),
            Some("JPEG")
        );
        assert_eq!(stored_media_extension(MP4, Some("mp4")).as_deref(), Some("mp4"));
        assert_eq!(stored_media_extension(MP4, None), None);
        assert_eq!(stored_media_extension(MP4, Some("")), None);
    }
}
