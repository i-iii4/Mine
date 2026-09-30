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
//
// Every note of the space is read, in any folder, the way the app indexes it.
// Media is saved where the app saves new media (the media folder of
// `.mine/layout.json`, the root of a flat space) and named by the app's
// collision rule.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use mine_core::links::LinkIndex;
use mine_core::save::select_unique_file_stem;
use mine_lib::domain::vault::VaultLayout;
use mine_lib::markdown_images::{
    build_inline_wikilink, media_extension_for_content_type, replaceable_body_images, BodyImage,
};
use mine_lib::net::{download_validated_to_file, fetch_validated_head};
use mine_lib::storage::files;

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

    match run(&vault_path, apply, &Network) {
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

/// What the tool asks of the network. Tests stand in for it.
trait Remote {
    /// The `Content-Type` the server announces for `url`, if it answers.
    fn content_type(&self, url: &str) -> Option<String>;
    /// Download `url` to the new file `dest`.
    fn download(&self, url: &str, dest: &Path) -> anyhow::Result<()>;
}

struct Network;

impl Remote for Network {
    fn content_type(&self, url: &str) -> Option<String> {
        let resp = fetch_validated_head(url, PROBE_TIMEOUT, &[]).ok()?;
        resp.header("Content-Type").map(str::to_string)
    }

    fn download(&self, url: &str, dest: &Path) -> anyhow::Result<()> {
        download_validated_to_file(url, dest, REQUEST_TIMEOUT, &[])
    }
}

/// Localize the remote media of every note in the space at `vault_path`.
///
/// Notes are the ones the app indexes (`files::scan_md_files`: every `.md`
/// below the root, hidden and service folders skipped). Media goes where the
/// app writes new media: the media folder of `.mine/layout.json`, the root of
/// a flat space. A new name follows the app's collision rule across the whole
/// space (`select_unique_file_stem`), and the embed names the file by its
/// shortest unambiguous link, so it resolves from the note wherever it sits.
/// Without `apply` nothing on disk changes.
fn run(vault_path: &Path, apply: bool, remote: &dyn Remote) -> anyhow::Result<Report> {
    let mut report = Report::default();
    let vault = files::layout_for_new_files(&VaultLayout::new(vault_path.to_path_buf()))?;
    // Every file name in the space, grown by each name this run takes.
    let mut paths = files::scan_vault_file_paths(&vault)?;

    for note in files::scan_md_files(&vault)? {
        report.scanned += 1;
        let original = std::fs::read_to_string(&note)?;
        let references = remote_references(&original);
        if references.is_empty() {
            continue;
        }

        let stem = note
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("media")
            .to_string();
        report.notes_with_references += 1;
        report.references += references.len();
        println!("{}", note.display());

        let mut stored = BTreeMap::new();
        for (index, url) in references.iter().enumerate() {
            // Not every embedded URL is media. Bodies also carry shortener
            // links (t.co and friends) that resolve to a page; downloading one
            // would store an HTML document as if it were a picture. Ask the
            // server what it serves before believing the markup; the clipper
            // stores the same types under the same extensions.
            let content_type = remote.content_type(url);
            let Some(ext) = content_type
                .as_deref()
                .and_then(media_extension_for_content_type)
            else {
                report.skipped += 1;
                if !apply {
                    println!("  · skipped, not media: {url}");
                }
                continue;
            };
            let raw_name = format!("{stem} (media {})", index + 1);
            let name = match select_unique_file_stem(&raw_name, ext, &paths) {
                Ok(name) => format!("{name}.{ext}"),
                Err(error) => {
                    println!("  ✗ {url}: no free name for {raw_name}.{ext}: {error}");
                    report.failed += 1;
                    continue;
                }
            };
            let relative = vault.new_media_stem(&name);
            if !apply {
                println!("  → {relative}  ({url})");
                paths.push(relative);
                continue;
            }

            let dest = vault.new_media_path(&name);
            match download_into_space(&vault, remote, url, &dest) {
                Ok(()) => {
                    println!("  ✓ {relative}");
                    paths.push(relative.clone());
                    stored.insert(url.clone(), relative);
                    report.downloaded += 1;
                }
                Err(e) => {
                    println!("  ✗ {url}: {e:#}");
                    report.failed += 1;
                }
            }
        }

        if !stored.is_empty() {
            let links = LinkIndex::new(&paths);
            let targets = stored
                .into_iter()
                .map(|(url, relative)| {
                    let link = links.shortest_link(&relative, false).unwrap_or(relative);
                    (url, link)
                })
                .collect();
            // The note may have been edited during the downloads: rewrite what
            // it holds now, so an edit made meanwhile is kept.
            let current = std::fs::read_to_string(&note)?;
            files::write_atomically(&note, replace_references(&current, &targets).as_bytes())?;
        }
    }

    Ok(report)
}

/// Download `url` to `dest` inside the space, creating the media folder when
/// the space has none yet and refusing a target that leaves the space.
fn download_into_space(
    vault: &VaultLayout,
    remote: &dyn Remote,
    url: &str,
    dest: &Path,
) -> anyhow::Result<()> {
    files::validate_vault_write_target(vault, dest)?;
    if let Some(folder) = dest.parent() {
        std::fs::create_dir_all(folder)?;
    }
    remote.download(url, dest)
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

#[cfg(test)]
mod tests {
    use super::*;
    use mine_core::links::{LinkResolution, LinkSyntax};

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
    fn a_repaired_note_names_its_media_by_the_apps_collision_rule() {
        // A name already taken anywhere in the space gets the app's ` (2)`
        // suffix; a server that answers with a page is not downloaded.
        let space = Space::flat();
        space.write("Elsewhere/Note (media 1).jpg", "someone else's picture");
        space.write(
            "Note.md",
            "![a](https://h.com/a.jpg)\n\n![page](https://t.co/x)\n",
        );
        let remote = FakeRemote::new(&[
            ("https://h.com/a.jpg", "image/jpeg"),
            ("https://t.co/x", "text/html; charset=utf-8"),
        ]);

        let report = run(space.root(), true, &remote).unwrap();

        assert_eq!((report.downloaded, report.skipped), (1, 1));
        assert_eq!(space.read("Note (media 1) (2).jpg"), "https://h.com/a.jpg");
        assert_eq!(
            space.read("Note.md"),
            "![[Note (media 1) (2).jpg|a]]\n\n![page](https://t.co/x)\n"
        );
        assert_eq!(
            space.resolve("Note.md", "Note (media 1) (2).jpg"),
            LinkResolution::Resolved("Note (media 1) (2).jpg".to_string())
        );
    }

    #[test]
    fn notes_in_any_folder_get_their_media_in_the_media_folder() {
        // В4.7: the three-folder layout keeps notes in `Cards/` and deeper;
        // media goes to `Media/`, created on first use, and the embed resolves
        // from the note. Hidden folders are not notes.
        let space = Space::standard();
        let card = "---\ntype: article\n---\n# Card\n\n![a](https://h.com/a.jpg)\n";
        space.write("Cards/Card.md", card);
        space.write("Projects/Deep/Diagram.md", "![d](https://h.com/d.svg)\n");
        let hidden = "![h](https://h.com/h.jpg)\n";
        space.write(".obsidian/Hidden.md", hidden);
        let remote = FakeRemote::new(&[
            ("https://h.com/a.jpg", "image/jpeg"),
            ("https://h.com/d.svg", "image/svg+xml"),
            ("https://h.com/h.jpg", "image/jpeg"),
        ]);

        let report = run(space.root(), true, &remote).unwrap();

        assert_eq!((report.scanned, report.downloaded), (2, 2));
        assert_eq!(
            space.read("Media/Card (media 1).jpg"),
            "https://h.com/a.jpg"
        );
        assert_eq!(
            space.read("Media/Diagram (media 1).svg"),
            "https://h.com/d.svg"
        );
        assert!(!space.path("Card (media 1).jpg").exists());
        assert!(!space.path("Cards/Card (media 1).jpg").exists());
        assert_eq!(
            space.read("Cards/Card.md"),
            card.replace("![a](https://h.com/a.jpg)", "![[Card (media 1).jpg|a]]")
        );
        assert_eq!(
            space.read("Projects/Deep/Diagram.md"),
            "![[Diagram (media 1).svg|d]]\n"
        );
        assert_eq!(
            space.resolve("Cards/Card.md", "Card (media 1).jpg"),
            LinkResolution::Resolved("Media/Card (media 1).jpg".to_string())
        );
        assert_eq!(
            space.resolve("Projects/Deep/Diagram.md", "Diagram (media 1).svg"),
            LinkResolution::Resolved("Media/Diagram (media 1).svg".to_string())
        );
        assert_eq!(space.read(".obsidian/Hidden.md"), hidden);
    }

    #[test]
    fn dry_run_downloads_and_writes_nothing() {
        let space = Space::standard();
        space.write("Cards/Card.md", "![a](https://h.com/a.jpg)\n");
        let before = space.files();
        let remote = FakeRemote::new(&[("https://h.com/a.jpg", "image/jpeg")]);

        let report = run(space.root(), false, &remote).unwrap();

        assert_eq!(report.references, 1);
        assert!(remote.downloaded.borrow().is_empty());
        assert_eq!(space.files(), before);
    }

    /// A temporary space on disk.
    struct Space(tempfile::TempDir);

    impl Space {
        fn flat() -> Self {
            Self(tempfile::tempdir().unwrap())
        }

        /// The three-folder layout the app writes for a new space.
        fn standard() -> Self {
            let space = Self::flat();
            space.write(
                ".mine/layout.json",
                r#"{"cards":"Cards","media":"Media","collections":"Collections"}"#,
            );
            space
        }

        fn root(&self) -> &Path {
            self.0.path()
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.root().join(relative)
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.path(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        fn read(&self, relative: &str) -> String {
            std::fs::read_to_string(self.path(relative)).unwrap()
        }

        /// Every file of the space with its bytes.
        fn files(&self) -> BTreeMap<PathBuf, Vec<u8>> {
            fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
                for entry in std::fs::read_dir(dir).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        walk(&path, out);
                    } else {
                        out.insert(path.clone(), std::fs::read(&path).unwrap());
                    }
                }
            }
            let mut files = BTreeMap::new();
            walk(self.root(), &mut files);
            files
        }

        /// How the app resolves the Obsidian link `target` written in `note`.
        fn resolve(&self, note: &str, target: &str) -> LinkResolution {
            let vault = VaultLayout::new(self.root().to_path_buf());
            LinkIndex::new(files::scan_vault_file_paths(&vault).unwrap()).resolve(
                note,
                target,
                LinkSyntax::Obsidian,
            )
        }
    }

    /// Servers that announce the given content types and serve their own URL
    /// as the file's bytes.
    struct FakeRemote {
        content_types: BTreeMap<String, String>,
        downloaded: std::cell::RefCell<Vec<String>>,
    }

    impl FakeRemote {
        fn new(content_types: &[(&str, &str)]) -> Self {
            Self {
                content_types: content_types
                    .iter()
                    .map(|(url, content_type)| ((*url).to_string(), (*content_type).to_string()))
                    .collect(),
                downloaded: std::cell::RefCell::default(),
            }
        }
    }

    impl Remote for FakeRemote {
        fn content_type(&self, url: &str) -> Option<String> {
            self.content_types.get(url).cloned()
        }

        fn download(&self, url: &str, dest: &Path) -> anyhow::Result<()> {
            self.downloaded.borrow_mut().push(url.to_string());
            std::fs::write(dest, url)?;
            Ok(())
        }
    }
}
