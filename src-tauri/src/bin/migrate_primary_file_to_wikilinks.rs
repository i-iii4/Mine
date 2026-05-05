// migrate-primary-file-to-wikilinks
//
// Rewrite legacy primary media frontmatter from:
//
//   file: image.png
//
// to the Obsidian-compatible canonical form:
//
//   file: "[[image.png]]"
//
// The migration is intentionally narrow: only the frontmatter `file`
// scalar is changed. Markdown body embeds are left untouched because the
// current runtime contract derives card kind from body presence.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Context;
use mine_lib::domain::block::{canonical_attachment_wikilink, normalize_attachment_reference};
use mine_lib::util::now_iso8601;

fn usage() {
    eprintln!(
        "usage: migrate-primary-file-to-wikilinks [--dry-run | --apply] <vault-path>\n\n\
         --dry-run   show what would change (default)\n\
         --apply     rewrite affected .md files and create backups\n"
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
                report.scanned,
                report.changes.len(),
                report.unchanged
            );
            if let Some(path) = report.backup_root {
                println!("backup: {}", path.display());
            } else if !apply && !report.changes.is_empty() {
                println!("(dry run - no files were modified; re-run with --apply to commit)");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("migration failed: {e:#}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileChange {
    path: PathBuf,
    rewritten: String,
    from: String,
    to: String,
}

#[derive(Debug, Default)]
struct Report {
    scanned: usize,
    changes: Vec<FileChange>,
    unchanged: usize,
    backup_root: Option<PathBuf>,
}

fn run(vault_path: &Path, apply: bool) -> anyhow::Result<Report> {
    let files = read_markdown_files(vault_path)?;
    let mut changes = Vec::new();
    let mut unchanged = 0usize;

    for path in files {
        let original = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        match plan_file_change(&original) {
            Some((rewritten, from, to)) => {
                println!("~ {}: {} -> {}", path.display(), from, to);
                changes.push(FileChange {
                    path,
                    rewritten,
                    from,
                    to,
                });
            }
            None => unchanged += 1,
        }
    }

    let mut report = Report {
        scanned: changes.len() + unchanged,
        changes,
        unchanged,
        backup_root: None,
    };

    if apply && !report.changes.is_empty() {
        let backup_root = vault_path
            .join(".mine-migration-backup")
            .join(now_iso8601().replace([':', '/'], "-"));
        std::fs::create_dir_all(&backup_root)?;

        for change in &report.changes {
            backup_file(vault_path, &backup_root, &change.path)?;
            std::fs::write(&change.path, &change.rewritten)
                .with_context(|| format!("failed to write {}", change.path.display()))?;
        }

        report.backup_root = Some(backup_root);
    }

    Ok(report)
}

fn read_markdown_files(vault_path: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_markdown_files(vault_path, vault_path, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_markdown_files(
    vault_path: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
) -> anyhow::Result<()> {
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("failed to read {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if path.is_dir() {
            if should_skip_dir(vault_path, &path, name) {
                continue;
            }
            collect_markdown_files(vault_path, &path, files)?;
            continue;
        }

        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        files.push(path);
    }
    Ok(())
}

fn should_skip_dir(vault_path: &Path, path: &Path, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    path == vault_path.join(".mine-migration-backup")
        || path == vault_path.join(".arena")
        || path == vault_path.join(".git")
}

fn plan_file_change(content: &str) -> Option<(String, String, String)> {
    let (frontmatter, body) = split_frontmatter(content)?;
    let file_line = find_file_line(frontmatter)?;
    let current = parse_file_line_value(file_line)?;
    let target = normalize_attachment_reference(&current)?;
    let canonical = canonical_attachment_wikilink(&target);

    if current.trim() == canonical {
        return None;
    }

    let patched_frontmatter = patch_file_line(frontmatter, &canonical)?;
    let rewritten = format!("---\n{patched_frontmatter}---\n{body}");
    Some((rewritten, current, canonical))
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    if !content.starts_with("---\n") {
        return None;
    }
    let after_open = &content[4..];
    let close_rel = after_open.find("\n---\n")?;
    let frontmatter = &after_open[..close_rel + 1];
    let body_start = 4 + close_rel + 5;
    let body = if body_start <= content.len() {
        &content[body_start..]
    } else {
        ""
    };
    Some((frontmatter, body))
}

fn find_file_line(frontmatter: &str) -> Option<&str> {
    frontmatter.lines().find(|line| {
        let trimmed = line.trim_start();
        line.len() == trimmed.len() && trimmed.starts_with("file:")
    })
}

fn parse_file_line_value(line: &str) -> Option<String> {
    let raw = line.strip_prefix("file:")?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(value) = serde_yaml::from_str::<String>(raw) {
        return Some(value);
    }
    Some(unquote_simple(raw).to_string())
}

fn unquote_simple(raw: &str) -> &str {
    raw.strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            raw.strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(raw)
}

fn patch_file_line(frontmatter: &str, canonical: &str) -> Option<String> {
    let mut out = String::with_capacity(frontmatter.len() + canonical.len() + 4);
    let mut patched = false;

    for segment in frontmatter.split_inclusive('\n') {
        let line = segment.trim_end_matches('\n');
        let newline = if segment.ends_with('\n') { "\n" } else { "" };
        let trimmed = line.trim_start();

        if !patched && line.len() == trimmed.len() && trimmed.starts_with("file:") {
            out.push_str("file: ");
            out.push_str(&yaml_double_quote(canonical));
            out.push_str(newline);
            patched = true;
        } else {
            out.push_str(segment);
        }
    }

    patched.then_some(out)
}

fn yaml_double_quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn backup_file(vault_path: &Path, backup_root: &Path, path: &Path) -> anyhow::Result<()> {
    let rel = path.strip_prefix(vault_path).with_context(|| {
        format!(
            "failed to compute backup relative path for {}",
            path.display()
        )
    })?;
    let backup_path = backup_root.join(rel);
    if let Some(parent) = backup_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(path, &backup_path).with_context(|| {
        format!(
            "failed to back up {} to {}",
            path.display(),
            backup_path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_rewrites_raw_file_only() {
        let content = "---\ntype: image\nfile: photo.png\nsaved_at: 2026-01-01T00:00:00Z\n---\n";
        let (rewritten, from, to) = plan_file_change(content).unwrap();
        assert_eq!(from, "photo.png");
        assert_eq!(to, "[[photo.png]]");
        assert!(rewritten.contains("file: \"[[photo.png]]\""));
        assert!(rewritten.ends_with("---\n"));
    }

    #[test]
    fn plan_leaves_body_embeds_untouched() {
        let content = "---\ntype: image\nfile: photo.png\nsaved_at: 2026-01-01T00:00:00Z\n---\n![[photo.png]]";
        let (rewritten, _, _) = plan_file_change(content).unwrap();
        assert!(rewritten.ends_with("---\n![[photo.png]]"));
    }

    #[test]
    fn plan_is_idempotent_for_canonical_file() {
        let content =
            "---\ntype: image\nfile: \"[[photo.png]]\"\nsaved_at: 2026-01-01T00:00:00Z\n---\n";
        assert!(plan_file_change(content).is_none());
    }

    #[test]
    fn plan_normalizes_bang_wikilink_to_plain_wikilink() {
        let content =
            "---\ntype: image\nfile: \"![[photo.png]]\"\nsaved_at: 2026-01-01T00:00:00Z\n---\n";
        let (rewritten, _, to) = plan_file_change(content).unwrap();
        assert_eq!(to, "[[photo.png]]");
        assert!(rewritten.contains("file: \"[[photo.png]]\""));
    }

    #[test]
    fn split_rejects_body_without_frontmatter() {
        assert!(split_frontmatter("body only").is_none());
    }

    #[test]
    fn yaml_double_quote_escapes_backslash_and_quote() {
        assert_eq!(
            yaml_double_quote("[[a\\\"b.png]]"),
            "\"[[a\\\\\\\"b.png]]\""
        );
    }
}
