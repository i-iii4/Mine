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
    /// `429 Too Many Requests` with this `Retry-After`, if any.
    TooManyRequests { retry_after: Option<&'static str> },
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
/// How many `GET` and `HEAD` requests reached each address.
static REQUESTS: Mutex<Option<HashMap<String, (usize, usize)>>> = Mutex::new(None);
/// Hosts whose name has no DNS answer.
static WITHOUT_DNS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn counted(url: &str, count: impl FnOnce(&mut (usize, usize))) {
    let mut requests = REQUESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    count(requests.get_or_insert_with(HashMap::new).entry(url.to_string()).or_default());
}

/// How many `GET` requests reached `url`, attempts of a retry included.
pub fn gets(url: &str) -> usize {
    REQUESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|requests| requests.get(url).map(|count| count.0))
        .unwrap_or(0)
}

/// How many `HEAD` requests reached `url`.
pub fn heads(url: &str) -> usize {
    REQUESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|requests| requests.get(url).map(|count| count.1))
        .unwrap_or(0)
}

/// The name of `host` has no DNS answer from now on.
pub fn without_dns(host: &str) {
    WITHOUT_DNS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(host.to_string());
}

/// Whether the name of `url` has a DNS answer.
pub fn resolves(url: &str) -> bool {
    let host = url.split('/').nth(2).unwrap_or(url);
    !WITHOUT_DNS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().any(|name| name == host)
}

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
    counted(url, |count| count.1 += 1);
    match answer_for(url)? {
        Answer::Bytes { content_type, .. } => Some(content_type),
        Answer::Slow { .. } | Answer::Cut(_) | Answer::Status(_) | Answer::TooManyRequests { .. } => None,
    }
}

/// Download `url` to the new file `dest`, as `net::download_with_attempts`
/// does: the file appears only complete, an existing one is never replaced,
/// `attempts` attempts except after a `429` or a web page, which end it at
/// once, and `progress` after every part that arrives. An HTTP error status
/// fails with the same typed `net::HttpStatusError`. Answers the type declared
/// for the file.
pub fn download(url: &str, dest: &Path, attempts: u32, progress: &(dyn Fn() + Sync)) -> anyhow::Result<Option<String>> {
    let failed = |error: anyhow::Error| error.context(format!("download failed: {url}"));
    let asked = |count: usize| counted(url, |counts| counts.0 += count);
    let tries = attempts as usize;
    let refused = |status: u16, retry_after: Option<&str>| {
        failed(mine_lib::net::HttpStatusError::new(url, status, retry_after, std::time::SystemTime::now()).into())
    };
    let mut declared = None;
    let body = match answer_for(url) {
        None => {
            asked(tries);
            return Err(failed(unresolved(url)));
        }
        Some(Answer::Status(status)) => {
            asked(tries);
            return Err(refused(status, None));
        }
        Some(Answer::TooManyRequests { retry_after }) => {
            asked(1);
            return Err(refused(mine_lib::net::TOO_MANY_REQUESTS, retry_after));
        }
        Some(Answer::Cut(part)) => {
            asked(tries);
            for _ in 0..tries {
                if !part.is_empty() {
                    progress();
                }
            }
            return Err(failed(anyhow::anyhow!("connection reset by peer").context("download interrupted")));
        }
        Some(Answer::Bytes { content_type: "text/html", .. }) => {
            asked(1);
            return Err(failed(mine_lib::net::NotAFile.into()));
        }
        Some(Answer::Bytes { content_type, body }) => {
            asked(1);
            progress();
            declared = Some(content_type.to_string());
            body
        }
        Some(Answer::Slow { body, chunks, pause }) => {
            asked(1);
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
    Ok(declared)
}
