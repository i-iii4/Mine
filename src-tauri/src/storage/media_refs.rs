// Media reference resolution for Markdown and Obsidian inline embeds.
//
// Standard Markdown image paths are resolved relative to the containing note.
// Obsidian embeds additionally support basename lookup through the vault.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::domain::block::{InlineMediaReference, InlineMediaSyntax};
use crate::domain::vault::VaultLayout;

/// Cached resolver for bulk index migrations.
///
/// Single-block indexing can use the stateless helpers below. Backfills may
/// resolve hundreds of Obsidian basename embeds, so this resolver builds the
/// vault basename index lazily once and reuses it for every row in the pass.
pub struct MediaResolver<'a> {
    vault: &'a VaultLayout,
    basename_index: Option<HashMap<String, Vec<PathBuf>>>,
}

impl<'a> MediaResolver<'a> {
    pub fn new(vault: &'a VaultLayout) -> Self {
        Self {
            vault,
            basename_index: None,
        }
    }

    pub fn resolve_inline_media(
        &mut self,
        block_slug: &str,
        reference: &InlineMediaReference,
    ) -> Option<PathBuf> {
        match reference.syntax {
            InlineMediaSyntax::MarkdownImage => {
                resolve_frontmatter_media(self.vault, block_slug, &reference.source)
            }
            InlineMediaSyntax::ObsidianEmbed => {
                self.resolve_obsidian_embed(block_slug, &reference.source)
            }
        }
    }

    pub fn resolve_inline_media_root_relative(
        &mut self,
        block_slug: &str,
        reference: &InlineMediaReference,
    ) -> Option<String> {
        self.resolve_inline_media(block_slug, reference)
            .and_then(|path| self.vault.root_relative_reference(&path))
    }

    fn resolve_obsidian_embed(&mut self, block_slug: &str, reference: &str) -> Option<PathBuf> {
        if reference.is_empty()
            || reference.starts_with("http://")
            || reference.starts_with("https://")
            || reference.contains('\0')
        {
            return None;
        }

        if let Some(path) = resolve_frontmatter_media(self.vault, block_slug, reference) {
            return Some(path);
        }

        if has_path_separator(reference) {
            return resolve_root_relative(self.vault, reference);
        }

        self.resolve_by_basename(block_slug, reference)
    }

    fn resolve_by_basename(&mut self, block_slug: &str, file_name: &str) -> Option<PathBuf> {
        let block_path = self.vault.block_path(block_slug);
        let block_parent = block_path.parent().unwrap_or(self.vault.root());
        let mut candidates = self.basename_index().get(file_name)?.clone();
        candidates.sort_by(|a, b| {
            let a_key = candidate_rank(self.vault.root(), block_parent, a);
            let b_key = candidate_rank(self.vault.root(), block_parent, b);
            a_key.cmp(&b_key)
        });
        candidates.into_iter().next()
    }

    fn basename_index(&mut self) -> &HashMap<String, Vec<PathBuf>> {
        self.basename_index.get_or_insert_with(|| {
            let mut index = HashMap::new();
            collect_all_basename_matches(self.vault.root(), &mut index);
            index
        })
    }
}

/// Find the document of a collection, wherever it sits in the vault.
///
/// A collection is referred to by name (`[[Каталоги]]`), while its document is
/// a file that may live in any folder. Commands that open, rename or delete a
/// collection used to assume the vault root; once collections moved into their
/// own folder that assumption stopped holding.
///
/// Returns `None` when no such document exists — the caller decides whether
/// that is an error or an invitation to create one.
pub fn resolve_collection_document(vault: &VaultLayout, collection_ref: &str) -> Option<PathBuf> {
    let direct = vault.block_path(collection_ref);
    if direct.exists() {
        return Some(direct);
    }
    if has_path_separator(collection_ref) {
        return None;
    }
    let file_name = format!("{collection_ref}.md");
    let mut candidates = Vec::new();
    collect_basename_matches(vault.root(), &file_name, &mut candidates);
    candidates.sort_by(|a, b| {
        let a_key = candidate_rank(vault.root(), vault.root(), a);
        let b_key = candidate_rank(vault.root(), vault.root(), b);
        a_key.cmp(&b_key)
    });
    candidates.into_iter().next()
}

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
        // Last resort, and the one that survives a reorganised vault: find the
        // file by name anywhere inside it, nearest folder first. `file:` in
        // frontmatter is written as `"[[name.ext]]"` — a name, not a path — so
        // once notes and media live in different folders, resolving it only
        // against the note's own folder finds nothing. Inline embeds already
        // fall back this way; indexed references had no such fallback, and a
        // vault sorted into Cards/ and Media/ lost every frontmatter medium.
        .or_else(|| {
            (!has_path_separator(reference))
                .then(|| resolve_by_basename(vault, block_slug, reference))
                .flatten()
        })
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

fn collect_all_basename_matches(dir: &Path, index: &mut HashMap<String, Vec<PathBuf>>) {
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
            collect_all_basename_matches(&path, index);
            continue;
        }
        if file_type.is_file() {
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                index.entry(name.to_string()).or_default().push(path);
            }
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
    fn collection_document_is_found_in_its_folder() {
        // Commands that open, rename or delete a collection used to assume the
        // vault root. A sorted vault keeps collections elsewhere, and the name
        // in `[[Каталоги]]` says nothing about where.
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Collections")).unwrap();
        let doc = dir.path().join("Collections/Каталоги.md");
        std::fs::write(&doc, "---\ntype: channel\n---\n").unwrap();

        assert_eq!(resolve_collection_document(&vault, "Каталоги"), Some(doc));
        assert_eq!(resolve_collection_document(&vault, "Нет такой"), None);
    }

    #[test]
    fn collection_document_in_a_flat_vault_is_still_found() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        let doc = dir.path().join("Каталоги.md");
        std::fs::write(&doc, "---\ntype: channel\n---\n").unwrap();

        assert_eq!(resolve_collection_document(&vault, "Каталоги"), Some(doc));
    }

    #[test]
    fn indexed_media_finds_a_frontmatter_file_that_moved_to_another_folder() {
        // The layout this exists for: notes in Cards/, media in Media/, and
        // `file: "[[photo.jpg]]"` naming the file without a path. Resolving that
        // only against the note's folder finds nothing, and every card with a
        // frontmatter medium loses its preview.
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        std::fs::create_dir_all(dir.path().join("Media")).unwrap();
        std::fs::write(dir.path().join("Cards/note.md"), "").unwrap();
        let image = dir.path().join("Media/photo.jpg");
        std::fs::write(&image, b"img").unwrap();

        assert_eq!(
            resolve_indexed_media(&vault, "Cards/note", "photo.jpg"),
            Some(image),
        );
    }

    #[test]
    fn indexed_media_keeps_preferring_an_explicit_path() {
        // A reference that states a path means that path; the basename search
        // is a fallback, not an override.
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        std::fs::create_dir_all(dir.path().join("Media")).unwrap();
        std::fs::write(dir.path().join("Cards/note.md"), "").unwrap();
        let stated = dir.path().join("Media/photo.jpg");
        std::fs::write(&stated, b"img").unwrap();
        std::fs::write(dir.path().join("Cards/photo.jpg"), b"other").unwrap();

        assert_eq!(
            resolve_indexed_media(&vault, "Cards/note", "Media/photo.jpg"),
            Some(stated),
        );
    }

    #[test]
    fn indexed_media_still_reports_a_missing_file_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Cards")).unwrap();
        std::fs::write(dir.path().join("Cards/note.md"), "").unwrap();

        assert_eq!(resolve_indexed_media(&vault, "Cards/note", "gone.jpg"), None);
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

    #[test]
    fn cached_resolver_finds_attachment_by_basename() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Журнал")).unwrap();
        std::fs::create_dir_all(dir.path().join("Медиафайлы")).unwrap();
        std::fs::write(dir.path().join("Журнал/04.12.2025.md"), "").unwrap();
        let image = dir
            .path()
            .join("Медиафайлы/telegram-cloud-photo-size-2-5298783204590424341-x.jpg");
        std::fs::write(&image, b"img").unwrap();

        let mut resolver = MediaResolver::new(&vault);
        let got = resolver.resolve_inline_media(
            "Журнал/04.12.2025",
            &reference(
                "telegram-cloud-photo-size-2-5298783204590424341-x.jpg",
                InlineMediaSyntax::ObsidianEmbed,
            ),
        );

        assert_eq!(got, Some(image));
    }
}
