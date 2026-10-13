//! A stand-in for the web in the helper's tests. The helper's own downloads
//! refuse every local address (`net::validate_fetch_url`), so a test server
//! on this Mac cannot answer them; this stand-in answers as servers do
//! instead: bytes with a type, an HTTP error, a connection cut after some
//! bytes, a slow transfer. Its failures carry the same messages as
//! `net::download_validated_to_file`, and an address no test served is a
//! name that does not resolve: no test reaches the real web.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

/// How the stand-in server answers one address.
#[derive(Debug, Clone)]
pub enum Answer {
    /// `200` with these bytes, declared as `content_type`.
    Bytes {
        content_type: &'static str,
        body: Vec<u8>,
    },
    /// An HTTP error status, as `404` or `500`.
    Status(u16),
    /// The connection drops after these bytes, on every attempt.
    Cut(Vec<u8>),
    /// `200`, the bytes coming in `chunks` parts with `pause` before each.
    Slow {
        body: Vec<u8>,
        chunks: usize,
        pause: Duration,
    },
}

static ANSWERS: Mutex<Option<HashMap<String, Answer>>> = Mutex::new(None);

/// Answer `url` with `answer` from now on, in every test thread.
pub fn serve(url: &str, answer: Answer) {
    ANSWERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(url.to_string(), answer);
}

fn answer_for(url: &str) -> Option<Answer> {
    ANSWERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|answers| answers.get(url).cloned())
}

fn unresolved(url: &str) -> anyhow::Error {
    let host = url.split('/').nth(2).unwrap_or(url);
    anyhow::anyhow!("failed to resolve host {host}: nodename nor servname provided, or not known")
}

/// What a `HEAD` of `url` declares as its type.
pub fn head(url: &str) -> Option<&'static str> {
    match answer_for(url)? {
        Answer::Bytes { content_type, .. } => Some(content_type),
        Answer::Slow { .. } | Answer::Cut(_) | Answer::Status(_) => None,
    }
}

/// Download `url` to the new file `dest`, as `net::download_validated_to_file`
/// does: the file appears only complete, an existing one is never replaced,
/// three attempts, and `progress` after every part that arrives.
pub fn download(url: &str, dest: &Path, progress: &(dyn Fn() + Sync)) -> anyhow::Result<()> {
    let failed = |error: anyhow::Error| error.context(format!("download failed: {url}"));
    let body = match answer_for(url) {
        None => return Err(failed(unresolved(url))),
        Some(Answer::Status(status)) => {
            return Err(failed(anyhow::anyhow!("request to {url} failed with HTTP {status}")))
        }
        Some(Answer::Cut(part)) => {
            for _ in 0..3 {
                if !part.is_empty() {
                    progress();
                }
            }
            return Err(failed(anyhow::anyhow!("connection reset by peer").context("download interrupted")));
        }
        Some(Answer::Bytes { body, .. }) => {
            progress();
            body
        }
        Some(Answer::Slow { body, chunks, pause }) => {
            let size = body.len().div_ceil(chunks.max(1)).max(1);
            for _ in body.chunks(size) {
                std::thread::sleep(pause);
                progress();
            }
            body
        }
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|error| failed(anyhow::Error::from(error).context(format!("failed to publish download {}", dest.display()))))?;
    file.write_all(&body)?;
    file.sync_all()?;
    Ok(())
}
