//! Networking utilities shared by the native messaging host and Are.na import.
//!
//! Centralizes SSRF protection: every outbound fetch validates the resolved IP
//! of the request URL — and of every redirect hop — against private, loopback,
//! link-local and multicast ranges. The previous ad-hoc `ureq::get(...)` call
//! sites validated only the initial URL, so a redirect to `169.254.169.254` or
//! `127.0.0.1` bypassed the filter entirely.

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context, Result};
use url::{Host, Url};

pub use mine_core::page_files::{is_public_ip, TOO_MANY_REQUESTS};

/// Maximum number of redirects to follow. Each hop is revalidated before it is
/// followed, so this only bounds redirect-chain length, not safety.
const MAX_REDIRECTS: usize = 5;

/// Hard cap on a downloaded media body. Protects the disk from an unbounded or
/// chunked response that keeps trickling bytes under the idle timeout. The clipper
/// upload server applies the same `take(MAX + 1)` guard; this aligns the
/// download path with it.
///
/// Sized for what people actually save rather than for what feels tidy. A cap
/// that rejects a routine 1080p clip does not protect anything — it silently
/// leaves a remote URL in the note, and a note that depends on someone else's
/// server is exactly what this vault exists to avoid.
pub const MAX_MEDIA_BYTES: u64 = 500 * 1024 * 1024;

/// How many times a download is attempted before it fails. A refusal for too
/// many requests is never repeated: another attempt only prolongs the limit
/// (SPEC_CLIPPER.md, «Файл картинки из браузера, отказ сайта и причина
/// ошибки», Б2). An answer that is a web page is not repeated either.
pub const DOWNLOAD_ATTEMPTS: u32 = 3;

/// The answer is a web page, not the file: an error page or a bot check does
/// not become a picture (SPEC_CLIPPER.md, «Один путь файла со страницы», Б8).
/// Another attempt would get the same page, so a download stops here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the answer is a web page")]
pub struct NotAFile;

/// Whether `content_type` declares a web page.
fn declares_web_page(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html"))
}

/// A server answered with an HTTP error status. Kept typed so the caller can
/// tell a refusal from a broken connection and name the site, the code and,
/// for [`TOO_MANY_REQUESTS`], when the site allows the next request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("request to {url} failed with HTTP {status}")]
pub struct HttpStatusError {
    /// The address that answered with the status (after redirects).
    pub url: String,
    pub status: u16,
    /// How long the server asks to wait, from its `Retry-After`.
    pub retry_after: Option<Duration>,
}

impl HttpStatusError {
    /// The error for `status` answered by `url`, reading `Retry-After` from
    /// `header` relative to `now`.
    pub fn new(url: &str, status: u16, retry_after_header: Option<&str>, now: SystemTime) -> Self {
        Self {
            url: url.to_string(),
            status,
            retry_after: retry_after_header.and_then(|value| parse_retry_after(value, now)),
        }
    }

    /// The host that answered, as a person names the site.
    pub fn host(&self) -> Option<String> {
        Url::parse(&self.url).ok()?.host_str().map(str::to_string)
    }
}

/// `Retry-After` (RFC 9110, 10.2.3): a number of seconds or an HTTP date. A
/// date already past means now; a value of neither form is unknown.
pub fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(at.duration_since(now).unwrap_or(Duration::ZERO))
}

/// Pause before the second attempt; each later attempt waits one step more.
const DOWNLOAD_RETRY_BACKOFF: Duration = Duration::from_millis(500);

/// Validate that a URL is safe to fetch: `http`/`https` only, and the resolved
/// host must not be a private, loopback, link-local, broadcast, unspecified or
/// multicast address.
pub fn validate_fetch_url(url: &str) -> Result<()> {
    let parsed = Url::parse(url).map_err(|e| anyhow!("invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => bail!("only http:// and https:// URLs are allowed, got: {}", other),
    }

    let host = parsed.host().ok_or_else(|| anyhow!("URL has no host"))?;
    match host {
        Host::Ipv4(addr) => validate_public_ip(IpAddr::V4(addr))?,
        Host::Ipv6(addr) => validate_public_ip(IpAddr::V6(addr))?,
        Host::Domain(domain) => {
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                bail!("private/loopback hosts are not allowed: {}", domain);
            }
            let port = parsed
                .port_or_known_default()
                .ok_or_else(|| anyhow!("URL has no resolvable port"))?;
            let mut resolved_any = false;
            for addr in (domain, port)
                .to_socket_addrs()
                .map_err(|e| anyhow!("failed to resolve host {domain}: {e}"))?
            {
                resolved_any = true;
                validate_public_ip(addr.ip())?;
            }
            if !resolved_any {
                bail!("host did not resolve: {}", domain);
            }
        }
    }
    Ok(())
}

fn validate_public_ip(ip: IpAddr) -> Result<()> {
    if !is_public_ip(ip) {
        bail!("private/loopback addresses are not allowed: {}", ip);
    }
    Ok(())
}

/// Resolves names for the HTTP client and admits only public addresses. The
/// check covers the address the connection is actually made to: a separate
/// lookup before the request can be answered differently the second time
/// (DNS rebinding) (SPEC_AUDIT_FIXES.md, Ф10).
struct PublicOnlyResolver;

impl ureq::Resolver for PublicOnlyResolver {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        if let Some(blocked) = addrs.iter().find(|addr| !is_public_ip(addr.ip())) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("{netloc} resolves to a private or service address: {}", blocked.ip()),
            ));
        }
        if addrs.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{netloc} did not resolve"),
            ));
        }
        Ok(addrs)
    }
}

/// Perform a GET that revalidates **every** redirect hop against SSRF rules.
///
/// The agent is built with `.redirects(0)` so ureq surfaces 3xx responses
/// instead of following them silently. We resolve the `Location` header against
/// the current URL, revalidate the next hop with [`validate_fetch_url`], and
/// only then follow it. The returned [`ureq::Response`] is the final 2xx
/// response; the caller reads the body (ideally bounded — see
/// [`download_validated_to_file`]).
pub fn fetch_validated_get(
    url: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<ureq::Response> {
    fetch_validated(Method::Get, url, Limit::Total(timeout), headers)
}

/// HEAD `url` under the same validation and redirect rules as
/// [`fetch_validated_get`], for callers that need only the response headers.
///
/// Servers are free to reject HEAD; a caller that depends on the answer should
/// treat an error as "unknown" rather than as a failure of the whole operation.
pub fn fetch_validated_head(
    url: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<ureq::Response> {
    fetch_validated(Method::Head, url, Limit::Total(timeout), headers)
}

#[derive(Clone, Copy)]
enum Method {
    Get,
    Head,
}

/// How long a request may take.
#[derive(Clone, Copy)]
enum Limit {
    /// The whole request, body included: right for small answers.
    Total(Duration),
    /// Connecting and every single read. A body of any size may take as long
    /// as it needs while bytes keep arriving; only a stalled transfer fails.
    Idle(Duration),
}

fn fetch_validated(
    method: Method,
    url: &str,
    limit: Limit,
    headers: &[(&str, &str)],
) -> Result<ureq::Response> {
    let agent = match limit {
        Limit::Total(_) => ureq::AgentBuilder::new(),
        Limit::Idle(idle) => ureq::AgentBuilder::new()
            .timeout_connect(idle)
            .timeout_read(idle)
            .timeout_write(idle),
    }
    .redirects(0)
    .resolver(PublicOnlyResolver)
    .build();
    let mut current = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        validate_fetch_url(&current)?;
        let mut req = match method {
            Method::Get => agent.get(&current),
            Method::Head => agent.head(&current),
        };
        if let Limit::Total(timeout) = limit {
            req = req.timeout(timeout);
        }
        for (name, value) in headers {
            req = req.set(name, value);
        }
        match req.call() {
            Ok(resp) => {
                let status = resp.status();
                if (300..400).contains(&status) {
                    let location = resp
                        .header("Location")
                        .ok_or_else(|| anyhow!("redirect {status} without Location header"))?
                        .to_string();
                    let base = Url::parse(&current)
                        .map_err(|e| anyhow!("invalid redirect base URL {current}: {e}"))?;
                    let next = base
                        .join(&location)
                        .map_err(|e| anyhow!("invalid redirect Location '{location}': {e}"))?;
                    current = next.to_string();
                    continue;
                }
                return Ok(resp);
            }
            // 4xx/5xx are returned by ureq as Err(Status); surface the code.
            Err(ureq::Error::Status(status, resp)) => {
                return Err(status_error(&current, status, &resp).into());
            }
            Err(err) => {
                return Err(
                    anyhow::Error::new(err).context(format!("transport error fetching {current}"))
                );
            }
        }
    }
    bail!("too many redirects (> {MAX_REDIRECTS}) starting from {url}")
}

/// The typed error for an HTTP error `status` answered by `url`.
fn status_error(url: &str, status: u16, resp: &ureq::Response) -> HttpStatusError {
    HttpStatusError::new(url, status, resp.header("Retry-After"), SystemTime::now())
}

/// Whether `error` is a refusal for too many requests, which no further
/// attempt may repeat.
fn is_too_many_requests(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<HttpStatusError>())
        .any(|refusal| refusal.status == TOO_MANY_REQUESTS)
}

/// GET `url` and stream the body to `dest`, revalidating redirects and capping
/// the body at [`MAX_MEDIA_BYTES`]. Bytes are streamed into a same-directory
/// temp file, fsynced, then atomically linked under the final create-new name;
/// callers never observe a partial download.
///
/// `idle_timeout` bounds connecting and each read, not the whole transfer: a
/// large video on a slow link finishes as long as bytes keep coming. Up to
/// [`DOWNLOAD_ATTEMPTS`] attempts are made, except after a
/// [`TOO_MANY_REQUESTS`] answer, which ends the download at once; when the
/// server names the file with a strong `ETag` or a `Last-Modified` date and
/// honours `Range`, a retry continues from the bytes already on disk instead
/// of starting over. A 25 MB clip used to be thrown away at 22 MB when a
/// total deadline ran out. An HTTP error status reaches the caller as an
/// [`HttpStatusError`] in the error's chain.
pub fn download_validated_to_file(
    url: &str,
    dest: &Path,
    idle_timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<()> {
    download_validated_to_file_reporting(url, dest, idle_timeout, headers, &|| ())
}

/// [`download_validated_to_file`], calling `progress` each time bytes
/// arrive: the clipper's helper counts them as signs that a save is still
/// working (SPEC_DEEP_AUDIT.md, Н9).
pub fn download_validated_to_file_reporting(
    url: &str,
    dest: &Path,
    idle_timeout: Duration,
    headers: &[(&str, &str)],
    progress: &(dyn Fn() + Sync),
) -> Result<()> {
    download_with_attempts(url, dest, DOWNLOAD_ATTEMPTS, idle_timeout, headers, progress).map(|_| ())
}

/// [`download_validated_to_file_reporting`] with a number of attempts of its
/// own: after a refusal the browser met, the helper asks the site once
/// (SPEC_CLIPPER.md, «Один путь файла со страницы», Б8). Answers the type the
/// server declared for the file, which tells what an address without an
/// extension holds without a `HEAD` of its own (Б9).
pub fn download_with_attempts(
    url: &str,
    dest: &Path,
    attempts: u32,
    idle_timeout: Duration,
    headers: &[(&str, &str)],
    progress: &(dyn Fn() + Sync),
) -> Result<Option<String>> {
    download_attempting(dest, attempts, DOWNLOAD_RETRY_BACKOFF, progress, |resume| {
        let range;
        let mut request_headers = headers.to_vec();
        if let Some((offset, validator)) = resume {
            range = format!("bytes={offset}-");
            request_headers.push(("Range", &range));
            request_headers.push(("If-Range", validator));
        }
        let resp = fetch_validated(Method::Get, url, Limit::Idle(idle_timeout), &request_headers)?;
        Ok(DownloadResponse {
            status: resp.status(),
            content_range_start: resp.header("Content-Range").and_then(content_range_start),
            validator: resume_validator(&resp),
            content_type: resp.header("Content-Type").map(str::to_string),
            body: Box::new(resp.into_reader()),
        })
    })
    .with_context(|| format!("download failed: {url}"))
}

/// One answer to a download request, reduced to what resuming needs.
struct DownloadResponse {
    status: u16,
    content_range_start: Option<u64>,
    validator: Option<String>,
    content_type: Option<String>,
    body: Box<dyn Read + Send>,
}

/// A value for `If-Range` that names this exact file: a strong `ETag`, else a
/// `Last-Modified` date. A weak `ETag` cannot guard a byte range.
fn resume_validator(resp: &ureq::Response) -> Option<String> {
    resp.header("ETag")
        .filter(|tag| !tag.starts_with("W/"))
        .or_else(|| resp.header("Last-Modified"))
        .map(str::to_string)
}

/// The first byte of `Content-Range: bytes <start>-<end>/<total>`.
fn content_range_start(value: &str) -> Option<u64> {
    value.trim().strip_prefix("bytes ")?.split('-').next()?.trim().parse().ok()
}

/// The attempt loop behind [`download_validated_to_file`], with the network
/// replaced by `fetch` so resuming can be tested without a server.
///
/// `fetch` receives `Some((offset, validator))` when a retry asks the server
/// to continue from `offset`. An answer that is not the matching `206` part
/// (the file changed, or the server ignores `Range`) restarts from zero.
#[cfg(test)]
fn download_resumable(
    dest: &Path,
    backoff: Duration,
    progress: &(dyn Fn() + Sync),
    fetch: impl FnMut(Option<(u64, &str)>) -> Result<DownloadResponse>,
) -> Result<Option<String>> {
    download_attempting(dest, DOWNLOAD_ATTEMPTS, backoff, progress, fetch)
}

fn download_attempting(
    dest: &Path,
    attempts: u32,
    backoff: Duration,
    progress: &(dyn Fn() + Sync),
    mut fetch: impl FnMut(Option<(u64, &str)>) -> Result<DownloadResponse>,
) -> Result<Option<String>> {
    let parent = dest
        .parent()
        .ok_or_else(|| anyhow::anyhow!("download destination has no parent: {}", dest.display()))?;
    std::fs::create_dir_all(parent)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let tmp = dest.with_file_name(format!("{file_name}.tmp.{}.{}", std::process::id(), nonce));
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&tmp)
        .with_context(|| format!("failed to create {}", tmp.display()))?;
    let result = fill_with_attempts(&mut file, attempts, backoff, progress, &mut fetch)
        .and_then(|content_type| {
            file.sync_all()
                .with_context(|| format!("failed to fsync download {}", tmp.display()))?;
            Ok(content_type)
        });
    drop(file);
    let content_type = match result {
        Ok(content_type) => content_type,
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
    };
    // One exclusive rename, not link + unlink: hard links are unreliable in
    // cloud storage (iCloud Drive), and a crash between two steps would leave
    // a visible `name.tmp.*` duplicate in the space.
    if let Err(error) = crate::util::rename_exclusive(&tmp, dest).with_context(|| {
        format!(
            "failed to publish download {} -> {}",
            tmp.display(),
            dest.display()
        )
    }) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("failed to fsync directory {}", parent.display()))?;
    Ok(content_type)
}

/// A body reader that calls `progress` after every read that brought bytes.
struct Reporting<'a, R> {
    inner: R,
    progress: &'a (dyn Fn() + Sync),
}

impl<R: Read> Read for Reporting<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buf)?;
        if count > 0 {
            (self.progress)();
        }
        Ok(count)
    }
}

fn fill_with_attempts(
    file: &mut std::fs::File,
    attempts: u32,
    backoff: Duration,
    progress: &(dyn Fn() + Sync),
    fetch: &mut impl FnMut(Option<(u64, &str)>) -> Result<DownloadResponse>,
) -> Result<Option<String>> {
    let mut validator: Option<String> = None;
    let mut last_error = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            std::thread::sleep(backoff * attempt);
        }
        let offset = file.metadata()?.len();
        let resume = match validator.as_deref() {
            Some(tag) if offset > 0 => Some((offset, tag)),
            _ => None,
        };
        let response = match fetch(resume) {
            Ok(response) => response,
            Err(error) if is_too_many_requests(&error) => return Err(error),
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        if response.content_type.as_deref().is_some_and(declares_web_page) {
            file.set_len(0)?;
            return Err(NotAFile.into());
        }
        let continues = resume.is_some()
            && response.status == 206
            && response.content_range_start == Some(offset);
        if continues {
            file.seek(SeekFrom::End(0))?;
        } else {
            if (200..300).contains(&response.status) && response.status != 200 {
                // A part we did not ask for (or not where we asked) cannot be
                // stitched on; start over without Range next time.
                file.set_len(0)?;
                validator = None;
                last_error = Some(anyhow!("unexpected HTTP {} for a download", response.status));
                continue;
            }
            file.set_len(0)?;
            file.seek(SeekFrom::Start(0))?;
            validator = response.validator.clone();
        }
        let already = if continues { offset } else { 0 };
        let content_type = response.content_type.clone();
        // take(remaining + 1) so an exactly-MAX body is not silently truncated:
        // one byte past the cap proves the body exceeds it.
        let mut reader = Reporting {
            inner: response.body.take(MAX_MEDIA_BYTES - already + 1),
            progress,
        };
        match std::io::copy(&mut reader, file) {
            Ok(written) if already + written > MAX_MEDIA_BYTES => {
                bail!("media body exceeds {MAX_MEDIA_BYTES} bytes");
            }
            Ok(_) => {
                file.flush()?;
                return Ok(content_type);
            }
            Err(error) => {
                // Keep what arrived: the next attempt continues from it when
                // the server can resume, and starts over otherwise.
                file.flush()?;
                last_error = Some(anyhow::Error::from(error).context("download interrupted"));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("download failed")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_connection_resolver_refuses_a_name_that_leads_inside() {
        use ureq::Resolver;
        let error = PublicOnlyResolver.resolve("localhost:80").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        let error = PublicOnlyResolver.resolve("[::ffff:127.0.0.1]:80").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        let error = PublicOnlyResolver.resolve("100.64.0.1:443").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn a_fetch_never_connects_to_a_private_address_even_after_the_first_check() {
        // A local server stands in for a rebinding DNS answer: the request is
        // refused at connection time, whatever an earlier lookup said.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let agent = ureq::AgentBuilder::new().resolver(PublicOnlyResolver).build();
        let error = agent.get(&format!("http://127.0.0.1:{port}/")).call().unwrap_err();
        assert!(error.to_string().contains("private or service address"), "{error}");
    }

    use super::*;

    #[test]
    fn validate_fetch_url_rejects_private_hosts() {
        assert!(validate_fetch_url("http://127.0.0.1/image.jpg").is_err());
        assert!(validate_fetch_url("http://10.0.0.2/image.jpg").is_err());
        assert!(validate_fetch_url("http://localhost/image.jpg").is_err());
        assert!(validate_fetch_url("http://[::1]/image.jpg").is_err());
    }

    #[test]
    fn validate_fetch_url_rejects_link_local_metadata_endpoint() {
        // Cloud metadata endpoint — the prime SSRF target.
        assert!(validate_fetch_url("http://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn validate_fetch_url_rejects_non_http_schemes() {
        assert!(validate_fetch_url("file:///etc/passwd").is_err());
        assert!(validate_fetch_url("ftp://example.com/x").is_err());
        assert!(validate_fetch_url("data:text/plain,hi").is_err());
    }

    #[test]
    fn validate_fetch_url_allows_public_ip() {
        assert!(validate_fetch_url("https://93.184.216.34/image.jpg").is_ok());
    }

    /// A body that yields `bytes`, then fails as a dropped connection does.
    struct Interrupted {
        bytes: std::io::Cursor<Vec<u8>>,
    }

    impl Read for Interrupted {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.bytes.read(buf)? {
                0 => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "stalled")),
                n => Ok(n),
            }
        }
    }

    fn response(status: u16, start: Option<u64>, validator: Option<&str>, body: Box<dyn Read + Send>) -> DownloadResponse {
        DownloadResponse {
            status,
            content_range_start: start,
            validator: validator.map(str::to_string),
            content_type: None,
            body,
        }
    }

    fn whole(bytes: &[u8]) -> Box<dyn Read + Send> {
        Box::new(std::io::Cursor::new(bytes.to_vec()))
    }

    fn cut(bytes: &[u8]) -> Box<dyn Read + Send> {
        Box::new(Interrupted { bytes: std::io::Cursor::new(bytes.to_vec()) })
    }

    fn scratch() -> std::path::PathBuf {
        // Parallel tests can read the same clock value; the counter keeps
        // their folders apart.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mine-net-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("clip.mp4")
    }

    #[test]
    fn a_retry_continues_from_the_bytes_already_on_disk() {
        let dest = scratch();
        let mut asked = Vec::new();
        download_resumable(&dest, Duration::ZERO, &|| (), |resume| {
            asked.push(resume.map(|(offset, tag)| (offset, tag.to_string())));
            Ok(match resume {
                None => response(200, None, Some("\"v1\""), cut(b"hello ")),
                Some(_) => response(206, Some(6), None, whole(b"world")),
            })
        })
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
        assert_eq!(asked, vec![None, Some((6, "\"v1\"".to_string()))]);
    }

    #[test]
    fn a_server_that_ignores_range_starts_the_file_over() {
        let dest = scratch();
        let mut attempt = 0;
        download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            attempt += 1;
            Ok(if attempt == 1 {
                response(200, None, Some("\"v1\""), cut(b"hel"))
            } else {
                response(200, None, Some("\"v1\""), whole(b"hello world"))
            })
        })
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
    }

    #[test]
    fn a_file_without_a_validator_is_never_resumed() {
        let dest = scratch();
        let mut asked = Vec::new();
        download_resumable(&dest, Duration::ZERO, &|| (), |resume| {
            asked.push(resume.is_some());
            Ok(if asked.len() == 1 {
                response(200, None, None, cut(b"hel"))
            } else {
                response(200, None, None, whole(b"hello world"))
            })
        })
        .unwrap();
        assert_eq!(asked, vec![false, false]);
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
    }

    #[test]
    fn a_misplaced_part_is_discarded() {
        let dest = scratch();
        let mut attempt = 0;
        download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            attempt += 1;
            Ok(match attempt {
                1 => response(200, None, Some("\"v1\""), cut(b"hello ")),
                2 => response(206, Some(3), None, whole(b"lo world")),
                _ => response(200, None, None, whole(b"hello world")),
            })
        })
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
    }

    #[test]
    fn a_finished_download_is_moved_into_place_under_one_name() {
        use std::os::unix::fs::MetadataExt;
        let dest = scratch();
        download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            Ok(response(200, None, None, whole(b"hello world")))
        })
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
        assert_eq!(std::fs::metadata(&dest).unwrap().nlink(), 1);
        assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn a_download_never_replaces_a_file_already_at_its_name() {
        let dest = scratch();
        std::fs::write(&dest, b"existing").unwrap();
        let error = download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            Ok(response(200, None, None, whole(b"hello world")))
        })
        .unwrap_err();
        assert!(error.chain().any(|cause| cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists)));
        assert_eq!(std::fs::read(&dest).unwrap(), b"existing");
        assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn three_failed_attempts_leave_no_file_behind() {
        let dest = scratch();
        let result = download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            Ok(response(200, None, None, cut(b"partial")))
        });
        assert!(result.is_err());
        assert!(!dest.exists());
        let leftovers = std::fs::read_dir(dest.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 0);
    }

    /// Н9: every read that brings bytes is reported, also on a retry, so the
    /// clipper's helper can tell the clipper a long download still works.
    #[test]
    fn every_part_that_arrives_is_reported() {
        let dest = scratch();
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let report = || {
            reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        };
        let mut attempt = 0;
        download_resumable(&dest, Duration::ZERO, &report, |_| {
            attempt += 1;
            Ok(if attempt == 1 {
                response(200, None, None, cut(b"hel"))
            } else {
                response(200, None, None, Box::new(std::io::Cursor::new(b"hello world".to_vec()).chain(&b"!"[..])))
            })
        })
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world!");
        assert!(reads.load(std::sync::atomic::Ordering::Relaxed) >= 3, "parts went unreported");
    }

    /// Manual: the 25.9 MB 2160p clip that a 15 s whole-request deadline used
    /// to throw away. `cargo test -p mine --lib real_x_video -- --ignored`.
    #[test]
    #[ignore = "downloads a real 26 MB video from video.twimg.com"]
    fn real_x_video_downloads_under_the_idle_timeout() {
        let dest = scratch();
        let started = std::time::Instant::now();
        download_validated_to_file(
            "https://video.twimg.com/amplify_video/2104542324449787904/vid/avc1/2842x2160/jum7WbJ0hV9Y7wq3.mp4",
            &dest,
            Duration::from_secs(15),
            &[],
        )
        .unwrap();
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 25_919_872);
        eprintln!("downloaded in {:?}", started.elapsed());
    }

    /// A local server that answers every request with `status` and
    /// `headers`, closing each connection; it counts the requests it got.
    /// Only this Mac is reached: the network is never asked.
    fn refusing_server(status: &'static str, headers: &'static str) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/picture.jpg", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = std::sync::Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok_and(|read| read > 0) && line != "\r\n" {
                    line.clear();
                }
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{headers}Content-Length: 0\r\nConnection: close\r\n\r\n"
                );
            }
        });
        (address, requests)
    }

    /// One attempt against `url` the way `download_validated_to_file_reporting`
    /// makes it, without its public-address guard, which refuses this Mac.
    fn local_attempt(url: &str) -> Result<DownloadResponse> {
        match ureq::AgentBuilder::new().redirects(0).build().get(url).call() {
            Ok(resp) => Ok(DownloadResponse {
                status: resp.status(),
                content_range_start: None,
                validator: None,
                content_type: resp.header("Content-Type").map(str::to_string),
                body: Box::new(resp.into_reader()),
            }),
            Err(ureq::Error::Status(status, resp)) => Err(status_error(url, status, &resp).into()),
            Err(error) => Err(error.into()),
        }
    }

    /// Б2: a `429` is asked once, and its `Retry-After` reaches the caller.
    #[test]
    fn too_many_requests_is_asked_once_and_says_when_to_retry() {
        let (url, requests) = refusing_server("429 Too Many Requests", "Retry-After: 600\r\n");
        let dest = scratch();

        let error = download_resumable(&dest, Duration::ZERO, &|| (), |_| local_attempt(&url)).unwrap_err();

        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1, "a 429 was asked again");
        let refusal = error.chain().find_map(|cause| cause.downcast_ref::<HttpStatusError>()).unwrap();
        assert_eq!(refusal.status, TOO_MANY_REQUESTS);
        assert_eq!(refusal.retry_after, Some(Duration::from_secs(600)));
        assert_eq!(refusal.host().as_deref(), Some("127.0.0.1"));
        assert!(!dest.exists());
    }

    /// Б8: a web page is not the file, and asking again would bring it again.
    #[test]
    fn a_web_page_is_not_the_file_and_is_asked_once() {
        let dest = scratch();
        let mut attempts = 0;
        let error = download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            attempts += 1;
            Ok(DownloadResponse { content_type: Some("text/html; charset=utf-8".into()), ..response(200, None, None, whole(b"<html>")) })
        })
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert!(error.chain().any(|cause| cause.downcast_ref::<NotAFile>().is_some()));
        assert!(!dest.exists());
        assert!(declares_web_page("text/html; charset=utf-8"));
        assert!(declares_web_page("TEXT/HTML"));
        assert!(!declares_web_page("image/jpeg"));
    }

    /// Б9: the download answers the type the server declared for the file.
    #[test]
    fn a_download_answers_the_type_of_the_file() {
        let dest = scratch();
        let content_type = download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            Ok(DownloadResponse { content_type: Some("video/mp4".into()), ..response(200, None, None, whole(b"bytes")) })
        })
        .unwrap();
        assert_eq!(content_type.as_deref(), Some("video/mp4"));
    }

    /// Б8: after a refusal the browser met, one attempt is one request.
    #[test]
    fn a_download_makes_only_the_attempts_it_is_given() {
        let dest = scratch();
        let mut asked = 0;
        let result = download_attempting(&dest, 1, Duration::ZERO, &|| (), |_| {
            asked += 1;
            Err(HttpStatusError::new("https://cdn.test/a.jpg", 503, None, SystemTime::now()).into())
        });
        assert!(result.is_err());
        assert_eq!(asked, 1);
    }

    /// Б2: every other failure keeps its three attempts.
    #[test]
    fn other_refusals_are_still_tried_three_times() {
        let (url, requests) = refusing_server("503 Service Unavailable", "");
        let dest = scratch();

        let error = download_resumable(&dest, Duration::ZERO, &|| (), |_| local_attempt(&url)).unwrap_err();

        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), DOWNLOAD_ATTEMPTS as usize);
        let refusal = error.chain().find_map(|cause| cause.downcast_ref::<HttpStatusError>()).unwrap();
        assert_eq!(refusal.status, 503);
        assert_eq!(refusal.retry_after, None);
    }

    /// Б2: a `429` met on a retry ends the download there too.
    #[test]
    fn a_429_on_a_retry_ends_the_download() {
        let dest = scratch();
        let mut attempts = 0;
        let error = download_resumable(&dest, Duration::ZERO, &|| (), |_| {
            attempts += 1;
            if attempts == 1 {
                Ok(response(200, None, None, cut(b"part")))
            } else {
                Err(HttpStatusError::new("https://cdn.test/a.jpg", TOO_MANY_REQUESTS, None, SystemTime::now()).into())
            }
        })
        .unwrap_err();
        assert_eq!(attempts, 2);
        assert!(is_too_many_requests(&error));
    }

    #[test]
    fn retry_after_reads_seconds_and_dates() {
        let now = httpdate::parse_http_date("Thu, 29 Oct 2026 12:00:00 GMT").unwrap();
        assert_eq!(parse_retry_after("600", now), Some(Duration::from_secs(600)));
        assert_eq!(parse_retry_after(" 0 ", now), Some(Duration::ZERO));
        assert_eq!(
            parse_retry_after("Thu, 29 Oct 2026 12:10:00 GMT", now),
            Some(Duration::from_secs(600))
        );
        // A date already past allows the next request now.
        assert_eq!(parse_retry_after("Thu, 29 Oct 2026 11:00:00 GMT", now), Some(Duration::ZERO));
        assert_eq!(parse_retry_after("soon", now), None);
        assert_eq!(parse_retry_after("-5", now), None);
    }

    #[test]
    fn content_range_start_reads_the_first_byte() {
        assert_eq!(content_range_start("bytes 6-10/11"), Some(6));
        assert_eq!(content_range_start("bytes */11"), None);
        assert_eq!(content_range_start("items 1-2/3"), None);
    }
}
