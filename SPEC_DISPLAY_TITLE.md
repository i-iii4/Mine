# Display Title and Heading Model

Related documents: [SPEC_BLOCK.md](SPEC_BLOCK.md) | [SPEC_OBSIDIAN_MARKDOWN_COMPAT.md](SPEC_OBSIDIAN_MARKDOWN_COMPAT.md) | [SPEC_CLIPPER.md](SPEC_CLIPPER.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_TEXT_SELECTION_EXTRACTION.md](SPEC_TEXT_SELECTION_EXTRACTION.md) | [SPEC_INLINE_MEDIA_EXTRACTION.md](SPEC_INLINE_MEDIA_EXTRACTION.md)

## Status

Planned. This document defines the target contract for removing
`frontmatter.title` from the canonical write model while preserving read
compatibility with existing vault files.

## Goal

Mine should not persist artificial titles just to satisfy the data model. A
title is content when it is real, and content belongs in Markdown.

The target model:

1. New Mine-authored blocks do not write `title:` to frontmatter.
2. A real visible heading is written as the first Markdown H1 in body.
3. UI derives its title slot from the first H1.
4. Existing `frontmatter.title` remains a legacy read fallback.
5. Filename/slug remains the durable identity and final fallback label.
6. Tweets, quotes, image clips, local/anonymous videos, and files do not get
   synthetic titles.

## Terms

`content heading`

The first level-1 Markdown heading in the block body, for example
`# Stripe - Financial Infrastructure`. It is user-visible content and should be
editable in Obsidian like any other Markdown.

`legacy title`

Existing `frontmatter.title`. Mine reads it for older files but new write paths
must not create it automatically.

`display title`

An indexed/read-model value used by the UI. It is derived, not persisted as
source metadata.

`fallback label`

A human-readable label derived from the filename stem. It is used only when a
surface requires a navigation label and the block has no content heading or
legacy title.

## Derivation

For any block, Mine derives UI title data in this order:

1. First H1 in body.
2. Existing `frontmatter.title` as legacy fallback.
3. Filename stem as fallback label.

The source Markdown is not rewritten on read. Derived values live in the local
index/cache and can be rebuilt from files.

## UX Contract

Card title slot:

1. If a content heading exists, show it as the title slot.
2. If no content heading exists but a legacy title exists, show the legacy
   title as a compatibility fallback.
3. The title slot is one line only and truncates with ellipsis.
4. If the block is a social/tweet card or a text-selection quote with no H1,
   do not create a title slot from the body. Show the normal preview/body
   content instead.

Detail:

1. Do not render a separate metadata H2 above body.
2. Render the Markdown body, including its H1 when present.
3. Avoid duplicate headings: if the body already has H1, the old metadata H2
   must not also appear.
4. If there is no H1, Detail should not invent one from filename or selected
   text.

Search:

1. Prefer content heading.
2. Fall back to legacy title.
3. Fall back to filename stem as a navigation label.
4. Search may index all three, but search indexing must not create source
   frontmatter.

Drag preview:

Use the same card rendering contract as the grid. It must not reintroduce a
synthetic title for quotes or social cards.

## Write Contract

### Link Clips

If the page has a real document title, write it as the first H1 in body:

```md
---
type: link
url: https://stripe.com
Mine Collections:
  - "[[Web Design]]"
saved_at: 2026-05-01T14:30:00Z
source: web-clipper
---

# Stripe - Financial Infrastructure
```

`frontmatter.url` remains the canonical URL. The H1 is display/content text,
not identity.

### Article Clips

If the article has a real title, body starts with one H1, followed by article
content:

```md
---
type: article
url: https://example.com/article
author: Author Name
Mine Collections:
  - "[[Reading]]"
saved_at: 2026-05-01T14:30:00Z
source: web-clipper
---

# Article Title

Article text...
```

If the extracted article body already starts with the same H1, do not duplicate
it.

### Text Selection And Quote Cards

Do not generate H1 from the selected text. A one-word quote remains a one-word
body, not a one-word title.

Filename/slug may still use a readable seed derived from the selection for file
creation, but that seed must not be persisted as `title:` or inserted as H1.

### Social/Tweet Clips

Do not generate H1 from tweet text. A tweet is displayed as social content:
body/preview plus author/source context. The first 80 characters of a tweet may
be used as a filename seed, but not as a visible title.

### Image, Video, And File Blocks

Do not write `title:` automatically for media/file imports. A real video page
heading may be written as body H1, but local/anonymous videos do not get a
synthetic title from filename. If a user later adds a caption or heading, that
belongs in Markdown body, not in generated frontmatter.

## Backward Compatibility

Existing files with `frontmatter.title` continue to read.

No automatic vault-wide migration is required for phase 1. The first
implementation should change new write paths and UI derivation only. A later
optional migration can move legacy title values into H1 when that is safe and
human-reviewable.

Unsafe migration cases:

1. Body already has a different H1.
2. Social/tweet cards where the legacy title is synthetic.
3. Quote cards where the legacy title was generated from selected text.
4. Media/file cards where the legacy title merely mirrors filename.

## Implementation Plan

1. Add a derived title parser.
   - Extract first H1 from Markdown body without rendering.
   - Return `{ content_heading, legacy_title, fallback_label }`.
   - Keep it pure and covered by Rust unit tests.

2. Extend storage read model.
   - Add derived fields such as `display_title` and `content_heading` to the
     local index/API, or an equivalent typed read model.
   - Keep `frontmatter.title` as legacy metadata, not the UI source.
   - Rebuild these fields from source files during indexing.

3. Switch frontend title surfaces.
   - Card title slot reads `display_title`.
   - Card title stays one line with ellipsis.
   - Detail removes metadata H2 duplication and relies on rendered body H1.
   - Search result label uses `display_title`, then fallback label.

4. Update write paths.
   - Clipper link/article writes real page title as H1.
   - Text-selection extraction stops sending/writing title.
   - Inline-media extraction stops sending/writing title.
   - File/image/video imports stop generating title.
   - Rename stops syncing `frontmatter.title` to filename stem.

5. Preserve old vaults.
   - Existing `frontmatter.title` remains visible as fallback until edited or
     optionally migrated.
   - No read path writes H1 or removes title.

6. Add tests.
   - H1 beats legacy title.
   - Legacy title works when no H1 exists.
   - Filename fallback works when neither H1 nor legacy title exists.
   - Tweet/quote without H1 shows no synthetic card title.
   - Link/article clips write H1 and no `title:`.
   - Rename changes filename only, not content heading.

## Acceptance Criteria

1. A newly saved normal article has no `title:` in frontmatter and has one H1
   in body.
2. A newly saved link has no `title:` in frontmatter and can show its page title
   from body H1.
3. A saved tweet does not show an artificial heading made from tweet text.
4. A one-word quote does not show that word as a title.
5. Card title rendering for H1 is one line with ellipsis.
6. Detail does not duplicate heading above body.
7. Existing old files with `frontmatter.title` still display correctly.
8. In-app rename no longer rewrites `frontmatter.title`.
