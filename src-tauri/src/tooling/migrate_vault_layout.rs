// migrate-vault-layout
//
// Sort a flat vault into three folders by what each file is: `Collections` for
// channel documents, `Cards` for every other note, `Media` for everything else.
//
// Why this is safe for links: Mine resolves an Obsidian embed (`![[name.ext]]`)
// by basename across the whole vault, preferring the folder nearest the note —
// the same rule Obsidian uses. Moving a file deeper therefore does not break
// references to it in either app. Legacy `![alt](file.ext)` markdown embeds do
// NOT survive, because those resolve relative to the note's own folder; run
// migrate-body-to-wikilinks first and this tool will refuse to start until none
// are left.
//
// What does change: a block's identity is its path relative to the vault root,
// so every moved note gets a new slug and its derived previews are rebuilt once.
// Collection membership lives inside the notes and survives untouched.
//
// Usage:
//   migrate-vault-layout --dry-run <vault>
//   migrate-vault-layout --apply   <vault>
//
// `--apply` writes a journal next to the vault listing every move, so the
// layout can be reversed by hand if needed. No files are deleted or rewritten;
// this tool only moves them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const COLLECTIONS_DIR: &str = "Collections";
const CARDS_DIR: &str = "Cards";
const MEDIA_DIR: &str = "Media";

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Destination {
    Collections,
    Cards,
    Media,
}

impl Destination {
    fn dir(self) -> &'static str {
        match self {
            Self::Collections => COLLECTIONS_DIR,
            Self::Cards => CARDS_DIR,
            Self::Media => MEDIA_DIR,
        }
    }
}

fn usage() {
    eprintln!(
        "usage: migrate-vault-layout [--dry-run | --apply] <vault-path>\n\n\
         --dry-run   show how the vault would be sorted (default)\n\
         --apply     move the files and write a journal of every move\n"
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
                "\n{} files in the vault root: {} collections, {} cards, {} media, {} left alone.",
                report.moves.len() + report.skipped,
                report.count(Destination::Collections),
                report.count(Destination::Cards),
                report.count(Destination::Media),
                report.skipped,
            );
            if !apply && !report.moves.is_empty() {
                println!("(dry run — nothing moved; re-run with --apply to commit)");
            }
            if apply {
                println!("journal: {}", report.journal.display());
                println!("re-index the vault so the new paths become the blocks' identity");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("migration failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}

struct Report {
    moves: Vec<(PathBuf, PathBuf, Destination)>,
    skipped: usize,
    journal: PathBuf,
}

impl Report {
    fn count(&self, destination: Destination) -> usize {
        self.moves
            .iter()
            .filter(|(_, _, d)| *d == destination)
            .count()
    }
}

fn run(vault: &Path, apply: bool) -> anyhow::Result<Report> {
    let legacy = notes_with_legacy_embeds(vault)?;
    if !legacy.is_empty() {
        anyhow::bail!(
            "{} note(s) still use `![alt](file)` embeds, which resolve relative to \
             their own folder and would break once notes and media are separated. \
             Run migrate-body-to-wikilinks first. First offender: {}",
            legacy.len(),
            legacy[0].display(),
        );
    }

    let mut moves: Vec<(PathBuf, PathBuf, Destination)> = Vec::new();
    let mut skipped = 0usize;
    let mut taken: BTreeMap<PathBuf, ()> = BTreeMap::new();

    let mut entries: Vec<PathBuf> = std::fs::read_dir(vault)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    entries.sort();

    for path in entries {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            skipped += 1;
            continue;
        };
        // Already-sorted folders, `.mine`, and anything else the user arranged
        // themselves are left exactly as they are.
        if !path.is_file() || name.starts_with('.') {
            skipped += 1;
            continue;
        }

        let destination = classify(&path)?;
        let mut target = vault.join(destination.dir()).join(name);
        // Two files cannot share a name inside one destination. Flat vaults make
        // this rare — the whole root was one namespace — but a collection and a
        // card could collide once they land in different folders and back.
        let mut suffix = 1;
        while target.exists() || taken.contains_key(&target) {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
            let ext = path.extension().and_then(|e| e.to_str());
            let candidate = match ext {
                Some(ext) => format!("{stem} ({suffix}).{ext}"),
                None => format!("{stem} ({suffix})"),
            };
            target = vault.join(destination.dir()).join(candidate);
            suffix += 1;
        }
        taken.insert(target.clone(), ());
        println!("{} → {}/", name, destination.dir());
        moves.push((path, target, destination));
    }

    let journal = vault.join(".mine").join("layout-migration.tsv");
    if !apply {
        return Ok(Report {
            moves,
            skipped,
            journal,
        });
    }

    for dir in [COLLECTIONS_DIR, CARDS_DIR, MEDIA_DIR] {
        std::fs::create_dir_all(vault.join(dir))?;
    }
    std::fs::create_dir_all(vault.join(".mine"))?;

    let mut log = String::from("# source\tdestination\n");
    for (from, to, _) in &moves {
        std::fs::rename(from, to)?;
        log.push_str(&format!("{}\t{}\n", from.display(), to.display()));
    }
    std::fs::write(&journal, log)?;

    Ok(Report {
        moves,
        skipped,
        journal,
    })
}

/// Decide where a file belongs: channel documents, other notes, everything else.
fn classify(path: &Path) -> anyhow::Result<Destination> {
    if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Ok(Destination::Media);
    }
    let content = std::fs::read_to_string(path).unwrap_or_default();
    Ok(if is_channel_document(&content) {
        Destination::Collections
    } else {
        Destination::Cards
    })
}

/// A channel document declares `type: channel` in its frontmatter.
fn is_channel_document(content: &str) -> bool {
    let Some(rest) = content.strip_prefix("---") else {
        return false;
    };
    let Some(end) = rest.find("\n---") else {
        return false;
    };
    rest[..end]
        .lines()
        .map(str::trim)
        .any(|line| line == "type: channel" || line == "type: \"channel\"")
}

/// Notes still carrying `![alt](local-file)` embeds, which do not survive the move.
///
/// Remote URLs are fine — they do not resolve against the filesystem at all.
fn notes_with_legacy_embeds(vault: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(vault)? {
        let path = entry?.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        if has_local_markdown_embed(&content) {
            found.push(path);
        }
    }
    Ok(found)
}

fn has_local_markdown_embed(body: &str) -> bool {
    let mut rest = body;
    while let Some(open) = rest.find("![") {
        let after = &rest[open + 2..];
        // `![[` is an Obsidian embed, which resolves by basename and is safe.
        if after.starts_with('[') {
            rest = &after[1..];
            continue;
        }
        let Some(bracket) = after.find("](") else {
            rest = after;
            continue;
        };
        let url_start = bracket + 2;
        let Some(close) = after[url_start..].find(')') else {
            rest = &after[url_start..];
            continue;
        };
        let target = after[url_start..url_start + close].trim();
        if !target.starts_with("http://") && !target.starts_with("https://") && !target.is_empty() {
            return true;
        }
        rest = &after[url_start + close..];
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_documents_are_recognised_by_frontmatter() {
        assert!(is_channel_document("---\ntype: channel\nposition: 1\n---\n"));
        assert!(is_channel_document("---\ntype: \"channel\"\n---\n"));
        assert!(!is_channel_document("---\ntype: article\n---\n"));
        assert!(!is_channel_document("no frontmatter at all"));
        // `type: channel` in the body is not a declaration.
        assert!(!is_channel_document("---\ntitle: x\n---\ntype: channel\n"));
    }

    #[test]
    fn only_local_markdown_embeds_block_the_migration() {
        assert!(has_local_markdown_embed("![a](photo.jpg)"));
        assert!(has_local_markdown_embed("text\n\n![](clip.mp4)"));
        // These resolve by basename across the vault and survive the move.
        assert!(!has_local_markdown_embed("![[photo.jpg]]"));
        assert!(!has_local_markdown_embed("![[photo.jpg|alt]]"));
        // Remote embeds never touch the filesystem.
        assert!(!has_local_markdown_embed("![a](https://cdn.example/a.jpg)"));
        assert!(!has_local_markdown_embed("plain text"));
    }
}
