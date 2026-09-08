// localize-remote-media
//
// Download media that stayed behind a remote URL in a note's body and rewrite
// the reference to a local Obsidian wikilink.
//
// Rationale: the clipper localizes inline media at save time, but a download
// that fails leaves the remote URL in place. Until the media cap was raised
// that happened routinely for 1080p video, which exceeded it. Such a note is
// not self-contained: it needs the network to render, and it breaks for good
// once the origin deletes the file. This tool repairs those notes after the
// fact.
//
// Usage:
//   localize-remote-media --dry-run <vault>
//   localize-remote-media --apply   <vault>
//
// `--dry-run` (default) reports what would be downloaded without touching the
// disk. `--apply` downloads and rewrites in place. No backups are taken — the
// user is responsible for git/iCloud/Time Machine before applying.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use mine_lib::net::download_validated_to_file;

/// Matches the clipper's inline download budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Short by design: this only reads headers to classify a URL.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

fn usage() {
    eprintln!(
        "usage: localize-remote-media [--dry-run | --apply] <vault-path>\n\n\
         --dry-run   list remote media that would be downloaded (default)\n\
         --apply     download it and rewrite the references in place\n"
    );
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut apply = false;
    let mut vault_path: Option<PathBuf> = None;

    for arg in args {
        match arg.as_str() {
            "--apply" => apply = true,
            "--dry-run" => apply = false,
            "-h" | "--help" => {
                usage();
                return ExitCode::SUCCESS;
            }
            other if other.starts_with("--") => {
                eprintln!("unknown option: {other}");
                usage();
                return ExitCode::from(2);
            }
            other => {
                if vault_path.is_some() {
                    eprintln!("multiple vault paths given");
                    return ExitCode::from(2);
                }
                vault_path = Some(PathBuf::from(other));
            }
        }
    }

    let Some(vault_path) = vault_path else {
        usage();
        return ExitCode::from(2);
    };

    if !vault_path.is_dir() {
        eprintln!("vault path is not a directory: {}", vault_path.display());
        return ExitCode::from(2);
    }

    match run(&vault_path, apply) {
        Ok(report) => {
            println!(
                "\n{} .md files scanned, {} remote references in {} notes, \
                 {} downloaded, {} skipped as non-media, {} failed.",
                report.scanned,
                report.references,
                report.notes_with_references,
                report.downloaded,
                report.skipped,
                report.failed
            );
            if !apply && report.references > 0 {
                println!("(dry run — nothing was downloaded; re-run with --apply to commit)");
            }
            if report.failed > 0 {
                println!("failed references keep their remote URL and can be retried later");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("localization failed: {e:#}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Default)]
struct Report {
    scanned: usize,
    notes_with_references: usize,
    references: usize,
    downloaded: usize,
    failed: usize,
    skipped: usize,
}

fn run(vault_path: &Path, apply: bool) -> anyhow::Result<Report> {
    let mut report = Report::default();
    let existing = existing_names(vault_path);

    for entry in std::fs::read_dir(vault_path)? {
        let path = entry?.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.'))
        {
            continue;
        }

        report.scanned += 1;
        let original = std::fs::read_to_string(&path)?;
        let references = remote_references(&original);
        if references.is_empty() {
            continue;
        }

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("media")
            .to_string();
        report.notes_with_references += 1;
        report.references += references.len();
        println!("{}", path.display());

        let mut rewritten = original.clone();
        let mut changed = false;
        for (index, url) in references.iter().enumerate() {
            // Not every embedded URL is media. Bodies also carry shortener
            // links (t.co and friends) that resolve to a page; downloading one
            // would store an HTML document as if it were a picture. Ask the
            // server what it serves before believing the markup.
            let Some(ext) = media_extension(url) else {
                report.skipped += 1;
                if !apply {
                    println!("  · skipped, not media: {url}");
                }
                continue;
            };
            let name = unique_name(&existing, &stem, index + 1, ext);
            if !apply {
                println!("  → {name}  ({url})");
                continue;
            }

            let dest = vault_path.join(&name);
            match download_validated_to_file(url, &dest, REQUEST_TIMEOUT, &[]) {
                Ok(()) => {
                    println!("  ✓ {name}");
                    rewritten = replace_reference(&rewritten, url, &name);
                    report.downloaded += 1;
                    changed = true;
                }
                Err(e) => {
                    println!("  ✗ {url}: {e:#}");
                    report.failed += 1;
                }
            }
        }

        if changed {
            std::fs::write(&path, rewritten)?;
        }
    }

    Ok(report)
}

/// Every filename already in the vault, so generated names never collide with
/// media a note is legitimately using.
fn existing_names(vault_path: &Path) -> BTreeSet<String> {
    let Ok(entries) = std::fs::read_dir(vault_path) else {
        return BTreeSet::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str().map(str::to_string))
        .collect()
}

fn unique_name(existing: &BTreeSet<String>, stem: &str, index: usize, ext: &str) -> String {
    let mut candidate = format!("{stem} (media {index}).{ext}");
    let mut suffix = index;
    while existing.contains(&candidate) {
        suffix += 1;
        candidate = format!("{stem} (media {suffix}).{ext}");
    }
    candidate
}

/// Collect the http(s) URLs a body still embeds directly.
///
/// Only `![...](url)` is considered: a plain link is a reference to a page, not
/// media the note is supposed to own.
fn remote_references(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = body;

    while let Some(open) = rest.find("![") {
        let after = &rest[open + 2..];
        let Some(bracket) = after.find("](") else {
            rest = after;
            continue;
        };
        let url_start = bracket + 2;
        let Some(close) = after[url_start..].find(')') else {
            rest = &after[url_start..];
            continue;
        };
        let url = after[url_start..url_start + close].trim();
        if (url.starts_with("http://") || url.starts_with("https://"))
            && seen.insert(url.to_string())
        {
            found.push(url.to_string());
        }
        rest = &after[url_start + close..];
    }

    found
}

/// Rewrite every embed of `url` to a wikilink, preserving its alt text.
fn replace_reference(body: &str, url: &str, name: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;

    while let Some(open) = rest.find("![") {
        let after = &rest[open + 2..];
        let Some(bracket) = after.find("](") else {
            out.push_str(&rest[..open + 2]);
            rest = after;
            continue;
        };
        let url_start = bracket + 2;
        let Some(close) = after[url_start..].find(')') else {
            out.push_str(&rest[..open + 2]);
            rest = after;
            continue;
        };

        let alt = &after[..bracket];
        let found = after[url_start..url_start + close].trim();
        out.push_str(&rest[..open]);
        if found == url {
            if alt.is_empty() {
                out.push_str(&format!("![[{name}]]"));
            } else {
                out.push_str(&format!("![[{name}|{alt}]]"));
            }
        } else {
            out.push_str(&rest[open..open + 2 + url_start + close + 1]);
        }
        rest = &after[url_start + close + 1..];
    }

    out.push_str(rest);
    out
}

/// The extension to store `url` under, or `None` if it does not serve media.
///
/// The server decides, not the markup: an embed can point at anything, and a
/// URL that ends in `.jpg` is not proof either. One HEAD per reference is cheap
/// next to the download it guards.
fn media_extension(url: &str) -> Option<&'static str> {
    let resp = mine_lib::net::fetch_validated_head(url, PROBE_TIMEOUT, &[]).ok()?;
    let content_type = resp.header("Content-Type")?;
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    Some(match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/heic" => "heic",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_embedded_remote_media() {
        let body = "text\n\n![](https://cdn.example/a.mp4)\n\n[link](https://example.com)\n\n![[local.jpg]]";
        assert_eq!(
            remote_references(body),
            vec!["https://cdn.example/a.mp4".to_string()]
        );
    }

    #[test]
    fn repeated_url_is_reported_once() {
        let body = "![](https://c.example/a.jpg)\n![](https://c.example/a.jpg)";
        assert_eq!(remote_references(body).len(), 1);
    }

    #[test]
    fn rewrites_every_embed_of_one_url_and_keeps_alt_text() {
        let body = "![](https://c.example/a.mp4) and ![clip](https://c.example/a.mp4) and ![](https://c.example/b.jpg)";
        let out = replace_reference(body, "https://c.example/a.mp4", "Note (media 1).mp4");
        assert_eq!(
            out,
            "![[Note (media 1).mp4]] and ![[Note (media 1).mp4|clip]] and ![](https://c.example/b.jpg)"
        );
    }

    #[test]
    fn generated_names_avoid_files_already_in_the_vault() {
        let existing: BTreeSet<String> = ["Note (media 1).mp4".to_string()].into_iter().collect();
        assert_eq!(
            unique_name(&existing, "Note", 1, "mp4"),
            "Note (media 2).mp4"
        );
    }
}
