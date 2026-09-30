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

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use mine_lib::markdown_images::{build_inline_wikilink, replaceable_body_images, BodyImage};
use mine_lib::net::download_validated_to_file;

/// How long a download may stall (connecting, or between reads), not a
/// deadline for the whole file.
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

        let mut stored = BTreeMap::new();
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
                    stored.insert(url.clone(), name);
                    report.downloaded += 1;
                }
                Err(e) => {
                    println!("  ✗ {url}: {e:#}");
                    report.failed += 1;
                }
            }
        }

        if !stored.is_empty() {
            std::fs::write(&path, replace_references(&original, &stored))?;
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

/// Byte offset where a note's Markdown body begins: after the frontmatter
/// when the note opens with a `---` line closed by another `---` line (the
/// rule `parse_block` applies), otherwise the start of the file.
fn body_start(content: &str) -> usize {
    let Some(rest) = content.strip_prefix("---\n") else {
        return 0;
    };
    let mut offset = "---\n".len();
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.strip_suffix('\n').unwrap_or(line) == "---" {
            return offset;
        }
    }
    0
}

/// Images of the note's body that still embed http(s) media directly, with
/// their byte ranges in `content`.
///
/// The body is read as Markdown (`replaceable_body_images`): code, an escaped
/// or unclosed `![`, ordinary links, titled and reference-style images and
/// anything inside a wikilink are not candidates, so the rewrite touches only
/// the bytes of real images (В4.1).
fn remote_images(content: &str) -> Vec<BodyImage> {
    let start = body_start(content);
    replaceable_body_images(&content[start..])
        .into_iter()
        .filter(|image| image.url.starts_with("http://") || image.url.starts_with("https://"))
        .map(|image| BodyImage {
            range: image.range.start + start..image.range.end + start,
            ..image
        })
        .collect()
}

/// Each http(s) URL the note still embeds directly, once, in order of first
/// appearance. A plain link is a reference to a page, not media the note is
/// supposed to own.
fn remote_references(content: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    remote_images(content)
        .into_iter()
        .filter_map(|image| seen.insert(image.url.clone()).then_some(image.url))
        .collect()
}

/// `content` with every embed of a stored URL rewritten to a wikilink to its
/// local name, keeping the caption. Every other byte stays as it was.
fn replace_references(content: &str, stored: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut copied = 0;
    for image in remote_images(content) {
        let Some(name) = stored.get(&image.url) else {
            continue;
        };
        out.push_str(&content[copied..image.range.start]);
        out.push_str(&build_inline_wikilink(name, image.caption.trim()));
        copied = image.range.end;
    }
    out.push_str(&content[copied..]);
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
        let out = localized(body, &[("https://c.example/a.mp4", "Note (media 1).mp4")]);
        assert_eq!(
            out,
            "![[Note (media 1).mp4]] and ![[Note (media 1).mp4|clip]] and ![](https://c.example/b.jpg)"
        );
    }

    /// The note the tool writes once every URL in `stored` is downloaded
    /// under the paired name.
    fn localized(content: &str, stored: &[(&str, &str)]) -> String {
        let stored = stored
            .iter()
            .map(|(url, name)| ((*url).to_string(), (*name).to_string()))
            .collect();
        replace_references(content, &stored)
    }

    #[test]
    fn escaped_image_syntax_is_not_a_reference() {
        // В4.1: `\![` is a literal `!` before a link, not an embed.
        let content = "Write \\![not an image](https://h.com/x.jpg) literally.\n\n\
                       ![real](https://h.com/r.jpg)";
        assert_eq!(remote_references(content), ["https://h.com/r.jpg"]);
        let stored = [
            ("https://h.com/x.jpg", "N (media 1).jpg"),
            ("https://h.com/r.jpg", "N (media 2).jpg"),
        ];
        let real = "![real](https://h.com/r.jpg)";
        assert_eq!(
            localized(content, &stored),
            content.replacen(real, "![[N (media 2).jpg|real]]", 1)
        );
    }

    #[test]
    fn unclosed_image_before_a_link_is_not_a_reference() {
        // В4.1: the target of an ordinary link is not media.
        let content = "![ unclosed [t](https://example.com/a.png) text";
        assert!(remote_references(content).is_empty());
        let stored = [("https://example.com/a.png", "N (media 1).png")];
        assert_eq!(localized(content, &stored), content);
    }

    #[test]
    fn code_and_text_around_a_real_image_stay_byte_identical() {
        // An example in code names the same file as the real image, and an
        // unclosed `![` stands before paragraphs and code: only the real
        // image changes.
        let content = "Look ![ at this\n\nA paragraph.\n\n\
                       ```markdown\n![example](https://h.com/e.jpg)\n```\n\n\
                       Inline `![example](https://h.com/e.jpg)` too.\n\n\
                       ![real](https://h.com/e.jpg)\n";
        assert_eq!(remote_references(content), ["https://h.com/e.jpg"]);
        let stored = [("https://h.com/e.jpg", "N (media 1).jpg")];
        let real = "![real](https://h.com/e.jpg)\n";
        assert_eq!(
            localized(content, &stored),
            content.replacen(real, "![[N (media 1).jpg|real]]\n", 1)
        );
    }

    #[test]
    fn titled_and_reference_images_stay_as_written() {
        let content = "![t](https://h.com/t.jpg \"Hover text\")\n\n\
                       ![r][ref] and ![ref]\n\n[ref]: https://h.com/r.jpg\n\n\
                       ![plain](https://h.com/p.jpg)";
        assert_eq!(remote_references(content), ["https://h.com/p.jpg"]);
        let stored = [
            ("https://h.com/t.jpg", "N (media 1).jpg"),
            ("https://h.com/r.jpg", "N (media 2).jpg"),
            ("https://h.com/p.jpg", "N (media 3).jpg"),
        ];
        let plain = "![plain](https://h.com/p.jpg)";
        assert_eq!(
            localized(content, &stored),
            content.replacen(plain, "![[N (media 3).jpg|plain]]", 1)
        );
    }

    #[test]
    fn frontmatter_is_not_a_body() {
        let content = "---\nsource: \"![x](https://h.com/fm.jpg)\"\n---\n\
                       ![b](https://h.com/b.jpg)\n";
        assert_eq!(remote_references(content), ["https://h.com/b.jpg"]);
        let stored = [
            ("https://h.com/fm.jpg", "N (media 1).jpg"),
            ("https://h.com/b.jpg", "N (media 2).jpg"),
        ];
        assert_eq!(
            localized(content, &stored),
            "---\nsource: \"![x](https://h.com/fm.jpg)\"\n---\n![[N (media 2).jpg|b]]\n"
        );
    }

    #[test]
    fn wikilinks_of_a_localized_note_keep_what_they_hold() {
        // A second run over a repaired note: the caption of a local embed and
        // the text of a wikilink are not images of the page.
        let content = "![[N (media 1).jpg|outer ![inner](https://h.com/i.jpg) text]]\n\n\
                       [[Other|![a](https://h.com/a.jpg)]]";
        assert!(remote_references(content).is_empty());
        let stored = [
            ("https://h.com/i.jpg", "N (media 2).jpg"),
            ("https://h.com/a.jpg", "N (media 3).jpg"),
        ];
        assert_eq!(localized(content, &stored), content);
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
