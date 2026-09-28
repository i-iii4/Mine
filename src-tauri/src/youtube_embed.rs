//! Loopback page that hosts the YouTube embedded player.
//!
//! YouTube refuses to play an embed that arrives without an HTTP `Referer`
//! (player error 153). The interface is served from `tauri://localhost`, and
//! WKWebView sends no referrer from a custom scheme, so an iframe placed in the
//! interface directly can never play. The player therefore lives one level
//! down, in a page this process serves from `http://localhost:<port>`: that
//! page's origin becomes the referrer YouTube sees. See SPEC_FRONTEND.md
//! «Видеопрезентация источника карточки».

use std::sync::Mutex;

use mine_core::domain::video_source::{parse_youtube_source, valid_video_id};

const ROUTE_PREFIX: &str = "/youtube/";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum YoutubeEmbedError {
    #[error("not a supported YouTube source URL: {0}")]
    UnsupportedSource(String),
    #[error("could not start the local video page server: {0}")]
    Server(String),
}

/// Lazily started loopback server. Nothing listens until the first card with
/// a YouTube source asks for its player address.
#[derive(Default)]
pub struct YoutubeEmbedServer {
    port: Mutex<Option<u16>>,
}

impl YoutubeEmbedServer {
    /// The address of the wrapper page for the card's source URL.
    ///
    /// # Errors
    /// The URL is not a supported YouTube source, or the server cannot bind.
    pub fn player_url(&self, source_url: &str) -> Result<String, YoutubeEmbedError> {
        let source = parse_youtube_source(source_url)
            .ok_or_else(|| YoutubeEmbedError::UnsupportedSource(source_url.to_owned()))?;
        let port = self.port()?;
        Ok(format!("{}{ROUTE_PREFIX}{}", origin(port), source.video_id))
    }

    fn port(&self) -> Result<u16, YoutubeEmbedError> {
        let mut port = self
            .port
            .lock()
            .map_err(|error| YoutubeEmbedError::Server(error.to_string()))?;
        if let Some(port) = *port {
            return Ok(port);
        }
        let started = start()?;
        *port = Some(started);
        Ok(started)
    }
}

/// `localhost`, not `127.0.0.1`: YouTube refuses some videos when the
/// referrer is a bare IP address and plays them for the `localhost` name.
fn origin(port: u16) -> String {
    format!("http://localhost:{port}")
}

fn start() -> Result<u16, YoutubeEmbedError> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|error| YoutubeEmbedError::Server(error.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|address| address.port())
        .ok_or_else(|| YoutubeEmbedError::Server("listener has no IP address".into()))?;
    std::thread::Builder::new()
        .name("youtube-embed".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                let response = respond(request.method(), request.url(), port);
                if let Err(error) = request.respond(response) {
                    log::warn!("youtube embed response: {error}");
                }
            }
        })
        .map_err(|error| YoutubeEmbedError::Server(error.to_string()))?;
    Ok(port)
}

fn respond(method: &tiny_http::Method, url: &str, port: u16) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    match (method, route(url)) {
        (tiny_http::Method::Get, Some(video_id)) => {
            let mut response = tiny_http::Response::from_string(wrapper_html(video_id, port));
            for (name, value) in WRAPPER_HEADERS {
                if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                    response.add_header(header);
                }
            }
            response
        }
        _ => tiny_http::Response::from_string("").with_status_code(404),
    }
}

const WRAPPER_HEADERS: [(&str, &str); 5] = [
    ("Content-Type", "text/html; charset=utf-8"),
    ("Content-Security-Policy", "default-src 'none'; frame-src https://www.youtube.com; style-src 'unsafe-inline'"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("X-Content-Type-Options", "nosniff"),
    ("Cache-Control", "no-store"),
];

/// The video id of a wrapper route; any other path is not served.
fn route(url: &str) -> Option<&str> {
    let video_id = url.strip_prefix(ROUTE_PREFIX)?;
    valid_video_id(video_id).then_some(video_id)
}

fn wrapper_html(video_id: &str, port: u16) -> String {
    let origin = origin(port);
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}iframe{{display:block;border:0;width:100%;height:100%}}</style>
</head><body>
<iframe src="https://www.youtube.com/embed/{video_id}?playsinline=1&amp;origin={origin}" title="YouTube video player" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
</body></html>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn get(port: u16, path: &str) -> String {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(stream, "GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n").expect("request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("response");
        response
    }

    #[test]
    fn player_url_uses_the_localhost_name_and_the_source_video() {
        let server = YoutubeEmbedServer::default();
        let url = server.player_url("https://youtu.be/9KDDhAOyv9k").expect("player url");
        let port = server.port().expect("port");
        assert_eq!(url, format!("http://localhost:{port}/youtube/9KDDhAOyv9k"));
        assert_eq!(server.player_url("https://www.youtube.com/watch?v=abcdefghijk").expect("second"), format!("http://localhost:{port}/youtube/abcdefghijk"));
    }

    #[test]
    fn player_url_rejects_sources_the_shared_grammar_rejects() {
        let server = YoutubeEmbedServer::default();
        for url in ["https://youtube.com.evil.example/watch?v=9KDDhAOyv9k", "http://youtu.be/9KDDhAOyv9k", "not a url"] {
            assert_eq!(server.player_url(url), Err(YoutubeEmbedError::UnsupportedSource(url.to_owned())));
        }
        assert!(server.port.lock().expect("lock").is_none(), "a rejected source must not start the server");
    }

    #[test]
    fn route_serves_only_valid_video_ids() {
        assert_eq!(route("/youtube/9KDDhAOyv9k"), Some("9KDDhAOyv9k"));
        for url in ["/youtube/9KDDhAOyv9", "/youtube/9KDDhAOyv9k?x=1", "/youtube/9KDDhAOyv9k/", "/youtube/<script>xx", "/", "/other/9KDDhAOyv9k"] {
            assert_eq!(route(url), None, "{url}");
        }
    }

    #[test]
    fn wrapper_embeds_youtube_with_its_own_origin_as_referrer() {
        let html = wrapper_html("9KDDhAOyv9k", 4321);
        assert!(html.contains(r#"src="https://www.youtube.com/embed/9KDDhAOyv9k?playsinline=1&amp;origin=http://localhost:4321""#));
        assert!(!html.contains("autoplay=1"), "opening a card must not start the video");
        assert!(html.contains(r#"referrerpolicy="strict-origin-when-cross-origin""#));
        assert!(html.contains("allowfullscreen"));
    }

    #[test]
    fn server_answers_the_wrapper_route_and_nothing_else() {
        let server = YoutubeEmbedServer::default();
        server.player_url("https://youtu.be/9KDDhAOyv9k").expect("player url");
        let port = server.port().expect("port");
        let page = get(port, "/youtube/9KDDhAOyv9k");
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("Referrer-Policy: strict-origin-when-cross-origin"));
        assert!(page.contains("frame-src https://www.youtube.com"));
        assert!(page.contains("https://www.youtube.com/embed/9KDDhAOyv9k"));
        assert!(get(port, "/youtube/bad").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/").starts_with("HTTP/1.1 404"));
    }
}
