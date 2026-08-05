//! Networking utilities shared by the native messaging host and Are.na import.
//!
//! Centralizes SSRF protection: every outbound fetch validates the resolved IP
//! of the request URL — and of every redirect hop — against private, loopback,
//! link-local and multicast ranges. The previous ad-hoc `ureq::get(...)` call
//! sites validated only the initial URL, so a redirect to `169.254.169.254` or
//! `127.0.0.1` bypassed the filter entirely.

use std::io::Read;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use url::{Host, Url};

/// Maximum number of redirects to follow. Each hop is revalidated before it is
/// followed, so this only bounds redirect-chain length, not safety.
const MAX_REDIRECTS: usize = 5;

/// Hard cap on a downloaded media body. Protects the disk from an unbounded or
/// chunked response that stays within the per-request timeout. The clipper
/// upload server applies the same `take(MAX + 1)` guard; this aligns the
/// download path with it.
///
/// Sized for what people actually save rather than for what feels tidy. A cap
/// that rejects a routine 1080p clip does not protect anything — it silently
/// leaves a remote URL in the note, and a note that depends on someone else's
/// server is exactly what this vault exists to avoid.
pub const MAX_MEDIA_BYTES: u64 = 500 * 1024 * 1024;

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
    match ip {
        IpAddr::V4(addr)
            if addr.is_private()
                || addr.is_loopback()
                || addr.is_link_local()
                || addr.is_broadcast()
                || addr.is_unspecified() =>
        {
            bail!("private/loopback addresses are not allowed: {}", addr);
        }
        IpAddr::V6(addr)
            if addr.is_loopback()
                || addr.is_unspecified()
                || addr.is_unique_local()
                || addr.is_unicast_link_local()
                || addr.is_multicast() =>
        {
            bail!("private/loopback addresses are not allowed: {}", addr);
        }
        _ => Ok(()),
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
    fetch_validated(Method::Get, url, timeout, headers)
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
    fetch_validated(Method::Head, url, timeout, headers)
}

#[derive(Clone, Copy)]
enum Method {
    Get,
    Head,
}

fn fetch_validated(
    method: Method,
    url: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<ureq::Response> {
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let mut current = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        validate_fetch_url(&current)?;
        let mut req = match method {
            Method::Get => agent.get(&current),
            Method::Head => agent.head(&current),
        }
        .timeout(timeout);
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
            Err(ureq::Error::Status(status, _resp)) => {
                bail!("request to {current} failed with HTTP {status}");
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

/// GET `url` and stream the body to `dest`, revalidating redirects and capping
/// the body at [`MAX_MEDIA_BYTES`]. Bytes are streamed into a same-directory
/// temp file, fsynced, then atomically linked under the final create-new name;
/// callers never observe a partial download.
pub fn download_validated_to_file(
    url: &str,
    dest: &Path,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<()> {
    let resp = fetch_validated_get(url, timeout, headers)?;
    // take(MAX + 1) so an exactly-MAX body is not silently truncated: a read of
    // MAX + 1 bytes proves the body exceeds the cap.
    let mut reader = resp.into_reader().take(MAX_MEDIA_BYTES + 1);
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
        .write(true)
        .create_new(true)
        .open(&tmp)
        .with_context(|| format!("failed to create {}", tmp.display()))?;
    match std::io::copy(&mut reader, &mut file) {
        Ok(written) if written > MAX_MEDIA_BYTES => {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            bail!("media body exceeds {MAX_MEDIA_BYTES} bytes: {url}");
        }
        Ok(_) => {
            if let Err(error) = file
                .sync_all()
                .with_context(|| format!("failed to fsync download {}", tmp.display()))
            {
                drop(file);
                let _ = std::fs::remove_file(&tmp);
                return Err(error);
            }
            drop(file);
            if let Err(error) = std::fs::hard_link(&tmp, dest).with_context(|| {
                format!(
                    "failed to publish download {} -> {}",
                    tmp.display(),
                    dest.display()
                )
            }) {
                let _ = std::fs::remove_file(&tmp);
                return Err(error);
            }
            let _ = std::fs::remove_file(&tmp);
            std::fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .with_context(|| format!("failed to fsync directory {}", parent.display()))?;
            Ok(())
        }
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            Err(anyhow::Error::from(error)
                .context(format!("failed to write download to {}", tmp.display())))
        }
    }
}

#[cfg(test)]
mod tests {
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
}
