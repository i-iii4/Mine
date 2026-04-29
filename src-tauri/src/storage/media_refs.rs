// Media reference resolution for Markdown and Obsidian inline embeds.
//
// Standard Markdown image paths are resolved relative to the containing note.
// Obsidian embeds additionally support basename lookup through the vault.

use std::cmp::Reverse;
use std::path::{Component, Path, PathBuf};

use crate::domain::block::{InlineMediaReference, InlineMediaSyntax};
use crate::domain::vault::VaultLayout;

/// Resolve a frontmatter media field as a normal local path.
pub fn resolve_frontmatter_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    let path = vault.resolve_local_reference(block_slug, reference)?;
    path.exists().then_some(path)
}

/// Resolve a media path that already came from the SQLite index.
///
/// Indexed media paths are normalized to vault-root-relative when possible,
/// but legacy rows may still contain note-relative values.
pub fn resolve_indexed_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    resolve_root_relative(vault, reference)
        .or_else(|| resolve_frontmatter_media(vault, block_slug, reference))
}

/// Resolve an inline media reference using syntax-specific rules.
pub fn resolve_inline_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &InlineMediaReference,
) -> Option<PathBuf> {
    match reference.syntax {
        InlineMediaSyntax::MarkdownImage => {
            resolve_frontmatter_media(vault, block_slug, &reference.source)
        }
        InlineMediaSyntax::ObsidianEmbed => {
            resolve_obsidian_embed(vault, block_slug, &reference.source)
        }
    }
}

/// Resolve and render an inline media reference as vault-root-relative.
pub fn resolve_inline_media_root_relative(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &InlineMediaReference,
) -> Option<String> {
    resolve_inline_media(vault, block_slug, reference)
        .and_then(|path| vault.root_relative_reference(&path))
}

fn resolve_obsidian_embed(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    if reference.is_empty()
        || reference.starts_with("http://")
        || reference.starts_with("https://")
        || reference.contains('\0')
    {
        return None;
    }

    if let Some(path) = resolve_frontmatter_media(vault, block_slug, reference) {
        return Some(path);
    }

    if has_path_separator(reference) {
        return resolve_root_relative(vault, reference);
    }

    resolve_by_basename(vault, block_slug, reference)
}

fn resolve_root_relative(vault: &VaultLayout, reference: &str) -> Option<PathBuf> {
    let reference_path = Path::new(reference);
    if reference_path.is_absolute() {
        return None;
    }
    let resolved = normalize_join(vault.root(), reference_path)?;
    if !resolved.starts_with(vault.root()) || !resolved.exists() {
        return None;
    }
    Some(resolved)
}

fn resolve_by_basename(vault: &VaultLayout, block_slug: &str, file_name: &str) -> Option<PathBuf> {
    let block_path = vault.block_path(block_slug);
    let block_parent = block_path.parent().unwrap_or(vault.root());
    let mut candidates = Vec::new();
    collect_basename_matches(vault.root(), file_name, &mut candidates);
    candidates.sort_by(|a, b| {
        let a_key = candidate_rank(vault.root(), block_parent, a);
        let b_key = candidate_rank(vault.root(), block_parent, b);
        a_key.cmp(&b_key)
    });
    candidates.into_iter().next()
}

fn collect_basename_matches(dir: &Path, file_name: &str, candidates: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if is_ignored_media_search_dir(&path) {
                continue;
            }
            collect_basename_matches(&path, file_name, candidates);
            continue;
        }
        if file_type.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == file_name)
        {
            candidates.push(path);
        }
    }
}

fn candidate_rank(
    root: &Path,
    block_parent: &Path,
    candidate: &Path,
) -> (Reverse<usize>, usize, String) {
    let candidate_parent = candidate.parent().unwrap_or(root);
    let common = common_prefix_len(block_parent, candidate_parent);
    let depth = candidate
        .strip_prefix(root)
        .ok()
        .map(component_count)
        .unwrap_or(usize::MAX);
    (
        Reverse(common),
        depth,
        candidate.to_string_lossy().into_owned(),
    )
}

fn common_prefix_len(a: &Path, b: &Path) -> usize {
    a.components()
        .zip(b.components())
        .take_while(|(left, right)| left == right)
        .count()
}

fn component_count(path: &Path) -> usize {
    path.components().count()
}

fn has_path_separator(reference: &str) -> bool {
    reference.contains('/') || reference.contains('\\')
}

fn is_ignored_media_search_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with('.') || matches!(name, "node_modules" | "target" | "__pycache__")
        })
}

fn normalize_join(base: &Path, relative: &Path) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::block::{InlineMediaReference, InlineMediaSyntax};

    fn reference(source: &str, syntax: InlineMediaSyntax) -> InlineMediaReference {
        InlineMediaReference {
            source: source.to_string(),
            syntax,
        }
    }

    #[test]
    fn markdown_image_stays_relative_to_note() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Notes")).unwrap();
        std::fs::create_dir_all(dir.path().join("Images")).unwrap();
        std::fs::write(dir.path().join("Notes/Note.md"), "").unwrap();
        std::fs::write(dir.path().join("Images/photo.jpg"), b"img").unwrap();

        let got = resolve_inline_media(
            &vault,
            "Notes/Note",
            &reference("photo.jpg", InlineMediaSyntax::MarkdownImage),
        );

        assert!(got.is_none());
    }

    #[test]
    fn obsidian_embed_finds_attachment_by_basename_in_subfolders() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Библиотека/images/images")).unwrap();
        std::fs::write(dir.path().join("Библиотека/Азбука.md"), "").unwrap();
        let image = dir.path().join("Библиотека/images/images/01.jpg");
        std::fs::write(&image, b"img").unwrap();

        let got = resolve_inline_media(
            &vault,
            "Библиотека/Азбука",
            &reference("01.jpg", InlineMediaSyntax::ObsidianEmbed),
        );

        assert_eq!(got, Some(image));
    }

    #[test]
    fn obsidian_embed_with_path_uses_explicit_path() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Библиотека/images")).unwrap();
        std::fs::write(dir.path().join("Библиотека/Азбука.md"), "").unwrap();
        let image = dir.path().join("Библиотека/images/01.jpg");
        std::fs::write(&image, b"img").unwrap();

        let got = resolve_inline_media(
            &vault,
            "Библиотека/Азбука",
            &reference("images/01.jpg", InlineMediaSyntax::ObsidianEmbed),
        );

        assert_eq!(got, Some(image));
    }

    #[test]
    fn obsidian_embed_ignores_trash_and_service_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join(".trash")).unwrap();
        std::fs::write(dir.path().join("Note.md"), "").unwrap();
        std::fs::write(dir.path().join(".trash/01.jpg"), b"img").unwrap();

        let got = resolve_inline_media(
            &vault,
            "Note",
            &reference("01.jpg", InlineMediaSyntax::ObsidianEmbed),
        );

        assert!(got.is_none());
    }

    #[test]
    fn obsidian_embed_prefers_nearest_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("A/media")).unwrap();
        std::fs::create_dir_all(dir.path().join("B")).unwrap();
        std::fs::write(dir.path().join("A/Note.md"), "").unwrap();
        let nearby = dir.path().join("A/media/photo.jpg");
        std::fs::write(&nearby, b"near").unwrap();
        std::fs::write(dir.path().join("B/photo.jpg"), b"far").unwrap();

        let got = resolve_inline_media(
            &vault,
            "A/Note",
            &reference("photo.jpg", InlineMediaSyntax::ObsidianEmbed),
        );

        assert_eq!(got, Some(nearby));
    }
}
