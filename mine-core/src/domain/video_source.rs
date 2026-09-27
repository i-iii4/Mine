//! Validated external video identity, independent of the card's content kind.
//!
//! Browser consumers use the shared JS grammar; both implementations run the
//! same fixtures so preview classification and actual embedding cannot drift.

/// YouTube identity derived exclusively from a supported source URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YoutubeSource {
    /// The provider's eleven-character video identifier.
    pub video_id: String,
}

fn valid_video_id(value: &str) -> bool {
    value.len() == 11
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Parse the same exact host/path grammar as `extension/lib/youtubeSource.js`.
#[must_use]
pub fn parse_youtube_source(value: &str) -> Option<YoutubeSource> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    let id = match url.host_str()? {
        "youtu.be" | "www.youtu.be" => {
            let path = url.path().strip_prefix('/')?;
            path.strip_suffix('/').unwrap_or(path).to_owned()
        }
        "youtube.com" | "www.youtube.com" | "m.youtube.com" => {
            if url.path() == "/watch" {
                let mut values = url.query_pairs().filter(|(key, _)| key == "v");
                let first = values.next()?.1.into_owned();
                if values.next().is_some() { return None; }
                first
            } else {
                let path = url.path().strip_prefix("/shorts/").or_else(|| url.path().strip_prefix("/embed/"))?;
                path.strip_suffix('/').unwrap_or(path).to_owned()
            }
        }
        _ => return None,
    };
    valid_video_id(&id).then_some(YoutubeSource { video_id: id })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(serde::Deserialize)]
    struct Fixture { url: String, id: Option<String> }

    #[test]
    fn youtube_source_uses_shared_browser_grammar() {
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!("../../../extension/lib/youtubeSource.fixtures.json")).expect("valid provider fixtures");
        for fixture in fixtures {
            assert_eq!(parse_youtube_source(&fixture.url).map(|source| source.video_id), fixture.id, "{}", fixture.url);
        }
    }
}
