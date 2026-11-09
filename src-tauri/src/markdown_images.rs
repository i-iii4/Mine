//! The images of a Markdown body and their wikilinks live in the portable core
//! (`mine_core::domain::markdown_images`), so every executor of a clip reads a
//! body by one rule (SPEC_CLIPPER.md, «Один путь файла со страницы», Б13).

pub use mine_core::domain::markdown_images::*;
