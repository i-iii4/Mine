// migrate-body-to-wikilinks
//
// Phase 18.H.3: rewrite legacy percent-encoded markdown image embeds
// (`![alt](Title%20%28image%201%29.jpg)`) into Obsidian wikilinks
// (`![[Title (image 1).jpg|alt]]`) across every `.md` file in a vault.
//
// Rationale: after 18.H.1 new clips use wikilink syntax. Blocks saved
// between 18.F.1 and 18.H.1 keep the percent-encoded markdown form in
// their bodies. Mine still reads both, but the raw `.md` source is
// ugly in Obsidian for those blocks. This tool converts them in place.
//
// Usage:
//   migrate-body-to-wikilinks --dry-run <vault>
//   migrate-body-to-wikilinks --apply   <vault>
//
// `--dry-run` (default) prints what would change and does not touch
// the disk. `--apply` rewrites affected files. No backups are taken —
// the user is responsible for git/iCloud/Time Machine before applying.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mine_lib::domain::markdown::convert_markdown_images_to_wikilinks;

fn usage() {
    eprintln!(
        "usage: migrate-body-to-wikilinks [--dry-run | --apply] <vault-path>\n\n\
         --dry-run   show what would change (default)\n\
         --apply     rewrite affected .md files in place\n"
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
                "\n{} .md files scanned, {} would change, {} unchanged.",
                report.scanned, report.changed, report.unchanged
            );
            if !apply && report.changed > 0 {
                println!("(dry run — no files were modified; re-run with --apply to commit)");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("migration failed: {e:#}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Default)]
struct Report {
    scanned: usize,
    changed: usize,
    unchanged: usize,
}

fn run(vault_path: &Path, apply: bool) -> anyhow::Result<Report> {
    let mut report = Report::default();

    let entries = std::fs::read_dir(vault_path)?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // Skip hidden dotfiles like `.mine/…` (though read_dir already
        // returns them only if they sit at vault root; `.mine` is a
        // directory and skipped above).
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.'))
        {
            continue;
        }

        report.scanned += 1;
        let original = std::fs::read_to_string(&path)?;

        // Only transform the body, not the frontmatter. Front-matter
        // is a YAML block between two `---` lines at the top of the
        // file; wikilinks don't belong there.
        let (frontmatter, body) = split_frontmatter(&original);
        let new_body = convert_markdown_images_to_wikilinks(body);
        if new_body == body {
            report.unchanged += 1;
            continue;
        }

        let rebuilt = if let Some(fm) = frontmatter {
            format!("---\n{fm}---\n{new_body}")
        } else {
            new_body.clone()
        };

        report.changed += 1;
        println!("~ {}", path.display());

        if apply {
            std::fs::write(&path, rebuilt)?;
        }
    }

    Ok(report)
}

/// Split a markdown file into `(Some(frontmatter), body)` when the file
/// starts with a `---` fence, or `(None, body)` otherwise. The
/// frontmatter block is returned without the fence delimiters.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    if !content.starts_with("---\n") {
        return (None, content);
    }
    let after_open = &content[4..];
    let Some(close_rel) = after_open.find("\n---\n") else {
        return (None, content);
    };
    let fm = &after_open[..close_rel + 1];
    let body_start = 4 + close_rel + 5;
    let body = if body_start <= content.len() {
        &content[body_start..]
    } else {
        ""
    };
    (Some(fm), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_without_frontmatter_returns_none() {
        let content = "just body\n\n![](x.jpg)";
        assert_eq!(split_frontmatter(content), (None, content));
    }

    #[test]
    fn split_with_valid_frontmatter() {
        let content = "---\ntitle: Test\n---\nbody here";
        let (fm, body) = split_frontmatter(content);
        assert_eq!(fm, Some("title: Test\n"));
        assert_eq!(body, "body here");
    }

    #[test]
    fn split_with_unclosed_frontmatter_returns_whole_content_as_body() {
        let content = "---\ntitle: no close\nmore body";
        let (fm, body) = split_frontmatter(content);
        assert!(fm.is_none());
        assert_eq!(body, content);
    }
}
