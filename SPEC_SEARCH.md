# Surface Search and Hybrid Retrieval

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [SPEC_STORAGE.md](SPEC_STORAGE.md) | [SPEC_INTEGRATION.md](SPEC_INTEGRATION.md) | [SPEC_DOMAIN.md](SPEC_DOMAIN.md) | [SPEC_GROUP_SELECTION.md](SPEC_GROUP_SELECTION.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

## Goal

Search is hybrid retrieval over blocks plus scoped channel filtering. The
visible block-search UI is the Search Overlay
([SPEC_SEARCH_OVERLAY.md](SPEC_SEARCH_OVERLAY.md)); this document owns the
backend read model, ranking, match metadata and card rendering rules.

- `Cmd+F` opens/closes the Search Overlay — modal block-search navigation. The
  former invisible grid-filter mode is removed: the Grid is never filtered by a
  search query.
- `Shift+Cmd+F` focuses search in the left top chrome segment and filters the
  channel list.
- `Cmd+K` remains reserved for scoped card/Detail overflow actions and never
  opens search.
- "No command palette" stays in force: the overlay searches and navigates, it
  never executes commands. There is still no `/search` route.

The main Grid search must search titles, full card content and searchable
metadata (`author`, `url`) while keeping the current page model: the user stays
on Everything or the current collection, and the same masonry Grid rerenders
with filtered/ranked cards.

The target search experience is hybrid retrieval, not a single text matcher.
The user can type a query in a different language from the saved card content
and still get relevant results. Example: a Russian query such as `память`,
`память как стая птиц` or `майн` can surface English cards containing
`memory`, `memory is a flock of birds` or `Mine` when the semantic/alias signal
is strong enough.

The implementation must preserve exact-search trust: semantic matches improve
recall, but exact title/body matches remain explainable and must not be buried
under vague semantic-neighbor results.

## Non-Goals

- No modal command palette.
- No `/search` route.
- No client-side scan over DOM nodes or Markdown files.
- No OCR/PDF/video-content search in this phase.
- No cloud-only search dependency. Any cloud embedding provider must be an
  explicit opt-in backend and cannot be required for the default local app.
- No fake highlight for semantic-only matches. Highlight ranges exist only for
  lexical/alias/fuzzy matches with a real text range in the rendered excerpt.

## Search Scopes

### Main Block Search (`Cmd+F`) — Search Overlay

`Cmd+F` opens or closes the Search Overlay; the full visual/keyboard/data
contract lives in [SPEC_SEARCH_OVERLAY.md](SPEC_SEARCH_OVERLAY.md). Key points
owned here:

- the overlay calls the dedicated route-facing backend command
  (`search_grid_blocks`) vault-wide (`currentTag` is not passed) and
  renders `LightBlock` + `search_match` per the Match Metadata / Card Rendering
  rules below;
- the Grid is never filtered by a search query: overlay results live in
  overlay-owned state, the route snapshot underneath stays untouched, and
  closing the overlay restores exactly the surface the user started from;
- the bottom app bar exposes a right-side `Search elements` action with the `⌘F`
  shortcut label and the same toggle behavior. This action is a command
  trigger, not a selected-state control: it must not remain visually pressed
  while the overlay is open;
- the top chrome is split by the same `--sidebar-width` boundary as the body:
  the left segment contains the native traffic-light spacer, the space
  selector, sidebar channel search and a `border-r border-sidebar-border`, so
  the Sidebar/Main divider continues to the top edge of the window. The right
  segment starts with a current collection switcher and leaves the remaining
  pixels as drag region;
- group selection and the overlay do not interact: the modal overlay owns the
  keyboard entirely while open.

When `query` is non-empty, overlay ordering is relevance-first. Normal route
order in the Grid is always `saved_at DESC`.

### Sidebar Search (`Shift+Cmd+F`)

Sidebar search is a permanent top-chrome control inside the left
`--sidebar-width` segment. The visual order is: native traffic-light spacer,
one vertical `bg-border` separator, the `VaultSwitcher`/space selector, a
second vertical `bg-border` separator, a no-icon `Input ghost` search field
with the design-system `h-8 px-3` geometry, then the existing
`border-r border-sidebar-border` Sidebar/Main divider. Collapsed sidebar does
not collapse the top chrome safety zone to zero and does not reserve an empty
search slot: the left segment uses CSS intrinsic sizing (`w-auto`) with an
`80px` traffic-light reserve, a `1px` separator and a `VaultSwitcher` capped at
`159px`, so the whole collapsed segment cannot exceed `240px`. It hides only
the channel search input and lets the right collection switcher start
immediately after that compact collapsed segment. There is no JS measurement or
hidden probe in this path; short folder names must never be truncated by the
collapsed container.

The space selector shows the current folder name, truncates before the search
field, and opens a searchable known-vault dropdown. It uses the same switch
path as the previous bottom-bar vault switcher; `Cmd+Shift+O` still opens the
native folder picker.
The selector width follows the current folder name but is capped at 50% of the
remaining left chrome width (`max-w-[50%]`). Folder names use end ellipsis.
The root trigger stays transparent; hover/open/focus state is drawn only by the
inner pill around the name (`h-6 rounded-1 px-2 bg-active`), with focus fill
restricted to keyboard focus. Top-chrome triggers do not show dropdown
chevrons.
Pointer-open closes prevent Radix trigger auto-focus and blur the trigger, so a
single pointer click cannot leave a sticky hover-colored pill. Pointer drag
also cannot open the dropdown: pointer activation is deferred to click and a
drag-threshold gesture suppresses that click. The search field takes the
remaining width and keeps native input scrolling so the latest typed characters
remain visible. The
search control is a wrapper surface with a transparent input, not a standalone
framed input. Empty hover/focus changes only placeholder color from tertiary to
muted. A non-empty trimmed query fills only that search surface with
`bg-accent`, matching the bottom action bar, and shows an icon-only
`Clear collection search` button (`X`, `h-6 w-6 rounded-1`) on the right. Clear
restores the full channel list and returns focus to the input.

`Shift+Cmd+F` focuses/selects that top-chrome input. It filters only sidebar
channel rows and does not change the route or Grid dataset.
`Everything` is part of the filtered row set: it remains visible only when the
query is empty or matches `Everything` / `__all__`.
While that input is focused, unmodified `ArrowUp`/`ArrowDown` move a persistent
active descendant across visible Sidebar rows, including the bottom create row,
without moving DOM focus out of the input; the user can keep typing after arrow
navigation. `Enter` activates the active row. `Escape` clears a non-empty
sidebar search value; with an empty value it blurs the input and clears the
active descendant.

### Collection Switcher Search

The right top chrome collection switcher is route navigation, not a second
Grid search scope. Its trigger displays the current route collection
(`Everything` or the active channel). Its dropdown contains a small search
field that filters only destination collections using the same
case-insensitive exact/prefix/substring/fuzzy channel matcher as Sidebar
search and the same Sidebar ordering before ranking. The trigger keeps the
right-side top-chrome spacing in expanded mode: transparent root `px-6` plus an
inner `px-2` hover/open pill, placing text on a `32px` content axis from the
segment edge. In compact/collapsed sidebar mode that wide right-side inset is
removed: the collection trigger switches to `px-3`, matching the space selector
root padding so the current collection starts immediately after the compact
space segment without an extra 32px gap.

The current collection is excluded from the dropdown result set entirely. It is
not duplicated as a disabled row, not marked with a check/radio icon and not
styled as selected. Choosing any visible item immediately navigates to that
collection route and closes the menu.

The collection switcher dropdown has a pinned bottom `Create collection` action
that is always available and never appears as an inline search result.
Activating it closes the dropdown and opens a separate create-channel dialog.
The dialog may prefill from the current search query, validates empty/duplicate
names, uses the normal channel create command, refreshes App snapshots and
navigates to the created channel.

Space switcher dropdown follows the same no-current/no-check/no-icon menu
language, adds its own `Search spaces` input, lists only destination spaces and
keeps a plain pinned `Add space` action. `Search collections`, `Search spaces`
and Sidebar channel search use the same input-owned keyboard model:
`ArrowUp`/`ArrowDown` change `aria-activedescendant`, pointer hover may update
the active row, but focus remains in the search input.

Sidebar search is client-side because taxonomy/channel rows are already a small
App-owned read model. Matching is centralized in `src/lib/channelSearch.ts`:
case-insensitive exact/prefix/word-prefix/substring ranking first, then bounded
Damerau-Levenshtein typo tolerance for queries of at least 3 characters. Ties
keep the current channel order, so the sidebar remains deterministic.

## Keyboard Contract

| Shortcut | Scope | Behavior |
|---|---|---|
| `Cmd+F` | Search Overlay | Open/close the modal block-search overlay (keyboard contract inside: SPEC_SEARCH_OVERLAY.md) |
| `Shift+Cmd+F` | Sidebar | Focus/select the top-chrome channel search input |
| `Escape` in sidebar search input | Sidebar | Clear the query; if empty, blur the input |
| `Escape` in the search overlay | Search Overlay | Close the overlay regardless of query |

Shortcut handlers must ignore editable/nested overlay targets using the shared
keyboard target helpers. `Cmd+F` and `Shift+Cmd+F` must call `preventDefault()`
only when Mine owns the shortcut; they must not leak into any browser/webview
find behavior.

Desktop shortcut delivery must not depend on DOM `keydown`: Tauri registers
native menu accelerators for `Cmd+F` and `Shift+Cmd+F` and emits
`surface-search-shortcut` with `main` or `sidebar`. The frontend `keydown`
handler remains a browser/dev fallback and must be keyboard-layout independent:
use the physical `KeyboardEvent.code === "KeyF"` path in addition to the Latin
`key === "f"` so `Cmd+F` works on non-Latin macOS layouts.

## Backend Read Model

Main search uses a dedicated route-facing `search_grid_blocks` snapshot, not
the normal Grid command and not the removed global `search()` frontend surface.

```ts
interface SearchGridBlocksParams {
  currentTag?: string;
  limit: number;
  query: string;
  cursor?: SearchPageToken;
}

interface SearchSnapshot {
  generation: ProjectionRevision;
  search_generation: SearchRevision;
  blocks: LightBlock[];
  has_more: boolean;
  next_cursor: SearchPageToken | null;
  cursor_reset: boolean;
}
```

If `query` is empty, Search Overlay recent mode uses vault-wide
`list_grid_blocks` and keeps the normal SQL path:

- filter out channel documents;
- optional `block_tags` filter for `currentTag`;
- `ORDER BY saved_at DESC`;
- `LIMIT limit + 1 OFFSET offset`.

If `query` is non-empty, `search_grid_blocks` uses the backend `SearchEngine`
path:

- sync normalized derived `search_chunks` for changed indexed blocks;
- run lexical FTS5 over `blocks_fts`;
- run alias/transliteration-expanded FTS5 groups;
- run typo-tolerant fuzzy matching over `search_chunks`;
- run semantic vector retrieval over persisted `search_embeddings` when local
  model vectors are available;
- fuse candidates into one deterministic relevance order;
- return the same lightweight `LightBlock` projection and optional
  `search_match` metadata.

The FTS column weights are:

| FTS column | Indexed source | Weight |
|---|---|---:|
| `title` | `display_title`, legacy `title`, `fallback_label` | `8.0` |
| `description` | frontmatter/link description | `3.0` |
| `body` | full Markdown body after frontmatter | `1.0` |

`bm25(...) ASC` is required: in SQLite FTS5 lower scores are better.

The lexical layer still uses SQLite FTS5. The route-facing backend is a local
`SearchEngine` layer with four sources of evidence:

| Layer | Purpose | Required behavior |
|---|---|---|
| Lexical index | Exact, prefix and phrase-like matches | Fast route-filtered matching over title/description/body with stable snippets |
| Alias index | Human aliases, transliteration, localized names | `майн`/`mine`, `память`/`memory`, domain/source aliases and curated synonym sets |
| Semantic vector index | Cross-language and meaning-based recall | Russian query can retrieve English content by meaning without literal overlap |
| Fusion/rerank | Combine evidence into one ordered Grid | Exact lexical trust is preserved while semantic recall improves discovery |

The frontend calls one route-facing search command for non-empty queries. It must not know
whether a result came from FTS5, Tantivy, aliases or vector search except through
explicit match metadata.

Implemented behavior:

- `search_grid_blocks(...)` delegates non-empty queries to the backend
  `SearchEngine` boundary;
- lexical retrieval still uses SQLite FTS5 with prefix terms;
- query planning refuses stopword-filtered queries shorter than 2 alphanumeric
  characters, so one-letter fragments never reach FTS/alias/semantic retrieval;
- query planning expands stopword-filtered token groups with deterministic
  aliases/transliteration;
- each token group is route-filtered as an OR group internally, while different
  meaningful groups remain AND requirements;
- Russian aliases such as `память`, `стая`, `птиц`, `майн` can retrieve English
  terms such as `memory`, `flock`, `birds`, `mine`;
- fuzzy candidates are produced from normalized chunks and return real ranges;
- semantic retrieval uses local `fastembed` + `intfloat/multilingual-e5-small`;
- semantic vectors are persisted in SQLite with model id, dimension and chunk
  hash;
- `fastembed` model files are cached outside the repo under
  `~/Library/Application Support/com.mine.app/cache/fastembed` unless
  `FASTEMBED_CACHE_DIR` is explicitly set;
- single-token Latin queries stay strict and bypass semantic embedding work:
  semantic-only cards are not injected into the visible result set;
- semantic-only cards are allowed for cross-language Cyrillic queries and
  multi-token semantic queries where literal matching alone is insufficient,
  but only after the normalized meaningful query has at least 3 alphanumeric
  characters. One- and two-character queries stay lexical/alias/fuzzy only so
  `в`, `ав` or mixed-layout fragments cannot pull a 200-row semantic tail;
- background metadata backfill warms chunks/vectors after vault open; keypress
  search never downloads a model or generates missing embeddings in the
  foreground;
- when the local semantic model is still warming or vectors are unavailable,
  search degrades to lexical/alias/fuzzy results for the same input;
- fusion collapses duplicate chunk hits to one card and keeps exact title/body
  evidence above weaker semantic-only evidence.

## Search Documents And Chunks

Search operates on derived search documents, not directly on rendered cards.
The `.md` file remains the source of truth; every search artifact is rebuildable
from Markdown + frontmatter + media metadata.

```rust
struct SearchDocument {
    block_id: i64,
    slug: String,
    title: Option<String>,
    description: Option<String>,
    body: String,
    document_hash: String,
}

struct SearchChunk {
    block_id: i64,
    slug: String,
    chunk_index: usize,
    field: SearchField,
    text: String,
    start_char: usize,
    end_char: usize,
    text_hash: String,
}
```

Chunking rules:

- title and description are single chunks;
- article/social body chunks use a bounded token window with overlap;
- chunks must keep offsets back to normalized plain text so snippets can map to
  rendered excerpts;
- chunks include enough surrounding text for cards to show a useful 2-3 line
  preview without loading the full `.md` during keypress search.

## Query Semantics

Search input is tokenized by whitespace. Each token is escaped for FTS5 and
sent as a prefix token (`"mem"*`, not `"mem"`), because Surface Search filters
while the user is still typing. The implementation must not expose raw FTS
syntax to the user.

Rules:

- multi-token text is an AND query;
- matching is case-insensitive according to the SQLite FTS tokenizer;
- empty or whitespace-only query is the normal Grid route;
- after stopword filtering, a query with fewer than 2 alphanumeric characters
  is treated as not ready and returns no search plan;
- semantic-only retrieval is gated until the stopword-filtered query contains
  at least 3 alphanumeric characters;
- invalid punctuation must not throw user-visible SQL/FTS errors.

Hybrid query normalization additionally produces:

- `literal_terms`: original lexical tokens;
- `normalized_terms`: lowercase/diacritic-normalized terms;
- `alias_terms`: curated aliases, transliterations and localized labels;
- `semantic_query`: the full user query for embedding;
- `language_hint`: best-effort language/script classification for ranking and
  diagnostics, never a hard filter.

For cross-language queries, semantic search is required. Transliteration and
alias expansion are useful recall helpers, but they are not a substitute for a
multilingual embedding model.

## Ranking And Fusion

The search engine returns one ordered result set with per-result evidence.
Ranking must be deterministic for a fixed index and query.

Evidence classes:

| Match kind | Meaning | UI treatment |
|---|---|---|
| `exact` | Literal token/phrase appears in rendered title/description/body | Highlight matched range |
| `prefix` | User typed a token prefix | Highlight only the typed prefix range |
| `fuzzy` | Typo-tolerant lexical match | Highlight corrected matched token and mark as fuzzy evidence |
| `alias` | Query matched an alias/transliteration/synonym | Highlight target token if present; otherwise show alias evidence |
| `semantic` | Vector similarity match without literal overlap | Show semantic excerpt, no fake text highlight |

Fusion contract:

- exact title matches outrank semantic-only body matches;
- exact/prefix body matches outrank weak semantic-only matches;
- semantic matches can outrank stale/weak lexical matches when the semantic
  score is high and lexical evidence is absent or low-value;
- collection route filtering is applied before final result return;
- recency is a tie-breaker, not the primary relevance signal;
- duplicates from multiple chunks collapse to one card result using the best
  evidence and best excerpt.

The implementation uses explicit, auditable boosts: title/description/body
field priority, exact/prefix/alias/fuzzy kind priority, semantic cosine score
and `saved_at` as a tie-breaker. The architecture keeps the formula inside
`storage::search_engine`, so it can be replaced by a learned/reranker model
without changing the frontend command contract.

## Match Metadata

`LightBlock` can carry optional search-only metadata:

```ts
interface SearchMatch {
  field: "title" | "description" | "author" | "body" | "url" | "semantic";
  kind: "exact" | "prefix" | "fuzzy" | "alias" | "semantic";
  excerpt: string;
  ranges: Array<{ start: number; end: number }>;
  score: number;
  explanation?: string;
}
```

The backend returns plain text plus character ranges. Prefix matches highlight
only the typed prefix: query `memo` over `memory` returns the `memo` range, not
the full `memory` token. It must not return HTML or SQLite snippet markup for
direct rendering.

Field priority for the visible first match:

1. `title`
2. `description`
3. `body`

`author` and `url` are searchable metadata fields, but they are not visible
highlight surfaces. An author-only or URL-only match can return and rank a card,
but the backend must return an empty `ranges` array for that match. The card
keeps its normal title/preview rendering; it must not replace the preview with
the author string, must not reveal the hidden URL, and must not draw a fake
mark.

`title` is considered only when the Grid card actually renders a title. Social
cards (X/Twitter/Instagram layouts) render media plus preview/body text and do
not expose `title` on the card surface, so their match metadata must prefer
`description`/`body` over title/fallback-label matches.

For `title`, `excerpt` is the rendered title text. For `description`, `excerpt`
is the description text around the first visible match. For `body`, `excerpt`
is a whitespace-normalized article slice around the first visible match.
For `author` and `url`, `excerpt` may contain the matched metadata for ranking
explanation/debugging, but the frontend treats it as non-rendered metadata.

Match metadata is built only for returned rows, never for the full result set.

Semantic-only matches return `kind: "semantic"`, `field: "semantic"` and an
empty `ranges` array unless the chosen excerpt also contains a literal/alias
range. The card renders the excerpt normally and may show subtle secondary
metadata later, but it must not invent highlight ranges.

## Card Rendering

Article-derived feed cards in active main search mode use search metadata,
including social/X/Instagram cards with media previews:

- if `field === "title"`, render the normal title with highlighted ranges and
  keep normal preview behavior;
- if `field === "description"` or `field === "body"`, replace the normal
  preview text with a 2-3 line excerpt around the first match;
- if `field === "author"` or `field === "url"`, keep the normal card preview
  and draw no highlight; those fields only explain why the card was returned;
- highlighted ranges render with the design-system search mark token;
- semantic-only excerpts render without highlighted text;
- clearing the query restores normal title/preview rendering.

Standalone media cards do not synthesize body excerpts. They may highlight
title or description matches, but empty-body media remains visually media-first.

Search metadata must not affect masonry measurement stability outside active
search mode. In active search mode, layout recomputes from the filtered blocks
and the excerpt text actually rendered by cards.

## Frontend Data Flow

App owns:

- `searchOverlayOpen` and `searchOverlayQuery` (session-lived, see
  SPEC_SEARCH_OVERLAY.md);
- `sidebarSearchQuery`;
- `sidebarSearchFocusSequence`;
- per-route normal snapshot cache (route-keyed only — search never touches it).

Overlay search requests are owned by the overlay component: a debounced
`search_grid_blocks(undefined, query, limit, cursor)` call with a request
sequence. A continued page uses only the opaque cursor returned by the previous
`SearchSnapshot`; it never invents an offset.
Search results are never applied if:

- the query changed after request start;
- a newer request sequence completed first;
- the overlay closed.

Every search response carries both `ProjectionRevision` and `SearchRevision`.
If either changed, or the cursor query fingerprint differs, backend returns a
reset snapshot from offset zero; frontend replaces the result set and never
combines ranking pages from different revisions.

Debounce: `100ms`. It is short enough to feel live while avoiding one IPC
request per key repeat.

Hybrid search may return in two phases:

1. lexical/alias results, fast enough for live typing;
2. semantic fusion results when embeddings are available.

If the engine uses two phases, the frontend still receives monotonic snapshots
for the same query sequence. It must never flash unrelated results from an older
query. The first usable result set should appear quickly; semantic enrichment
must refine ordering without blocking typing or route switching.

## Derived Storage

Hybrid search adds rebuildable derived storage under the local app data store,
keyed by `vault-id`, never inside the synced vault:

| Store | Content | Rebuild source |
|---|---|---|
| `blocks_fts` or replacement lexical index | title/description/body terms | Markdown + frontmatter |
| `search_alias_terms` | aliases, transliterations, localized names | deterministic alias builder + curated config |
| `search_chunks` | normalized searchable chunks and offsets | Markdown + frontmatter |
| `search_embeddings` | embedding vectors with model metadata | `search_chunks` + embedding model |

Embedding rows include `model_id`, vector `dim`, `text_hash` and `updated_at`.
Changing the model id, vector dimension or chunking contract invalidates only
derived embeddings; user files are never rewritten.

Default privacy contract:

- local-first search must work without network;
- lexical/alias search is always available;
- semantic search requires a local embedding model by default;
- optional remote embeddings require explicit user opt-in and must be replaceable
  by local embeddings without changing the search API.

## Indexing Lifecycle

Watcher/indexer responsibilities:

- update lexical and alias artifacts synchronously with block indexing;
- enqueue embedding jobs for changed chunks;
- mark semantic state as `ready`, `building`, `stale` or `unavailable`;
- keep stale embeddings searchable only when their `chunk_hash` still matches;
- never block Grid rendering on embedding generation.

Search behavior by semantic state:

| Semantic state | Behavior |
|---|---|
| `ready` | Full hybrid fusion |
| `building` | Lexical/alias results immediately; semantic results appear as chunks complete |
| `stale` | Lexical/alias only for changed chunks; unchanged ready chunks remain semantic-searchable |
| `unavailable` | Lexical/alias search only, with no degraded UI chrome |

## Interaction With Selection And Navigation

The overlay is modal: while open it owns the keyboard entirely, so it cannot
conflict with Grid group selection or Grid keyboard focus. The Grid dataset is
never filtered by search, so no focus pruning is needed.

Opening a result is normal card open behavior into Detail; the overlay closes.
For a card outside the current route's grid, Detail's sibling navigation has no
neighbors — an accepted soft degradation (SPEC_SEARCH_OVERLAY.md).

## Performance Contract

The search path must stay fast for large vaults:

- no Markdown file reads during keypress search;
- no DOM scanning;
- search runs on a blocking backend task off the UI thread;
- return `limit + 1` lightweight rows, not full `IndexedBlock` bodies;
- build excerpts only for returned rows;
- keep existing virtual masonry and pagination;
- semantic search uses chunk-level vector lookup and returns candidate slugs
  before card projection; the storage boundary can move this to ANN later
  without changing the frontend contract;
- embedding generation is background work and must not run on the UI thread.

Behavior target: typing in a 10k-card vault remains interactive. If profiling
shows IPC payload or excerpt generation as the bottleneck, reduce result payload
before changing the visual contract.

Semantic behavior:

- first lexical results should remain sub-100ms for warm local indexes;
- semantic refinement should feel progressive, not blocking;
- a vault without completed embeddings must still feel functional.

## Test Contract

Backend:

- text search matches `display_title`, fallback label, description and body;
- cross-language query over a semantic-ready index can return a card with no
  literal token overlap;
- transliteration/alias query can return the canonical card;
- collection search combines FTS and `block_tags` filter;
- relevance order prefers title matches over body-only matches;
- author and URL matches return the matching card without visible highlight
  ranges;
- exact title matches outrank semantic-only body matches;
- punctuation in user query cannot break FTS SQL;
- one-character Cyrillic/Latin queries return no search plan;
- short Cyrillic/mixed-layout queries bypass the semantic provider;
- pagination returns `has_more` correctly in search mode;
- snippets return plain text and valid ranges;
- prefix snippets return only the typed prefix range;
- social-card metadata targets the rendered preview/body surface, not hidden title metadata;
- semantic-only results return no fake highlight ranges;
- stale embedding rows are ignored when their `chunk_hash` no longer matches.

Frontend (overlay-specific contract: SPEC_SEARCH_OVERLAY.md → Test Contract):

- `Cmd+F` and the bottom app bar `Search elements` open/close the Search Overlay;
  the Grid is not refetched and its dataset is untouched;
- the top app chrome still renders the Sidebar/Main divider up to the window
  top edge;
- `Shift+Cmd+F` focuses/selects top-chrome sidebar search and does not change Grid;
- stale search responses are ignored;
- article body matches render the highlighted excerpt as the row snippet and in
  the preview card;
- title matches highlight the title without replacing the preview;
- author and URL matches do not replace preview text, do not reveal hidden URL
  text and render no `mark`;
- semantic-only matches show an excerpt without text highlight;
- `Cmd+K` remains scoped to card/Detail menus and never opens search.
