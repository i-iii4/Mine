// Media reference resolution for Markdown and Obsidian inline embeds.
//
// Standard Markdown image paths are resolved relative to the containing note.
// Obsidian embeds additionally support basename lookup through the vault.

use mine_core::links::{LinkIndex, LinkResolution, LinkSyntax};
use std::path::{Path, PathBuf};

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
    link_index: Option<LinkIndex>,
}

impl<'a> MediaResolver<'a> {
    pub fn new(vault: &'a VaultLayout) -> Self {
        Self {
            vault,
            link_index: None,
        }
    }

    pub fn resolve_inline_media(
        &mut self,
        block_slug: &str,
        reference: &InlineMediaReference,
    ) -> Option<PathBuf> {
        let syntax = match reference.syntax {
            InlineMediaSyntax::MarkdownImage => LinkSyntax::Markdown,
            InlineMediaSyntax::ObsidianEmbed => LinkSyntax::Obsidian,
        };
        let source = format!("{block_slug}.md");
        resolve_with_index(
            self.vault,
            self.link_index(),
            &source,
            &reference.source,
            syntax,
        )
    }

    pub fn resolve_inline_media_root_relative(
        &mut self,
        block_slug: &str,
        reference: &InlineMediaReference,
    ) -> Option<String> {
        self.resolve_inline_media(block_slug, reference)
            .and_then(|path| self.vault.root_relative_reference(&path))
    }

    pub fn resolve_note_target(&mut self, block_slug: &str, reference: &str) -> Option<String> {
        let source = format!("{block_slug}.md");
        match self
            .link_index()
            .resolve(&source, reference, LinkSyntax::Obsidian)
        {
            LinkResolution::Resolved(path) if path.ends_with(".md") => Some(path),
            _ => None,
        }
    }

    pub fn resolve_indexed_media(&mut self, block_slug: &str, reference: &str) -> Option<PathBuf> {
        if let Some(path) = exact_indexed_root_path(self.vault.root(), reference) {
            return Some(path);
        }
        let syntax = if reference.starts_with("./") || reference.starts_with("../") {
            LinkSyntax::Markdown
        } else {
            LinkSyntax::Obsidian
        };
        let vault = self.vault;
        resolve_with_index(
            vault,
            self.link_index(),
            &format!("{block_slug}.md"),
            reference,
            syntax,
        )
    }

    fn link_index(&mut self) -> &LinkIndex {
        self.link_index
            .get_or_insert_with(|| build_link_index(self.vault.root()))
    }

    /// Destructive actions may resolve a short name only when it is unique.
    pub fn unique_basename(
        &mut self,
        file_name: &str,
    ) -> Result<Option<PathBuf>, AmbiguousMediaReference> {
        match self.link_index().resolve_basename(file_name) {
            LinkResolution::Resolved(path) => Ok(Some(self.vault.root().join(path))),
            LinkResolution::Missing => Ok(None),
            LinkResolution::Ambiguous(_) => Err(AmbiguousMediaReference(file_name.into())),
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
    resolve_with_index(
        vault,
        &build_link_index(vault.root()),
        "source.md",
        collection_ref,
        LinkSyntax::Obsidian,
    )
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
    let mut paths = Vec::new();
    let name = collection_ref.rsplit('/').next().unwrap_or(collection_ref);
    collect(vault.root(), &format!("{name}.md"), &mut paths)?;
    if has_path_separator(collection_ref) {
        let relative = paths
            .iter()
            .filter_map(|path| path.strip_prefix(vault.root()).ok())
            .filter_map(|path| path.to_str())
            .collect::<Vec<_>>();
        let index = LinkIndex::new(&relative);
        return match index.resolve("source.md", collection_ref, LinkSyntax::Obsidian) {
            LinkResolution::Resolved(path)
                if path == format!("{collection_ref}.md")
                    || path.ends_with(&format!("/{collection_ref}.md")) =>
            {
                Ok(vec![vault.root().join(path)])
            }
            LinkResolution::Resolved(_)
            | LinkResolution::Missing
            | LinkResolution::Ambiguous(_) => Ok(Vec::new()),
        };
    }
    paths.sort();
    Ok(paths)
}

/// Resolve a frontmatter media field as a normal local path.
pub fn resolve_frontmatter_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    let syntax = if reference.starts_with("./") || reference.starts_with("../") {
        LinkSyntax::Markdown
    } else {
        LinkSyntax::Obsidian
    };
    resolve_with_index(
        vault,
        &build_link_index(vault.root()),
        &format!("{block_slug}.md"),
        reference,
        syntax,
    )
}

fn resolve_wikilink_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    resolve_with_index(
        vault,
        &build_link_index(vault.root()),
        &format!("{block_slug}.md"),
        reference,
        LinkSyntax::Obsidian,
    )
}

fn resolve_markdown_media(
    vault: &VaultLayout,
    block_slug: &str,
    reference: &str,
) -> Option<PathBuf> {
    resolve_with_index(
        vault,
        &build_link_index(vault.root()),
        &format!("{block_slug}.md"),
        reference,
        LinkSyntax::Markdown,
    )
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
    if let Some(path) = exact_indexed_root_path(vault.root(), reference) {
        return Some(path);
    }
    let syntax = if reference.starts_with("./") || reference.starts_with("../") {
        LinkSyntax::Markdown
    } else {
        LinkSyntax::Obsidian
    };
    resolve_with_index(
        vault,
        &build_link_index(vault.root()),
        &format!("{block_slug}.md"),
        reference,
        syntax,
    )
}

fn exact_indexed_root_path(root: &Path, reference: &str) -> Option<PathBuf> {
    if reference.is_empty() || reference.contains('\\') || reference.contains('\0') {
        return None;
    }
    let mut path = root.to_path_buf();
    for component in Path::new(reference).components() {
        let std::path::Component::Normal(part) = component else {
            return None;
        };
        path.push(part);
        if std::fs::symlink_metadata(&path)
            .ok()?
            .file_type()
            .is_symlink()
        {
            return None;
        }
    }
    std::fs::symlink_metadata(&path)
        .ok()?
        .is_file()
        .then_some(path)
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
    resolve_wikilink_media(vault, block_slug, reference)
}

fn resolve_with_index(
    vault: &VaultLayout,
    index: &LinkIndex,
    source: &str,
    reference: &str,
    syntax: LinkSyntax,
) -> Option<PathBuf> {
    match index.resolve(source, reference, syntax) {
        LinkResolution::Resolved(path) => Some(vault.root().join(path)),
        LinkResolution::Missing | LinkResolution::Ambiguous(_) => None,
    }
}

pub fn build_link_index(root: &Path) -> LinkIndex {
    let mut files = Vec::new();
    collect_all_files(root, root, &mut files);
    LinkIndex::new(files)
}

fn collect_all_files(root: &Path, dir: &Path, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if !is_ignored_media_search_dir(&path) {
                collect_all_files(root, &path, files);
            }
        } else if kind.is_file() {
            if let Ok(relative) = path.strip_prefix(root) {
                if let Some(relative) = relative.to_str() {
                    files.push(relative.to_string());
                }
            }
        }
    }
}

/// Find a file by name anywhere under `root`, nearest to the root first.
///
/// The vault writes media references as Obsidian wikilinks — a bare name, not
/// a path — so a name alone is all a consumer outside the index has to go on.
/// Used by the asset protocol, which receives `<vault>/<name>` URLs built by
/// the frontend and must still find the file after the vault was sorted into
/// folders.
pub fn resolve_basename_under(root: &Path, file_name: &str) -> Option<PathBuf> {
    if file_name.contains('/') || file_name.contains('\\') {
        return None;
    }
    match build_link_index(root).resolve_basename(file_name) {
        LinkResolution::Resolved(path) => Some(root.join(path)),
        LinkResolution::Missing | LinkResolution::Ambiguous(_) => None,
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
    fn collection_candidates_accept_a_unique_folder_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::create_dir_all(dir.path().join("Archive/A")).unwrap();
        let nested = dir.path().join("Archive/A/Design.md");
        std::fs::write(&nested, "---\ntype: channel\n---\n").unwrap();
        assert_eq!(
            collection_document_candidates(&vault, "A/Design").unwrap(),
            vec![nested.clone()]
        );

        std::fs::create_dir_all(dir.path().join("Other/A")).unwrap();
        std::fs::write(
            dir.path().join("Other/A/Design.md"),
            "---\ntype: channel\n---\n",
        )
        .unwrap();
        assert!(collection_document_candidates(&vault, "A/Design")
            .unwrap()
            .is_empty());

        std::fs::create_dir_all(dir.path().join("A")).unwrap();
        let exact = dir.path().join("A/Design.md");
        std::fs::write(&exact, "---\ntype: channel\n---\n").unwrap();
        assert_eq!(
            collection_document_candidates(&vault, "A/Design").unwrap(),
            vec![exact]
        );
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
    fn indexed_exact_path_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let vault = VaultLayout::new(dir.path().to_path_buf());
        std::fs::write(dir.path().join("safe.jpg"), b"safe").unwrap();
        assert_eq!(
            exact_indexed_root_path(vault.root(), "safe.jpg"),
            Some(dir.path().join("safe.jpg"))
        );
        assert_eq!(exact_indexed_root_path(vault.root(), "../safe.jpg"), None);
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
