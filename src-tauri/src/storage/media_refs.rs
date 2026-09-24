// Media reference resolution for Markdown and Obsidian inline embeds.
//
// Standard Markdown image paths are resolved relative to the containing note.
// Obsidian embeds additionally support basename lookup through the vault.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
#[error("ambiguous media reference: {0}")]
pub struct AmbiguousMediaReference(pub String);

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
                resolve_markdown_media(self.vault, block_slug, &reference.source)
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

        if let Some(path) = resolve_wikilink_media(self.vault, block_slug, reference) {
            return Some(path);
        }

        if has_path_separator(reference) {
            return resolve_root_relative(self.vault, reference);
        }

        self.resolve_by_basename(block_slug, reference)
    }

    fn resolve_by_basename(&mut self, block_slug: &str, file_name: &str) -> Option<PathBuf> {
        let _ = block_slug;
        match self.basename_index().get(file_name).map(Vec::as_slice) {
            Some([only]) => Some(only.clone()),
            _ => None,
        }
    }

    fn basename_index(&mut self) -> &HashMap<String, Vec<PathBuf>> {
        self.basename_index.get_or_insert_with(|| {
            let mut index = HashMap::new();
            collect_all_basename_matches(self.vault.root(), &mut index);
            index
        })
    }

    /// Destructive actions may resolve a short name only when it is unique.
    pub fn unique_basename(
        &mut self,
        file_name: &str,
    ) -> Result<Option<PathBuf>, AmbiguousMediaReference> {
        match self.basename_index().get(file_name).map(Vec::as_slice) {
            None | Some([]) => Ok(None),
            Some([path]) => Ok(Some(path.clone())),
            Some(_) => Err(AmbiguousMediaReference(file_name.into())),
        }
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
    (candidates.len() == 1)
        .then(|| candidates.into_iter().next())
        .flatten()
}

/// Enumerate every matching path for destructive collection operations.
/// Unlike best-effort display lookup, an incomplete directory read is an error.
/// Callers must check document type before deleting a matching filename.
pub fn collection_document_candidates(
    vault: &VaultLayout,
    collection_ref: &str,
) -> std::io::Result<Vec<PathBuf>> {
    fn collect(dir: &Path, name: &str, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let path = entry.path();
            if kind.is_dir() && !is_ignored_media_search_dir(&path) {
                collect(&path, name, out)?;
            } else if kind.is_file() && entry.file_name() == std::ffi::OsStr::new(name) {
                out.push(path);
            }
        }
        Ok(())
    }
    if has_path_separator(collection_ref) {
        let path = vault.block_path(collection_ref);
        return match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => Ok(vec![path]),
            Ok(_) => Ok(Vec::new()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error),
        };
    }
    let mut paths = Vec::new();
    collect(vault.root(), &format!("{collection_ref}.md"), &mut paths)?;
    paths.sort();
    Ok(paths)
}

/// Resolve a frontmatter media field as a normal local path.
pub fn resolve_frontmatter_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    match crate::storage::file_identity::bound_frontmatter_target(vault, block_slug, reference) {
        Ok(Some(path)) => return path,
        Err(error) => {
            log::warn!("media identity manifest unavailable: {error:#}");
            return None;
        }
        Ok(None) => {}
    }
    if !has_path_separator(reference) {
        let mut matches = Vec::new();
        collect_basename_matches(vault.root(), reference, &mut matches);
        if matches.len() > 1 {
            return None;
        }
    }
    let path = vault.resolve_local_reference(block_slug, reference)?;
    path.exists().then_some(path)
}

fn resolve_wikilink_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    match crate::storage::file_identity::bound_target(vault, block_slug, reference) {
        Ok(Some(path)) => return path,
        Err(error) => {
            log::warn!("media identity manifest unavailable: {error:#}");
            return None;
        }
        Ok(None) => {}
    }
    if has_path_separator(reference) {
        let local = vault
            .resolve_local_reference(block_slug, reference)
            .filter(|path| path.exists());
        let root = resolve_root_relative(vault, reference);
        return match (local, root) {
            (Some(left), Some(right)) if left != right => None,
            (Some(path), _) | (_, Some(path)) => Some(path),
            _ => None,
        };
    }
    resolve_by_basename(vault, block_slug, reference)
}

fn resolve_markdown_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    match crate::storage::file_identity::bound_markdown_target(vault, block_slug, reference) {
        Ok(Some(path)) => return path,
        Err(error) => {
            log::warn!("media identity manifest unavailable: {error:#}");
            return None;
        }
        Ok(None) => {}
    }
    vault
        .resolve_local_reference(block_slug, reference)
        .filter(|path| path.exists())
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
    match crate::storage::file_identity::bound_any_target(vault, block_slug, reference) {
        Ok(Some(path)) => return path,
        Err(error) => {
            log::warn!("media identity manifest unavailable: {error:#}");
            return None;
        }
        Ok(None) => {}
    }
    let ambiguous_short_name = if has_path_separator(reference) {
        false
    } else {
        let mut matches = Vec::new();
        collect_basename_matches(vault.root(), reference, &mut matches);
        matches.len() > 1
    };
    if ambiguous_short_name {
        return None;
    }
    resolve_root_relative(vault, reference)
        .or_else(|| resolve_frontmatter_media(vault, block_slug, reference))
        // A bare legacy name is safe only when exactly one file has that name.
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
            resolve_markdown_media(vault, block_slug, &reference.source)
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

    if let Some(path) = resolve_wikilink_media(vault, block_slug, reference) {
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

/// Find a file by name anywhere under `root`, nearest to the root first.
///
/// The vault writes media references as Obsidian wikilinks — a bare name, not
/// a path — so a name alone is all a consumer outside the index has to go on.
/// Used by the asset protocol, which receives `<vault>/<name>` URLs built by
/// the frontend and must still find the file after the vault was sorted into
/// folders.
pub fn resolve_basename_under(root: &Path, file_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_basename_matches(root, file_name, &mut candidates);
    (candidates.len() == 1)
        .then(|| candidates.into_iter().next())
        .flatten()
}

fn resolve_by_basename(vault: &VaultLayout, block_slug: &str, file_name: &str) -> Option<PathBuf> {
    let _ = block_slug;
    let mut candidates = Vec::new();
    collect_basename_matches(vault.root(), file_name, &mut candidates);
    (candidates.len() == 1)
        .then(|| candidates.into_iter().next())
        .flatten()
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
    fn resolves_a_bare_name_from_a_sorted_vault() {
        // What the asset protocol faces: the frontend builds `<vault>/<name>`
        // from the index, but a sorted vault keeps media under Media/.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Media")).unwrap();
        std::fs::write(root.join("Media/Work by — Hassco Design©.jpg"), b"jpg").unwrap();

        let resolved = resolve_basename_under(root, "Work by — Hassco Design©.jpg").unwrap();

        assert_eq!(resolved, root.join("Media/Work by — Hassco Design©.jpg"));
    }

    #[test]
    fn ambiguous_basename_does_not_choose_the_root_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Media/nested")).unwrap();
        std::fs::write(root.join("shot.png"), b"png").unwrap();
        std::fs::write(root.join("Media/nested/shot.png"), b"png").unwrap();

        assert_eq!(resolve_basename_under(root, "shot.png"), None);
    }

    #[test]
    fn missing_name_resolves_to_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_basename_under(dir.path(), "absent.jpg").is_none());
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

        assert_eq!(
            resolve_indexed_media(&vault, "Cards/note", "gone.jpg"),
            None
        );
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
    fn obsidian_embed_leaves_duplicate_basename_unresolved() {
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

        assert_eq!(got, None);
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
