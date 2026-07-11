// migrate-collections-to-wikilinks
//
// One-time migration from legacy Mine collection encodings to the
// Obsidian-first collection contract:
//
//   Mine Collections:
//     - "[[Красивый веб]]"
//
// Usage:
//   migrate-collections-to-wikilinks --dry-run <vault>
//   migrate-collections-to-wikilinks --apply   <vault>

use std::collections::{BTreeSet, HashMap};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{anyhow, Context};
use mine_lib::domain::collection::{
    collection_ref_from_canonical_value, normalize_collection_ref, patch_collections_frontmatter,
    MINE_COLLECTIONS_FIELD,
};
use mine_lib::domain::tag::normalize_tag;
use mine_lib::storage::files;
use mine_lib::util::now_iso8601;
use serde_yaml::Value;

fn usage() {
    eprintln!(
        "usage: migrate-collections-to-wikilinks [--dry-run | --apply] <vault-path>\n\n\
         --dry-run   show what would change (default)\n\
         --apply     rewrite affected .md files and rename safe collection pages\n"
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
                "\n{} .md files scanned, {} files would be patched, {} collection pages would be renamed.",
                report.scanned,
                report.file_changes.len(),
                report.renames.len()
            );
            if let Some(path) = report.backup_root {
                println!("backup: {}", path.display());
            } else if !apply && (!report.file_changes.is_empty() || !report.renames.is_empty()) {
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

#[derive(Debug, Clone)]
struct MdFile {
    path: PathBuf,
    stem: String,
    content: String,
    yaml: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileChange {
    path: PathBuf,
    rewritten: String,
    collections: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenameChange {
    from: PathBuf,
    to: PathBuf,
    collection_ref: String,
}

#[derive(Debug, Default)]
struct Report {
    scanned: usize,
    file_changes: Vec<FileChange>,
    renames: Vec<RenameChange>,
    backup_root: Option<PathBuf>,
}

fn run(vault_path: &Path, apply: bool) -> anyhow::Result<Report> {
    let files = read_root_markdown_files(vault_path)?;
    let mut conflicts = Vec::new();
    let collection_map = build_collection_map(&files, &mut conflicts);
    let renames = plan_collection_renames(vault_path, &files, &collection_map, &mut conflicts);
    let file_changes = plan_file_changes(&files, &collection_map)?;

    if !conflicts.is_empty() {
        return Err(anyhow!("conflicts:\n{}", conflicts.join("\n")));
    }

    for change in &file_changes {
        println!(
            "~ {} ({})",
            change.path.display(),
            change.collections.join(", ")
        );
    }
    for rename in &renames {
        println!("R {} -> {}", rename.from.display(), rename.to.display());
    }

    let mut report = Report {
        scanned: files.len(),
        file_changes,
        renames,
        backup_root: None,
    };

    if apply && (!report.file_changes.is_empty() || !report.renames.is_empty()) {
        let backup_root = vault_path
            .join(".mine-migration-backup")
            .join(now_iso8601().replace([':', '/'], "-"));
        std::fs::create_dir_all(&backup_root)?;

        for change in &report.file_changes {
            backup_file(vault_path, &backup_root, &change.path)?;
            files::write_atomically(&change.path, change.rewritten.as_bytes())
                .with_context(|| format!("failed to write {}", change.path.display()))?;
        }

        for rename in &report.renames {
            backup_file(vault_path, &backup_root, &rename.from)?;
            if let Some(parent) = rename.to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            rename_file_safely(&rename.from, &rename.to)?;
        }

        report.backup_root = Some(backup_root);
    }

    Ok(report)
}

fn read_root_markdown_files(vault_path: &Path) -> anyhow::Result<Vec<MdFile>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(vault_path)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.'))
        {
            continue;
        }
        let Some(stem) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let yaml = split_frontmatter(&content)
            .and_then(|frontmatter| serde_yaml::from_str::<Value>(frontmatter).ok());
        files.push(MdFile {
            path,
            stem,
            content,
            yaml,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn build_collection_map(files: &[MdFile], conflicts: &mut Vec<String>) -> HashMap<String, String> {
    let mut map = HashMap::new();

    for file in files {
        let Some(yaml) = &file.yaml else {
            continue;
        };
        if yaml_type(yaml).as_deref() != Some("channel") {
            continue;
        }
        let target = yaml_string(yaml, "title")
            .map(|title| normalize_collection_ref(&title))
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| humanize_legacy_ref(&file.stem));

        insert_mapping(&mut map, &file.stem, &target, conflicts);
        let normalized_stem = normalize_tag(&file.stem);
        insert_mapping(&mut map, &normalized_stem, &target, conflicts);
        let normalized_target = normalize_tag(&target);
        insert_mapping(&mut map, &normalized_target, &target, conflicts);
        insert_mapping(&mut map, &target, &target, conflicts);
    }

    map
}

fn insert_mapping(
    map: &mut HashMap<String, String>,
    key: &str,
    target: &str,
    conflicts: &mut Vec<String>,
) {
    let key = normalize_collection_ref(key);
    let target = normalize_collection_ref(target);
    if key.is_empty() || target.is_empty() {
        return;
    }
    if let Some(existing) = map.get(&key) {
        if existing != &target {
            conflicts.push(format!(
                "ambiguous collection mapping: '{}' -> '{}' and '{}'",
                key, existing, target
            ));
        }
        return;
    }
    map.insert(key, target);
}

fn plan_collection_renames(
    vault_path: &Path,
    files: &[MdFile],
    collection_map: &HashMap<String, String>,
    conflicts: &mut Vec<String>,
) -> Vec<RenameChange> {
    let mut renames = Vec::new();

    for file in files {
        let Some(yaml) = &file.yaml else {
            continue;
        };
        if yaml_type(yaml).as_deref() != Some("channel") {
            continue;
        }
        let Some(collection_ref) = collection_map.get(&file.stem).cloned() else {
            continue;
        };
        if collection_ref == file.stem {
            continue;
        }
        if collection_ref.contains('/') || collection_ref.contains('\\') {
            conflicts.push(format!(
                "collection page '{}' maps to nested target '{}'; this migration only renames root pages",
                file.path.display(),
                collection_ref
            ));
            continue;
        }

        let target = vault_path.join(format!("{collection_ref}.md"));
        if target == file.path {
            continue;
        }
        if target.exists() && !is_same_file(&file.path, &target) {
            conflicts.push(format!(
                "cannot rename '{}' to '{}': target exists",
                file.path.display(),
                target.display()
            ));
            continue;
        }
        renames.push(RenameChange {
            from: file.path.clone(),
            to: target,
            collection_ref,
        });
    }

    renames
}

fn plan_file_changes(
    files: &[MdFile],
    collection_map: &HashMap<String, String>,
) -> anyhow::Result<Vec<FileChange>> {
    let mut changes = Vec::new();

    for file in files {
        let Some(yaml) = &file.yaml else {
            continue;
        };
        if yaml_type(yaml).as_deref() == Some("channel") {
            continue;
        }
        let mine_authored = is_mine_authored_block(yaml);
        let collections = extract_collections(yaml, collection_map, mine_authored);
        if collections.is_empty() && !yaml_has_key(yaml, MINE_COLLECTIONS_FIELD) {
            continue;
        }

        let rewritten = patch_collections_frontmatter(&file.content, &collections)
            .map_err(|e| anyhow!("{}: {e}", file.path.display()))?;
        if rewritten == file.content {
            continue;
        }
        changes.push(FileChange {
            path: file.path.clone(),
            rewritten,
            collections,
        });
    }

    Ok(changes)
}

fn extract_collections(
    yaml: &Value,
    collection_map: &HashMap<String, String>,
    allow_legacy_tags: bool,
) -> Vec<String> {
    let raw_values = if let Some(value) = yaml.get(MINE_COLLECTIONS_FIELD) {
        yaml_string_values(value)
    } else if allow_legacy_tags {
        yaml.get("tags")
            .map(yaml_legacy_tag_values)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut seen = BTreeSet::new();
    let mut collections = Vec::new();
    for raw in raw_values {
        let Some(collection_ref) = resolve_collection_ref(&raw, collection_map) else {
            continue;
        };
        if seen.insert(collection_ref.clone()) {
            collections.push(collection_ref);
        }
    }
    collections
}

fn resolve_collection_ref(raw: &str, collection_map: &HashMap<String, String>) -> Option<String> {
    if let Some(canonical) = collection_ref_from_canonical_value(raw) {
        return Some(canonical);
    }

    let raw = normalize_collection_ref(raw);
    if raw.is_empty() {
        return None;
    }
    if let Some(mapped) = collection_map.get(&raw) {
        return Some(mapped.clone());
    }

    let normalized = normalize_tag(&raw);
    if let Some(mapped) = collection_map.get(&normalized) {
        return Some(mapped.clone());
    }

    Some(humanize_legacy_ref(&raw))
}

fn is_mine_authored_block(yaml: &Value) -> bool {
    matches!(
        yaml_type(yaml).as_deref(),
        Some("article" | "image" | "link" | "social" | "video")
    ) && yaml_has_key(yaml, "saved_at")
}

fn yaml_type(yaml: &Value) -> Option<String> {
    yaml_string(yaml, "type").map(|value| value.trim().to_string())
}

fn yaml_has_key(yaml: &Value, key: &str) -> bool {
    yaml.get(key).is_some()
}

fn yaml_string(yaml: &Value, key: &str) -> Option<String> {
    yaml.get(key).and_then(yaml_value_to_string)
}

fn yaml_string_values(value: &Value) -> Vec<String> {
    match value {
        Value::Sequence(seq) => seq.iter().filter_map(yaml_value_to_string).collect(),
        other => yaml_value_to_string(other).into_iter().collect(),
    }
}

fn yaml_legacy_tag_values(value: &Value) -> Vec<String> {
    match value {
        Value::Sequence(seq) => seq.iter().filter_map(yaml_value_to_string).collect(),
        Value::String(value) => value
            .split_whitespace()
            .map(|part| part.trim_start_matches('#').to_string())
            .filter(|part| !part.is_empty())
            .collect(),
        other => yaml_value_to_string(other).into_iter().collect(),
    }
}

fn yaml_value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Tagged(tagged) => yaml_value_to_string(&tagged.value),
        _ => None,
    }
}

fn humanize_legacy_ref(raw: &str) -> String {
    normalize_collection_ref(raw)
        .split('/')
        .map(|segment| {
            let spaced = segment
                .replace(['-', '_'], " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            capitalize_first(&spaced)
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn capitalize_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn split_frontmatter(content: &str) -> Option<&str> {
    if !content.starts_with("---\n") {
        return None;
    }
    let after_open = &content[4..];
    let close_rel = after_open.find("\n---\n")?;
    Some(&after_open[..close_rel + 1])
}

fn backup_file(vault_path: &Path, backup_root: &Path, path: &Path) -> anyhow::Result<()> {
    let relative = path.strip_prefix(vault_path).unwrap_or(path);
    let target = backup_root.join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(path, &target).with_context(|| {
        format!(
            "failed to backup {} to {}",
            path.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn rename_file_safely(from: &Path, to: &Path) -> anyhow::Result<()> {
    if to.exists() && is_same_file(from, to) {
        let parent = from
            .parent()
            .ok_or_else(|| anyhow!("cannot rename path without parent: {}", from.display()))?;
        let file_name = from
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("collection.md");
        let mut temp = None;
        for attempt in 0..1000 {
            let candidate = parent.join(format!(
                ".mine-case-rename-{}-{attempt}-{file_name}",
                std::process::id()
            ));
            if !candidate.exists() {
                temp = Some(candidate);
                break;
            }
        }
        let temp = temp.ok_or_else(|| {
            anyhow!(
                "failed to allocate temporary rename path near {}",
                from.display()
            )
        })?;
        std::fs::rename(from, &temp).with_context(|| {
            format!(
                "failed to move {} to temporary {}",
                from.display(),
                temp.display()
            )
        })?;
        return std::fs::rename(&temp, to).with_context(|| {
            format!(
                "failed to move temporary {} to {}",
                temp.display(),
                to.display()
            )
        });
    }

    std::fs::rename(from, to)
        .with_context(|| format!("failed to rename {} to {}", from.display(), to.display()))
}

#[cfg(unix)]
fn is_same_file(left: &Path, right: &Path) -> bool {
    let Ok(left_meta) = std::fs::metadata(left) else {
        return false;
    };
    let Ok(right_meta) = std::fs::metadata(right) else {
        return false;
    };
    left_meta.dev() == right_meta.dev() && left_meta.ino() == right_meta.ino()
}

#[cfg(not(unix))]
fn is_same_file(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_yaml(input: &str) -> Value {
        serde_yaml::from_str(input).unwrap()
    }

    #[test]
    fn resolve_legacy_ref_uses_channel_title_mapping() {
        let mut map = HashMap::new();
        insert_mapping(&mut map, "красивый-веб", "Красивый веб", &mut Vec::new());

        assert_eq!(
            resolve_collection_ref("красивый-веб", &map),
            Some("Красивый веб".to_string())
        );
    }

    #[test]
    fn extract_collections_reads_canonical_wikilinks() {
        let yaml = parse_yaml("type: article\nsaved_at: 2026-04-29T00:00:00Z\nMine Collections:\n  - \"[[Красивый веб]]\"\n  - \"[[Research|Board]]\"");
        assert_eq!(
            extract_collections(&yaml, &HashMap::new(), true),
            vec!["Красивый веб".to_string(), "Research".to_string()]
        );
    }

    #[test]
    fn extract_collections_reads_legacy_tags_only_for_mine_blocks() {
        let yaml =
            parse_yaml("type: image\nsaved_at: 2026-04-29T00:00:00Z\ntags:\n  - красивый-веб");
        let mut map = HashMap::new();
        insert_mapping(&mut map, "красивый-веб", "Красивый веб", &mut Vec::new());

        assert_eq!(
            extract_collections(&yaml, &map, is_mine_authored_block(&yaml)),
            vec!["Красивый веб".to_string()]
        );

        let foreign = parse_yaml("tags:\n  - personal");
        assert!(extract_collections(&foreign, &map, is_mine_authored_block(&foreign)).is_empty());
    }

    #[test]
    fn patch_preserves_obsidian_tags_and_adds_mine_collections() {
        let content =
            "---\ntype: image\nsaved_at: 2026-04-29T00:00:00Z\ntags:\n  - красивый-веб\n---\nBody";
        let yaml =
            parse_yaml("type: image\nsaved_at: 2026-04-29T00:00:00Z\ntags:\n  - красивый-веб");
        let mut map = HashMap::new();
        insert_mapping(&mut map, "красивый-веб", "Красивый веб", &mut Vec::new());
        let collections = extract_collections(&yaml, &map, true);

        let rewritten = patch_collections_frontmatter(content, &collections).unwrap();
        assert!(rewritten.contains("tags:\n  - красивый-веб\n"));
        assert!(rewritten.contains("Mine Collections:\n  - \"[[Красивый веб]]\""));
    }
}
